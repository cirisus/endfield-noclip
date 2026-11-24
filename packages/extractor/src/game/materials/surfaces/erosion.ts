import type { TextureSlot } from '@endfield-noclip/package-format/materials';
import type { ErosionDynamicSurface, ErosionSurface } from '@endfield-noclip/package-format/surfaces';
import type { Rgb, Vec4 } from '@endfield-noclip/package-format/values';

import { tiledSlot } from '../describe-steps.ts';
import { linearRgb, type MaterialReader } from '../material-values.ts';

const tiled = (reader: MaterialReader, name: string, tiling: string | null): TextureSlot | null => {
	const slot = reader.slot(name);
	return slot === undefined ? null : tiledSlot(slot, tiling === null ? 1 : reader.float(tiling, 1), 0);
};

const hdr = (reader: MaterialReader, name: string): Rgb => {
	const value = reader.hdrColor(name) ?? [1, 1, 1, 1];
	return [value[0], value[1], value[2]];
};

/**
 * `HGRP/Erosion` (`docs/game-data/materials.md#erosion`). every map samples UV set 0 and tiles by its own
 * property rather than its `_ST`; the metal, noise and flow colours are HDR and used as stored
 *
 * @param reader the material's properties
 * @returns its surface
 */
export const describeErosion = (reader: MaterialReader): ErosionSurface => {
	const { float, color } = reader;
	return {
		kind: 'erosion',
		textures: {
			baseNormal: tiled(reader, '_BaseNormalMap', '_BaseNormalTilling'),
			metalMix: tiled(reader, '_MetalMixMap', null),
			flowRamp: tiled(reader, '_FlowRampMap', null),
			detailNormal: tiled(reader, '_DetailNormalMap', '_DetailNormalTilling'),
			noisePattern: tiled(reader, '_NoisePatternMap', '_NoisePatternMapTilling'),
		},
		baseColor: linearRgb(color('_BaseColor') ?? [1, 1, 1, 1]),
		roughness: float('_Roughness', 0),
		detailRoughnessCover: float('_DetailRoughnessCover', 0),
		metallic: float('_Metallic', 0),
		metallicOffset: float('_MetallicOffset', 0),
		metallicColor: hdr(reader, '_MetallicColor'),
		normalScale: float('_NormalScale', 1),
		detailNormalScale: float('_DetailNormalScale', 1),
		occlusionStrength: float('_OcclusionStrength', 1),
		f0: 0.08 * float('_Specular', 0.5),
		noise: {
			depth: float('_NoiseStrength', 0),
			tint: hdr(reader, '_NoisePatternTintColor'),
			alphaTint: hdr(reader, '_NoisePatternAlphaTintColor'),
			min: float('_NoiseMin', 0),
			emissiveStrength: float('_NoiseEmissiveStrength', 0),
			fadeDistance: float('_DistanceBlend', 1),
		},
		flow: {
			tiling: float('_FlowNormalTilling', 0),
			noiseStrength: float('_FlowNoiseStrength', 0),
			// 0.05 · speed per second (docs/game-data/materials.md#clock)
			scroll: 0.05 * float('_FlowNormalSpeed', 0),
			speedOffset: float('_FlowSpeedOffset', 0),
			colorOffset: float('_FlowColorOffset', 0),
			top: hdr(reader, '_FlowTopColor'),
			bottom: hdr(reader, '_FlowBottomColor'),
			colorStrength: float('_FlowColorStrength', 0),
			emissiveStrength: float('_FlowColorEmissiveStrength', 0),
			roughness: float('_FlowRoughness', 0),
		},
	};
};

/**
 * `HGRP/ErosionDynamic` (`docs/game-data/materials.md#erosion`): clearable blight patches with a colour LUT,
 * matcap normal, animated ripples and flowing bands. every colour is HDR and used as stored
 *
 * @param reader the material's properties
 * @returns its surface
 */
export const describeErosionDynamic = (reader: MaterialReader): ErosionDynamicSurface => {
	const { float, vector } = reader;
	const rippleConfig = (name: string): Vec4 => {
		const value = vector(name) ?? [1, 1, 1, 1];
		return [value[0], value[1], value[2], value[3]];
	};
	return {
		kind: 'erosionDynamic',
		textures: {
			colorLut: tiled(reader, '_ColorLUTMap', null),
			baseNormal: tiled(reader, '_BaseNormalMap', '_BaseNormalTilling'),
			metalMix: tiled(reader, '_MetalMixMap', null),
			flowRamp: tiled(reader, '_FlowRampMap', null),
			detailNormal: tiled(reader, '_DetailNormalMap', '_DetailNormalTilling'),
			noisePattern: tiled(reader, '_NoisePatternMap', '_NoisePatternMapTilling'),
			matcapNormal: tiled(reader, '_MatcapNormalMap', null),
		},
		baseColor: hdr(reader, '_BaseColor'),
		roughness: float('_Roughness', 0),
		detailRoughnessCover: float('_DetailRoughnessCover', 0),
		metallic: float('_Metallic', 0),
		metallicOffset: float('_MetallicOffset', 0),
		normalScale: float('_NormalScale', 1),
		detailNormalScale: float('_DetailNormalScale', 1),
		// (_DetailNormalSpeed * 0.1) * (time * 0.05)
		detailNormalScroll: 0.005 * float('_DetailNormalSpeed', 0),
		occlusionStrength: float('_OcclusionStrength', 1),
		noise: {
			depth: float('_NoiseStrength', 0.9),
			tint: hdr(reader, '_NoisePatternTintColor'),
			colorMode: float('_NoiseColorMode', 0),
			min: float('_NoiseMin', 0.1),
			emissiveStrength: float('_NoiseEmissiveStrength', 0.2),
			fadeDistance: float('_DistanceBlend', 1),
		},
		flow: {
			tiling: float('_FlowNormalTilling', 0.1),
			noiseStrength: float('_FlowNoiseStrength', 0.1),
			scroll: 0.05 * float('_FlowNormalSpeed', 1),
			speedOffset: float('_FlowSpeedOffset', 0),
			colorOffset: float('_FlowColorOffset', 0),
			top: hdr(reader, '_FlowTopColor'),
			bottom: hdr(reader, '_FlowBottomColor'),
			colorStrength: float('_FlowColorStrength', 0.1),
			roughness: float('_FlowRoughness', 0.1),
			roughnessOffset: float('_FlowRoughnessOffset', 0),
		},
		matcap: {
			tiling: float('_MatcapNormalTilling', 1),
			strength: float('_MatcapNormalStrength', 0.1),
			areaOffset: float('_MatcapNormalAreaOffset', 0.1),
		},
		ripple: {
			configs: [
				rippleConfig('_RippleConfig0'),
				rippleConfig('_RippleConfig1'),
				rippleConfig('_RippleConfig2'),
			],
			width: float('_RippleWidth', 0.1),
			ringRatio: float('_RingRatio', 0.8),
			// (time * 0.05) * (_RippleSpeed * 2.0)
			speed: 0.1 * float('_RippleSpeed', 1),
			noiseStrength: float('_RippleNoiseStrength', 0.1),
			colorOffset: float('_RippleColorOffset', 0),
			top: hdr(reader, '_RippleTopColor'),
			bottom: hdr(reader, '_RippleBottomColor'),
		},
	};
};
