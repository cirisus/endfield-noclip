/** a uniform block allocated for this frame */
export interface UniformAllocation {
	/** dynamic offset to bind */
	offset: number;
	f32: Float32Array;
	u32: Uint32Array;
}

/**
 * frame-local staging views backed by a rotating GPU buffer. call {@link beginFrame}, fill allocations, then
 * {@link flush} before submitting draws. staging views are reused on the next frame.
 */
export class UniformRing {
	readonly buffer: GPUBuffer;
	#device: GPUDevice;
	#staging: ArrayBuffer;
	#alignment: number;
	#regionSize: number;
	#regions: number;
	#region = 0;
	#cursor = 0;

	/**
	 * @param device the device
	 * @param regionSize bytes available per frame
	 * @param regions frames in flight the ring rotates through
	 */
	constructor(device: GPUDevice, regionSize: number, regions: number) {
		this.#device = device;
		this.#alignment = device.limits.minUniformBufferOffsetAlignment;
		this.#regionSize = Math.ceil(regionSize / this.#alignment) * this.#alignment;
		this.#regions = regions;
		this.#staging = new ArrayBuffer(this.#regionSize);
		this.buffer = device.createBuffer({
			label: 'uniform ring',
			size: this.#regionSize * regions,
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
		});
	}

	/** invalidates previous staging allocations; flush them before advancing */
	beginFrame(): void {
		this.#region = (this.#region + 1) % this.#regions;
		this.#cursor = 0;
	}

	/**
	 * @param size bytes needed
	 * @returns views over a fresh zeroed block and its dynamic offset
	 * @throws {RangeError} when the frame's region is exhausted
	 */
	allocate(size: number): UniformAllocation {
		const at = this.#cursor;
		const end = at + Math.ceil(size / this.#alignment) * this.#alignment;
		if (end > this.#regionSize) {
			throw new RangeError('uniform ring region exhausted');
		}
		this.#cursor = end;
		const f32 = new Float32Array(this.#staging, at, size / 4);
		f32.fill(0);
		return {
			offset: this.#region * this.#regionSize + at,
			f32,
			u32: new Uint32Array(this.#staging, at, size / 4),
		};
	}

	/** @returns bytes of the rotating uniform buffer */
	get bytes(): number {
		return this.buffer.size;
	}

	/** uploads staged allocations; call after filling their views and before submitting draws */
	flush(): void {
		if (this.#cursor > 0) {
			this.#device.queue.writeBuffer(
				this.buffer,
				this.#region * this.#regionSize,
				this.#staging,
				0,
				this.#cursor,
			);
		}
	}

	/** frees the GPU buffer */
	destroy(): void {
		this.buffer.destroy();
	}
}
