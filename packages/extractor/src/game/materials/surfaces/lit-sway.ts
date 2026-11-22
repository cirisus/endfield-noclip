import type { LitSway, LitVertexOffset } from '@endfield-noclip/package-format/surfaces';

import type { MaterialReader } from '../material-values.ts';

/**
 * `_SIMPLE_VERTEXANIM`'s sway: the cloth's (`docs/game-data/materials.md#swaying-cloth`) or the pendulum's
 * (`#swinging-pendulums`). `_GPU_CLOTH` materials sway too: that keyword only lets an entity with a cloth
 * simulation replace the position the sway is added to
 *
 * @param reader an `HGRP/Lit` material's properties
 * @returns its sway, or `null` when it keeps still or sways in a way the viewer doesn't draw (the rope, a
 *   pendulum with gravity or its own anchor), which its surface lists as a gap
 */
export const swayOf = (reader: MaterialReader): LitSway | null => {
	const { float, has } = reader;
	const intensity = float('_SimpleVertexAnimationWindIntensity', 0);
	// the shader skips the sway when this sum is zero; the noise offset itself moves nothing in these variants
	const enabled = intensity + float('_NoiseOffsetIntensity', 0) !== 0;
	if (!has('_SIMPLE_VERTEXANIM') || !enabled) {
		return null;
	}
	let direction: LitSway['direction'] = null;
	if (float('_Use_Custom_WindDir', 0) !== 0) {
		// the shader approximates cos and sin by their Taylor series; at authored angles they agree to 1e-3
		const angle = (float('_MainDirectionAngle', 0) * Math.PI) / 180;
		direction = [Math.cos(angle), Math.sin(angle)];
	}
	const frequency = float('_SimpleVertexAnimationWindFreq', 1);
	if (has('_SIMPLE_VERTEXANIM_CLOTH')) {
		return {
			kind: 'cloth',
			intensity,
			frequency,
			softness: float('_SimpleVertexAnimationWindSoftFactor', 0),
			kite: float('_Kite', 0),
			tendency: float('_DirectionTendency', 0),
			direction,
		};
	}
	// a pendulum that doesn't swing still turns about +Y in the game; none on map02 does, and the viewer
	// draws neither
	if (has('_SIMPLE_VERTEXANIM_PENDULUM') && intensity !== 0 && !pendulumGap(reader)) {
		return {
			kind: 'pendulum',
			intensity,
			frequency,
			spinFrequency: float('_SelfRotationSpeed', 0),
			// the shader's degree factor is π/180 to 1e-4, halved
			spinRange: (float('_SelfRotationRange', 0) * Math.PI) / 360,
			stability: float('_Stability', 0),
			direction,
		};
	}
	return null;
};

/**
 * @param reader an `HGRP/Lit` material with `_SIMPLE_VERTEXANIM_PENDULUM`
 * @returns whether its swing takes inputs the viewer doesn't read: gravity, or an anchor of its own
 */
const pendulumGap = (reader: MaterialReader): boolean =>
	reader.has('_SIMPLE_VERTEXANIM_USE_GRAVITY') || reader.float('_Use_Custom_Anchor', 0) !== 0;

/**
 * `_USE_VERTOFFSET`'s offset by a scrolling texture, with `_USE_VERTOFFSETMASK`'s mask
 * (`docs/game-data/materials.md#vertex-offset`). a fractional `_OffsetUVSet`, which the shader blends the two
 * UV sets by, reads as the nearer set
 *
 * @param reader an `HGRP/Lit` material's properties
 * @returns its vertex offset, or `null` without the keyword, without an offset texture, or with a mask
 *   keyword whose unset texture doesn't read as white
 */
export const vertexOffsetOf = (reader: MaterialReader): LitVertexOffset | null => {
	const { float, colorOrVector: vector, has, slot, shader } = reader;
	const texture = slot('_OffsetTex');
	if (!has('_USE_VERTOFFSET') || texture === undefined) {
		return null;
	}
	const uv = float('_OffsetUVSet', 0) >= 0.5 ? 1 : 0;
	let mask: LitVertexOffset['mask'] = null;
	if (has('_USE_VERTOFFSETMASK')) {
		const maskTexture = slot('_OffsetMaskTex');
		if (maskTexture !== undefined) {
			const speed = vector('_OffsetMaskSpeed') ?? [0, 0, 0, 0];
			mask = {
				texture: { ...maskTexture, uv },
				scroll: [speed[0], speed[1]],
				strength: float('_OffsetMaskPower', 0) * 0.2,
			};
		} else if (shader.textures['_OffsetMaskTex'] !== 'white') {
			return null;
		}
	}
	// the shader tests for 1 and 2 exactly, and reads any other value as object space
	let space: LitVertexOffset['space'] = 'object';
	switch (float('_OffsetSwitchDir', 0)) {
		case 1: {
			space = 'world';
			break;
		}
		case 2: {
			space = 'normal';
			break;
		}
		default: {
			break;
		}
	}
	const direction = vector('_OffsetDir') ?? [0, 0, 0, 0];
	const speed = vector('_OffsetSpeed') ?? [0, 0, 0, 0];
	return {
		texture: { ...texture, uv },
		scroll: [speed[0], speed[1]],
		direction: [direction[0], direction[1], direction[2]],
		space,
		intensity: float('_OffsetIntensity', 0),
		bias: float('_Bi_Offset', 0),
		vertexAlphaWeight: float('_UseVertexColorMask', 0) > 0,
		mask,
	};
};
