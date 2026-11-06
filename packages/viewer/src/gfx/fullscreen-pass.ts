/**
 * fullscreen passes: one triangle covering the targets, drawn by a pipeline with an `auto` layout whose
 * vertex stage is `vs_fullscreen` (post-common.wgsl)
 *
 * @module
 */

/** a fullscreen draw into one or more targets, with its groups bound from 0 */
export interface FullscreenPass {
	/** the render pass's label, which the GPU profiler reports it under */
	label: string;
	pipeline: GPURenderPipeline;
	groups: GPUBindGroup[];
	targets: GPUTextureView[];
}

/**
 * @param device the device
 * @param descriptor the pipeline's label, its module (which has `vs_fullscreen`), the fragment entry point
 *   and its targets
 * @returns the pipeline, with an `auto` layout
 */
export const fullscreenPipeline = (
	device: GPUDevice,
	descriptor: {
		label: string;
		module: GPUShaderModule;
		entryPoint: string;
		targets: GPUColorTargetState[];
	},
): GPURenderPipeline => {
	const { label, module, entryPoint, targets } = descriptor;
	return device.createRenderPipeline({
		label,
		layout: 'auto',
		vertex: { module, entryPoint: 'vs_fullscreen' },
		fragment: { module, entryPoint, targets },
		primitive: { topology: 'triangle-list' },
	});
};

/**
 * @param device the device
 * @param pipeline a pipeline with an `auto` layout
 * @param index the group's index
 * @param entries each binding's resource; an `auto` layout has exactly the bindings the stages use
 * @returns the group
 */
export const autoBindGroup = (
	device: GPUDevice,
	pipeline: GPURenderPipeline,
	index: number,
	entries: Record<number, GPUBindingResource>,
): GPUBindGroup =>
	device.createBindGroup({
		layout: pipeline.getBindGroupLayout(index),
		entries: Object.entries(entries).map(([binding, resource]) => ({ binding: Number(binding), resource })),
	});

/**
 * encodes the pass in a render pass of its own.
 *
 * @param encoder the encoder
 * @param pass the pass
 * @param loadOp `clear` clears the targets to transparent black first; `load` draws over them, for passes
 *   that blend onto their target
 */
export const encodeFullscreen = (
	encoder: GPUCommandEncoder,
	pass: FullscreenPass,
	loadOp: GPULoadOp = 'clear',
): void => {
	const render = encoder.beginRenderPass({
		label: pass.label,
		colorAttachments: pass.targets.map((view) => ({
			view,
			loadOp,
			storeOp: 'store',
			clearValue: [0, 0, 0, 0],
		})),
	});
	render.setPipeline(pass.pipeline);
	for (const [i, group] of pass.groups.entries()) {
		render.setBindGroup(i, group);
	}
	render.draw(3);
	render.end();
};
