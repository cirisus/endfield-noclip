import { unique } from '@mary-ext/array-fns';

import { FormatError } from '../binary/binary-reader.ts';
import { ByteView } from '../binary/byte-view.ts';
import type { Aabb } from '../unity/values.ts';

import {
	Component,
	parseComponentColumns,
	type RendererDraw,
	type StaticRenderer,
} from './init-chunk-data.ts';
import { levelTagOf } from './level-partition.ts';
import {
	ChunkObjectKind,
	type ChunkRows,
	readChunkRows,
	readPropertyTable,
	type MonoValue,
} from './mono-objects.ts';

// scattered foliage: grass and tree grids among a chunk's tag-3 proxy objects, serialized as whole ECS
// archetypes in the row's keyed property table (layout in docs/game-data/world.md#foliage-grids).

// #region types

/** `ProxyEntityType` values of the grids decoded here */
export const FoliageGridType = {
	Grass: 7,
	Tree: 9,
} as const;

export type FoliageGridType = (typeof FoliageGridType)[keyof typeof FoliageGridType];

/** entities of one grid that draw the same chain of draws */
export interface FoliageCluster {
	/** world bounds of the instances */
	bounds: Aabb;
	/** half-size of the foliage renderer for screen-size LOD culling, from {@link Component.LodInfo} or bounds */
	rendererHalfSize: number;
	/** draws with mesh and material keys resolved through the batch table; LOD levels follow the thresholds */
	renderer: StaticRenderer;
	/** packed column-major 4×4 object-to-world matrices, 16 floats per instance */
	instances: Float32Array;
	/** number of instances in {@link instances} (`instances.length / 16`) */
	instanceCount: number;
}

/** a grass or tree grid */
export interface FoliageGrid {
	type: FoliageGridType;
	/** the proxy object's id */
	id: number;
	/** `id >>> 27`: the owning level's namespace */
	levelTag: number;
	name: string;
	clusters: FoliageCluster[];
}

// #endregion

const ARCHETYPE_COUNT_KEY = 0xff000000;
const ENTITY_COUNT_KEY = 0xff020000;
const DESCRIPTORS_KEY = 0xff030000;
const BLOB_KEY = 0xff040000;
const BATCH_COUNT_KEY = 0xff050000;
const BATCH_KEY_KEY = 0xff060000;
const BATCH_MATERIAL_KEY = 0xff070000;
const BATCH_MESH_KEY = 0xff080000;
const BATCH_SUBMESH_KEY = 0xff090000;

/** a grass cluster of up to 4 instances; each id up to {@link GRASS_CLUSTER_LAST} doubles the capacity */
const GRASS_CLUSTER_FIRST = 37;
const GRASS_CLUSTER_LAST = 40;
/** a tree entity's one instance */
const TREE_INSTANCE = 80;
/** a column-major object-to-world matrix and two vec4 parameters */
const INSTANCE_SIZE = 96;
const DRAW_INFO_SIZE = 24;
const LOD_INFO_SIZE = 20;

/**
 * @param init an InitChunkData FlatBuffer (after `unpackHgPayload`)
 * @returns whether the chunk has a grass or tree grid; cheaper than {@link readFoliageGrids}
 * @throws {FormatError} if the root doesn't frame
 */
export const hasFoliageGrids = (init: Uint8Array | ChunkRows): boolean => {
	const { fb, rows } = readChunkRows(init);
	return rows.some((row) => gridType(fb, row) !== null);
};

/**
 * reads a chunk's grass and tree grids. a grid that spans files appears in each under the same id; callers
 * dedupe across files.
 *
 * @param init an InitChunkData FlatBuffer (after `unpackHgPayload`) or parsed rows
 * @param streaming its StreamingChunkData sibling, which holds the grids' batch tables
 * @returns the grids in row order, each with its clusters in file order
 * @throws {FormatError} if the two files disagree on the objects, or a grid's tables or columns don't frame
 */
export const readFoliageGrids = (
	init: Uint8Array | ChunkRows,
	streaming: Uint8Array | ChunkRows,
): FoliageGrid[] => {
	const initRows = readChunkRows(init);
	const streamRows = readChunkRows(streaming);
	if (streamRows.rows.length !== initRows.rows.length) {
		throw new FormatError('init and streaming chunks list different object counts');
	}
	const grids: FoliageGrid[] = [];
	for (const [i, row] of initRows.rows.entries()) {
		const type = gridType(initRows.fb, row);
		if (type === null) {
			continue;
		}
		const pair = streamRows.rows[i];
		if (pair.id !== row.id) {
			throw new FormatError(`object ${i}: init id ${row.id} pairs with streaming id ${pair.id}`);
		}
		const name = initRows.fb.stringField(row.table, 0);
		const props = propertyMap(initRows, row.table, row.id);
		const batches = readBatches(propertyMap(streamRows, pair.table, row.id), row.id);
		grids.push({
			type,
			id: row.id,
			levelTag: levelTagOf(row.id),
			name,
			clusters: readArchetypes(props, batches, type, row.id),
		});
	}
	return grids;
};

const gridType = (fb: ReturnType<typeof readChunkRows>['fb'], row: { tag: number; table: number }) => {
	if (row.tag !== ChunkObjectKind.Proxy) {
		return null;
	}
	const type = fb.u8Field(row.table, 2);
	switch (type) {
		case FoliageGridType.Grass:
		case FoliageGridType.Tree: {
			return type;
		}
		default: {
			return null;
		}
	}
};

const propertyMap = (
	{ fb }: ReturnType<typeof readChunkRows>,
	table: number,
	id: number,
): Map<number, MonoValue> => {
	const propTable = fb.tableField(table, 3);
	if (propTable === undefined) {
		throw new FormatError(`grid ${id} has no property table`);
	}
	return new Map(readPropertyTable(fb, propTable));
};

/** one entry of a grid's batch table */
interface Batch {
	key: number;
	materialHash: bigint;
	meshHash: bigint;
	submesh: number;
}

const readBatches = (props: Map<number, MonoValue>, id: number): Batch[] => {
	const count = intProperty(props, BATCH_COUNT_KEY, id);
	return Array.from({ length: count }, (_, i): Batch => {
		const key = props.get((BATCH_KEY_KEY | i) >>> 0);
		const material = props.get((BATCH_MATERIAL_KEY | i) >>> 0);
		const mesh = props.get((BATCH_MESH_KEY | i) >>> 0);
		if (key?.type !== 'uint' || material?.type !== 'asset' || mesh?.type !== 'asset') {
			throw new FormatError(`grid ${id} batch ${i} is incomplete`);
		}
		return {
			key: key.value,
			materialHash: material.hash,
			meshHash: mesh.hash,
			submesh: intProperty(props, (BATCH_SUBMESH_KEY | i) >>> 0, id),
		};
	});
};

const intProperty = (props: Map<number, MonoValue>, key: number, id: number): number => {
	const value = props.get(key);
	if (value?.type !== 'int') {
		throw new FormatError(`grid ${id} has no int under 0x${key.toString(16)}`);
	}
	return value.value;
};

const blobProperty = (props: Map<number, MonoValue>, key: number, id: number): Uint8Array => {
	const value = props.get(key);
	if (value?.type !== 'blob') {
		throw new FormatError(`grid ${id} has no blob under 0x${key.toString(16)}`);
	}
	return value.value;
};

const readArchetypes = (
	props: Map<number, MonoValue>,
	batches: Batch[],
	type: FoliageGridType,
	id: number,
): FoliageCluster[] => {
	const byKey = new Map(batches.map((batch) => [batch.key, batch]));
	const clusters: FoliageCluster[] = [];
	const archetypes = intProperty(props, ARCHETYPE_COUNT_KEY, id);
	for (let a = 0; a < archetypes; a++) {
		const count = intProperty(props, (ENTITY_COUNT_KEY | a) >>> 0, id);
		const descriptors = blobProperty(props, (DESCRIPTORS_KEY | a) >>> 0, id);
		const blob = blobProperty(props, (BLOB_KEY | a) >>> 0, id);
		const view = new ByteView(blob, `grid ${id} archetype ${a}`);
		const parsed = parseComponentColumns(descriptors, count, blob.length, `grid ${id} archetype ${a}`);
		const columns = new Map(parsed.map((column) => [column.id, column]));

		const boundsColumns = Array.from({ length: 6 }, (_, c) => columns.get(Component.BoundsCenterX + c));
		const lodInfoColumn = columns.get(Component.LodInfo);
		const hasLodInfo = lodInfoColumn !== undefined && lodInfoColumn.stride === LOD_INFO_SIZE;
		let drawColumn: { id: number; stride: number; offset: number } | undefined;
		let instanceColumn: { id: number; stride: number; offset: number } | undefined;
		for (const [column, layout] of columns) {
			if (column >= Component.DrawInfoFirst && column <= Component.DrawInfoLast) {
				drawColumn = layout;
			}
			const isInstances =
				type === FoliageGridType.Grass
					? column >= GRASS_CLUSTER_FIRST && column <= GRASS_CLUSTER_LAST
					: column === TREE_INSTANCE;
			if (isInstances) {
				instanceColumn = layout;
			}
		}
		if (boundsColumns.some((column) => column?.stride !== 4) || drawColumn === undefined) {
			throw new FormatError(`grid ${id} archetype ${a} lacks bounds or draw columns`);
		}
		if (instanceColumn === undefined) {
			throw new FormatError(`grid ${id} archetype ${a} has no instance column`);
		}
		const capacity = 1 << (drawColumn.id - Component.DrawInfoFirst);
		if (drawColumn.stride !== 4 + 32 * capacity) {
			throw new FormatError(`grid ${id} archetype ${a} has draw stride ${drawColumn.stride}`);
		}
		// a tree entity holds one instance; a grass cluster a count and room for its capacity
		let grassCapacity = 0;
		let instanceStride = INSTANCE_SIZE;
		if (type === FoliageGridType.Grass) {
			grassCapacity = 4 << (instanceColumn.id - GRASS_CLUSTER_FIRST);
			instanceStride = 4 + INSTANCE_SIZE * grassCapacity;
		}
		if (instanceColumn.stride !== instanceStride) {
			throw new FormatError(`grid ${id} archetype ${a} has instance stride ${instanceColumn.stride}`);
		}

		for (let e = 0; e < count; e++) {
			const f = (column: { offset: number } | undefined) => view.f32(column!.offset + e * 4);
			const bounds: Aabb = {
				center: [f(boundsColumns[0]), f(boundsColumns[1]), f(boundsColumns[2])],
				extents: [f(boundsColumns[3]), f(boundsColumns[4]), f(boundsColumns[5])],
			};
			const rendererHalfSize = hasLodInfo
				? Math.sqrt(Math.max(0, view.f32(lodInfoColumn.offset + e * LOD_INFO_SIZE + 12)))
				: Math.max(bounds.extents[0], bounds.extents[1], bounds.extents[2]);
			const draws = readDraws(view, drawColumn.offset + e * drawColumn.stride, capacity, {
				type,
				batches,
				byKey,
				id,
			});
			const base = instanceColumn.offset + e * instanceColumn.stride;
			let instanceCount = 1;
			let first = base;
			if (type === FoliageGridType.Grass) {
				instanceCount = view.u32(base);
				first = base + 4;
				if (instanceCount > grassCapacity) {
					throw new FormatError(`grid ${id} cluster holds ${instanceCount} of ${grassCapacity} instances`);
				}
			}
			// pack matrices contiguously in one buffer (dropping the two trailing vec4s per instance) so
			// millions of instances don't allocate a Float32Array view each
			const instances = new Float32Array(instanceCount * 16);
			const out = new Uint8Array(instances.buffer);
			for (let k = 0; k < instanceCount; k++) {
				out.set(view.subarray(first + k * INSTANCE_SIZE, 64), k * 64);
			}
			const lodCount = new Set(draws.map((draw) => draw.lod)).size;
			clusters.push({ bounds, rendererHalfSize, renderer: { draws, lodCount }, instances, instanceCount });
		}
	}
	return clusters;
};

const readDraws = (
	view: ByteView,
	at: number,
	capacity: number,
	grid: { type: FoliageGridType; batches: Batch[]; byKey: Map<number, Batch>; id: number },
): RendererDraw[] => {
	const count = view.u32(at);
	if (count > capacity) {
		throw new FormatError(`grid ${grid.id} has ${count} draws in room for ${capacity}`);
	}
	const draws: RendererDraw[] = [];
	for (let d = 0; d < count; d++) {
		const info = at + 4 + d * DRAW_INFO_SIZE;
		const lod = at + 4 + capacity * DRAW_INFO_SIZE + d * 8;
		let batch: Batch | undefined;
		let flags: number;
		let sparsity: number | undefined;
		// the info names its batch entry instead of holding asset keys: grass by the entry's key, trees by its
		// index
		if (grid.type === FoliageGridType.Grass) {
			batch = grid.byKey.get(view.u32(info + 4));
			sparsity = view.f32(info + 8);
			flags = view.u32(info + 12);
		} else {
			batch = grid.batches[view.u32(info + 12)];
			flags = view.u32(info + 16);
		}
		if (batch === undefined) {
			throw new FormatError(`grid ${grid.id} draw ${d} names no batch entry`);
		}
		draws.push({
			meshHash: batch.meshHash,
			materialHash: batch.materialHash,
			submesh: batch.submesh,
			flags,
			lodMaxSquared: view.f32(lod),
			lodMinSquared: view.f32(lod + 4),
			lod: 0,
			...(sparsity !== undefined ? { sparsity } : {}),
		});
	}
	// grids carry no LOD-range column; a draw's LOD is the rank of its upper threshold
	// oxlint-disable-next-line unicorn/no-array-sort -- sorts a fresh copy
	const uppers = unique(draws.map((draw) => draw.lodMaxSquared)).sort((a, b) => b - a);
	for (const draw of draws) {
		draw.lod = uppers.indexOf(draw.lodMaxSquared);
	}
	return draws;
};
