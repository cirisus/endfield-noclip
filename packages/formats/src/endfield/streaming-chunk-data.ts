import { FormatError } from '../binary/binary-reader.ts';

import { ChunkObjectKind } from './init-chunk-data.ts';
import { readChunkRows, readPropertyTable, type MonoValue } from './mono-objects.ts';

// resource bindings of streamed objects (`StreamingChunkData_*`, sibling of `InitChunkData_*`; layout in
// docs/game-data/world.md#streamingchunkdata). row readings follow Variante/endfield_research_kit (MIT,
// `memory/game_data/world_chunk_union_vectors.md`). kind-1 objects are read with their Init row by
// `readMonoObjects`; this flat view is for keys outside its component addressing (kind-2 properties, bits ≥ 32).

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

/** a streamed object's bindings */
export interface StreamingRecord {
	/** the object id, shared with InitChunkData */
	id: number;
	/** union tag, as InitChunkData's object kind */
	kind: number;
	properties: StreamingProperty[];
}

/** a parsed StreamingChunkData FlatBuffer */
export interface StreamingChunk {
	version: number;
	records: StreamingRecord[];
}

// #endregion

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
 * parses a decoded StreamingChunkData FlatBuffer
 *
 * @param data the file after `unpackHgPayload` (`hg/payload.ts`)
 * @returns every object's property bindings, in file order
 * @throws {FormatError} on any framing mismatch
 */
export const parseStreamingChunk = (data: Uint8Array): StreamingChunk => {
	const { fb, version, rows } = readChunkRows(data);
	const records = rows.map(({ id, tag, table }): StreamingRecord => {
		const properties: StreamingProperty[] = [];
		const add = (component: number, at: number) => {
			for (const [key, value] of readPropertyTable(fb, at)) {
				properties.push({ key, component, value });
			}
		};
		switch (tag) {
			case ChunkObjectKind.Mono: {
				const components = fb.vector(table, 4);
				for (let c = 0; c < components.length; c++) {
					add(c, fb.tableAt(components.start, c));
				}
				break;
			}
			default: {
				const at = fb.field(table, 3);
				if (at !== undefined) {
					add(0, fb.deref(at));
				}
				break;
			}
		}
		return { id, kind: tag, properties };
	});
	return { version, records };
};

/**
 * @param record a streamed object
 * @returns the entity's HLOD link, or `null` for an object outside every HLOD tree (no link, or a zeroed one)
 * @throws {FormatError} if the link's id isn't the object's
 */
export const hlodLink = (record: StreamingRecord): HlodLink | null => {
	for (const { key, value } of record.properties) {
		if (key !== HLOD_LINK_KEY || value.type !== 'int4') {
			continue;
		}
		const [id, parent, childCount, index] = value.value;
		if (id === 0) {
			return null;
		}
		// the link's own id is the entity id, which is how children name their parent
		if (id >>> 0 !== record.id) {
			throw new FormatError(`object ${record.id} has an HLOD link of id ${id >>> 0}`);
		}
		return { parent: parent === 0 ? null : parent >>> 0, childCount, index };
	}
	return null;
};

/**
 * @param record a streamed object
 * @param key property key
 * @returns the asset key bound under `key`, or `undefined` if the object has no such asset property
 * @throws {FormatError} if the key is bound more than once
 */
export const assetProperty = (record: StreamingRecord, key: number): bigint | undefined => {
	let found: bigint | undefined;
	for (const { key: candidate, value } of record.properties) {
		if (candidate === key && value.type === 'asset') {
			if (found !== undefined) {
				throw new FormatError(`object ${record.id} binds property 0x${key.toString(16)} twice`);
			}
			found = value.hash;
		}
	}
	return found;
};
