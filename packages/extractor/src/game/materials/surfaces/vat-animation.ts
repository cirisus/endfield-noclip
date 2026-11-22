import type { UnsupportedSurface } from '@endfield-noclip/package-format/surfaces';

import { softBodyHdr, vatPadding } from '../effects/soft-body.ts';
import { type MaterialReader, unsupported } from '../material-values.ts';

/**
 * `HGRP/Lit`'s Houdini vertex animations (`docs/game-data/materials.md#vertex-animation-textures`), which
 * move the mesh by a position and a rotation texture
 */
export interface VatAnimation {
	/**
	 * `rigid` (`_VAT_RIGIDBODY`): each piece of the mesh moves rigidly about its pivot. `soft`
	 * (`_VAT_SOFTBODY`): each vertex moves by its own offset, and its normal and tangent are the rotation's
	 */
	body: 'rigid' | 'soft';
	/** `_PositionTexture`'s texture (an id of the material's slots) */
	position: number;
	/** `_RotationTexture`'s texture */
	rotation: number;
	/** `_frameCount` */
	frameCount: number;
	/** loops per second, negative when it plays backwards: `_houdiniFPS / (_frameCount − 0.01) · _playbackSpeed` */
	cycleRate: number;
	/** `_gameTimeAtFirstFrame`, the game time its loop starts at */
	cycleStart: number;
	/**
	 * the first frame takes its texels rather than the rest pose: `_B_animateFirstFrame`, always for a soft
	 * body
	 */
	animateFirstFrame: boolean;
	/** the factors on the texel column and on the row's span, from `_boundMinZ` and `_boundMaxX` */
	uScale: number;
	vScale: number;
	/**
	 * the position texture's offsets are `min + texel · range`: the texel itself for HDR textures
	 * (`_TextureFormat` 1), a fraction of the bounds for 8-bit ones, whose rotations are stored as `q / 2 +
	 * 0.5`
	 */
	min: [x: number, y: number, z: number];
	range: [x: number, y: number, z: number];
	hdr: boolean;
	/** `_globalPscaleMul`, scaling every piece; 1 for a soft body */
	scale: number;
	/**
	 * `_VATMaxPieceScale` when the position texture's alpha holds each piece's scale (`_pScaleInPosA`), else
	 * `null` (always for a soft body)
	 */
	maxPieceScale: number | null;
}

/** the keywords of {@link VatAnimation}'s bodies */
export const VAT_KEYWORDS = { rigid: '_VAT_RIGIDBODY', soft: '_VAT_SOFTBODY' } as const;

/**
 * @param reader an `HGRP/Lit` material's properties
 * @returns its vertex animation, `unsupported` for the cases the viewer doesn't play, or `null` without
 *   either keyword
 */
export const vatOf = (reader: MaterialReader): VatAnimation | UnsupportedSurface | null => {
	const { float, has, slot } = reader;
	let body: VatAnimation['body'];
	if (has(VAT_KEYWORDS.rigid)) {
		body = 'rigid';
	} else if (has(VAT_KEYWORDS.soft)) {
		body = 'soft';
	} else {
		return null;
	}
	const name = body === 'rigid' ? 'a rigid-body animation' : 'a soft-body animation';
	if (has('_UNLOAD_ROT_TEX')) {
		return unsupported(`${name} without its rotation texture`);
	}
	if (float('_HoudiniVATInParticle', 0) !== 0) {
		return unsupported(`${name} driven by particle data`);
	}
	if (float('_B_autoPlayback', 0) === 0) {
		return unsupported(`${name} whose frame is set per draw`);
	}
	if (float('_BlendMeshNormalAndTangent', 0) !== 0) {
		return unsupported(`${name} that keeps the mesh normals`);
	}
	const position = slot('_PositionTexture');
	const rotation = slot('_RotationTexture');
	if (position === undefined || rotation === undefined) {
		return unsupported(`${name} without its position or rotation texture`);
	}
	const frameCount = Math.max(Math.round(float('_frameCount', 0)), 1);
	const min: VatAnimation['min'] = [float('_boundMinX', 0), float('_boundMinY', 0), float('_boundMinZ', 0)];
	const max = [float('_boundMaxX', 0), float('_boundMaxY', 0), float('_boundMaxZ', 0)];
	const hdr = softBodyHdr(reader);
	const rigid = body === 'rigid';
	return {
		body,
		position: position.texture,
		rotation: rotation.texture,
		frameCount,
		cycleRate: (float('_houdiniFPS', 0) / (frameCount - 0.01)) * float('_playbackSpeed', 1),
		cycleStart: float('_gameTimeAtFirstFrame', 0),
		animateFirstFrame: !rigid || float('_B_animateFirstFrame', 0) !== 0,
		uScale: vatPadding(min[2]),
		vScale: vatPadding(max[0]),
		min: hdr ? [0, 0, 0] : min,
		range: hdr ? [1, 1, 1] : [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
		hdr,
		scale: rigid ? float('_globalPscaleMul', 1) : 1,
		maxPieceScale: rigid && float('_pScaleInPosA', 0) !== 0 ? float('_VATMaxPieceScale', 1) : null,
	};
};
