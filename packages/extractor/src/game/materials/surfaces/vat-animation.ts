import type { UnsupportedSurface } from '@endfield-noclip/package-format/surfaces';

import { softBodyHdr, vatPadding } from '../effects/soft-body.ts';
import { type MaterialReader, unsupported } from '../material-values.ts';

/**
 * `HGRP/Lit`'s vertex animations (`docs/game-data/materials.md#vertex-animation-textures`): Houdini's, which
 * move the mesh by a position and a rotation texture, or a bone animation stored as matrices
 */
export type VatAnimation = HoudiniVat | BoneVat;

/** a Houdini vertex animation, read from a position and a rotation texture */
export interface HoudiniVat {
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

/**
 * a bone animation (`_COMMONVAT_BONE_*`): each frame's row of the map holds every bone's 3 × 4 matrix, which
 * the vertices blend by their weights
 */
export interface BoneVat {
	body: 'bone';
	/** `_CommonVATMap`'s texture (an id of the material's slots) */
	map: number;
	/** the bones the map holds, a third of its width (`_CommonVATMapParams.x`) */
	boneCount: number;
	/** `_CommonVATMapParams.y`, the map's rows */
	frameCount: number;
	/** `_CommonVATFPS`, frames per second of the gameplay clock */
	frameRate: number;
	/** the bones each vertex blends, 1 to 4 from the keyword */
	influences: number;
}

/** the keywords of {@link HoudiniVat}'s bodies */
export const VAT_KEYWORDS = { rigid: '_VAT_RIGIDBODY', soft: '_VAT_SOFTBODY' } as const;

/** the keywords of {@link BoneVat}, by the bones each vertex blends */
export const BONE_VAT_KEYWORDS = [
	'_COMMONVAT_BONE_1',
	'_COMMONVAT_BONE_2',
	'_COMMONVAT_BONE_3',
	'_COMMONVAT_BONE_4',
] as const;

/**
 * @param reader an `HGRP/Lit` material's properties
 * @returns the vertex animation keyword it enables, `null` without one
 */
export const vatKeyword = (reader: MaterialReader): string | null =>
	[VAT_KEYWORDS.rigid, VAT_KEYWORDS.soft, ...BONE_VAT_KEYWORDS].find((keyword) => reader.has(keyword)) ??
	null;

/**
 * @param reader an `HGRP/Lit` material's properties
 * @returns its vertex animation, `unsupported` for the cases the viewer doesn't play, or `null` without
 *   either keyword
 */
export const vatOf = (reader: MaterialReader): VatAnimation | UnsupportedSurface | null => {
	const { float, has, slot } = reader;
	const influences = BONE_VAT_KEYWORDS.findIndex((keyword) => has(keyword)) + 1;
	if (influences > 0) {
		return boneVatOf(reader, influences);
	}
	let body: HoudiniVat['body'];
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
	const min: HoudiniVat['min'] = [float('_boundMinX', 0), float('_boundMinY', 0), float('_boundMinZ', 0)];
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

/**
 * @param reader an `HGRP/Lit` material with a `_COMMONVAT_BONE_*` keyword
 * @param influences the bones each vertex blends
 * @returns its bone animation, or `unsupported` for the cases the viewer doesn't play
 */
const boneVatOf = (reader: MaterialReader, influences: number): BoneVat | UnsupportedSurface => {
	const { float, slot } = reader;
	if (float('_CommonVATAutoPlay', 0) <= 0.5) {
		return unsupported('a bone animation whose frame is set per draw');
	}
	if (float('_CommonVATBlendNormal', 0) !== 0) {
		return unsupported('a bone animation that blends back to the mesh normals');
	}
	const map = slot('_CommonVATMap');
	const params = reader.colorOrVector('_CommonVATMapParams');
	if (map === undefined || params === undefined) {
		return unsupported('a bone animation without its map');
	}
	const boneCount = Math.floor(params[0] / 3);
	const frameCount = Math.round(params[1]);
	if (boneCount < 1 || frameCount < 1) {
		return unsupported('a bone animation with an empty map');
	}
	return {
		body: 'bone',
		map: map.texture,
		boneCount,
		frameCount,
		frameRate: float('_CommonVATFPS', 0),
		influences,
	};
};
