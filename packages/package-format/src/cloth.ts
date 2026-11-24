/**
 * GPU cloth simulation tables and blobs (`tables/cloth.bin.zst` `EFCT` and `.clth` `EFCL` TLV containers).
 *
 * `tables/cloth.bin.zst` lives in `core.czar` and maps each packed cloth index (`0…cloths.length - 1`) to its
 * skeleton buffer offset and node count, plus the {@link BlobKind.Cloth} blob id holding the bulk simulation
 * buffers and the {@link TextureTable} id of the wind noise texture (`_WindGlobalNoiseTex`).
 *
 * @module
 */

import { viewOf } from './binary.ts';
import {
	checkStride,
	decodeContainer,
	encodeContainer,
	fourcc,
	requireSection,
	type ContainerSectionInput,
} from './container.ts';
import { PackageFormatError } from './errors.ts';

/** byte size of one `ClothMetaData` record (44 u32 words) */
export const CLOTH_META_RECORD_BYTES = 176;

/** byte size of one `ClothNodeData` record (48 u32 words) */
export const CLOTH_NODE_RECORD_BYTES = 192;

/** byte size of one packed `ivec4`/`uvec4` batch or cache-map pair */
export const CLOTH_PAIR_RECORD_BYTES = 16;

/** one simulated cloth's index entry in `tables/cloth.bin.zst` */
export interface ClothTableEntry {
	/** first bone index in the scene's cloth skeleton buffer */
	skeletonOffset: number;
	/** number of nodes (bones) belonging to this cloth; `> 256` selects single-skeleton 16-bit vertex indexing */
	nodeCount: number;
}

/** `tables/cloth.bin.zst`: per-cloth skeleton layout and references to the simulation blob and wind noise */
export interface ClothTable {
	/** {@link BlobKind.Cloth} blob index in `tables/blobs.bin`, or `null` when the scene has no simulated cloth */
	blob: number | null;
	/** {@link TextureTable} id of `WindNoiseTex` (`_WindGlobalNoiseTex`), or `null` when unavailable */
	windNoiseTexture: number | null;
	/** per-cloth skeleton offsets and node counts, indexed by instance blocks' `CLTH` sparse section */
	cloths: ClothTableEntry[];
}

/** `.clth` (`EFCL` v2 TLV container): GPU-ready simulation buffers for all cloths in a scene */
export interface ClothDataBlob {
	clothCount: number;
	nodeCount: number;
	/** number of 16-byte `ivec4` records (2 batches per record) */
	batchVec4Count: number;
	/** number of 16-byte `uvec4` records (2 cache entries per record) */
	cacheVec4Count: number;
	/** `clothCount * 176` bytes (`ClothMetaData` with dense `groupOffset.xyz` pre-filled) */
	meta: Uint8Array;
	/** `nodeCount * 192` bytes (`ClothNodeData` initial state) */
	nodes: Uint8Array;
	/** `batchVec4Count * 16` bytes (`ivec4[]` batch cache ranges) */
	batches: Uint8Array;
	/** `cacheVec4Count * 16` bytes (`uvec4[]` cross-batch cache mappings) */
	cache: Uint8Array;
}

const MAJOR_VERSION = 2;
const TABLE_MAGIC = fourcc('EFCT');
const BLOB_MAGIC = fourcc('EFCL');

const TAG_HEAD = fourcc('HEAD');
const TAG_CLTH = fourcc('CLTH');
const TAG_META = fourcc('META');
const TAG_NODE = fourcc('NODE');
const TAG_BTCH = fourcc('BTCH');
const TAG_CACH = fourcc('CACH');

const TABLE_TAGS = new Set([TAG_HEAD, TAG_CLTH]);
const BLOB_TAGS = new Set([TAG_HEAD, TAG_META, TAG_NODE, TAG_BTCH, TAG_CACH]);

const TABLE_HEAD_BYTES = 16;
const TABLE_ENTRY_BYTES = 8;
const BLOB_HEAD_BYTES = 16;
const NONE = 0xff_ff_ff_ff;

/**
 * encodes `tables/cloth.bin.zst` as an `EFCT` v2 TLV container (before its zstd frame)
 *
 * @param table the cloth table
 * @returns the encoded table
 */
export const encodeClothTable = (table: ClothTable): Uint8Array => {
	const head = new Uint8Array(TABLE_HEAD_BYTES);
	const hv = viewOf(head);
	hv.setUint32(0, table.blob ?? NONE, true);
	hv.setUint32(4, table.windNoiseTexture ?? NONE, true);
	hv.setUint32(8, table.cloths.length, true);
	hv.setUint32(12, 0, true);

	const entries = new Uint8Array(table.cloths.length * TABLE_ENTRY_BYTES);
	const ev = viewOf(entries);
	for (const [i, entry] of table.cloths.entries()) {
		const at = i * TABLE_ENTRY_BYTES;
		ev.setUint32(at, entry.skeletonOffset, true);
		ev.setUint32(at + 4, entry.nodeCount, true);
	}

	const sections: ContainerSectionInput[] = [{ tag: TAG_HEAD, required: true, data: head }];
	if (table.cloths.length > 0) {
		sections.push({
			tag: TAG_CLTH,
			required: true,
			data: entries,
			count: table.cloths.length,
			stride: TABLE_ENTRY_BYTES,
		});
	}
	return encodeContainer({ magic: TABLE_MAGIC, majorVersion: MAJOR_VERSION, sections });
};

/**
 * decodes `tables/cloth.bin.zst` (`EFCT` v2 TLV container, after its zstd frame)
 *
 * @param data raw container bytes
 * @returns the decoded cloth table
 * @throws {PackageFormatError} if the container or section sizes are malformed
 */
export const decodeClothTable = (data: Uint8Array): ClothTable => {
	const container = decodeContainer(data, {
		magic: TABLE_MAGIC,
		majorVersion: MAJOR_VERSION,
		knownTags: TABLE_TAGS,
		label: 'cloth table',
	});
	const head = requireSection(container, TAG_HEAD, 'cloth table');
	if (head.byteLength < TABLE_HEAD_BYTES) {
		throw new PackageFormatError('cloth table HEAD is too short');
	}
	const hv = viewOf(head.data);
	const rawBlob = hv.getUint32(0, true);
	const rawWind = hv.getUint32(4, true);
	const count = hv.getUint32(8, true);

	const cloths: ClothTableEntry[] = [];
	if (count > 0) {
		const sec = requireSection(container, TAG_CLTH, 'cloth table');
		checkStride(sec, TABLE_ENTRY_BYTES, 'CLTH');
		if (sec.count !== count) {
			throw new PackageFormatError(`cloth table CLTH count ${sec.count} disagrees with header ${count}`);
		}
		const ev = viewOf(sec.data);
		for (let i = 0; i < count; i++) {
			const at = i * TABLE_ENTRY_BYTES;
			cloths.push({
				skeletonOffset: ev.getUint32(at, true),
				nodeCount: ev.getUint32(at + 4, true),
			});
		}
	}

	return {
		blob: rawBlob === NONE ? null : rawBlob,
		windNoiseTexture: rawWind === NONE ? null : rawWind,
		cloths,
	};
};

/**
 * encodes a `.clth` simulation data blob as an `EFCL` v2 TLV container
 *
 * @param blob the simulation buffers
 * @returns the encoded blob
 * @throws {RangeError} if any buffer length disagrees with its record count
 */
export const encodeClothDataBlob = (blob: ClothDataBlob): Uint8Array => {
	if (blob.meta.byteLength !== blob.clothCount * CLOTH_META_RECORD_BYTES) {
		throw new RangeError('cloth blob meta length disagrees with clothCount');
	}
	if (blob.nodes.byteLength !== blob.nodeCount * CLOTH_NODE_RECORD_BYTES) {
		throw new RangeError('cloth blob nodes length disagrees with nodeCount');
	}
	if (blob.batches.byteLength !== blob.batchVec4Count * CLOTH_PAIR_RECORD_BYTES) {
		throw new RangeError('cloth blob batches length disagrees with batchVec4Count');
	}
	if (blob.cache.byteLength !== blob.cacheVec4Count * CLOTH_PAIR_RECORD_BYTES) {
		throw new RangeError('cloth blob cache length disagrees with cacheVec4Count');
	}
	const head = new Uint8Array(BLOB_HEAD_BYTES);
	const hv = viewOf(head);
	hv.setUint32(0, blob.clothCount, true);
	hv.setUint32(4, blob.nodeCount, true);
	hv.setUint32(8, blob.batchVec4Count, true);
	hv.setUint32(12, blob.cacheVec4Count, true);

	return encodeContainer({
		magic: BLOB_MAGIC,
		majorVersion: MAJOR_VERSION,
		sections: [
			{ tag: TAG_HEAD, required: true, data: head },
			{
				tag: TAG_META,
				required: true,
				data: blob.meta,
				count: blob.clothCount,
				stride: CLOTH_META_RECORD_BYTES,
			},
			{
				tag: TAG_NODE,
				required: true,
				data: blob.nodes,
				count: blob.nodeCount,
				stride: CLOTH_NODE_RECORD_BYTES,
			},
			{
				tag: TAG_BTCH,
				required: true,
				data: blob.batches,
				count: blob.batchVec4Count,
				stride: CLOTH_PAIR_RECORD_BYTES,
			},
			{
				tag: TAG_CACH,
				required: true,
				data: blob.cache,
				count: blob.cacheVec4Count,
				stride: CLOTH_PAIR_RECORD_BYTES,
			},
		],
	});
};

/**
 * decodes a `.clth` simulation data blob (`EFCL` v2 TLV container)
 *
 * @param data raw container bytes
 * @returns the decoded simulation buffers (zero-copy views)
 * @throws {PackageFormatError} if the container or section sizes are malformed
 */
export const decodeClothDataBlob = (data: Uint8Array): ClothDataBlob => {
	const container = decodeContainer(data, {
		magic: BLOB_MAGIC,
		majorVersion: MAJOR_VERSION,
		knownTags: BLOB_TAGS,
		label: 'cloth data blob',
	});
	const head = requireSection(container, TAG_HEAD, 'cloth data blob');
	if (head.byteLength < BLOB_HEAD_BYTES) {
		throw new PackageFormatError('cloth data blob HEAD is too short');
	}
	const hv = viewOf(head.data);
	const clothCount = hv.getUint32(0, true);
	const nodeCount = hv.getUint32(4, true);
	const batchVec4Count = hv.getUint32(8, true);
	const cacheVec4Count = hv.getUint32(12, true);

	const meta = requireSection(container, TAG_META, 'cloth data blob');
	const nodes = requireSection(container, TAG_NODE, 'cloth data blob');
	const batches = requireSection(container, TAG_BTCH, 'cloth data blob');
	const cache = requireSection(container, TAG_CACH, 'cloth data blob');

	checkStride(meta, CLOTH_META_RECORD_BYTES, 'META');
	checkStride(nodes, CLOTH_NODE_RECORD_BYTES, 'NODE');
	checkStride(batches, CLOTH_PAIR_RECORD_BYTES, 'BTCH');
	checkStride(cache, CLOTH_PAIR_RECORD_BYTES, 'CACH');

	if (
		meta.count !== clothCount ||
		nodes.count !== nodeCount ||
		batches.count !== batchVec4Count ||
		cache.count !== cacheVec4Count
	) {
		throw new PackageFormatError('cloth data blob section counts disagree with HEAD');
	}

	return {
		clothCount,
		nodeCount,
		batchVec4Count,
		cacheVec4Count,
		meta: meta.data.subarray(0, clothCount * CLOTH_META_RECORD_BYTES),
		nodes: nodes.data.subarray(0, nodeCount * CLOTH_NODE_RECORD_BYTES),
		batches: batches.data.subarray(0, batchVec4Count * CLOTH_PAIR_RECORD_BYTES),
		cache: cache.data.subarray(0, cacheVec4Count * CLOTH_PAIR_RECORD_BYTES),
	};
};
