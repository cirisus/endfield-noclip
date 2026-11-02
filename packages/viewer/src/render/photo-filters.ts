import type { VignetteSettings } from '@endfield-noclip/package-format/environment';
import type { PhotoFilter, PhotoFilters } from '@endfield-noclip/package-format/photo-filters';
import { textureLevelLayout } from '@endfield-noclip/package-format/textures';

import { NEUTRAL_GRADING } from './color-grading.ts';
import type { EnvironmentInput, PostInput } from './environment.ts';

const object = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === 'object' && !Array.isArray(value);

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const vector = (value: unknown, size: number): value is number[] =>
	Array.isArray(value) && value.length === size && value.every(finite);
const list = (value: unknown, check: (item: unknown) => boolean): boolean =>
	Array.isArray(value) && value.length > 0 && value.length <= 256 && value.every(check);

const curve = (value: unknown): boolean =>
	value === null ||
	(object(value) &&
		finite(value.preWrapMode) &&
		finite(value.postWrapMode) &&
		list(
			value.keys,
			(key) =>
				object(key) &&
				['time', 'value', 'inSlope', 'outSlope', 'weightedMode', 'inWeight', 'outWeight'].every((k) =>
					finite(key[k]),
				),
		));
const minMax = (value: unknown): boolean =>
	object(value) &&
	finite(value.mode) &&
	[0, 1, 2, 3].includes(value.mode) &&
	finite(value.scalar) &&
	finite(value.min) &&
	curve(value.curve) &&
	curve(value.minCurve) &&
	(value.mode === 0 || value.mode === 3 || value.curve !== null) &&
	(value.mode !== 2 || value.minCurve !== null);
const zero = (value: unknown): boolean =>
	object(value) && minMax(value) && value.mode === 0 && value.scalar === 0;
const curves = (value: unknown): value is unknown[] =>
	Array.isArray(value) && value.length === 3 && value.every(minMax);
const gradient = (value: unknown): boolean =>
	value === null ||
	(object(value) &&
		typeof value.fixed === 'boolean' &&
		list(value.colorKeys, (key) => object(key) && finite(key.time) && vector(key.color, 3)) &&
		list(value.alphaKeys, (key) => object(key) && finite(key.time) && finite(key.alpha)));
const color = (value: unknown): boolean =>
	object(value) &&
	finite(value.mode) &&
	[0, 1, 2, 3, 4].includes(value.mode) &&
	vector(value.max, 4) &&
	vector(value.min, 4) &&
	gradient(value.maxGradient) &&
	gradient(value.minGradient) &&
	(value.mode === 0 || value.mode === 2 || value.maxGradient !== null) &&
	(value.mode !== 3 || value.minGradient !== null);

// this pass handles simple zero-gravity billboards, not arbitrary scene particle materials.
const particles = (value: unknown): boolean => {
	if (
		!object(value) ||
		value.renderMode !== 0 ||
		value.alignment !== 0 ||
		value.stretch !== null ||
		value.velocity !== null ||
		value.drag !== null ||
		value.speedLimit != null ||
		value.ringBuffer !== null ||
		!Array.isArray(value.bursts) ||
		value.bursts.length !== 0 ||
		!vector(value.pivot, 3) ||
		value.pivot.some((v) => v !== 0) ||
		!vector(value.meshWeights, 1) ||
		value.meshWeights[0] <= 0 ||
		value.mesh !== 0 ||
		typeof value.shapeScaling !== 'boolean' ||
		typeof value.looping !== 'boolean' ||
		!finite(value.duration) ||
		value.duration <= 0 ||
		!finite(value.startDelay) ||
		value.startDelay < 0 ||
		!finite(value.simulationSpeed) ||
		value.simulationSpeed < 0 ||
		!finite(value.maxParticles) ||
		!Number.isInteger(value.maxParticles) ||
		value.maxParticles < 0 ||
		!minMax(value.startLifetime) ||
		!minMax(value.startSpeed) ||
		!minMax(value.rate) ||
		!zero(value.gravityModifier) ||
		!color(value.startColor) ||
		(value.colorOverLifetime !== null && !color(value.colorOverLifetime)) ||
		!curves(value.startSize) ||
		!curves(value.startRotation) ||
		!zero(value.startRotation[0]) ||
		!zero(value.startRotation[1]) ||
		(value.sizeOverLifetime !== null && !curves(value.sizeOverLifetime)) ||
		(value.rotationOverLifetime !== null &&
			(!curves(value.rotationOverLifetime) ||
				!zero(value.rotationOverLifetime[0]) ||
				!zero(value.rotationOverLifetime[1])))
	) {
		return false;
	}
	const shape = value.shape;
	if (
		shape !== null &&
		(!object(shape) ||
			!finite(shape.kind) ||
			![0, 2, 4, 5, 8, 10].includes(shape.kind) ||
			![
				'radius',
				'radiusThickness',
				'angle',
				'length',
				'arc',
				'randomDirection',
				'sphericalDirection',
				'randomPosition',
			].every((k) => finite(shape[k])) ||
			!['position', 'rotation', 'scale'].every((k) => vector(shape[k], 3)))
	) {
		return false;
	}
	const sheet = value.textureSheet;
	return (
		sheet === null ||
		(object(sheet) &&
			vector(sheet.tiles, 2) &&
			sheet.tiles.every((v) => Number.isInteger(v) && v >= 1 && v <= 64) &&
			(sheet.row === null ||
				(finite(sheet.row) &&
					Number.isInteger(sheet.row) &&
					sheet.row >= -2 &&
					sheet.row < sheet.tiles[1])) &&
			(sheet.frameOverTime === null || minMax(sheet.frameOverTime)) &&
			minMax(sheet.startFrame) &&
			['fps', 'cycles', 'uvChannels'].every((k) => finite(sheet[k])))
	);
};

const effect = (value: unknown): boolean => {
	if (
		!object(value) ||
		typeof value.name !== 'string' ||
		!vector(value.matrix, 16) ||
		!vector(value.tint, 4) ||
		typeof value.ignorePostExposure !== 'boolean' ||
		!particles(value.particles)
	) {
		return false;
	}
	const source = value.texture;
	if (
		!object(source) ||
		(source.format !== 'bc7-rgba-unorm' && source.format !== 'bc7-rgba-unorm-srgb') ||
		!finite(source.width) ||
		!finite(source.height) ||
		![source.width, source.height].every((n) => Number.isInteger(n) && n >= 4 && n <= 2048 && n % 4 === 0) ||
		!Array.isArray(source.levels) ||
		source.levels.length === 0 ||
		source.levels.length > Math.floor(Math.log2(Math.max(source.width, source.height))) + 1
	) {
		return false;
	}
	const sampler = source.sampler;
	if (
		!object(sampler) ||
		!['addressModeU', 'addressModeV', 'addressModeW'].every((k) =>
			['repeat', 'clamp-to-edge', 'mirror-repeat'].some((v) => v === sampler[k]),
		) ||
		!['magFilter', 'minFilter', 'mipmapFilter'].every(
			(k) => sampler[k] === 'nearest' || sampler[k] === 'linear',
		) ||
		sampler.mipBias !== 0 ||
		!finite(sampler.maxAnisotropy) ||
		!Number.isInteger(sampler.maxAnisotropy) ||
		sampler.maxAnisotropy < 1 ||
		sampler.maxAnisotropy > 16 ||
		(sampler.maxAnisotropy > 1 &&
			[sampler.magFilter, sampler.minFilter, sampler.mipmapFilter].some((v) => v !== 'linear'))
	) {
		return false;
	}
	const size = {
		kind: '2d' as const,
		format: source.format,
		width: source.width,
		height: source.height,
		depthOrArrayLayers: 1,
	};
	return source.levels.every(
		(data, level) =>
			typeof data === 'string' &&
			data.length <= 6_000_000 &&
			Uint8Array.fromBase64(data).byteLength === textureLevelLayout(size, level).byteLength,
	);
};

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

const BLOOM_DEFAULT: NonNullable<PostInput['bloom']> = {
	resolutionHighQuality: 2,
	thresholdHighQuality: 1,
	intensityHighQuality: 0,
	scatterHighQuality: 0.5,
	tint: [1, 1, 1, 1],
	blendMode: 2,
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
			filter.effects !== undefined &&
			(!Array.isArray(filter.effects) || filter.effects.length > 4 || !filter.effects.every(effect))
		) {
			throw new Error(`invalid effects for ${filter.id}`);
		}
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
		if (
			filter.bloom != null &&
			(!object(filter.bloom) ||
				!Object.entries(filter.bloom).every(
					([key, v]) => Object.hasOwn(BLOOM_DEFAULT, key) && matches(Reflect.get(BLOOM_DEFAULT, key), v),
				))
		) {
			throw new Error(`invalid bloom for ${filter.id}`);
		}
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
			filter.vignette === null && filter.bloom == null
				? profile.post
				: {
						...post,
						vignette:
							filter.vignette === null
								? post.vignette
								: { ...VIGNETTE_DEFAULT, ...post.vignette, ...filter.vignette },
						bloom: filter.bloom == null ? post.bloom : { ...BLOOM_DEFAULT, ...post.bloom, ...filter.bloom },
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
