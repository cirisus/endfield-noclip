import {
	type FullscreenPass,
	type FullscreenPipeline,
	autoBindGroup,
	encodeFullscreen,
	fullscreenPipeline,
} from '../../gfx/fullscreen-pass.ts';
import type { PipelineCache } from '../../gfx/pipeline-cache.ts';
import { placeholder } from '../../gfx/placeholders.ts';
import { LINEAR_REPEAT, sampler } from '../../gfx/samplers.ts';
import { HDR_FORMAT, type SceneTextures } from '../frame/render-targets.ts';
import { SkyBinding } from '../sky/atmosphere-luts.ts';
import atmosphereWgsl from '../sky/atmosphere.wgsl?raw';
import { fogSource } from '../sky/fog-source.ts';
import skyWgsl from '../sky/sky.wgsl?raw';
import type { TextureBinding } from '../textures/texture-store.ts';

import compositeWgsl from './composite.wgsl?raw';
import { postShaderModule } from './shader-source.ts';

/**
 * the composite (composite.wgsl): resolves the main pass into the scene at the render size, with the
 * reflections, AO, sky, celestial layers and fogs
 */
export class Composite {
	#device: GPUDevice;
	#pipeline: FullscreenPipeline;
	#skyInputs: {
		postUniforms: GPUBuffer;
		sampler: GPUSampler;
		skyView: GPUTextureView;
		froxels: GPUTextureView;
	};
	/** groups 0 (uniforms) and 1 (the sky-view LUT and the volumetric fog), built once pipeline compiles */
	#skyGroups: [GPUBindGroup, GPUBindGroup] | null = null;
	#pass: FullscreenPass | null = null;
	/** the height fog's flow noise and the repeating sampler the game reads it with */
	#flowNoiseGroup: GPUBindGroup | null = null;
	#flowNoise: TextureBinding;
	#noFlowNoise: TextureBinding;
	#repeatSampler: GPUSampler;

	/**
	 * @param device the device
	 * @param pipelines the pipeline cache
	 * @param input the post chain's `Post` uniforms, the bilinear clamping sampler, the sky-view LUT and the
	 *   volumetric fog
	 */
	constructor(
		device: GPUDevice,
		pipelines: PipelineCache,
		input: { postUniforms: GPUBuffer; sampler: GPUSampler; skyView: GPUTextureView; froxels: GPUTextureView },
	) {
		this.#device = device;
		this.#skyInputs = input;
		this.#pipeline = fullscreenPipeline(pipelines, {
			label: 'composite',
			module: postShaderModule(device, 'composite', [
				atmosphereWgsl,
				fogSource({ group: 1, binding: SkyBinding.froxels }),
				skyWgsl,
				compositeWgsl,
			]),
			entryPoint: 'fs_composite',
			targets: [{ format: HDR_FORMAT }],
		});
		this.#repeatSampler = sampler(device, LINEAR_REPEAT);
		this.#noFlowNoise = {
			view: placeholder(device, 'black', '3d'),
			sampler: this.#repeatSampler,
			version: -1,
		};
		this.#flowNoise = this.#noFlowNoise;
	}

	#ensureSkyGroups(compiled: GPURenderPipeline): [GPUBindGroup, GPUBindGroup] {
		this.#skyGroups ??= [
			autoBindGroup(this.#device, compiled, 0, { 0: { buffer: this.#skyInputs.postUniforms } }),
			autoBindGroup(this.#device, compiled, 1, {
				[SkyBinding.skyView]: this.#skyInputs.skyView,
				[SkyBinding.sampler]: this.#skyInputs.sampler,
				[SkyBinding.froxels]: this.#skyInputs.froxels,
			}),
		];
		return this.#skyGroups;
	}

	#ensureFlowNoiseGroup(compiled: GPURenderPipeline): GPUBindGroup {
		this.#flowNoiseGroup ??= autoBindGroup(this.#device, compiled, 3, {
			0: this.#flowNoise.view,
			1: this.#repeatSampler,
		});
		return this.#flowNoiseGroup;
	}

	/** @returns whether the flow noise is bound */
	get hasFlowNoise(): boolean {
		return this.#flowNoise !== this.#noFlowNoise;
	}

	/**
	 * binds the height fog's flow noise, once it streams in.
	 *
	 * @param noise the 3D texture's binding, or `null` for none
	 */
	setFlowNoise(noise: TextureBinding | null): void {
		const next = noise ?? this.#noFlowNoise;
		if (next !== this.#flowNoise) {
			this.#flowNoise = next;
			this.#flowNoiseGroup = null;
			if (this.#pass !== null) {
				this.#pass.groups = undefined;
			}
		}
	}

	/**
	 * rebinds the inputs after they were recreated.
	 *
	 * @param input the deferred-lit scene (`scene.lit`, holding celestial layers on sky pixels and lit radiance
	 *   on surface pixels), main-pass depth, and the composited target
	 */
	resize(input: { scene: SceneTextures; target: GPUTextureView }): void {
		const { scene, target } = input;
		let sceneGroup: GPUBindGroup | null = null;
		this.#pass = {
			label: 'composite',
			pipeline: this.#pipeline,
			bind: (compiled) => [
				...this.#ensureSkyGroups(compiled),
				(sceneGroup ??= autoBindGroup(this.#device, compiled, 2, {
					0: scene.lit,
					1: scene.depth,
				})),
				this.#ensureFlowNoiseGroup(compiled),
			],
			targets: [target],
		};
	}

	/** @param encoder this frame's encoder, after the reflections and celestial layers */
	encode(encoder: GPUCommandEncoder): void {
		const pass = this.#pass;
		if (pass === null) {
			throw new Error('composite used before resize()');
		}
		encodeFullscreen(encoder, pass);
	}
}
