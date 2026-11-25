import type { LightShaftLook } from '../../environment/environment.ts';
import { ADDITIVE } from '../../gfx/blend.ts';
import { createBufferWithData, createUniformBuffer } from '../../gfx/buffers.ts';
import {
	type FullscreenPass,
	type FullscreenPipeline,
	autoBindGroup,
	encodeFullscreen,
	fullscreenPipeline,
} from '../../gfx/fullscreen-pass.ts';
import type { PipelineCache } from '../../gfx/pipeline-cache.ts';
import { LINEAR_CLAMP, sampler } from '../../gfx/samplers.ts';
import { TextureSet } from '../../gfx/texture-set.ts';
import type { Camera } from '../../scene/camera.ts';
import { HDR_FORMAT, type SceneTextures } from '../frame/render-targets.ts';
import luminanceWgsl from '../shaders/common/luminance.wgsl?raw';

import lightShaftsWgsl from './light-shafts.wgsl?raw';
import { postShaderModule } from './shader-source.ts';

/** byte size of `Shafts` in light-shafts.wgsl */
const UNIFORM_BYTES = 48;
/** the game's `lightShaftDownSampleFactor` at PC quality tiers 2000 and up */
const DOWNSAMPLE = 2;
/** the game's default `lightShaftSampleNum` */
const SAMPLES = 12;
/** the game's default `lightShaftBlurPassCount` */
const BLUR_PASSES = 3;

interface Sized {
	/** the downsample, then the blur passes, ping-ponging */
	passes: FullscreenPass[];
	/** adds the last blur onto the scene */
	apply: FullscreenPass;
}

/** owns the shafts' reduced-size targets and passes */
export class LightShafts {
	#device: GPUDevice;
	#postUniforms: GPUBuffer;
	#uniforms: GPUBuffer;
	/** per blur pass: its index */
	#passUniforms: GPUBuffer[];
	#data = new Float32Array(UNIFORM_BYTES / 4);
	#sampler: GPUSampler;
	#pipelines: Record<'downsample' | 'blur' | 'apply', FullscreenPipeline>;
	#targets: TextureSet;
	#sized: Sized | null = null;

	/**
	 * @param device the device
	 * @param pipelines the pipeline cache
	 * @param postUniforms the post chain's `Post` uniforms
	 */
	constructor(device: GPUDevice, pipelines: PipelineCache, postUniforms: GPUBuffer) {
		this.#device = device;
		this.#targets = new TextureSet(device);
		this.#postUniforms = postUniforms;
		this.#uniforms = createUniformBuffer(device, 'light shaft uniforms', UNIFORM_BYTES);
		this.#passUniforms = Array.from({ length: BLUR_PASSES }, (_, i) =>
			createBufferWithData(device, {
				label: `light shaft blur ${i}`,
				usage: GPUBufferUsage.UNIFORM,
				data: new Float32Array([i, 0, 0, 0]),
			}),
		);
		this.#sampler = sampler(device, LINEAR_CLAMP);
		const module = postShaderModule(device, 'light shafts', [luminanceWgsl, lightShaftsWgsl]);
		const pipeline = (label: string, entryPoint: string, target: GPUColorTargetState): FullscreenPipeline =>
			fullscreenPipeline(pipelines, { label, module, entryPoint, targets: [target] });
		this.#pipelines = {
			downsample: pipeline('light shaft downsample', 'fs_downsample', { format: HDR_FORMAT }),
			blur: pipeline('light shaft blur', 'fs_blur', { format: HDR_FORMAT }),
			// the game adds the colour only
			apply: pipeline('light shaft apply', 'fs_apply', {
				format: HDR_FORMAT,
				blend: ADDITIVE,
				writeMask: GPUColorWrite.RED | GPUColorWrite.GREEN | GPUColorWrite.BLUE,
			}),
		};
	}

	/** @returns bytes of the targets */
	get bytes(): number {
		return this.#targets.bytes;
	}

	/**
	 * (re)creates the targets for a new render size or inputs.
	 *
	 * @param input the main pass's textures, the composited scene (read, then added onto) and the render size
	 */
	resize(input: { scene: SceneTextures; composited: GPUTextureView; width: number; height: number }): void {
		this.#release();
		const device = this.#device;
		const p = this.#pipelines;
		const width = Math.max(1, Math.ceil(input.width / DOWNSAMPLE));
		const height = Math.max(1, Math.ceil(input.height / DOWNSAMPLE));
		const views = [0, 1].map((i) =>
			this.#targets
				.create({ label: `light shafts ${i}`, size: [width, height], format: HDR_FORMAT })
				.createView(),
		);
		const shafts = { buffer: this.#uniforms };
		const passes: FullscreenPass[] = [
			{
				label: 'light shaft downsample',
				pipeline: p.downsample,
				bind: (compiled) => [
					autoBindGroup(device, compiled, 0, {
						0: { buffer: this.#postUniforms },
						1: shafts,
						2: this.#sampler,
					}),
					autoBindGroup(device, compiled, 1, { 0: input.composited, 1: input.scene.depth }),
				],
				targets: [views[0]],
			},
		];
		// the blurs and the apply read none of the post uniforms
		let blurShared: GPUBindGroup | null = null;
		for (let i = 0; i < BLUR_PASSES; i++) {
			const passUniform = this.#passUniforms[i];
			const readView = views[i % 2];
			passes.push({
				label: 'light shaft blur',
				pipeline: p.blur,
				bind: (compiled) => [
					(blurShared ??= autoBindGroup(device, compiled, 0, { 1: shafts, 2: this.#sampler })),
					autoBindGroup(device, compiled, 1, { 2: { buffer: passUniform }, 3: readView }),
				],
				targets: [views[(i + 1) % 2]],
			});
		}
		const apply: FullscreenPass = {
			label: 'light shaft apply',
			pipeline: p.apply,
			bind: (compiled) => [
				autoBindGroup(device, compiled, 0, { 2: this.#sampler }),
				autoBindGroup(device, compiled, 1, { 3: views[BLUR_PASSES % 2] }),
			],
			targets: [input.composited],
		};
		this.#sized = { passes, apply };
	}

	/**
	 * adds this frame's shafts onto the composited scene, when the look has them and the sun is in front of the
	 * camera.
	 *
	 * @param encoder this frame's encoder, after compositing and before temporal antialiasing
	 * @param input the camera (unjittered), the render size's aspect and the environment's shafts (`null`:
	 *   none)
	 */
	encode(
		encoder: GPUCommandEncoder,
		input: { camera: Camera; aspect: number; look: LightShaftLook | null },
	): void {
		const sized = this.#sized;
		if (sized === null) {
			throw new Error('light shafts used before resize()');
		}
		const { camera, aspect, look } = input;
		if (look === null) {
			return;
		}
		const sun = camera.projectDirection(look.sunDirection, aspect);
		if (sun === null) {
			return;
		}
		const f = this.#data;
		f.set([1 / look.occlusionDepthRange, look.bloomScale, 0, look.maxBrightness], 0);
		f.set([...look.tint, look.threshold], 4);
		f.set([sun[0], sun[1], SAMPLES, look.blurIntensity], 8);
		this.#device.queue.writeBuffer(this.#uniforms, 0, f);
		for (const pass of sized.passes) {
			encodeFullscreen(encoder, pass);
		}
		encodeFullscreen(encoder, sized.apply, 'load');
	}

	#release(): void {
		this.#targets.destroy();
		this.#sized = null;
	}

	/** frees the targets and the uniforms */
	destroy(): void {
		this.#release();
		this.#uniforms.destroy();
		for (const buffer of this.#passUniforms) {
			buffer.destroy();
		}
	}
}
