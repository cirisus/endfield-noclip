/** shader labels and pipeline keys identify immutable descriptors for the lifetime of the cache */
export class PipelineCache {
	#device: GPUDevice;
	#modules = new Map<string, GPUShaderModule>();
	#render = new Compiled<GPURenderPipeline>();
	#compute = new Compiled<GPUComputePipeline>();

	/** @param device the device */
	constructor(device: GPUDevice) {
		this.#device = device;
	}

	/**
	 * @param label module label, also the cache key
	 * @param code WGSL source
	 * @returns the compiled module
	 */
	module(label: string, code: string): GPUShaderModule {
		return this.#modules.getOrInsertComputed(label, () => this.#device.createShaderModule({ label, code }));
	}

	/**
	 * concurrent requests for a key share one compilation; a rejected compilation remains cached.
	 *
	 * @param key unique key of the pipeline's state, e.g. `terrain/fill`
	 * @param describe builds the descriptor; only called on a miss
	 * @returns the pipeline
	 */
	prepare(key: string, describe: () => GPURenderPipelineDescriptor): Promise<GPURenderPipeline> {
		return this.#render.prepare(key, () =>
			this.#device.createRenderPipelineAsync({ label: key, ...describe() }),
		);
	}

	/**
	 * {@link prepare} for a compute pipeline.
	 *
	 * @param key unique key of the pipeline's state, e.g. `volumetric fog`
	 * @param describe builds the descriptor; only called on a miss
	 * @returns the pipeline
	 */
	prepareCompute(key: string, describe: () => GPUComputePipelineDescriptor): Promise<GPUComputePipeline> {
		return this.#compute.prepare(key, () =>
			this.#device.createComputePipelineAsync({ label: key, ...describe() }),
		);
	}

	/**
	 * @param key a key passed to {@link prepare}
	 * @returns the pipeline, or `undefined` while it compiles
	 */
	get(key: string): GPURenderPipeline | undefined {
		return this.#render.ready.get(key);
	}

	/**
	 * @param key a key passed to {@link prepareCompute}
	 * @returns the pipeline, or `undefined` while it compiles
	 */
	getCompute(key: string): GPUComputePipeline | undefined {
		return this.#compute.ready.get(key);
	}

	/** @returns how many pipelines are still compiling */
	get compiling(): number {
		return this.#render.pending.size + this.#compute.pending.size;
	}

	/** @returns compiled pipeline count */
	get size(): number {
		return this.#render.ready.size + this.#compute.ready.size;
	}
}

/** one kind of pipeline: those compiled, and those compiling */
class Compiled<P> {
	readonly ready = new Map<string, P>();
	readonly pending = new Map<string, Promise<P>>();

	prepare(key: string, compile: () => Promise<P>): Promise<P> {
		const pipeline = this.ready.get(key);
		if (pipeline !== undefined) {
			return Promise.resolve(pipeline);
		}
		return this.pending.getOrInsertComputed(key, () =>
			compile().then((compiled) => {
				this.ready.set(key, compiled);
				this.pending.delete(key);
				return compiled;
			}),
		);
	}
}
