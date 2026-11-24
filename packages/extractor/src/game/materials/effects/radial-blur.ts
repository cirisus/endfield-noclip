import type {
	RadialBlurSurface,
	RefractTexture,
	UnsupportedSurface,
} from '@endfield-noclip/package-format/surfaces';

import { undrawnBlend, undrawnKeywords } from '../describe-steps.ts';
import { type MaterialReader, unsupported } from '../material-values.ts';

import {
	degreesRotation,
	effectTexture,
	nearFadeOf,
	softBlendOf,
	speedOf,
	UNSET_WHITE,
} from './effect-steps.ts';

/** keywords of `HGRP/Effect/VFXRadialBlur` that are drawn */
const RADIAL_BLUR_KEYWORDS = new Set([
	'_USE_DIRECTIONAL_BLUR',
	'_USE_MASK',
	'_USE_POLARUV',
	'_USE_SOFTBLEND',
]);

/**
 * `HGRP/Effect/VFXRadialBlur`: a 5-tap radial or directional blur of the composited scene, optionally masked
 * (`docs/game-data/effects.md#radial-blur`)
 *
 * @param reader the material's properties
 * @returns its surface, or `unsupported`
 */
export const describeRadialBlur = (reader: MaterialReader): RadialBlurSurface | UnsupportedSurface => {
	const { float, colorOrVector, has } = reader;
	const undrawn = undrawnBlend(reader, ['alphaBlend']) ?? undrawnKeywords(reader, RADIAL_BLUR_KEYWORDS);
	if (undrawn !== null) {
		return undrawn;
	}
	const zTest = float('_ZTest', 4);
	let depthTest: RadialBlurSurface['depthTest'];
	switch (zTest) {
		case 4: {
			depthTest = 'less-equal';
			break;
		}
		case 0:
		case 8: {
			depthTest = 'always';
			break;
		}
		default: {
			return unsupported(`_ZTest ${zTest}`);
		}
	}
	let mask: RadialBlurSurface['mask'] = null;
	if (has('_USE_MASK')) {
		const bound = reader.slot('_MaskTex') ?? UNSET_WHITE;
		if (bound.uv !== 0) {
			return unsupported(`_MaskTex on UV set ${bound.uv}`);
		}
		const switched = float('_MaskSwitchUV', 0) !== 0;
		if (switched && !has('_USE_POLARUV')) {
			return unsupported('_MaskSwitchUV without polar UVs');
		}
		const texture: RefractTexture = {
			...effectTexture(
				bound,
				speedOf(reader, '_MaskTexUVSpeed'),
				degreesRotation(float('_MaskTexUVRotate', 0)),
			),
			source: switched ? 'polar' : 'uv0',
		};
		mask = { texture, redAlpha: float('_UseMaskTexAsAlpha', 1) !== 0 };
	}
	let direction: RadialBlurSurface['direction'] = null;
	if (has('_USE_DIRECTIONAL_BLUR')) {
		const raw = colorOrVector('_Direction') ?? [0, 0, 0, 0];
		const length = Math.hypot(raw[0], raw[1]);
		direction = length > 0 ? [raw[0] / length, raw[1] / length] : [0, 0];
	}
	const offset = colorOrVector('_CanterOffset') ?? [0, 0, 0, 0];
	return {
		kind: 'radialBlur',
		depthTest,
		intensity: float('_RadialBlurIntensity', 0.1),
		power: float('_Power', 1),
		alpha: float('_TintColorAlpha', 1),
		inParticle: float('_InParticle', 1) !== 0,
		withScreenDepth: float('_RadialBlurWithScreenDepth', 0) !== 0,
		centerOffset: [offset[0], offset[1]],
		direction,
		mask,
		softDistance: softBlendOf(reader)?.distance ?? 0,
		near: nearFadeOf(reader),
	};
};
