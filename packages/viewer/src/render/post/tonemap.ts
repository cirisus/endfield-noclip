import {
	type FullscreenPass,
	type FullscreenPipeline,
	autoBindGroup,
	encodeFullscreen,
	fullscreenPipeline,
} from '../../gfx/fullscreen-pass.ts';
import type { PipelineCache } from '../../gfx/pipeline-cache.ts';
import colorWgsl from '../shaders/common/color.wgsl?raw';

import { postShaderModule } from './shader-source.ts';
import tonemapWgsl from './tonemap.wgsl?raw';

/** the final pass (tonemap.wgsl): exposure, bloom, vignette, grading and tonemapping into the swapchain */
export class Tonemap {
	#device: GPUDevice;
	#postUniforms: GPUBuffer;
	#sampler: GPUSampler;
	#pipeline: FullscreenPipeline;
	#postGroup: GPUBindGroup | null = null;
	/** per temporal history: the pass reading it */
	#passes: [FullscreenPass, FullscreenPass] | null = null;

	/**
	 * @param device the device
	 * @param pipelines the pipeline cache
	 * @param postUniforms the post chain's `Post` uniforms
	 * @param sampler the bilinear clamping sampler the bloom is read with
	 * @param swapchainFormat the canvas format
	 */
	constructor(
		device: GPUDevice,
		pipelines: PipelineCache,
		postUniforms: GPUBuffer,
		sampler: GPUSampler,
		swapchainFormat: GPUTextureFormat,
	) {
		this.#device = device;
		this.#postUniforms = postUniforms;
		this.#sampler = sampler;
		this.#pipeline = fullscreenPipeline(pipelines, {
			label: 'tonemap',
			module: postShaderModule(device, 'tonemap', [colorWgsl, tonemapWgsl]),
			entryPoint: 'fs_tonemap',
			targets: [{ format: swapchainFormat }],
		});
	}

	/**
	 * rebinds the inputs after they were recreated.
	 *
	 * @param input the temporal histories, and the bloom (`null` without any)
	 */
	resize(input: { histories: readonly GPUTexture[]; bloom: GPUTexture | null }): void {
		const makePass = (history: GPUTexture): FullscreenPass => {
			const historyView = history.createView();
			const bloomView = (input.bloom ?? history).createView();
			return {
				label: 'tonemap',
				pipeline: this.#pipeline,
				bind: (compiled) => [
					(this.#postGroup ??= autoBindGroup(this.#device, compiled, 0, {
						0: { buffer: this.#postUniforms },
					})),
					autoBindGroup(this.#device, compiled, 1, {
						0: historyView,
						1: bloomView,
						2: this.#sampler,
					}),
				],
				targets: [],
			};
		};
		this.#passes = [makePass(input.histories[0]), makePass(input.histories[1])];
	}

	/**
	 * @param encoder this frame's encoder, after the bloom
	 * @param input the swapchain's current view and which history this frame's resolve wrote
	 */
	encode(encoder: GPUCommandEncoder, input: { swapchain: GPUTextureView; history: number }): void {
		if (this.#passes === null) {
			throw new Error('tonemap used before resize()');
		}
		const pass = this.#passes[input.history];
		pass.targets[0] = input.swapchain;
		encodeFullscreen(encoder, pass);
	}
}
