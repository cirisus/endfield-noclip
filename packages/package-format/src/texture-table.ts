/**
 * `tables/textures.bin.zst`, the texture table: one zstd frame around an `EFTX` v2 TLV container. its own
 * module, outside the asset modules the pack cache fingerprints, so a layout change leaves cached conversions
 * valid
 *
 * @module
 */

import { viewOf } from './binary.ts';
import { checkStride, decodeContainer, encodeContainer, fourcc, requireSection } from './container.ts';
import { EntryStatus, entryStatusCode, entryStatusName } from './entry-status.ts';
import { PackageFormatError } from './errors.ts';
import type { ReadyTexture, TextureEntry, TexturePiece, TextureSampler } from './textures.ts';

/** the decoded texture table; a texture's id is its index */
export interface TextureTable {
	/** entries in the table; ids run `0…count - 1` */
	readonly count: number;
	/** the distinct samplers entries use; {@link ReadyTexture.sampler} indexes this list */
	readonly samplers: readonly TextureSampler[];
	/**
	 * @param id texture id
	 * @returns the entry, decoded on first use and the same object afterwards, or `undefined` when `id` isn't
	 *   in the table
	 */
	entry(id: number): TextureEntry | undefined;
	/**
	 * @param id texture id
	 * @returns how many pieces the texture has: 0 when it isn't ready or isn't in the table
	 */
	pieceCount(id: number): number;
	/**
	 * reads {@link ReadyTexture.pieces} without decoding the entry
	 *
	 * @param id texture id
	 * @param index piece index, below {@link pieceCount}
	 * @returns the piece's blob
	 */
	pieceBlob(id: number, index: number): number;
}

/** {@link ReadyTexture.kind} by its code in the table */
export const TEXTURE_KIND_CODES: readonly ReadyTexture['kind'][] = [
	'2d',
	'cube',
	'2d-array',
	'cube-array',
	'3d',
];

/**
 * {@link ReadyTexture.format} (a key of `TEXTURE_FORMATS`) by its code in the table. a format added to
 * `TEXTURE_FORMATS` needs a code here; renumbering needs a new table version
 */
export const TEXTURE_FORMAT_CODES: readonly string[] = [
	'bc1-rgba-unorm',
	'bc1-rgba-unorm-srgb',
	'bc2-rgba-unorm',
	'bc2-rgba-unorm-srgb',
	'bc3-rgba-unorm',
	'bc3-rgba-unorm-srgb',
	'bc4-r-unorm',
	'bc4-r-snorm',
	'bc5-rg-unorm',
	'bc5-rg-snorm',
	'bc6h-rgb-ufloat',
	'bc6h-rgb-float',
	'bc7-rgba-unorm',
	'bc7-rgba-unorm-srgb',
	'r8unorm',
	'rg8unorm',
	'rgba8unorm',
	'rgba8unorm-srgb',
	'bgra8unorm',
	'bgra8unorm-srgb',
	'r16unorm',
	'rg16unorm',
	'rgba16unorm',
	'r16float',
	'rg16float',
	'rgba16float',
	'r32float',
	'rg32float',
	'rgba32float',
];

const ADDRESS_MODES: readonly TextureSampler['addressModeU'][] = ['repeat', 'clamp-to-edge', 'mirror-repeat'];
const FILTERS: readonly TextureSampler['magFilter'][] = ['nearest', 'linear'];

const MAGIC = fourcc('EFTX');
const MAJOR_VERSION = 2;
const TAG_SAMP = fourcc('SAMP');
const TAG_TEXS = fourcc('TEXS');
const TAG_PCES = fourcc('PCES');
const KNOWN_TAGS = new Set([TAG_SAMP, TAG_TEXS, TAG_PCES]);

const SAMPLER_SIZE = 12;
const TEXTURE_RECORD_SIZE = 20;
const PIECE_SIZE = 8;

const codes = <T>(values: readonly T[]): ReadonlyMap<T, number> =>
	new Map(values.map((value, code) => [value, code]));

const kindCodes = codes(TEXTURE_KIND_CODES);
const formatCodes = codes(TEXTURE_FORMAT_CODES);
const addressCodes = codes(ADDRESS_MODES);
const filterCodes = codes(FILTERS);

const codeOf = <T>(map: ReadonlyMap<T, number>, value: T, label: string): number => {
	const code = map.get(value);
	if (code === undefined) {
		throw new RangeError(`${label} ${String(value)} has no code in the texture table`);
	}
	return code;
};

const valueOf = <T>(values: readonly T[], code: number, label: string): T => {
	const value = values[code];
	if (value === undefined) {
		throw new PackageFormatError(`unknown ${label} ${code}`);
	}
	return value;
};

/**
 * encodes the texture table as an `EFTX` v2 TLV container (`SAMP`, `TEXS`, `PCES`)
 *
 * @param samplers the sampler palette
 * @param entries entries in id order
 * @returns the encoded table
 * @throws {RangeError} on a value without a code or a field that doesn't fit its record
 */
export const encodeTextureTable = (
	samplers: readonly TextureSampler[],
	entries: readonly TextureEntry[],
): Uint8Array => {
	const pieceCount = entries.reduce(
		(sum, entry) => sum + (entry.status === 'ready' ? entry.pieces.length : 0),
		0,
	);
	const sampBuf = new Uint8Array(samplers.length * SAMPLER_SIZE);
	const sampView = viewOf(sampBuf);
	for (const [index, sampler] of samplers.entries()) {
		const at = index * SAMPLER_SIZE;
		sampView.setUint8(at, codeOf(addressCodes, sampler.addressModeU, 'address mode'));
		sampView.setUint8(at + 1, codeOf(addressCodes, sampler.addressModeV, 'address mode'));
		sampView.setUint8(at + 2, codeOf(addressCodes, sampler.addressModeW, 'address mode'));
		sampView.setUint8(at + 3, codeOf(filterCodes, sampler.magFilter, 'filter'));
		sampView.setUint8(at + 4, codeOf(filterCodes, sampler.minFilter, 'filter'));
		sampView.setUint8(at + 5, codeOf(filterCodes, sampler.mipmapFilter, 'filter'));
		if (sampler.maxAnisotropy > 0xff_ff) {
			throw new RangeError(`sampler ${index}'s anisotropy ${sampler.maxAnisotropy} doesn't fit 16 bits`);
		}
		sampView.setUint16(at + 6, sampler.maxAnisotropy, true);
		sampView.setFloat32(at + 8, sampler.mipBias, true);
	}

	const texBuf = new Uint8Array(entries.length * TEXTURE_RECORD_SIZE);
	const texView = viewOf(texBuf);
	const pieceBuf = new Uint8Array(pieceCount * PIECE_SIZE);
	const pieceView = viewOf(pieceBuf);
	let piece = 0;
	for (const [id, entry] of entries.entries()) {
		const at = id * TEXTURE_RECORD_SIZE;
		texView.setUint8(at, entryStatusCode(entry.status));
		texView.setUint32(at + 12, piece, true);
		if (entry.status !== 'ready') {
			continue;
		}
		const droppedMips = entry.droppedMips ?? 0;
		if (
			entry.mipCount > 0xff ||
			droppedMips > 0xff ||
			entry.width > 0xff_ff ||
			entry.height > 0xff_ff ||
			entry.depthOrArrayLayers > 0xff_ff ||
			entry.sampler >= samplers.length
		) {
			throw new RangeError(`texture ${id} has a field out of its record's range`);
		}
		texView.setUint8(at + 1, codeOf(kindCodes, entry.kind, 'texture kind'));
		texView.setUint8(at + 2, codeOf(formatCodes, entry.format, 'texture format'));
		texView.setUint8(at + 3, entry.mipCount);
		texView.setUint16(at + 4, entry.width, true);
		texView.setUint16(at + 6, entry.height, true);
		texView.setUint16(at + 8, entry.depthOrArrayLayers, true);
		texView.setUint16(at + 10, entry.sampler, true);
		texView.setUint8(at + 16, droppedMips);
		for (const { blob, firstLevel, levelCount } of entry.pieces) {
			const pieceAt = piece * PIECE_SIZE;
			pieceView.setUint32(pieceAt, blob, true);
			pieceView.setUint8(pieceAt + 4, firstLevel);
			pieceView.setUint8(pieceAt + 5, levelCount);
			piece++;
		}
	}

	return encodeContainer({
		magic: MAGIC,
		majorVersion: MAJOR_VERSION,
		sections: [
			{ tag: TAG_SAMP, required: true, data: sampBuf, count: samplers.length, stride: SAMPLER_SIZE },
			{ tag: TAG_TEXS, required: true, data: texBuf, count: entries.length, stride: TEXTURE_RECORD_SIZE },
			{ tag: TAG_PCES, required: true, data: pieceBuf, count: pieceCount, stride: PIECE_SIZE },
		],
	});
};

/**
 * checks every record once, so the table's accessors never throw on content
 *
 * @param data the texture table, inflated
 * @returns the table, decoding entries on first use
 * @throws {PackageFormatError} on a bad header or length, an unknown code, a sampler index past the palette
 *   or piece ranges that don't follow each other
 */
export const decodeTextureTable = (data: Uint8Array): TextureTable => {
	const container = decodeContainer(data, {
		magic: MAGIC,
		majorVersion: MAJOR_VERSION,
		knownTags: KNOWN_TAGS,
		label: 'texture table',
	});
	const sampSec = requireSection(container, TAG_SAMP, 'texture table');
	const texSec = requireSection(container, TAG_TEXS, 'texture table');
	const pieceSec = requireSection(container, TAG_PCES, 'texture table');
	checkStride(sampSec, SAMPLER_SIZE, 'SAMP');
	checkStride(texSec, TEXTURE_RECORD_SIZE, 'TEXS');
	checkStride(pieceSec, PIECE_SIZE, 'PCES');

	const sampView = viewOf(sampSec.data);
	const samplers: TextureSampler[] = [];
	for (let index = 0; index < sampSec.count; index++) {
		const at = index * sampSec.stride;
		samplers.push({
			addressModeU: valueOf(ADDRESS_MODES, sampView.getUint8(at), 'address mode'),
			addressModeV: valueOf(ADDRESS_MODES, sampView.getUint8(at + 1), 'address mode'),
			addressModeW: valueOf(ADDRESS_MODES, sampView.getUint8(at + 2), 'address mode'),
			magFilter: valueOf(FILTERS, sampView.getUint8(at + 3), 'filter'),
			minFilter: valueOf(FILTERS, sampView.getUint8(at + 4), 'filter'),
			mipmapFilter: valueOf(FILTERS, sampView.getUint8(at + 5), 'filter'),
			maxAnisotropy: sampView.getUint16(at + 6, true),
			mipBias: sampView.getFloat32(at + 8, true),
		});
	}

	const count = texSec.count;
	const texView = viewOf(texSec.data);
	const pieceView = viewOf(pieceSec.data);
	const firstPieces = new Uint32Array(count + 1);
	firstPieces[count] = pieceSec.count;
	for (let id = 0; id < count; id++) {
		firstPieces[id] = texView.getUint32(id * texSec.stride + 12, true);
	}
	if (count > 0 && firstPieces[0] !== 0) {
		throw new PackageFormatError('texture table pieces start past the list');
	}
	for (let id = 0; id < count; id++) {
		const at = id * texSec.stride;
		const status = texView.getUint8(at);
		if (status > EntryStatus.Failed) {
			throw new PackageFormatError(`texture ${id} has unknown status ${status}`);
		}
		const pieces = firstPieces[id + 1] - firstPieces[id];
		if (pieces < 0 || (status !== EntryStatus.Ready && pieces !== 0)) {
			throw new PackageFormatError(`texture ${id}'s pieces don't follow the previous texture's`);
		}
		if (status === EntryStatus.Ready) {
			valueOf(TEXTURE_KIND_CODES, texView.getUint8(at + 1), 'texture kind');
			valueOf(TEXTURE_FORMAT_CODES, texView.getUint8(at + 2), 'texture format');
			if (texView.getUint16(at + 10, true) >= samplers.length) {
				throw new PackageFormatError(`texture ${id}'s sampler is past the palette`);
			}
		}
	}

	const pieceCount = (id: number): number => {
		const first = firstPieces[id];
		const end = firstPieces[id + 1];
		return first === undefined || end === undefined ? 0 : end - first;
	};

	const decoded: (TextureEntry | undefined)[] = [];
	const decode = (id: number): TextureEntry => {
		const at = id * texSec.stride;
		const status = entryStatusName(texView.getUint8(at), `texture ${id}`);
		if (status !== 'ready') {
			return { status };
		}
		const pieces: TexturePiece[] = [];
		for (let piece = firstPieces[id]; piece < firstPieces[id + 1]; piece++) {
			const pieceAt = piece * pieceSec.stride;
			pieces.push({
				blob: pieceView.getUint32(pieceAt, true),
				firstLevel: pieceView.getUint8(pieceAt + 4),
				levelCount: pieceView.getUint8(pieceAt + 5),
			});
		}
		const droppedMips = texView.getUint8(at + 16);
		return {
			status,
			kind: valueOf(TEXTURE_KIND_CODES, texView.getUint8(at + 1), 'texture kind'),
			format: valueOf(TEXTURE_FORMAT_CODES, texView.getUint8(at + 2), 'texture format'),
			width: texView.getUint16(at + 4, true),
			height: texView.getUint16(at + 6, true),
			depthOrArrayLayers: texView.getUint16(at + 8, true),
			mipCount: texView.getUint8(at + 3),
			...(droppedMips > 0 ? { droppedMips } : {}),
			sampler: texView.getUint16(at + 10, true),
			pieces,
		};
	};

	return {
		count,
		samplers,
		entry(id) {
			if (!(id >= 0 && id < count)) {
				return undefined;
			}
			let entry = decoded[id];
			if (entry === undefined) {
				entry = decode(id);
				decoded[id] = entry;
			}
			return entry;
		},
		pieceCount,
		pieceBlob(id, index) {
			return pieceView.getUint32((firstPieces[id] + index) * pieceSec.stride, true);
		},
	};
};
