import type { ResidentGeometry } from '../../streaming/resident.ts';

import type { VertexStreams } from './draw-ranges.ts';

/** a geometry's quantized positions, at location 0 */
export const POSITION_STREAM: GPUVertexBufferLayout = {
	arrayStride: 8,
	attributes: [{ shaderLocation: 0, offset: 0, format: 'unorm16x4' }],
};

/** a geometry's octahedral normals, at location 1 */
export const NORMAL_STREAM: GPUVertexBufferLayout = {
	arrayStride: 4,
	attributes: [{ shaderLocation: 1, offset: 0, format: 'snorm16x2' }],
};

/** bytes per vertex of the zero buffer bound in place of missing streams (the widest are float UVs) */
const ZERO_STRIDE = 8;
/** vertices the zero buffer starts with */
const INITIAL_ZERO_VERTICES = 65_536;

/**
 * binds geometries' vertex streams in a pass, skipping a buffer already bound at the same offset, and owns
 * the zeros bound in place of streams a geometry lacks
 */
export class VertexBindings {
	#device: GPUDevice;
	#zeros: GPUBuffer;
	// one per vertex buffer slot of the widest layout
	#buffers: (GPUBuffer | null)[] = [null, null, null, null, null, null];
	#offsets: number[] = [0, 0, 0, 0, 0, 0];

	/** @param device the device */
	constructor(device: GPUDevice) {
		this.#device = device;
		this.#zeros = this.#zeroBuffer(ZERO_STRIDE * INITIAL_ZERO_VERTICES);
	}

	#zeroBuffer(size: number): GPUBuffer {
		return this.#device.createBuffer({ label: 'zero streams', size, usage: GPUBufferUsage.VERTEX });
	}

	/** @returns bytes of the zero buffer */
	get bytes(): number {
		return this.#zeros.size;
	}

	/**
	 * grows the zeros to cover a geometry that lacks a stream
	 *
	 * @param vertexCount the geometry's vertices
	 */
	fitZeros(vertexCount: number): void {
		if (vertexCount * ZERO_STRIDE > this.#zeros.size) {
			this.#zeros.destroy();
			this.#zeros = this.#zeroBuffer(vertexCount * ZERO_STRIDE);
		}
	}

	/** forgets what's bound (at the start of each encode, since other families bind in between) */
	reset(): void {
		this.#buffers.fill(null);
	}

	/**
	 * binds a geometry's vertex streams in the slots a phase's pipelines read, zeros where it lacks one
	 *
	 * @param pass the pass
	 * @param geometry the geometry
	 * @param streams the streams the phase reads
	 */
	bindStreams(pass: GPURenderPassEncoder, geometry: ResidentGeometry, streams: VertexStreams): void {
		this.#set(pass, 0, geometry.vertices, 0, geometry.positionBytes);
		switch (streams) {
			case 'position': {
				break;
			}
			case 'uv': {
				this.#stream(pass, 1, geometry.vertices, geometry.uv0Offset);
				this.#stream(pass, 2, geometry.vertices, geometry.uv1Offset);
				break;
			}
			case 'all': {
				this.#stream(pass, 1, geometry.vertices, geometry.normalOffset);
				this.#stream(pass, 2, geometry.vertices, geometry.uv0Offset);
				this.#stream(pass, 3, geometry.vertices, geometry.uv1Offset);
				this.#stream(pass, 4, geometry.vertices, geometry.tangentOffset);
				this.#stream(pass, 5, geometry.vertices, geometry.colorOffset);
				break;
			}
		}
	}

	/** destroys the zero buffer */
	destroy(): void {
		this.#zeros.destroy();
	}

	#set(pass: GPURenderPassEncoder, slot: number, buffer: GPUBuffer, offset: number, size?: number): void {
		if (this.#buffers[slot] === buffer && this.#offsets[slot] === offset && size === undefined) {
			return;
		}
		pass.setVertexBuffer(slot, buffer, offset, size);
		// a sized binding isn't remembered: the next geometry's positions always rebind
		this.#buffers[slot] = size === undefined ? buffer : null;
		this.#offsets[slot] = offset;
	}

	/** binds a stream of `vertices` at `offset`, or the zeros where the geometry lacks it (`null`) */
	#stream(pass: GPURenderPassEncoder, slot: number, vertices: GPUBuffer, offset: number | null): void {
		if (offset === null) {
			this.#set(pass, slot, this.#zeros, 0);
		} else {
			this.#set(pass, slot, vertices, offset);
		}
	}
}
