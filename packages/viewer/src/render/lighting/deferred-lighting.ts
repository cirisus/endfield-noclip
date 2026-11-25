import { LINEAR_CLAMP, sampler } from '../../gfx/samplers.ts';
import { FRAME_WGSL } from '../frame/frame-uniforms.ts';
import { HDR_FORMAT, type SceneTextures } from '../frame/render-targets.ts';
import { postCommonSource } from '../post/shader-source.ts';

import deferredLightingWgsl from './deferred-lighting.wgsl?raw';

/**
 * deferred lighting pass (deferred-lighting.wgsl): unpacks the G-buffer and writes lit HDR radiance into
 * `scene.lit` with `loadOp: 'load'`, leaving the celestial pass's sky pixels intact
 */
export class DeferredLighting {
	#device: GPUDevice;
	#pipeline: GPURenderPipeline;
	#postGroup: GPUBindGroup;
	#inputsLayout: GPUBindGroupLayout;
	#sampler: GPUSampler;
	#sized: { inputs: GPUBindGroup; target: GPUTextureView } | null = null;

	/**
	 * @param device the device
	 * @param layouts group 0 (`frame`) and group 1 (`post` uniforms) layouts
	 * @param postUniforms the post chain's `Post` uniforms buffer
	 */
	constructor(
		device: GPUDevice,
		layouts: { frame: GPUBindGroupLayout; postUniforms: GPUBindGroupLayout },
		postUniforms: GPUBuffer,
	) {
		this.#device = device;
		this.#sampler = sampler(device, LINEAR_CLAMP);
		const frag = GPUShaderStage.FRAGMENT;
		const tex = (binding: number, sampleType: GPUTextureSampleType = 'float'): GPUBindGroupLayoutEntry => ({
			binding,
			visibility: frag,
			texture: { sampleType },
		});
		this.#inputsLayout = device.createBindGroupLayout({
			label: 'deferred lighting inputs',
			entries: [
				tex(0),
				tex(1),
				tex(2),
				tex(3),
				tex(4, 'depth'),
				tex(5),
				tex(6),
				tex(7),
				{ binding: 8, visibility: frag, sampler: { type: 'filtering' } },
			],
		});
		const module = device.createShaderModule({
			label: 'deferred lighting',
			code: [FRAME_WGSL, postCommonSource(1, 0), deferredLightingWgsl].join('\n'),
		});
		this.#pipeline = device.createRenderPipeline({
			label: 'deferred lighting',
			layout: device.createPipelineLayout({
				label: 'deferred lighting',
				bindGroupLayouts: [layouts.frame, layouts.postUniforms, this.#inputsLayout],
			}),
			vertex: { module, entryPoint: 'vs_fullscreen' },
			fragment: { module, entryPoint: 'fs_deferred_lighting', targets: [{ format: HDR_FORMAT }] },
			primitive: { topology: 'triangle-list' },
		});
		this.#postGroup = device.createBindGroup({
			label: 'deferred lighting post',
			layout: layouts.postUniforms,
			entries: [{ binding: 0, resource: { buffer: postUniforms } }],
		});
	}

	/**
	 * rebinds the G-buffer, AO, SSR and wetness mask after a resize.
	 *
	 * @param input the main pass's G-buffer, blurred AO and resolved SSR
	 */
	resize(input: { scene: SceneTextures; ao: GPUTextureView; reflections: GPUTextureView }): void {
		const { scene } = input;
		this.#sized = {
			target: scene.lit,
			inputs: this.#device.createBindGroup({
				label: 'deferred lighting inputs',
				layout: this.#inputsLayout,
				entries: [
					{ binding: 0, resource: scene.emission },
					{ binding: 1, resource: scene.gbufferA },
					{ binding: 2, resource: scene.gbufferB },
					{ binding: 3, resource: scene.gbufferC },
					{ binding: 4, resource: scene.depth },
					{ binding: 5, resource: input.ao },
					{ binding: 6, resource: input.reflections },
					{ binding: 7, resource: scene.wetnessMask },
					{ binding: 8, resource: this.#sampler },
				],
			}),
		};
	}

	/**
	 * encodes the deferred lighting pass into `scene.lit`, preserving sky pixels written by the celestial pass.
	 *
	 * @param encoder this frame's encoder
	 * @param frameGroup group 0 (`frame`) and its dynamic uniform offset
	 */
	encode(encoder: GPUCommandEncoder, frameGroup: { group: GPUBindGroup; offset: number }): void {
		const sized = this.#sized;
		if (sized === null) {
			throw new Error('deferred lighting used before resize()');
		}
		const pass = encoder.beginRenderPass({
			label: 'deferred lighting',
			colorAttachments: [{ view: sized.target, loadOp: 'load', storeOp: 'store' }],
		});
		pass.setPipeline(this.#pipeline);
		pass.setBindGroup(0, frameGroup.group, [frameGroup.offset]);
		pass.setBindGroup(1, this.#postGroup);
		pass.setBindGroup(2, sized.inputs);
		pass.draw(3);
		pass.end();
	}
}
