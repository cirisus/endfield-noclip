/**
 * buffer creation shorthands, and a writer for uniform blocks laid out as vec4 rows
 *
 * @module
 */

/**
 * @param device the device
 * @param label the buffer's label
 * @param size bytes
 * @returns a `UNIFORM | COPY_DST` buffer, for uniforms written with `queue.writeBuffer`
 */
export const createUniformBuffer = (device: GPUDevice, label: string, size: number): GPUBuffer =>
	device.createBuffer({ label, size, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

/**
 * @param device the device
 * @param descriptor the buffer's label and usage (add `COPY_DST` to write it again later), the bytes it
 *   starts with, and the fewest bytes it may have (4 by default), for bindings with a minimum size
 * @returns a buffer holding `data`, padded with zeros to a multiple of 4 bytes
 */
export const createBufferWithData = (
	device: GPUDevice,
	descriptor: {
		label: string;
		usage: GPUBufferUsageFlags;
		data: ArrayBuffer | ArrayBufferView;
		minSize?: number;
	},
): GPUBuffer => {
	const { label, usage, data, minSize = 4 } = descriptor;
	const bytes = ArrayBuffer.isView(data)
		? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
		: new Uint8Array(data);
	const buffer = device.createBuffer({
		label,
		size: Math.max(minSize, Math.ceil(bytes.byteLength / 4) * 4),
		usage,
		mappedAtCreation: true,
	});
	new Uint8Array(buffer.getMappedRange()).set(bytes);
	buffer.unmap();
	return buffer;
};

/**
 * @param data the block's floats
 * @returns a function that writes `values` into vec4 row `row` of `data` (floats `row · 4` on)
 */
export const rowWriter =
	(data: Float32Array) =>
	(row: number, values: ArrayLike<number>): void => {
		data.set(values, row * 4);
	};
