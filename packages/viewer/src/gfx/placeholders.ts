/**
 * 1×1 textures shared across a device, bound where a texture is missing: transparent black (all zero) for
 * inputs that add or mask, opaque white for ones that multiply
 *
 * @module
 */

export type PlaceholderColor = 'black' | 'white';
export type PlaceholderDimension = '2d' | '2d-array' | 'cube' | '3d';

interface Placeholder {
	texture: GPUTexture;
	view: GPUTextureView;
}

const sets = new WeakMap<GPUDevice, Map<string, Placeholder>>();

/**
 * @param device the device
 * @param color `black` (0, 0, 0, 0) or `white` (1, 1, 1, 1)
 * @param dimension the view dimension it's bound as (a cube has six layers)
 * @returns a view of the device's `rgba8unorm` placeholder of that colour and dimension, created on first
 *   use; the same view on every call, so comparing a binding against it tells whether a texture is bound
 */
export const placeholder = (
	device: GPUDevice,
	color: PlaceholderColor,
	dimension: PlaceholderDimension,
): GPUTextureView =>
	sets
		.getOrInsertComputed(device, () => new Map())
		.getOrInsertComputed(color + ' ' + dimension, () => {
			const layers = dimension === 'cube' ? 6 : 1;
			const texture = device.createTexture({
				label: 'placeholder ' + color + ' ' + dimension,
				size: [1, 1, layers],
				dimension: dimension === '3d' ? '3d' : '2d',
				format: 'rgba8unorm',
				usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
			});
			if (color === 'white') {
				device.queue.writeTexture(
					{ texture },
					new Uint8Array(4 * layers).fill(255),
					{ bytesPerRow: 4, rowsPerImage: 1 },
					[1, 1, layers],
				);
			}
			return { texture, view: texture.createView({ dimension }) };
		}).view;

/**
 * destroys the device's placeholders; views handed out before can't be used after, and later calls to
 * {@link placeholder} create new ones.
 *
 * @param device the device
 */
export const destroyPlaceholders = (device: GPUDevice): void => {
	for (const { texture } of sets.get(device)?.values() ?? []) {
		texture.destroy();
	}
	sets.delete(device);
};
