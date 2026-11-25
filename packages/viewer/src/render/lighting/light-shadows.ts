import type { PipelineCache } from '../../gfx/pipeline-cache.ts';
import { SHADOW_FORMAT } from '../shadows/shadow-map.ts';

import clearSource from './light-shadow-clear.wgsl?raw';
import { ATLAS_SIZE, ShadowTiles } from './shadow-tiles.ts';

const CLEAR_KEY = 'light shadow clear';

/** the local lights' shadow atlas, with the tiles {@link ShadowTiles} hands out, and the pass that draws one */
export class LightShadows extends ShadowTiles {
	readonly texture: GPUTexture;
	/** the atlas, sampled and drawn into */
	readonly view: GPUTextureView;
	readonly #pipelines: PipelineCache;

	/**
	 * @param device the device
	 * @param pipelines the pipeline cache
	 */
	constructor(device: GPUDevice, pipelines: PipelineCache) {
		super();
		this.#pipelines = pipelines;
		this.texture = device.createTexture({
			label: 'local light shadows',
			size: [ATLAS_SIZE, ATLAS_SIZE],
			format: SHADOW_FORMAT,
			usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
		});
		this.view = this.texture.createView();
		const module = pipelines.module('light shadow clear', clearSource);
		void pipelines.prepare(CLEAR_KEY, () => ({
			label: 'light shadow clear',
			layout: 'auto',
			vertex: { module, entryPoint: 'vs_clear' },
			fragment: { module, entryPoint: 'fs_clear', targets: [] },
			depthStencil: { format: SHADOW_FORMAT, depthWriteEnabled: true, depthCompare: 'always' },
		}));
	}

	/** @returns bytes of the atlas */
	get bytes(): number {
		return ATLAS_SIZE * ATLAS_SIZE * 4;
	}

	/**
	 * draws {@link request}'s tile: clears it, then lets `draw` encode the casters
	 *
	 * @param encoder this frame's encoder
	 * @param bind binds the pass's frame group, whose view-projection is the request's
	 * @param draw encodes the casters into the pass and returns its draws
	 * @returns the draws encoded
	 */
	encode(
		encoder: GPUCommandEncoder,
		bind: (pass: GPURenderPassEncoder) => void,
		draw: (pass: GPURenderPassEncoder) => number,
	): number {
		const request = this.request;
		const clear = this.#pipelines.get(CLEAR_KEY);
		if (request === null || clear === undefined) {
			return 0;
		}
		const pass = encoder.beginRenderPass({
			label: 'local light shadow',
			colorAttachments: [],
			depthStencilAttachment: { view: this.view, depthLoadOp: 'load', depthStoreOp: 'store' },
		});
		const { x, y, size } = request;
		pass.setViewport(x, y, size, size, 0, 1);
		pass.setScissorRect(x, y, size, size);
		pass.setPipeline(clear);
		pass.draw(3);
		bind(pass);
		const draws = draw(pass);
		pass.end();
		return draws + 1;
	}

	/** frees the atlas */
	destroy(): void {
		this.texture.destroy();
	}
}
