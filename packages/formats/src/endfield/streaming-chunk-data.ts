import { FormatError } from '../binary/binary-reader.ts';

import { ChunkObjectKind } from './init-chunk-data.ts';
import {
	type ChunkRow,
	type ChunkRows,
	forEachProperty,
	readChunkRows,
	readPropertyValue,
	type MonoValue,
	ValueCode,
} from './mono-objects.ts';

// resource bindings of streamed objects (`StreamingChunkData_*`, sibling of `InitChunkData_*`; layout in
// docs/game-data/world.md#streamingchunkdata). row readings follow Variante/endfield_research_kit (MIT,
// `memory/game_data/world_chunk_union_vectors.md`). kind-1 objects are read with their Init row by
// `readMonoObjects`; this lazy view is for keys outside its component addressing (kind-2 properties, bits ≥ 32).

// #region types

/** one keyed value of a streamed object */
export interface StreamingProperty {
	/**
	 * property key. it reads as `component << 24 | field << 16 | index`: kind-1 objects use their
	 * StreamingComponentType bit as the component (14 = HGEnvironmentVolume, 32 = HGWaterGlobalConfig); 0xff
	 * keys are per entity archetype, so their meaning depends on the entity's InitChunkData components
	 */
	key: number;
	/** index of the component table it came from (kind 1); 0 for the single table of other kinds */
	component: number;
	value: MonoValue;
}

/**
 * an entity's place in the HLOD tree (the game's `HLODInfo`): a cluster hides once every child is loaded, and
 * a child hides while its parent is loaded and a sibling isn't (docs/game-data/world.md#lod-and-hlod)
 */
export interface HlodLink {
	/** the entity id of the parent cluster, or `null` at the top of a tree */
	parent: number | null;
	/** how many entities name this one as their parent; 0 for an entity that isn't a cluster */
	childCount: number;
	/** the entity's index among its parent's children, or -1 without a parent */
	index: number;
}

// #endregion

/**
 * the property key of a decal entity's material: a rect decal's (InitChunkData component 27) or a WaterDecal
 * box's (31)
 */
export const DECAL_MATERIAL_KEY = 0xff010000;

/** the property key of a WaterDecal box's (InitChunkData component 31) mesh, the render pipeline's cube */
export const WATER_DECAL_MESH_KEY = 0xff000000;

/** the property key of a renderer entity's {@link HlodLink} (the key is a mesh asset on other archetypes) */
const HLOD_LINK_KEY = 0xff000000;

/**
 * lazy view over a StreamingChunkData FlatBuffer. rows are indexed by object id on demand and property tables
 * are scanned without allocating values for untouched keys.
 */
export class StreamingChunk {
	readonly version: number;
	/** underlying parsed root and union rows, shareable with `readFoliageGrids` and `readMonoObjects` */
	readonly raw: ChunkRows;
	/** union rows in file order */
	readonly rows: readonly ChunkRow[];
	#byId: Map<number, ChunkRow> | undefined;

	/**
	 * @param data the file after `unpackHgPayload` (`hg/payload.ts`), or already-parsed {@link ChunkRows}
	 * @throws {FormatError} on any root framing mismatch
	 */
	constructor(data: Uint8Array | ChunkRows) {
		const raw = readChunkRows(data);
		this.version = raw.version;
		this.raw = raw;
		this.rows = raw.rows;
	}

	/**
	 * @param id object id
	 * @returns whether this chunk has a row for `id`
	 */
	has(id: number): boolean {
		return this.#rowOf(id) !== undefined;
	}

	/**
	 * @param target object id or row from {@link rows}
	 * @param key property key
	 * @returns the asset key bound under `key`, or `undefined` if absent
	 * @throws {FormatError} if the key is bound more than once
	 */
	assetProperty(target: number | ChunkRow, key: number): bigint | undefined {
		const row = typeof target === 'number' ? this.#rowOf(target) : target;
		if (row === undefined) {
			return undefined;
		}
		const { fb } = this.raw;
		let found: bigint | undefined;
		this.#forEachRowProperty(row, (_component, candidate, code, at) => {
			if (candidate === key && code === ValueCode.Asset) {
				if (found !== undefined) {
					throw new FormatError(`object ${row.id} binds property 0x${key.toString(16)} twice`);
				}
				found = fb.u64(at);
			}
		});
		return found;
	}

	/**
	 * @param target object id or row from {@link rows}
	 * @returns the entity's HLOD link, or `null` for an object outside every HLOD tree (no link, or a zeroed
	 *   one)
	 * @throws {FormatError} if the link's id isn't the object's
	 */
	hlodLink(target: number | ChunkRow): HlodLink | null {
		const row = typeof target === 'number' ? this.#rowOf(target) : target;
		if (row === undefined) {
			return null;
		}
		const { fb } = this.raw;
		let result: HlodLink | null = null;
		this.#forEachRowProperty(row, (_component, candidate, code, at) => {
			if (result !== null || candidate !== HLOD_LINK_KEY || code !== ValueCode.Int4) {
				return;
			}
			const id = fb.i32(at);
			if (id === 0) {
				return;
			}
			// the link's own id is the entity id, which is how children name their parent
			if (id >>> 0 !== row.id) {
				throw new FormatError(`object ${row.id} has an HLOD link of id ${id >>> 0}`);
			}
			const parent = fb.i32(at + 4);
			result = {
				parent: parent === 0 ? null : parent >>> 0,
				childCount: fb.i32(at + 8),
				index: fb.i32(at + 12),
			};
		});
		return result;
	}

	/**
	 * decodes every property of one row in stored order
	 *
	 * @param target object id or row from {@link rows}
	 * @returns the row's decoded properties, or `[]` if absent
	 */
	properties(target: number | ChunkRow): StreamingProperty[] {
		const row = typeof target === 'number' ? this.#rowOf(target) : target;
		if (row === undefined) {
			return [];
		}
		const { fb } = this.raw;
		const out: StreamingProperty[] = [];
		this.#forEachRowProperty(row, (component, key, code, at) => {
			out.push({ key, component, value: readPropertyValue(fb, code, at) });
		});
		return out;
	}

	#rowOf(id: number): ChunkRow | undefined {
		if (this.#byId === undefined) {
			this.#byId = new Map();
			for (const row of this.rows) {
				this.#byId.set(row.id, row);
			}
		}
		return this.#byId.get(id);
	}

	#forEachRowProperty(
		row: ChunkRow,
		visit: (component: number, key: number, code: number, valueAt: number) => void,
	): void {
		const { fb } = this.raw;
		switch (row.tag) {
			case ChunkObjectKind.Mono: {
				const components = fb.vector(row.table, 4);
				for (let c = 0; c < components.length; c++) {
					forEachProperty(fb, fb.tableAt(components.start, c), (key, code, at) => visit(c, key, code, at));
				}
				break;
			}
			default: {
				const at = fb.field(row.table, 3);
				if (at !== undefined) {
					forEachProperty(fb, fb.deref(at), (key, code, valueAt) => visit(0, key, code, valueAt));
				}
				break;
			}
		}
	}
}

/**
 * opens a lazy view over a decoded StreamingChunkData FlatBuffer
 *
 * @param data the file after `unpackHgPayload` (`hg/payload.ts`), or already-parsed {@link ChunkRows}
 * @returns the chunk view
 * @throws {FormatError} on any root framing mismatch
 */
export const parseStreamingChunk = (data: Uint8Array | ChunkRows): StreamingChunk => new StreamingChunk(data);
