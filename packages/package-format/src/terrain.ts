import { viewOf } from './binary.ts';
import { decodeContainer, encodeContainer, fourcc, requireSection } from './container.ts';
import { PackageFormatError } from './errors.ts';

// #region layout
// the terrain's page layout is fixed by the package format (every scene of the game shares it), so a change
// to any of these is an incompatible change to the package. the terrain square is the tile tree's root
// (`TreeInfo.origin`, `rootSize`), and its leaves are the terrain's finest tiles

/** edge of a leaf tile, metres */
export const TERRAIN_LEAF_METRES = 64;

/** samples per height page edge; pages share their edge samples with neighbours */
export const TERRAIN_PAGE_SAMPLES = 65;

/** a raw height sample's hole flag; the other 15 bits are the height, which is 0 on most holes */
export const TERRAIN_HOLE_BIT = 0x80_00;

/** texels per surface and splat page edge, border included */
export const TERRAIN_SURFACE_TEXELS = 132;

/** texels of each surface and splat page edge outside the tile; the rest map the tile edge to edge */
export const TERRAIN_SURFACE_BORDER = 2;

/** metres per splat index cell */
export const TERRAIN_SPLAT_CELL_METRES = 8;

/** splat index cells per leaf edge */
export const TERRAIN_SPLAT_CELLS = TERRAIN_LEAF_METRES / TERRAIN_SPLAT_CELL_METRES;

// #endregion

/** scene terrain parameters, from the game's `HGTerrainSurfacesData`; its square is the tile tree's root */
export interface TerrainInfo {
	/** world y of a zero sample */
	baseHeight: number;
	/**
	 * metres spanned by the 15-bit height range: `y = baseHeight + (h & (TERRAIN_HOLE_BIT − 1)) · heightScale /
	 * TERRAIN_HOLE_BIT`
	 */
	heightScale: number;
	/** levels that have height pages, ascending (the game ships a pyramid, not just leaves) */
	levels: number[];
	/** the close-up layer blend's inputs, or `null` if they weren't packed */
	splat: TerrainSplatInfo | null;
}

/**
 * the close-up layer blend: each leaf's {@link TERRAIN_SPLAT_CELL_METRES} m cells name 4 layers, blended by
 * the leaf's splat control page, then tinted. leaf tiles carry a {@link ContentKind.TerrainSplat} ref
 */
export interface TerrainSplatInfo {
	/** layers by ordinal, as the splat pages' index cells name them */
	layers: TerrainLayerInfo[];
	/** texels per layer texture edge at its first packed level */
	textureSize: number;
	/** mip levels per layer texture */
	textureLevels: number;
	/** {@link BlobKind.TerrainLayer} blobs by texture index: sRGB albedo with height in alpha */
	diffuse: number[];
	/** ... linear normal xy, roughness, occlusion */
	normal: number[];
}

/** one close-up material layer, from the game's `SplatLayerData` */
export interface TerrainLayerInfo {
	/** index into {@link TerrainSplatInfo.diffuse} and {@link TerrainSplatInfo.normal} */
	texture: number;
	/** texture repeats per metre of world position */
	tiling: number;
	/** uv offset */
	offset: [u: number, v: number];
	/** the layer's mean albedo, linear; the tint applies relative to it */
	meanColor: [r: number, g: number, b: number];
	/** scales the normal map's xy */
	normalScale: number;
	/** multiplies the diffuse texture's rgb */
	diffuseScale: [r: number, g: number, b: number];
	/** how far below the highest layer a layer still shows in the height blend */
	blendBorder: number;
	/** height = diffuse alpha · scale + offset */
	height: [scale: number, offset: number];
	/** occlusion = normal alpha · scale + offset */
	occlusion: [scale: number, offset: number];
	/** roughness = normal blue · scale + offset */
	roughness: [scale: number, offset: number];
}

/**
 * @param sample a raw height sample
 * @returns whether the sample is flagged as a hole; most holes' heights are 0, so don't draw or interpolate
 *   with one
 */
export const isTerrainHole = (sample: number): boolean => {
	return (sample & TERRAIN_HOLE_BIT) !== 0;
};

/**
 * @param terrain scene terrain parameters
 * @param sample a raw height sample
 * @returns the sample's world y, ignoring the hole flag
 */
export const terrainHeight = (
	terrain: Pick<TerrainInfo, 'baseHeight' | 'heightScale'>,
	sample: number,
): number => {
	return terrain.baseHeight + ((sample & (TERRAIN_HOLE_BIT - 1)) * terrain.heightScale) / TERRAIN_HOLE_BIT;
};

const MAJOR_VERSION = 2;

const HEIGHTS_MAGIC = fourcc('EFHT');
const SURFACE_MAGIC = fourcc('EFTS');
const SPLAT_MAGIC = fourcc('EFSL');

const TAG_HEAD = fourcc('HEAD');
const TAG_HGTS = fourcc('HGTS');
const TAG_ALBD = fourcc('ALBD');
const TAG_NORM = fourcc('NORM');
const TAG_CTRL = fourcc('CTRL');
const TAG_TINT = fourcc('TINT');
const TAG_INDX = fourcc('INDX');

const HEIGHTS_TAGS = new Set([TAG_HEAD, TAG_HGTS]);
const SURFACE_TAGS = new Set([TAG_HEAD, TAG_ALBD, TAG_NORM]);
const SPLAT_TAGS = new Set([TAG_HEAD, TAG_CTRL, TAG_TINT, TAG_INDX]);

/**
 * encodes a height page (`.hgt`, `EFHT` v2 TLV): zigzag deltas from a gradient prediction, as two byte
 * planes. arithmetic wraps at 16 bits, so the hole bit survives
 *
 * @param samples `side²` raw samples, rows along +Z
 * @param side samples per edge
 * @returns the encoded page
 * @throws {RangeError} if `samples` isn't `side²` long
 */
export const encodeHeightPage = (samples: Uint16Array, side: number): Uint8Array => {
	const count = side * side;
	if (samples.length !== count) {
		throw new RangeError(`height page needs ${count} samples, got ${samples.length}`);
	}
	const head = new Uint8Array(4);
	viewOf(head).setUint16(0, side, true);
	const body = new Uint8Array(count * 2);
	for (let i = 0; i < count; i++) {
		const delta = (samples[i] - predictHeight(samples, i, side)) & 0xff_ff;
		// zigzag over the 16-bit two's complement delta
		const signed = delta >= 0x80_00 ? delta - 0x1_00_00 : delta;
		const zigzag = signed >= 0 ? signed * 2 : -signed * 2 - 1;
		body[i] = zigzag & 0xff;
		body[count + i] = zigzag >> 8;
	}
	return encodeContainer({
		magic: HEIGHTS_MAGIC,
		majorVersion: MAJOR_VERSION,
		sections: [
			{ tag: TAG_HEAD, required: true, data: head },
			{ tag: TAG_HGTS, required: true, data: body, count },
		],
	});
};

const predictHeight = (samples: Uint16Array, i: number, side: number): number => {
	const first = i % side === 0;
	if (i < side) {
		return first ? 0 : samples[i - 1];
	}
	if (first) {
		return samples[i - side];
	}
	return (samples[i - 1] + samples[i - side] - samples[i - side - 1]) & 0xff_ff;
};

/**
 * @param data an encoded height page
 * @returns its side and raw samples
 * @throws {PackageFormatError} on a bad header or length
 */
export const decodeHeightPage = (data: Uint8Array): { side: number; samples: Uint16Array } => {
	const container = decodeContainer(data, {
		magic: HEIGHTS_MAGIC,
		majorVersion: MAJOR_VERSION,
		knownTags: HEIGHTS_TAGS,
		label: 'height page',
	});
	const head = requireSection(container, TAG_HEAD, 'height page');
	if (head.byteLength < 2) {
		throw new PackageFormatError('height page HEAD is too short');
	}
	const side = viewOf(head.data).getUint16(0, true);
	const count = side * side;
	const hgts = requireSection(container, TAG_HGTS, 'height page');
	if (hgts.byteLength !== count * 2) {
		throw new PackageFormatError(`height page HGTS is ${hgts.byteLength} bytes, expected ${count * 2}`);
	}
	const samples = new Uint16Array(count);
	for (let i = 0; i < count; i++) {
		const zigzag = hgts.data[i] | (hgts.data[count + i] << 8);
		const signed = zigzag & 1 ? -((zigzag + 1) >> 1) : zigzag >> 1;
		samples[i] = (predictHeight(samples, i, side) + signed) & 0xff_ff;
	}
	return { side, samples };
};

/** bytes of one BC3 image of `side`² texels */
export const bc3ImageBytes = (side: number): number => (side / 4) ** 2 * 16;

/** a terrain tile's baked surface: two BC3 (DXT5) images of `side`² texels, rows along +Z */
export interface SurfacePage {
	side: number;
	/** rgb linear albedo, a unused */
	albedo: Uint8Array;
	/** rg world normal x and z (`· 2 − 1`; y is reconstructed), b perceptual roughness, a occlusion */
	normal: Uint8Array;
}

/**
 * encodes a surface page (`.tsp`, `EFTS` v2 TLV), its images in row-major block order as `writeTexture` takes
 * them
 *
 * @param page the images
 * @returns the encoded page
 * @throws {RangeError} if `side` isn't a multiple of 4 or an image isn't one BC3 image of that size
 */
export const encodeSurfacePage = (page: SurfacePage): Uint8Array => {
	const { side } = page;
	const bytes = bc3ImageBytes(side);
	if (side % 4 !== 0 || page.albedo.length !== bytes || page.normal.length !== bytes) {
		throw new RangeError(`surface page images must be ${bytes}-byte BC3 images of ${side}² texels`);
	}
	const head = new Uint8Array(4);
	viewOf(head).setUint16(0, side, true);
	return encodeContainer({
		magic: SURFACE_MAGIC,
		majorVersion: MAJOR_VERSION,
		sections: [
			{ tag: TAG_HEAD, required: true, data: head },
			{ tag: TAG_ALBD, required: true, data: page.albedo },
			{ tag: TAG_NORM, required: true, data: page.normal },
		],
	});
};

/**
 * @param data an encoded surface page
 * @returns the page; its images are views into `data`
 * @throws {PackageFormatError} on a bad header or length
 */
export const decodeSurfacePage = (data: Uint8Array): SurfacePage => {
	const container = decodeContainer(data, {
		magic: SURFACE_MAGIC,
		majorVersion: MAJOR_VERSION,
		knownTags: SURFACE_TAGS,
		label: 'surface page',
	});
	const head = requireSection(container, TAG_HEAD, 'surface page');
	if (head.byteLength < 2) {
		throw new PackageFormatError('surface page HEAD is too short');
	}
	const side = viewOf(head.data).getUint16(0, true);
	if (side % 4 !== 0) {
		throw new PackageFormatError(`surface page side ${side} isn't a multiple of 4`);
	}
	const bytes = bc3ImageBytes(side);
	const albedo = requireSection(container, TAG_ALBD, 'surface page').data;
	const normal = requireSection(container, TAG_NORM, 'surface page').data;
	if (albedo.byteLength !== bytes || normal.byteLength !== bytes) {
		throw new PackageFormatError('surface page image length mismatch');
	}
	return { side, albedo, normal };
};

/** a leaf terrain tile's close-up blend inputs; images have `side`² texels with rows along +Z */
export interface SplatPage {
	side: number;
	/** index cells per edge */
	cells: number;
	/** RGBA8 splat control: rgb weight index slots 0–2, slot 3 gets the remainder */
	control: Uint8Array;
	/** BC3 sRGB tint, applied with weight a⁴ */
	tint: Uint8Array;
	/** 4 layer ordinals per cell, row-major from the minimum corner */
	index: Uint8Array;
}

/**
 * encodes a splat page (`.tsl`, `EFSL` v2 TLV)
 *
 * @param page the inputs
 * @returns the encoded page
 * @throws {RangeError} if `side` isn't a multiple of 4 or a section has the wrong size
 */
export const encodeSplatPage = (page: SplatPage): Uint8Array => {
	const { side, cells } = page;
	const tintBytes = bc3ImageBytes(side);
	if (
		side % 4 !== 0 ||
		page.control.length !== side * side * 4 ||
		page.tint.length !== tintBytes ||
		page.index.length !== cells * cells * 4
	) {
		throw new RangeError(`splat page sections don't fit a ${side}² page with ${cells}² cells`);
	}
	const head = new Uint8Array(8);
	const hv = viewOf(head);
	hv.setUint16(0, side, true);
	hv.setUint16(2, cells, true);
	return encodeContainer({
		magic: SPLAT_MAGIC,
		majorVersion: MAJOR_VERSION,
		sections: [
			{ tag: TAG_HEAD, required: true, data: head },
			{ tag: TAG_CTRL, required: true, data: page.control },
			{ tag: TAG_TINT, required: true, data: page.tint },
			{ tag: TAG_INDX, required: true, data: page.index },
		],
	});
};

/**
 * @param data an encoded splat page
 * @returns the page; its sections are views into `data`
 * @throws {PackageFormatError} on a bad header or length
 */
export const decodeSplatPage = (data: Uint8Array): SplatPage => {
	const container = decodeContainer(data, {
		magic: SPLAT_MAGIC,
		majorVersion: MAJOR_VERSION,
		knownTags: SPLAT_TAGS,
		label: 'splat page',
	});
	const head = requireSection(container, TAG_HEAD, 'splat page');
	if (head.byteLength < 4) {
		throw new PackageFormatError('splat page HEAD is too short');
	}
	const hv = viewOf(head.data);
	const side = hv.getUint16(0, true);
	const cells = hv.getUint16(2, true);
	if (side % 4 !== 0) {
		throw new PackageFormatError(`splat page side ${side} isn't a multiple of 4`);
	}
	const control = requireSection(container, TAG_CTRL, 'splat page').data;
	const tint = requireSection(container, TAG_TINT, 'splat page').data;
	const index = requireSection(container, TAG_INDX, 'splat page').data;
	if (
		control.byteLength !== side * side * 4 ||
		tint.byteLength !== bc3ImageBytes(side) ||
		index.byteLength !== cells * cells * 4
	) {
		throw new PackageFormatError('splat page section length mismatch');
	}
	return { side, cells, control, tint, index };
};
