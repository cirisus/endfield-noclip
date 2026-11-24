import type { RadialBlurSurface } from '@endfield-noclip/package-format/surfaces';

import {
	EffectKind,
	type EffectLook,
	EffectRow,
	emptyEffect,
	setNear,
	setSlot,
	SlotSource,
} from './effect-look.ts';

/**
 * float offsets of a VFXRadialBlur look's parameters. the UV, scroll, slot bit, soft blend, near fade and
 * unfogged rows are {@link EffectRow}'s; slot 0 is `_MaskTex`
 */
export const RadialBlurRow = {
	/**
	 * `_RadialBlurIntensity`, `_Power`, `_TintColorAlpha`, 1 when `_InParticle` scales intensity by vertex
	 * alpha
	 */
	blur: 68,
	/**
	 * 1 when `_RadialBlurWithScreenDepth` divides power by centre view depth, 1 with a mask, 1 with
	 * `_USE_DIRECTIONAL_BLUR`, 0
	 */
	options: 72,
	/** `_CanterOffset` xy, directional blur unit vector xy */
	center: 76,
} as const;

/**
 * a VFXRadialBlur layer ({@link RadialBlurSurface}). it samples the composited scene, so it draws in the
 * refraction pass after compositing
 *
 * @param surface the layer
 * @returns its look
 */
export const radialBlurLook = (surface: RadialBlurSurface): EffectLook => {
	const look = emptyEffect();
	const { params } = look;
	const { mask } = surface;
	if (mask !== null) {
		const source = mask.texture.source === 'polar' ? SlotSource.Polar : SlotSource.Uv0;
		setSlot(look, 0, mask.texture, source * 32 + (mask.redAlpha ? 16 : 0));
	}
	params.set(
		[surface.intensity, surface.power, surface.alpha, surface.inParticle ? 1 : 0],
		RadialBlurRow.blur,
	);
	params.set(
		[surface.withScreenDepth ? 1 : 0, mask === null ? 0 : 1, surface.direction === null ? 0 : 1, 0],
		RadialBlurRow.options,
	);
	params.set([...surface.centerOffset, ...(surface.direction ?? [0, 0])], RadialBlurRow.center);
	params[EffectRow.soft] = surface.softDistance;
	setNear(look, surface.near);
	params.set([1, EffectKind.RadialBlur, 0, 0], EffectRow.unfogged);
	return look;
};
