import { FormatError } from '../binary/binary-reader.ts';
import { ByteView } from '../binary/byte-view.ts';

import { chunkObjectNames, groupColumn, type InitChunk } from './init-chunk-data.ts';
import { levelTagOf } from './level-partition.ts';
import { forEachProperty, readPropertyValue, ValueCode } from './mono-objects.ts';

// local lights among the InitChunkData component-group entities (tag-2 rows, `init-chunk-data.ts`). their
// group columns 42 and 63 are zero-filled in the file; the values sit in the entity's own root row, whose slot 3
// is a keyed property table (`mono-objects.ts` layout) holding two blobs:
//   key 0xff000000, 236 bytes (core): the light as the renderer consumes it
//   key 0xff010000, 448 bytes (settings): the authored settings of HG's Light, then its additional data
// every offset of both is tabled under the local lights of docs/game-data/world.md#initchunkdata-layout;
// `decodeLight` reads the ones `ChunkLight` exposes.

// #region types

/** Unity `LightType` values (both blocks store the same) */
export const LightType = {
	Spot: 0,
	Directional: 1,
	Point: 2,
} as const;

/** a local light of a chunk */
export interface ChunkLight {
	/** full 32-bit entity id */
	id: number;
	/** `id >>> 27`: the owning level's namespace */
	levelTag: number;
	name: string;
	/** a {@link LightType} value, or another the game has */
	type: number;
	/** world position */
	position: [x: number, y: number, z: number];
	/** world direction the light points along (the transform's +z), unit length */
	direction: [x: number, y: number, z: number];
	/** linear radiant colour: the authored colour times intensity and the colour temperature's tint */
	color: [r: number, g: number, b: number];
	/** the authored intensity, already in {@link color} */
	intensity: number;
	/** metres */
	range: number;
	/** full cone angle, degrees (spot lights) */
	spotAngle: number;
	/** full inner cone angle, degrees (spot lights) */
	innerSpotAngle: number;
	/** Unity `LightmapBakeType`: 4 realtime, 1 mixed, 2 baked */
	bakeType: number;
	/** scales the specular lobe */
	specularIntensity: number;
	/** the light emits nothing and only shadows other local lights */
	shadowOnly: boolean;
	/** lights only characters */
	characterOnly: boolean;
	/** a point light's segment length (a tube along {@link direction}), 0 for a point */
	tubeLength: number;
	/** radius of the emitting sphere, m; widens highlights */
	softSourceRadius: number;
	/** the distance falloff's exponent; negative for inverse square with a smooth window */
	falloffExponent: number;
	/** the volumetric fog's multiplier on this light */
	volumetricScatteringIntensity: number;
	/** sorts lights of equal camera distance */
	priority: number;
	/** fades the light out with camera distance: full up to `falloff`, gone at `culling` (m) */
	distanceFade: { falloff: number; culling: number } | null;
	/** a box the light is confined to, faded towards its faces; offset and rotation in world axes */
	cullingBox: {
		offset: [x: number, y: number, z: number];
		halfExtents: [x: number, y: number, z: number];
		/** Euler degrees */
		rotation: [x: number, y: number, z: number];
		/** the fraction of the box, from its centre, that keeps full light */
		falloffThreshold: number;
	} | null;
	/** the authored shadow mode: 0 none, 2 soft */
	shadows: number;
	shadowStrength: number;
	/** scales the receiver's offset along its normal, in shadow-map texels */
	shadowNormalBias: number;
	/** the shadow projection's near and far planes from the light, m; the far plane isn't the range */
	shadowNearPlane: number;
	shadowFarPlane: number;
	/** the light casts no shadow from farther than this from the camera, m */
	shadowCullDistance: number;
	/** the fraction of {@link shadowCullDistance} from which the shadow fades out */
	shadowFadeRatio: number;
	/** degrees added to a spot's cone for the shadow projection */
	shadowGuardAngle: number;
	/** a bit per cube face a point light casts through, in the order +X −X +Y −Y +Z −Z; −1 for all */
	shadowCasterFaces: number;
	/** bits: 1 the light moves, 2 static objects cast, 4 dynamic objects cast */
	shadowCasterProperties: number;
}

// #endregion

/** group columns that only light entities have */
const LIGHT_COLUMNS = [42, 63];

const CORE_KEY = 0xff000000;
const SETTINGS_KEY = 0xff010000;
const CORE_SIZE = 236;
const SETTINGS_SIZE = 448;

/**
 * reads the local lights of a chunk. lights that span cells appear in each cell's chunk under the same id;
 * callers dedupe across files.
 *
 * @param chunk the parsed InitChunkData
 * @returns the lights in row order
 * @throws {FormatError} if a light's row has no property table or its blobs don't have the known sizes
 */
export const readChunkLights = (chunk: InitChunk): ChunkLight[] => {
	const lightIds = new Set<number>();
	for (const group of chunk.groups) {
		if (LIGHT_COLUMNS.every((id) => groupColumn(group, id) !== undefined)) {
			for (const id of group.ids) {
				lightIds.add(id);
			}
		}
	}
	if (lightIds.size === 0) {
		return [];
	}
	const names = chunkObjectNames(chunk);

	const { fb, rows } = chunk.rows;
	const lights: ChunkLight[] = [];
	for (const row of rows) {
		if (!lightIds.has(row.id)) {
			continue;
		}
		const table = fb.tableField(row.table, 3);
		if (table === undefined) {
			throw new FormatError(`light ${row.id} has no property table`);
		}
		let core: ByteView | undefined;
		let settings: ByteView | undefined;
		forEachProperty(fb, table, (key, code, valueAt) => {
			if (code !== ValueCode.Blob || (key !== CORE_KEY && key !== SETTINGS_KEY)) {
				return;
			}
			const value = readPropertyValue(fb, code, valueAt);
			if (value.type !== 'blob') {
				return;
			}
			if (key === CORE_KEY) {
				core = new ByteView(value.value, 'light core');
			} else {
				settings = new ByteView(value.value, 'light settings');
			}
		});
		if (core?.length !== CORE_SIZE || settings?.length !== SETTINGS_SIZE) {
			throw new FormatError(
				`light ${row.id} blobs are ${core?.length ?? 'absent'}/${settings?.length ?? 'absent'} bytes, expected ${CORE_SIZE}/${SETTINGS_SIZE}`,
			);
		}
		lights.push(decodeLight(row.id, names.get(row.id) ?? '', core, settings));
	}
	return lights;
};

const decodeLight = (id: number, name: string, core: ByteView, settings: ByteView): ChunkLight => {
	const flag = (at: number) => settings.u8(at) !== 0;
	const type = core.u32(88);
	if (settings.u32(12) !== type) {
		throw new FormatError(`light ${id}: its two blocks disagree on the type`);
	}
	return {
		id,
		levelTag: levelTagOf(id),
		name,
		type,
		position: core.vec3(28),
		direction: core.vec3(44),
		color: core.vec3(60),
		intensity: core.f32(16),
		range: core.f32(76),
		spotAngle: settings.f32(36),
		innerSpotAngle: settings.f32(40),
		bakeType: settings.u32(80),
		specularIntensity: settings.f32(20),
		shadowOnly: flag(91),
		characterOnly: flag(436),
		tubeLength: Math.max(settings.f32(144), 0),
		softSourceRadius: settings.f32(148),
		falloffExponent: settings.f32(444),
		volumetricScatteringIntensity: settings.f32(440),
		priority: settings.i32(140),
		distanceFade: flag(94) ? { falloff: settings.f32(156), culling: settings.f32(152) } : null,
		cullingBox: flag(92)
			? {
					offset: settings.vec3(100),
					halfExtents: settings.vec3(112),
					rotation: settings.vec3(124),
					falloffThreshold: settings.f32(136),
				}
			: null,
		shadows: settings.u32(160),
		shadowStrength: settings.f32(172),
		shadowNormalBias: settings.f32(180),
		shadowNearPlane: settings.f32(184),
		shadowFarPlane: settings.f32(256),
		shadowCullDistance: settings.f32(260),
		shadowFadeRatio: settings.f32(264),
		shadowGuardAngle: settings.f32(268),
		shadowCasterFaces: settings.i32(272),
		shadowCasterProperties: settings.i32(276),
	};
};
