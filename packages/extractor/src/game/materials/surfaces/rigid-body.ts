import type { UnsupportedSurface } from '@endfield-noclip/package-format/surfaces';

import { softBodyHdr, vatPadding } from '../effects/soft-body.ts';
import { type MaterialReader, unsupported } from '../material-values.ts';

/**
 * `HGRP/Lit`'s `_VAT_RIGIDBODY` (`docs/game-data/materials.md#rigid-body-animation`): a Houdini vertex
 * animation that moves each piece of the mesh rigidly, by a position and a rotation texture
 */
export interface RigidBodyAnimation {
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
	/** `_B_animateFirstFrame`: the first frame takes its texels rather than the rest pose */
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
	/** `_globalPscaleMul`, scaling every piece */
	scale: number;
	/**
	 * `_VATMaxPieceScale` when the position texture's alpha holds each piece's scale (`_pScaleInPosA`), else
	 * `null`
	 */
	maxPieceScale: number | null;
}

/**
 * @param reader an `HGRP/Lit` material's properties
 * @returns its rigid-body animation, `unsupported` for the cases the viewer doesn't play, or `null` without
 *   the keyword
 */
export const rigidBodyOf = (reader: MaterialReader): RigidBodyAnimation | UnsupportedSurface | null => {
	const { float, has, slot } = reader;
	if (!has('_VAT_RIGIDBODY')) {
		return null;
	}
	if (has('_UNLOAD_ROT_TEX')) {
		return unsupported('a rigid-body animation without its rotation texture');
	}
	if (float('_HoudiniVATInParticle', 0) !== 0) {
		return unsupported('a rigid-body animation driven by particle data');
	}
	if (float('_B_autoPlayback', 0) === 0) {
		return unsupported('a rigid-body animation whose frame is set per draw');
	}
	if (float('_BlendMeshNormalAndTangent', 0) !== 0) {
		return unsupported('a rigid-body animation that keeps the mesh normals');
	}
	const position = slot('_PositionTexture');
	const rotation = slot('_RotationTexture');
	if (position === undefined || rotation === undefined) {
		return unsupported('a rigid-body animation without its position or rotation texture');
	}
	const frameCount = Math.max(Math.round(float('_frameCount', 0)), 1);
	const min: RigidBodyAnimation['min'] = [
		float('_boundMinX', 0),
		float('_boundMinY', 0),
		float('_boundMinZ', 0),
	];
	const max = [float('_boundMaxX', 0), float('_boundMaxY', 0), float('_boundMaxZ', 0)];
	const hdr = softBodyHdr(reader);
	return {
		position: position.texture,
		rotation: rotation.texture,
		frameCount,
		cycleRate: (float('_houdiniFPS', 0) / (frameCount - 0.01)) * float('_playbackSpeed', 1),
		cycleStart: float('_gameTimeAtFirstFrame', 0),
		animateFirstFrame: float('_B_animateFirstFrame', 0) !== 0,
		uScale: vatPadding(min[2]),
		vScale: vatPadding(max[0]),
		min: hdr ? [0, 0, 0] : min,
		range: hdr ? [1, 1, 1] : [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
		hdr,
		scale: float('_globalPscaleMul', 1),
		maxPieceScale: float('_pScaleInPosA', 0) !== 0 ? float('_VATMaxPieceScale', 1) : null,
	};
};
