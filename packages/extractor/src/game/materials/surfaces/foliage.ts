/** the foliage shaders' inputs to the Lit model (`docs/game-data/materials.md#foliage`) */

import type {
	EmissiveFresnel,
	GrassInputs,
	LeafInputs,
	LitEmission,
	TrunkInputs,
} from '@endfield-noclip/package-format/surfaces';

import { linearRgb, type MaterialReader, scaleRgb } from '../material-values.ts';

/** `HGRP/Foliage/Leaf`'s inputs (`docs/game-data/materials.md#foliage`) */
export const leafInputsOf = (reader: MaterialReader): LeafInputs => {
	const { float, color, has } = reader;
	return {
		kind: 'leaf',
		occlusionShadow: float('_OcclusionShadow', 0),
		fakeShadow: {
			strength: float('_FakeDirectionalShadowStrength', 0),
			power: float('_FakeDirectionalShadowPow', 1),
		},
		diffuseUsesVertexNormal: float('_DiffuseUseVertexNormal', 0),
		twoSidedNormal: float('_TwoSidedNormal', 0) > 0,
		aoTransmission: [float('_AoAffectTransmissionStart', 0), float('_AoAffectTransmissionRange', 0.01)],
		aoSubsurface: [float('_AoAffectSubsurfaceStart', 0), float('_AoAffectSubsurfaceRange', 0.01)],
		subsurface: float('_SubsurfaceIntensity', 0),
		transmissionDistanceFade: float('_TransmissionDistanceFade', 0),
		canopy: has('_CANOPY_COLOR_RAMP')
			? {
					intensity: float('_CanopyRampIntensity', 0),
					startsAtTop: float('_CanopyRampStartAtTop', 0) > 0,
					range: float('_CanopyRampRange', 0),
					transition: float('_CanopyRampTransitionRange', 0),
					brighterScale: float('_CanopyRampColorBrighterScale', 1),
					cover: float('_CanopyRampColorCover', 0),
					color: linearRgb(color('_CanopyRampColor') ?? [1, 1, 1, 1]),
				}
			: null,
		blend: has('_BLEND_COLOR') ? leafBlendOf(reader) : null,
	};
};

const leafBlendOf = ({ float, color }: MaterialReader): NonNullable<LeafInputs['blend']> => {
	const blend = color('_BlendColor') ?? [1, 1, 1, 1];
	return {
		color: linearRgb(blend),
		strength: blend[3],
		normalAdd: float('_BlendNormalAdd', 0),
		normalPower: float('_BlendNormalPower', 1),
		withVertexNormal: float('_BlendWithVertexNormal', 0),
	};
};

/**
 * `HGRP/Foliage/Trunk`'s `_FOLIAGE_TRUNK` inputs (`docs/game-data/materials.md#foliage`)
 *
 * @param reader the material's properties
 * @returns the inputs, or `null` without the keyword
 */
export const trunkInputsOf = ({ float, color, has }: MaterialReader): TrunkInputs | null => {
	if (!has('_FOLIAGE_TRUNK')) {
		return null;
	}
	return {
		vertexAo: float('_TrunkVertexAoStrength', 0),
		ramp:
			float('_EnableTrunkRamp', 0) > 0.5
				? {
						color: linearRgb(color('_TrunkRampColor') ?? [1, 1, 1, 1]),
						intensity: float('_TrunkRampIntensity', 0),
						range: float('_TrunkRampRange', 0),
						transition: float('_TrunkRampTransitionRange', 0),
					}
				: null,
	};
};

/**
 * `HGRP/Foliage/Grass` and its card LOD's inputs (`docs/game-data/materials.md#foliage`). the card LOD
 * decodes its normal map its own way and masks by the normal map's B, so it takes neither the bend nor the
 * masks
 */
export const grassInputsOf = (reader: MaterialReader, card: boolean): GrassInputs => {
	const { float, vector, has } = reader;
	// the ramps' floors are stored as strengths, so a missing vector stays neutral
	const ao = vector('_AoParams') ?? [0, 0, 1, 0];
	const dir = vector('_DirParams') ?? [0, 0, 1, 0];
	return {
		kind: 'grass',
		bendNormalUpward: card ? 0 : float('_BendNormalUpward', 0),
		cameraLean: has('_USE_CAMERA_BASED_TILLING') ? float('_CameraBasedTillingIntensity', 0) : 0,
		maskOnDiffuse: card ? 0 : float('_MaskOnDiffuse', 0),
		maskOnTransmission: card ? 0 : float('_MaskOnTransmission', 0),
		twoSidedNormal: !card && float('_TwoSidedNormal', 0) > 0,
		subsurface: float('_SubsurfaceIntensity', 0),
		ao: [ao[0], ao[1], 1 - ao[2]],
		sunMask: [dir[0], dir[1], 1 - dir[2]],
	};
};

/**
 * `HGRP/Foliage/MushroomAnimation`'s no-map emission and optional Fresnel rim glow
 * (`docs/game-data/materials.md#mushroom-animation`). scales both by the resting interactive intensity when
 * `_EnableInteractiveEmissive` is set
 *
 * @param reader an `HGRP/Foliage/MushroomAnimation` material's properties
 * @returns its emission, or `null` when both base and Fresnel colours are black
 */
export const mushroomEmissionOf = (reader: MaterialReader): LitEmission | null => {
	const { float } = reader;
	const restScale =
		float('_EnableInteractiveEmissive', 0) > 0.5 ? float('_CharacterOutEmissiveIntensity', 0) : 1;
	const baseColor = scaleRgb(reader.hdrColor('_NoMapEmissiveColor') ?? [0, 0, 0, 1], restScale);
	const mode = float('_EmissiveNoMapMode', 0);
	// mode 0 reads base alpha (channel 1); mode 2 reads normal alpha (channel 3); mode 1 (vertex colour) is
	// unread and unused on map02
	let maskChannel = 0;
	if (mode < 0.5) {
		maskChannel = 1;
	} else if (mode >= 1.5) {
		maskChannel = 3;
	}
	const hasBase = maskChannel > 0 && baseColor.some((value) => value !== 0);

	let fresnel: EmissiveFresnel | null = null;
	if (float('_UseEmissiveNoMapFresnel', 0) > 0.5) {
		const color = scaleRgb(reader.hdrColor('_EmissiveNoMapFresnelColor') ?? [0, 0, 0, 1], restScale);
		if (color.some((value) => value !== 0)) {
			fresnel = {
				color,
				bias: float('_EmissiveNoMapFresnelBias', 0),
				power: float('_EmissiveNoMapFresnelPower', 1),
				useVertexNormal: float('_EmissiveNoMapFresnelUseVertexNormal', 0),
				vertexGreen: float('_EmissiveNoMapFresnelVertexG', 0),
			};
		}
	}
	if (!hasBase && fresnel === null) {
		return null;
	}
	return {
		color: hasBase ? baseColor : [0, 0, 0],
		source: 'mask',
		maskChannel: hasBase ? maskChannel : 0,
		channels: null,
		albedoAffect: float('_NoMapAlbedoAffectEmissive', 1),
		ignorePostExposure: float('_NoMapIgnorePostExposure', 1),
		albedoTint: null,
		pulse: null,
		breath: null,
		...(fresnel !== null ? { fresnel } : {}),
	};
};
