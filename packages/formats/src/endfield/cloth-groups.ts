import { FormatError } from '../binary/binary-reader.ts';
import { ByteView } from '../binary/byte-view.ts';

import { levelTagOf } from './level-partition.ts';
import {
	ChunkObjectKind,
	type ChunkRows,
	type MonoValue,
	readChunkRows,
	readPropertyTable,
} from './mono-objects.ts';

// cloth simulation groups among a chunk's tag-3 proxy objects (`ProxyEntityType` 8,
// `ClothGroupInfo_<hash>#<levelTag>_<id>`; layout in docs/game-data/world.md#cloth-groups).

// #region types

/** `ProxyEntityType` of a cloth simulation group */
export const CLOTH_GROUP_PROXY_TYPE = 8;

/** byte size of a serialized `ClothGroupMeta` struct */
export const CLOTH_GROUP_META_BYTES = 80;

/** byte size of one `ClothMetaData` record (44 u32 words) */
export const CLOTH_META_BYTES = 176;

/** byte size of one `ClothNodeData` record (48 u32 words) */
export const CLOTH_NODE_BYTES = 192;

/** byte size of one packed `ivec4` / `uvec4` batch or cache-map pair */
export const CLOTH_PAIR_BYTES = 16;

/** maximum cloths packed into one cloth group */
export const CLOTH_GROUP_MAX_CLOTHS = 4;

/** metadata for one simulated cloth inside a {@link ClothGroup} */
export interface ClothGroupEntry {
	/** `u32` cloth hash matching `InitChunkData` component 60 */
	hash: number;
	/** number of simulation nodes belonging to this cloth */
	nodeCount: number;
	/** number of 256-node batches (1 for ≤256 nodes, 2 for >256 nodes) */
	batchCount: number;
	/** number of cross-batch neighbor cache entries */
	cacheCount: number;
}

/** a cloth simulation group decoded from an `InitChunkData` proxy row */
export interface ClothGroup {
	/** the proxy object's id */
	id: number;
	/** `id >>> 27`: the owning level's namespace */
	levelTag: number;
	name: string;
	/** `u32` group hash */
	groupHash: number;
	/** group anchor position in world XZ */
	worldPosXZ: [x: number, z: number];
	/** cloths in this group (1–4) */
	cloths: ClothGroupEntry[];
	/** raw `ClothMetaData` records, `cloths.length * CLOTH_META_BYTES` bytes */
	metaBytes: Uint8Array;
	/** raw `ClothNodeData` records, `sum(nodeCount) * CLOTH_NODE_BYTES` bytes */
	nodeBytes: Uint8Array;
	/** raw packed `ivec4` batch ranges (2 batches per 16 bytes) */
	batchBytes: Uint8Array;
	/** raw packed `uvec4` cross-batch cache entries (2 entries per 16 bytes) */
	cacheBytes: Uint8Array;
}

// #endregion

const GROUP_META_KEY = 0xff000000;
const CLOTH_META_KEY = 0xff010000;
const CLOTH_NODE_KEY = 0xff020000;
const CLOTH_BATCH_KEY = 0xff030000;
const CLOTH_CACHE_KEY = 0xff040000;

/**
 * @param init an InitChunkData FlatBuffer (after `unpackHgPayload`) or parsed rows
 * @returns whether the chunk contains any cloth group proxies
 * @throws {FormatError} if the root doesn't frame
 */
export const hasClothGroups = (init: Uint8Array | ChunkRows): boolean => {
	const { fb, rows } = readChunkRows(init);
	return rows.some(
		(row) => row.tag === ChunkObjectKind.Proxy && fb.u8Field(row.table, 2) === CLOTH_GROUP_PROXY_TYPE,
	);
};

/**
 * reads every cloth simulation group from an `InitChunkData` chunk. a group spanning cells may repeat in each
 * cell's chunk under the same {@link ClothGroup.groupHash}; callers dedupe across files.
 *
 * @param init an InitChunkData FlatBuffer (after `unpackHgPayload`) or parsed rows
 * @returns the cloth groups in row order
 * @throws {FormatError} if a cloth group's property table or binary blobs don't match the expected sizes
 */
export const readClothGroups = (init: Uint8Array | ChunkRows): ClothGroup[] => {
	const { fb, rows } = readChunkRows(init);
	const groups: ClothGroup[] = [];
	for (const row of rows) {
		if (row.tag !== ChunkObjectKind.Proxy || fb.u8Field(row.table, 2) !== CLOTH_GROUP_PROXY_TYPE) {
			continue;
		}
		const name = fb.stringField(row.table, 0);
		const propTable = fb.tableField(row.table, 3);
		if (propTable === undefined) {
			throw new FormatError(`cloth group ${row.id} has no property table`);
		}
		const props = new Map(readPropertyTable(fb, propTable));
		const groupMeta = blobProperty(props, GROUP_META_KEY, row.id);
		if (groupMeta.length !== CLOTH_GROUP_META_BYTES) {
			throw new FormatError(
				`cloth group ${row.id} meta is ${groupMeta.length} bytes, expected ${CLOTH_GROUP_META_BYTES}`,
			);
		}
		const mv = new ByteView(groupMeta, `cloth group ${row.id} meta`);
		const clothCount = mv.i32(0);
		if (clothCount < 1 || clothCount > CLOTH_GROUP_MAX_CLOTHS) {
			throw new FormatError(`cloth group ${row.id} has invalid cloth count ${clothCount}`);
		}
		const groupHash = mv.u32(4);
		const worldPosXZ: [number, number] = [mv.f32(8), mv.f32(12)];
		const cloths: ClothGroupEntry[] = [];
		let totalNodes = 0;
		let totalBatches = 0;
		let totalCache = 0;
		for (let i = 0; i < clothCount; i++) {
			const hash = mv.u32(16 + i * 4);
			const nodeCount = mv.i32(32 + i * 4);
			const batchCount = mv.i32(48 + i * 4);
			const cacheCount = mv.i32(64 + i * 4);
			if (nodeCount < 0 || batchCount < 0 || cacheCount < 0) {
				throw new FormatError(`cloth group ${row.id} cloth ${i} has negative counts`);
			}
			cloths.push({ hash, nodeCount, batchCount, cacheCount });
			totalNodes += nodeCount;
			totalBatches += batchCount;
			totalCache += cacheCount;
		}

		const metaBytes = blobProperty(props, CLOTH_META_KEY, row.id);
		const nodeBytes = blobProperty(props, CLOTH_NODE_KEY, row.id);
		const batchBytes = blobProperty(props, CLOTH_BATCH_KEY, row.id);
		const cacheBytes = blobProperty(props, CLOTH_CACHE_KEY, row.id);

		const expectedMeta = clothCount * CLOTH_META_BYTES;
		const expectedNodes = totalNodes * CLOTH_NODE_BYTES;
		const expectedBatches = Math.ceil(totalBatches / 2) * CLOTH_PAIR_BYTES;
		const expectedCache = Math.max(1, Math.ceil(totalCache / 2)) * CLOTH_PAIR_BYTES;
		if (metaBytes.length !== expectedMeta) {
			throw new FormatError(
				`cloth group ${row.id} ClothMetaData is ${metaBytes.length} bytes, expected ${expectedMeta}`,
			);
		}
		if (nodeBytes.length !== expectedNodes) {
			throw new FormatError(
				`cloth group ${row.id} ClothNodeData is ${nodeBytes.length} bytes, expected ${expectedNodes}`,
			);
		}
		if (batchBytes.length !== expectedBatches) {
			throw new FormatError(
				`cloth group ${row.id} batch metadata is ${batchBytes.length} bytes, expected ${expectedBatches}`,
			);
		}
		if (cacheBytes.length !== expectedCache) {
			throw new FormatError(
				`cloth group ${row.id} cache map is ${cacheBytes.length} bytes, expected ${expectedCache}`,
			);
		}

		groups.push({
			id: row.id,
			levelTag: levelTagOf(row.id),
			name,
			groupHash,
			worldPosXZ,
			cloths,
			metaBytes,
			nodeBytes,
			batchBytes,
			cacheBytes,
		});
	}
	return groups;
};

const blobProperty = (props: Map<number, MonoValue>, key: number, id: number): Uint8Array => {
	const value = props.get(key);
	if (value?.type !== 'blob') {
		throw new FormatError(`cloth group ${id} has no blob under 0x${key.toString(16)}`);
	}
	return value.value;
};
