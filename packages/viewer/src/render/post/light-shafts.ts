import type { LightShaftLook } from '../../environment/environment.ts';
import { ADDITIVE } from '../../gfx/blend.ts';
import { createBufferWithData, createUniformBuffer } from '../../gfx/buffers.ts';
import {
	type FullscreenPass,
	autoBindGroup,
	encodeFullscreen,
	fullscreenPipeline,
} from '../../gfx/fullscreen-pass.ts';
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
	#pipelines: Record<'downsample' | 'blur' | 'apply', GPURenderPipeline>;
	#targets: TextureSet;
	#sized: Sized | null = null;

	/**
	 * @param device the device
	 * @param postUniforms the post chain's `Post` uniforms
	 */
	constructor(device: GPUDevice, postUniforms: GPUBuffer) {
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
		const pipeline = (label: string, entryPoint: string, target: GPUColorTargetState): GPURenderPipeline =>
			fullscreenPipeline(device, { label, module, entryPoint, targets: [target] });
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
				groups: [
					autoBindGroup(device, p.downsample, 0, {
						0: { buffer: this.#postUniforms },
						1: shafts,
						2: this.#sampler,
					}),
					autoBindGroup(device, p.downsample, 1, { 0: input.composited, 1: input.scene.depth }),
				],
				targets: [views[0]],
			},
		];
		// the blurs and the apply read none of the post uniforms
		const blurShared = autoBindGroup(device, p.blur, 0, { 1: shafts, 2: this.#sampler });
		for (let i = 0; i < BLUR_PASSES; i++) {
			passes.push({
				label: 'light shaft blur',
				pipeline: p.blur,
				groups: [
					blurShared,
					autoBindGroup(device, p.blur, 1, { 2: { buffer: this.#passUniforms[i] }, 3: views[i % 2] }),
				],
				targets: [views[(i + 1) % 2]],
			});
		}
		const apply: FullscreenPass = {
			label: 'light shaft apply',
			pipeline: p.apply,
			groups: [
				autoBindGroup(device, p.apply, 0, { 2: this.#sampler }),
				autoBindGroup(device, p.apply, 1, { 3: views[BLUR_PASSES % 2] }),
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
