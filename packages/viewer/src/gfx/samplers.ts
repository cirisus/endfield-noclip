/**
 * samplers shared across a device: passes and textures that sample the same way get one `GPUSampler`, keyed
 * by their descriptor with WebGPU's defaults filled in, so `{ magFilter: 'linear' }` and the same with
 * explicit `clamp-to-edge` address modes are one sampler
 *
 * @module
 */

/** bilinear, clamping to the edge (WebGPU's default address mode), without mips: render targets */
export const LINEAR_CLAMP: GPUSamplerDescriptor = { magFilter: 'linear', minFilter: 'linear' };

/** bilinear, clamping to the edge, trilinear across mips */
export const LINEAR_CLAMP_MIPMAPPED: GPUSamplerDescriptor = { ...LINEAR_CLAMP, mipmapFilter: 'linear' };

/** bilinear, repeating on every axis, without mips: tiling noise and wrapping volumes */
export const LINEAR_REPEAT: GPUSamplerDescriptor = {
	magFilter: 'linear',
	minFilter: 'linear',
	addressModeU: 'repeat',
	addressModeV: 'repeat',
	addressModeW: 'repeat',
};

/** trilinear, repeating: tiling material textures; spread with a `maxAnisotropy` for surfaces seen edge-on */
export const LINEAR_REPEAT_MIPMAPPED: GPUSamplerDescriptor = { ...LINEAR_REPEAT, mipmapFilter: 'linear' };

/** nearest texel and mip, repeating */
export const NEAREST_REPEAT: GPUSamplerDescriptor = {
	addressModeU: 'repeat',
	addressModeV: 'repeat',
	addressModeW: 'repeat',
};

const caches = new WeakMap<GPUDevice, Map<string, GPUSampler>>();

/**
 * @param device the device
 * @param descriptor the sampler's state; its label is ignored, since the sampler is shared
 * @returns the device's sampler for that state, created on first use and never destroyed (samplers hold no
 *   memory worth freeing)
 */
export const sampler = (device: GPUDevice, descriptor: GPUSamplerDescriptor): GPUSampler => {
	const state = {
		addressModeU: descriptor.addressModeU ?? 'clamp-to-edge',
		addressModeV: descriptor.addressModeV ?? 'clamp-to-edge',
		addressModeW: descriptor.addressModeW ?? 'clamp-to-edge',
		magFilter: descriptor.magFilter ?? 'nearest',
		minFilter: descriptor.minFilter ?? 'nearest',
		mipmapFilter: descriptor.mipmapFilter ?? 'nearest',
		lodMinClamp: descriptor.lodMinClamp ?? 0,
		lodMaxClamp: descriptor.lodMaxClamp ?? 32,
		compare: descriptor.compare,
		maxAnisotropy: descriptor.maxAnisotropy ?? 1,
	};
	const key = JSON.stringify(state);
	return caches
		.getOrInsertComputed(device, () => new Map())
		.getOrInsertComputed(key, () => device.createSampler({ ...state, label: 'sampler ' + key }));
};
