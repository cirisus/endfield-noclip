import type { SludgeSurface } from '@endfield-noclip/package-format/surfaces';
import type { Color, Rgb, Vec2, Vec4 } from '@endfield-noclip/package-format/values';

import type { MaterialReader } from '../material-values.ts';

/** per-patch heightfield parameters from `FBDynamicSceneSludgeComp` */
export interface SludgePatchParams {
	sludgeSize: number;
	sizeY: number;
	clipPlane0: number;
	clipPlane1: number;
}

/** synthetic texture slot name injected onto a sludge material variant for its patch heightmap */
export const SLUDGE_HEIGHTMAP_SLOT = '_SludgeHeightmap';

const rgb = (reader: MaterialReader, name: string): Rgb => {
	const v = reader.hdrColor(name) ?? [1, 1, 1, 1];
	return [v[0], v[1], v[2]];
};

const rgba = (reader: MaterialReader, name: string): Color => {
	const v = reader.hdrColor(name) ?? [1, 1, 1, 1];
	return [v[0], v[1], v[2], v[3]];
};

const vec2 = (reader: MaterialReader, name: string): Vec2 => {
	const v = reader.vector(name) ?? [0, 0, 0, 0];
	return [v[0], v[1]];
};

const vec4 = (reader: MaterialReader, name: string, fallback: Vec4): Vec4 => {
	const v = reader.vector(name) ?? fallback;
	return [v[0], v[1], v[2], v[3]];
};

/**
 * `HGRP/SludgeV2` (`docs/game-data/scene-states.md#sludge-and-miasma`): spray-clearable sludge surfaces.
 * per-patch heightmap dimensions and clip planes are folded in by {@link placedSludge}
 *
 * @param reader the material's properties
 * @returns its surface
 */
export const describeSludge = (reader: MaterialReader): SludgeSurface => {
	const { float } = reader;
	const slot = (name: string) => reader.slot(name) ?? null;
	return {
		kind: 'sludge',
		textures: {
			main: slot('_MainTex'),
			main2: slot('_MainTex2'),
			main3: slot('_MainTex3'),
			line: slot('_LineTex'),
			edge: slot('_EdgeTex'),
			heightmap: slot(SLUDGE_HEIGHTMAP_SLOT),
		},
		sludgeSize: 32,
		sizeY: 1,
		clipPlane0: 1 << 19,
		clipPlane1: 1 << 19,
		baseColor: rgb(reader, '_BaseColor'),
		baseColor2: rgb(reader, '_BaseColor2'),
		emissiveColor: rgb(reader, '_EmissiveColor'),
		lineColor: rgba(reader, '_LineColor'),
		edgeColor: rgba(reader, '_EdgeColor'),
		colorAlbedoPercent: float('_ColorAlbedoPercent', 1),
		colorEmissivePercent: float('_ColorEmissivePercent', 0),
		metallic: float('_Metallic', 0),
		roughnessMin: float('_RoughnessMin', 0),
		roughnessMax: float('_RoughnessMax', 1),
		occlusionStrength: float('_OcclusionStrength', 1),
		vertNormalOffset: float('_VertNormalOffset', 0),
		main3UseDisturb: float('_MainTex3UseDisturb', 1),
		lineRange: float('_LineRange', 0.8),
		lineRangeOut: float('_LineRangeOut', 0.08),
		lineRangeIn: float('_LineRangeIn', 0),
		edgeRange: float('_EdgeRange', 0.25),
		edgeAlpha: float('_EdgeAlpha', 1),
		speeds: {
			main: vec2(reader, '_MainTexUVSpeed'),
			main2: vec2(reader, '_MainTex2UVSpeed'),
			main3: vec2(reader, '_MainTex3UVSpeed'),
			line: vec2(reader, '_LineTexUVSpeed'),
			edge: vec2(reader, '_EdgeTexUVSpeed'),
		},
		wave: {
			intensity: vec4(reader, '_WaveIntensity', [1, 0, 0, 0]),
			length: vec4(reader, '_WaveLength', [1, 0, 0, 0]),
			speed: vec4(reader, '_WaveSpeed', [1, 0, 0, 0]),
		},
	};
};

/**
 * folds a `SludgeComp`'s patch dimensions and clip planes into a described {@link SludgeSurface}
 *
 * @param surface the base sludge surface
 * @param params the patch's dimensions and clip planes
 * @returns a new surface carrying the patch's parameters
 */
export const placedSludge = (surface: SludgeSurface, params: SludgePatchParams): SludgeSurface => ({
	...surface,
	sludgeSize: params.sludgeSize,
	sizeY: params.sizeY,
	clipPlane0: params.clipPlane0,
	clipPlane1: params.clipPlane1,
});
