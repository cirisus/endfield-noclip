import type { VignetteSettings } from '@endfield-noclip/package-format/environment';
import type { PhotoFilter, PhotoFilters } from '@endfield-noclip/package-format/photo-filters';
import { textureLevelLayout } from '@endfield-noclip/package-format/textures';

import { NEUTRAL_GRADING } from './color-grading.ts';
import type { EnvironmentInput } from './environment.ts';

const object = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === 'object' && !Array.isArray(value);

const matches = (template: unknown, value: unknown): boolean => {
	if (typeof template === 'number') {
		return typeof value === 'number' && Number.isFinite(value);
	}
	if (Array.isArray(template)) {
		return (
			Array.isArray(value) &&
			template.length === value.length &&
			template.every((v, i) => matches(v, value[i]))
		);
	}
	if (object(template)) {
		return object(value) && Object.entries(template).every(([key, v]) => matches(v, value[key]));
	}
	return typeof value === typeof template;
};

const VIGNETTE_DEFAULT: VignetteSettings = {
	mode: 0,
	color: [0, 0, 0, 1],
	center: [0.5, 0.5],
	intensity: 0,
	smoothness: 0.2,
	roundness: 1,
	rounded: false,
	blink: false,
	opacity: 1,
};

/**
 * @param value decoded JSON from an exported photo library
 * @returns validated data, including bounded GPU-ready LUT payloads
 * @throws {Error} for a malformed or incompatible library
 */
export const parsePhotoFilters = (value: unknown): PhotoFilters => {
	if (
		!object(value) ||
		value.format !== 'endfield-noclip.photo-filters' ||
		value.version !== 1 ||
		!Array.isArray(value.filters) ||
		value.filters.length > 64
	) {
		throw new Error('unsupported photo filter library');
	}
	const ids = new Set<string>();
	for (const filter of value.filters) {
		if (
			!object(filter) ||
			typeof filter.id !== 'string' ||
			ids.has(filter.id) ||
			typeof filter.name !== 'string' ||
			!Array.isArray(filter.unsupported) ||
			!filter.unsupported.every((v) => typeof v === 'string')
		) {
			throw new Error('invalid photo filter');
		}
		ids.add(filter.id);
		if (
			filter.grading !== null &&
			(!matches(NEUTRAL_GRADING, filter.grading) ||
				!object(filter.grading) ||
				typeof filter.grading.colorLookupEnabled !== 'boolean' ||
				typeof filter.grading.colorCurvesEnabled !== 'boolean')
		) {
			throw new Error(`invalid grading for ${filter.id}`);
		}
		if (
			filter.vignette !== null &&
			(!object(filter.vignette) ||
				!Object.entries(filter.vignette).every(
					([key, v]) =>
						Object.hasOwn(VIGNETTE_DEFAULT, key) && matches(Reflect.get(VIGNETTE_DEFAULT, key), v),
				))
		) {
			throw new Error(`invalid vignette for ${filter.id}`);
		}
		const lut = filter.lut;
		if (lut !== null) {
			if (
				!object(lut) ||
				lut.format !== 'bc7-rgba-unorm' ||
				typeof lut.size !== 'number' ||
				!Number.isInteger(lut.size) ||
				lut.size < 4 ||
				lut.size > 64 ||
				lut.size % 4 !== 0 ||
				typeof lut.data !== 'string' ||
				lut.data.length > 400_000 ||
				typeof lut.contribution !== 'number' ||
				!Number.isFinite(lut.contribution) ||
				lut.contribution < 0 ||
				lut.contribution > 1 ||
				Uint8Array.fromBase64(lut.data).byteLength !== lut.size ** 3
			) {
				throw new Error(`invalid LUT for ${filter.id}`);
			}
		}
	}
	// all fields used by the renderer are checked above; unused game fields are retained for provenance.
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the renderer-facing layout is validated above
	return value as unknown as PhotoFilters;
};

/**
 * @param profile the scene environment after spatial blending
 * @param filter selected photo look, or null to restore the scene
 * @returns a copy with only the authored photo overrides, leaving spatial lighting alone
 */
export const photoProfile = (profile: EnvironmentInput, filter: PhotoFilter | null): EnvironmentInput => {
	if (filter === null) {
		return profile;
	}
	const post = profile.post ?? {
		bloom: null,
		ambientOcclusion: null,
		vignette: null,
		screenSpaceReflection: null,
	};
	return {
		...profile,
		colorGrading: filter.grading ?? profile.colorGrading,
		post:
			filter.vignette === null
				? profile.post
				: {
						...post,
						vignette: { ...VIGNETTE_DEFAULT, ...post.vignette, ...filter.vignette },
					},
	};
};

/** owns the final pass's photo LUT and its independent uniform group */
export class PhotoLut {
	#device: GPUDevice;
	#layout: GPUBindGroupLayout;
	#sampler: GPUSampler;
	#uniform: GPUBuffer;
	#texture: GPUTexture;
	#filter: PhotoFilter | null = null;
	#group: GPUBindGroup;

	/**
	 * @param device WebGPU device
	 * @param layout the tonemap pipeline's photo group layout
	 */
	constructor(device: GPUDevice, layout: GPUBindGroupLayout) {
		this.#device = device;
		this.#layout = layout;
		this.#sampler = device.createSampler({
			magFilter: 'linear',
			minFilter: 'linear',
			addressModeU: 'clamp-to-edge',
			addressModeV: 'clamp-to-edge',
		});
		this.#uniform = device.createBuffer({
			size: 16,
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
		});
		this.#texture = device.createTexture({
			size: [1, 1],
			format: 'rgba8unorm',
			usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
		});
		this.#group = this.#bind();
	}

	#bind(): GPUBindGroup {
		return this.#device.createBindGroup({
			layout: this.#layout,
			entries: [
				{ binding: 0, resource: this.#texture.createView() },
				{ binding: 1, resource: this.#sampler },
				{ binding: 2, resource: { buffer: this.#uniform } },
			],
		});
	}

	/** @returns the group to bind after the tonemap pass's scene textures */
	get group(): GPUBindGroup {
		return this.#group;
	}

	/**
	 * @param filter selected authored look
	 * @param strength LUT contribution multiplier, 0–1
	 * @throws {Error} if the device cannot sample the selected BC texture
	 */
	set(filter: PhotoFilter | null, strength: number): void {
		const lut = filter?.lut;
		if (filter !== this.#filter) {
			if (lut && !this.#device.features.has('texture-compression-bc')) {
				throw new Error('photo LUTs require BC texture support');
			}
			const texture = this.#device.createTexture({
				size: lut ? [lut.size ** 2, lut.size] : [1, 1],
				format: lut?.format ?? 'rgba8unorm',
				usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
			});
			if (lut) {
				const layout = textureLevelLayout(
					{ kind: '2d', format: lut.format, width: lut.size ** 2, height: lut.size, depthOrArrayLayers: 1 },
					0,
				);
				this.#device.queue.writeTexture({ texture }, Uint8Array.fromBase64(lut.data), layout, [
					layout.width,
					layout.height,
				]);
			}
			this.#texture.destroy();
			this.#texture = texture;
			this.#group = this.#bind();
			this.#filter = filter;
		}
		this.#device.queue.writeBuffer(
			this.#uniform,
			0,
			new Float32Array([lut?.size ?? 1, (lut?.contribution ?? 0) * Math.min(1, Math.max(0, strength)), 0, 0]),
		);
	}

	/** frees the LUT and its uniform buffer */
	destroy(): void {
		this.#texture.destroy();
		this.#uniform.destroy();
	}
}
