import type { LightBeamSurface } from '@endfield-noclip/package-format/surfaces';

import { EffectKind, type EffectLook, EffectRow, emptyEffect } from './effect-look.ts';

/**
 * float offsets of a light beam's parameters ({@link lightBeamLook}), in place of {@link EffectRow}'s rows
 * 0–9. lengths are in the beam's own units, before its transform's scale. row 31 is shared
 */
export const BeamRow = {
	/** `_ColorFlat`: linear colour, alpha */
	color: 0,
	/** `_ConeParams0`: start and end radius, the side's normal (cosine and sine of the half angle) */
	cone: 4,
	/** `_ConeParams1`: the beam's direction xyz, 1 when the start cap is drawn */
	direction: 8,
	/** `_DistanceFallOff`: attenuation start and end, length, the fade-in length from the start (0: none) */
	falloff: 12,
	/** `_AlphaInside`, `_AlphaOutside`, `_AttenuationLerpLinearQuad`, `_FresnelPow` */
	alpha: 16,
	/** `_GlareFrontal`, `_GlareBehind`, the apex's offset behind the start (`_ConeGeomProps`), `_BlendMode` */
	glare: 20,
	/** distance fade start and end, second start and end (camera to the beam's origin, m) */
	fade: 24,
	/**
	 * the near camera fade's length (`_DistanceCamClipping`), the depth blend distance (0 without
	 * `VLB_DEPTH_BLEND`), `_DepthBlendCapOff`, `_UseClippingPlane`
	 */
	clip: 28,
	/** `_AdditionalClippingPlaneWS`: world-space normal, offset */
	plane: 32,
	/** `_TiltVectorX`, `_TiltVectorY`, `_ClippingPlaneTransition`, 0 */
	tilt: 36,
} as const;

/**
 * a volumetric light beam ({@link LightBeamSurface}), drawn on its cone mesh
 *
 * @param beam the beam
 * @returns its look
 */
export const lightBeamLook = (beam: LightBeamSurface): EffectLook => {
	const look = emptyEffect();
	const params = look.params;
	const additive = beam.additive ? 1 : 0;
	params.set(beam.color, BeamRow.color);
	params.set(beam.cone, BeamRow.cone);
	params.set(beam.direction, BeamRow.direction);
	params.set(beam.falloff, BeamRow.falloff);
	params.set([beam.alphaInside, beam.alphaOutside, beam.attenuationLerp, beam.fresnelPower], BeamRow.alpha);
	params.set([beam.glareFrontal, beam.glareBehind, beam.apexOffset, additive], BeamRow.glare);
	params.set([...beam.distanceFade, ...beam.distanceFadeSecond], BeamRow.fade);
	params.set(
		[beam.cameraClipping, beam.depthBlend, beam.depthBlendCapOff, beam.useClippingPlane],
		BeamRow.clip,
	);
	params.set(beam.clippingPlane, BeamRow.plane);
	params.set([...beam.tilt, beam.clippingPlaneTransition], BeamRow.tilt);
	params.set([beam.unfogged ? 1 : 0, EffectKind.Beam, additive, 0], EffectRow.unfogged);
	return look;
};
