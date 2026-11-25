/**
 * fullscreen passes: one triangle covering the targets, drawn by a pipeline with an `auto` layout whose
 * vertex stage is `vs_fullscreen` (post-common.wgsl)
 *
 * @module
 */

import type { PipelineCache } from './pipeline-cache.ts';

/** an asynchronously compiled fullscreen pipeline */
export interface FullscreenPipeline {
	readonly key: string;
	/** @returns the compiled pipeline, or `undefined` while it compiles */
	get(): GPURenderPipeline | undefined;
}

/** a fullscreen draw into one or more targets, with its groups bound from 0 */
export interface FullscreenPass {
	/** the render pass's label, which the GPU profiler reports it under */
	label: string;
	pipeline: FullscreenPipeline;
	/**
	 * builds the pass's bind groups once `pipeline` is compiled; memoized onto {@link groups} by
	 * {@link encodeFullscreen} so bind groups are created once per pass
	 */
	bind(pipeline: GPURenderPipeline): GPUBindGroup[];
	targets: GPUTextureView[];
	/** cached bind groups once {@link bind} has run */
	groups?: GPUBindGroup[];
}

/**
 * prepares an asynchronous fullscreen render pipeline with an `auto` layout via {@link PipelineCache}
 *
 * @param pipelines the pipeline cache
 * @param descriptor the pipeline's label (also its cache key), its module (which has `vs_fullscreen`), the
 *   fragment entry point, and its targets
 * @returns a handle whose `get()` returns the compiled pipeline once ready
 */
export const fullscreenPipeline = (
	pipelines: PipelineCache,
	descriptor: {
		label: string;
		module: GPUShaderModule;
		entryPoint: string;
		targets: GPUColorTargetState[];
	},
): FullscreenPipeline => {
	const { label, module, entryPoint, targets } = descriptor;
	void pipelines.prepare(label, () => ({
		layout: 'auto',
		vertex: { module, entryPoint: 'vs_fullscreen' },
		fragment: { module, entryPoint, targets },
		primitive: { topology: 'triangle-list' },
	}));
	return {
		key: label,
		get: () => pipelines.get(label),
	};
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
 * encodes the pass in a render pass of its own, skipping while its pipeline is still compiling.
 *
 * @param encoder the encoder
 * @param pass the pass
 * @param loadOp `clear` clears the targets to transparent black first; `load` draws over them, for passes
 *   that blend onto their target
 * @returns whether the pass was encoded (`false` while the pipeline is still compiling)
 */
export const encodeFullscreen = (
	encoder: GPUCommandEncoder,
	pass: FullscreenPass,
	loadOp: GPULoadOp = 'clear',
): boolean => {
	const pipeline = pass.pipeline.get();
	if (pipeline === undefined) {
		return false;
	}
	const groups = (pass.groups ??= pass.bind(pipeline));
	const render = encoder.beginRenderPass({
		label: pass.label,
		colorAttachments: pass.targets.map((view) => ({
			view,
			loadOp,
			storeOp: 'store',
			clearValue: [0, 0, 0, 0],
		})),
	});
	render.setPipeline(pipeline);
	for (const [i, group] of groups.entries()) {
		render.setBindGroup(i, group);
	}
	render.draw(3);
	render.end();
	return true;
};
