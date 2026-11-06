import { autoBindGroup, encodeFullscreen, fullscreenPipeline } from '../../gfx/fullscreen-pass.ts';
import colorWgsl from '../shaders/common/color.wgsl?raw';

import { postShaderModule } from './shader-source.ts';
import tonemapWgsl from './tonemap.wgsl?raw';

/** the final pass (tonemap.wgsl): exposure, bloom, vignette, grading and tonemapping into the swapchain */
export class Tonemap {
	#device: GPUDevice;
	#sampler: GPUSampler;
	#pipeline: GPURenderPipeline;
	#postGroup: GPUBindGroup;
	/** group 1 reading each temporal history */
	#groups: [GPUBindGroup, GPUBindGroup] | null = null;

	/**
	 * @param device the device
	 * @param postUniforms the post chain's `Post` uniforms
	 * @param sampler the bilinear clamping sampler the bloom is read with
	 * @param swapchainFormat the canvas format
	 */
	constructor(
		device: GPUDevice,
		postUniforms: GPUBuffer,
		sampler: GPUSampler,
		swapchainFormat: GPUTextureFormat,
	) {
		this.#device = device;
		this.#sampler = sampler;
		this.#pipeline = fullscreenPipeline(device, {
			label: 'tonemap',
			module: postShaderModule(device, 'tonemap', [colorWgsl, tonemapWgsl]),
			entryPoint: 'fs_tonemap',
			targets: [{ format: swapchainFormat }],
		});
		this.#postGroup = autoBindGroup(device, this.#pipeline, 0, { 0: { buffer: postUniforms } });
	}

	/**
	 * rebinds the inputs after they were recreated.
	 *
	 * @param input the temporal histories, and the bloom (`null` without any)
	 */
	resize(input: { histories: readonly GPUTexture[]; bloom: GPUTexture | null }): void {
		const group = (history: GPUTexture): GPUBindGroup =>
			autoBindGroup(this.#device, this.#pipeline, 1, {
				0: history.createView(),
				1: (input.bloom ?? history).createView(),
				2: this.#sampler,
			});
		this.#groups = [group(input.histories[0]), group(input.histories[1])];
	}

	/**
	 * @param encoder this frame's encoder, after the bloom
	 * @param input the swapchain's current view and which history this frame's resolve wrote
	 */
	encode(encoder: GPUCommandEncoder, input: { swapchain: GPUTextureView; history: number }): void {
		if (this.#groups === null) {
			throw new Error('tonemap used before resize()');
		}
		encodeFullscreen(encoder, {
			label: 'tonemap',
			pipeline: this.#pipeline,
			groups: [this.#postGroup, this.#groups[input.history]],
			targets: [input.swapchain],
		});
	}
}
