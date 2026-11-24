import type { WaterDecal } from '@endfield-noclip/formats/endfield/init-chunk-data';
import type {
	EffectTexture,
	UnsupportedSurface,
	WaterBase2,
	WaterBubble,
	WaterErosion,
	WaterErosionLayer,
	WaterFloatingLayers,
	WaterFoamSurface,
} from '@endfield-noclip/package-format/surfaces';
import type { Rgb } from '@endfield-noclip/package-format/values';

import { undrawnKeywords } from '../describe-steps.ts';
import { isUnsupported, type MaterialReader, unsupported } from '../material-values.ts';

import { dissolveOf, disturbIntensityOf, effectTexture, speedOf, UNSET_WHITE } from './effect-steps.ts';

/**
 * @param placement a static WaterDecal box's renderer values
 * @returns whether they leave its material as it is
 */
export const isNeutralWaterDecal = (placement: WaterDecal): boolean =>
	[...placement.params, ...placement.displacementTint].every((value) => value === 1);

const tintRgb = (rgb: Rgb, tint: readonly number[]): Rgb => [
	rgb[0] * tint[0],
	rgb[1] * tint[1],
	rgb[2] * tint[2],
];

/**
 * a static box's foam under its renderer values: the tiling scales the base map's UVs, the speed its scroll,
 * and the opacity, brightness and tint the whole output, all colour terms with it. the displacement is left
 * out with the displacement pass
 *
 * @param foam the box material's foam
 * @param placement the box's renderer values
 * @returns the foam the box draws
 */
export const placedWaterFoam = (foam: WaterFoamSurface, placement: WaterDecal): WaterFoamSurface => {
	const [tiling, speed, opacity, brightness] = placement.params;
	const [, ...tint] = placement.displacementTint;
	const { base } = foam.textures;
	return {
		...foam,
		textures: {
			...foam.textures,
			base: {
				...base,
				scale: [base.scale[0] * tiling, base.scale[1] * tiling],
				scroll: [base.scroll[0] * speed, base.scroll[1] * speed],
			},
		},
		baseColor: tintRgb(foam.baseColor, tint),
		tint: tintRgb(foam.tint, tint),
		opacity: foam.opacity * opacity * brightness,
		bubble: foam.bubble == null ? null : { ...foam.bubble, color: tintRgb(foam.bubble.color, tint) },
		floating:
			foam.floating == null
				? null
				: {
						...foam.floating,
						color: tintRgb(foam.floating.color, tint),
						colorDark: tintRgb(foam.floating.colorDark, tint),
					},
		base2:
			foam.base2 == null
				? null
				: {
						...foam.base2,
						texture: {
							...foam.base2.texture,
							scale: [foam.base2.texture.scale[0] * tiling, foam.base2.texture.scale[1] * tiling],
							scroll: [foam.base2.texture.scroll[0] * speed, foam.base2.texture.scroll[1] * speed],
						},
						tint: tintRgb(foam.base2.tint, tint),
					},
	};
};

/** WaterDecal keywords that are drawn; `_BLEND_BASECOLOR` must be among them */
const WATER_FOAM_KEYWORDS = new Set([
	'_BLEND_BASECOLOR',
	'_BLEND_BASECOLOR2',
	// the displacement pass raises the water's surface under the box; the foam is drawn without it
	'_BLEND_DISPLACEMENT',
	'_USE_DISTURB',
	'_USE_MASK',
	'_USE_SOFTBLEND',
	'_USE_DISSOLVE',
	'_USE_WATER_EROSION',
	'_USE_BUBBLE',
	'_USE_TWO_LAYER_FLOATING_MAP',
]);

/**
 * a texture an erosion layer reads by UV0 times a `*Movement` vector's zw, scrolled by its xy, without its
 * `_ST`
 */
const movedTexture = (reader: MaterialReader, name: string, movement: string): EffectTexture => {
	const moved = reader.colorOrVector(movement) ?? [0, 0, 1, 1];
	return {
		...effectTexture(reader.slot(name) ?? UNSET_WHITE),
		scale: [moved[2], moved[3]],
		offset: [0, 0],
		scroll: [moved[0], moved[1]],
	};
};

const rgbOf = (reader: MaterialReader, name: string): Rgb => {
	const c = reader.colorOrVector(name) ?? [0, 0, 0, 0];
	return [c[0], c[1], c[2]];
};

/**
 * @returns `_USE_WATER_EROSION`'s red tide, `null` without it, or `unsupported` when the textures it takes
 *   would exceed the look's slots (`WaterFoamSurface.erosion`)
 */
const erosionOf = (reader: MaterialReader): WaterErosion | null | UnsupportedSurface => {
	const { float, colorOrVector: color, has } = reader;
	if (!has('_USE_WATER_EROSION')) {
		return null;
	}
	// a distortion of zero moves nothing and an unset mask is white, so their slots are free for the erosion's
	if (has('_USE_DISSOLVE')) {
		return unsupported('_USE_WATER_EROSION with a dissolve');
	}
	if (has('_USE_BUBBLE') || has('_USE_TWO_LAYER_FLOATING_MAP') || has('_BLEND_BASECOLOR2')) {
		return unsupported('_USE_WATER_EROSION with bubble, floating, or second base colour');
	}
	if (has('_USE_DISTURB') && disturbIntensityOf(reader, 1).some((v) => v !== 0)) {
		return unsupported('_USE_WATER_EROSION with a distortion');
	}
	if (has('_USE_MASK') && reader.slot('_MaskTex') !== undefined) {
		return unsupported('_USE_WATER_EROSION with a mask texture');
	}
	const layer = (suffix: string): WaterErosionLayer => ({
		noise: movedTexture(reader, `_FlowGradientNoiseTex${suffix}`, `_FlowGradientMovement${suffix}`),
		color: rgbOf(reader, `_EdgeSharpColor${suffix}`),
		threshold: float(`_EdgeSharp${suffix}`, 0),
	});
	const noiseMovement = color('_FlowmapNoiseMovement') ?? [0, 0, 0, 0];
	return {
		flow: effectTexture(reader.slot('_FlowmapTex') ?? UNSET_WHITE),
		flowNoise: effectTexture(reader.slot('_FlowmapNoiseTex') ?? UNSET_WHITE, noiseMovement.slice(0, 2)),
		gradient: effectTexture(reader.slot('_FlowGradienteTex') ?? UNSET_WHITE),
		layers: [layer(''), layer('2'), layer('3')],
		noiseStrength: float('_FlowmapNoiseStrength', 0),
		flowShift: float('_FlowmapUVNoiseStrength', 0),
		distance: float('_FlowDistance', 1),
		offset: float('_FlowOffset', 0),
		edgeColor: rgbOf(reader, '_EdgeColor'),
	};
};

const bubbleOf = (reader: MaterialReader): WaterBubble | null => {
	const { float, has } = reader;
	if (!has('_USE_BUBBLE')) {
		return null;
	}
	return {
		texture: effectTexture(reader.slot('_AcidTexture') ?? UNSET_WHITE),
		color: rgbOf(reader, '_BubbleColor'),
		heightScale: float('_BubbleHeightScale', 0),
		speed: float('_BubbleSpeed', 0),
		randomFactor: float('_BubbleRandomFactor', 0),
		randomFactor2: float('_BubbleRandomFactor2', 0),
		peakTime: float('_BubblePeakTime', 0.8),
	};
};

const floatingOf = (reader: MaterialReader): WaterFloatingLayers | null => {
	const { float, has } = reader;
	if (!has('_USE_TWO_LAYER_FLOATING_MAP')) {
		return null;
	}
	const layerSlot = (name: string): EffectTexture | null => {
		const slot = reader.slot(name);
		return slot === undefined ? null : effectTexture(slot);
	};
	return {
		textures: [layerSlot('_ParallaxNoiseMap0'), layerSlot('_ParallaxNoiseMap1')],
		source: float('_ParallaxNoiseSwitchUV', 0),
		color: rgbOf(reader, '_ParallaxColor'),
		colorDark: rgbOf(reader, '_ParallaxColorDark'),
		layerOffset: float('_ParallaxLayerOffset', 0),
		strength: float('_ParallaxStrength', 0),
		strengthSpeed: float('_ParallaxStrengthSpeed', 0),
		useDisturb: float('_ParallaxUseDisturb', 0),
	};
};

const base2Of = (reader: MaterialReader): WaterBase2 | null | UnsupportedSurface => {
	const { float, has } = reader;
	if (!has('_BLEND_BASECOLOR2')) {
		return null;
	}
	if (has('_USE_BUBBLE')) {
		return unsupported('_BLEND_BASECOLOR2 with _USE_BUBBLE');
	}
	const tint = reader.colorOrVector('_BaseColorTint2') ?? [1, 1, 1, 1];
	return {
		texture: effectTexture(reader.slot('_BaseColorMap2') ?? UNSET_WHITE, speedOf(reader, '_BaseColorSpeed2')),
		source: float('_BaseColorSwitchUV2', 0),
		tint: [tint[0], tint[1], tint[2]],
		baseAlpha: float('_UseAChannelAsAlpha2', 1),
		disturbUse: float('_MainTexUseDisturb2', 1),
		mipBias: Math.floor(float('_Bias2', 0)),
	};
};

/**
 * `HGRP/WaterDecal`: foam projected onto the water surface inside a box, written into the water's foam colour
 * (`docs/game-data/water.md#waterdecal`)
 *
 * @param reader the material's properties
 * @returns its surface, or `unsupported` for the variants the viewer doesn't draw
 */
export const describeWaterFoam = (reader: MaterialReader): WaterFoamSurface | UnsupportedSurface => {
	// the pass fixes its premultiplied blend, so the material's blend properties don't say it
	const { float, colorOrVector: color, has } = reader;
	const keywords = undrawnKeywords(reader, WATER_FOAM_KEYWORDS);
	if (keywords !== null) {
		return keywords;
	}
	// without it the base colour map isn't blended in, and only `_BaseColor`'s constant would be written
	if (!has('_BLEND_BASECOLOR')) {
		return unsupported('no _BLEND_BASECOLOR');
	}
	let depthTest: WaterFoamSurface['depthTest'];
	{
		const zTest = float('_ZTest', 4);
		switch (zTest) {
			case 4: {
				depthTest = 'less-equal';
				break;
			}
			case 5: {
				depthTest = 'greater';
				break;
			}
			case 8: {
				depthTest = 'always';
				break;
			}
			default: {
				return unsupported(`_ZTest ${zTest}`);
			}
		}
	}
	const bias = Math.floor(float('_Bias', 0));
	const textureOf = (name: string, speed: string): EffectTexture =>
		effectTexture(reader.slot(name) ?? UNSET_WHITE, speedOf(reader, speed));
	const edgeRange = color('_EdgeFadeRange') ?? [0, 0, 0, 0];
	let dissolve: WaterFoamSurface['dissolve'] = null;
	if (has('_USE_DISSOLVE')) {
		// the edge colour is used as stored
		dissolve = { texture: textureOf('_DissolveTex', '_DissolveUVSpeed'), ...dissolveOf(reader, 1) };
	}
	const erosion = erosionOf(reader);
	if (isUnsupported(erosion)) {
		return erosion;
	}
	const base2 = base2Of(reader);
	if (isUnsupported(base2)) {
		return base2;
	}
	const base = color('_BaseColor') ?? [0, 0, 0, 0];
	const tint = color('_BaseColorTint') ?? [1, 1, 1, 1];
	return {
		kind: 'waterFoam',
		textures: {
			base: textureOf('_BaseColorMap', '_BaseColorSpeed'),
			// with the erosion they change nothing (`erosionOf`)
			disturb: has('_USE_DISTURB') && erosion === null ? textureOf('_DisturbTex1', '_DisturbUVSpeed1') : null,
			mask: has('_USE_MASK') && erosion === null ? textureOf('_MaskTex', '_MaskTexUVSpeed') : null,
		},
		sources: {
			base: float('_BaseColorSwitchUV', 0),
			disturb: float('_DisturbSwitchUV', 0),
			mask: float('_MaskUVSet', 0),
			dissolve: float('_DissolveSwitchUV', 0),
		},
		maskMatrix: color('_MaskTexUVRotateMatrix') ?? [1, 0, 0, 1],
		boxUv: color('_UVScaleOffset') ?? [1, 1, 0, 0],
		baseColor: [base[0], base[1], base[2]],
		tint: [tint[0], tint[1], tint[2]],
		baseAlpha: float('_UseAChannelAsAlpha', 0),
		maskAsAlpha: float('_UseMaskTexAsAlpha', 0),
		disturbBias: float('_Bi_Disturb', 0),
		disturb: disturbIntensityOf(reader, 1),
		disturbUse: [
			float('_MainTexUseDisturb', 0),
			float('_MaskTexUseDisturb', 0),
			float('_DissolveTexUseDisturb', 0),
		],
		edgeFade: float('_UseEdgeFade', 0) !== 0 ? [edgeRange[0], edgeRange[1]] : null,
		clipToBox: float('_MeshType', 0) !== 0,
		depthTest,
		mipBias: { base: Math.floor(float('_MinMipLevel', 0)) + bias, mask: bias, dissolve: bias },
		blendMode: float('_BlendMode', 0),
		opacity: float('_OverallOpacity', 1),
		soft: has('_USE_SOFTBLEND')
			? { distance: Math.max(float('_SoftDistance', 1), 1e-6), bias: float('_SoftBias', 0) }
			: null,
		dissolve,
		erosion,
		bubble: bubbleOf(reader),
		floating: floatingOf(reader),
		base2,
	};
};
