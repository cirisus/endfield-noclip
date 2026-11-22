/**
 * bakes `_VAT_RIGIDBODY`'s Houdini animation (`docs/game-data/materials.md#rigid-body-animation`) into a
 * skeletal one: each piece of the mesh becomes a bone, whose matrix at every frame is the rigid transform the
 * shader reads from the position and rotation textures
 */

import { VkFormat } from '@endfield-noclip/formats/binary/ktx2';
import { type DecodedMesh, VertexAttributeFormat } from '@endfield-noclip/formats/unity/mesh';
import type { DecodedTexture } from '@endfield-noclip/formats/unity/texture';

import type { ObjectLocator } from '../../game/assets/assets.ts';
import type { RigidBodyAnimation } from '../../game/materials/surfaces/rigid-body.ts';
import type { SkinMotion } from '../../game/prefabs/prefab.ts';

/** a {@link RigidBodyAnimation} as the conversion worker reads it */
export interface RigidBodyBake extends Omit<RigidBodyAnimation, 'position' | 'rotation'> {
	position: ObjectLocator;
	rotation: ObjectLocator;
	/** the submeshes drawn with the animation; the others hold still */
	submeshes: number[];
}

/** a VAT texture's top level as RGBA floats, as the shader samples it */
export interface VatTexels {
	width: number;
	height: number;
	/** RGBA per texel, row 0 first (`v = 0`) */
	texels: Float32Array;
}

/** the most bones a vertex's `uint8x4` indices can name */
const MAX_BONES = 256;

/**
 * @param texture a decoded VAT texture
 * @returns its top level as floats
 * @throws {Error} for a format other than RGBA half, float or 8-bit unorm
 */
export const vatTexels = (texture: DecodedTexture): VatTexels => {
	const level = texture.levels[0];
	const count = texture.width * texture.height * 4;
	let texels: Float32Array;
	switch (texture.vkFormat) {
		case VkFormat.R16G16B16A16_SFLOAT: {
			texels = Float32Array.from(new Float16Array(level.buffer, level.byteOffset, count));
			break;
		}
		case VkFormat.R32G32B32A32_SFLOAT: {
			texels = new Float32Array(level.buffer.slice(level.byteOffset, level.byteOffset + count * 4));
			break;
		}
		case VkFormat.R8G8B8A8_UNORM: {
			texels = Float32Array.from(level.subarray(0, count), (value) => value / 255);
			break;
		}
		default: {
			throw new Error(`VAT texture ${texture.name} has format ${texture.format.name}`);
		}
	}
	return { width: texture.width, height: texture.height, texels };
};

/**
 * @param mesh the mesh the animation's materials draw
 * @param bake the animation, with the submeshes it moves
 * @param position its position texture
 * @param rotation its rotation texture
 * @returns a copy of the mesh skinned to one bone per piece (bone 0 holding the other submeshes still) and
 *   the motion that plays the animation, or the reason it can't be baked
 */
export const rigidBodySkin = (
	mesh: DecodedMesh,
	bake: RigidBodyBake,
	position: VatTexels,
	rotation: VatTexels,
): { mesh: DecodedMesh; motion: SkinMotion } | { reason: string } => {
	const lookup = mesh.uvs[1];
	const pivotX = mesh.uvs[2];
	const pivotYz = mesh.uvs[3];
	if (lookup == null || pivotX == null || pivotYz == null) {
		return { reason: 'a rigid-body mesh without UV sets 1–3' };
	}
	// the shader's per-vertex inputs: UV1 finds the piece's texels, UV2.x and UV3 hold its pivot
	const moving = new Uint8Array(mesh.vertexCount);
	for (const index of bake.submeshes) {
		const submesh = mesh.submeshes[index];
		if (submesh === undefined) {
			continue;
		}
		for (let i = submesh.firstIndex; i < submesh.firstIndex + submesh.indexCount; i++) {
			moving[mesh.indices[i] + submesh.baseVertex] = 1;
		}
	}
	const pieces: { u: number; v: number; pivot: [number, number, number] }[] = [];
	const pieceOf = new Map<string, number>();
	const bones = new Float32Array(mesh.vertexCount);
	for (let vertex = 0; vertex < mesh.vertexCount; vertex++) {
		if (moving[vertex] === 0) {
			continue;
		}
		const u = lookup.data[vertex * lookup.dimension];
		const v = lookup.data[vertex * lookup.dimension + 1];
		const pivot: [number, number, number] = [
			-pivotX.data[vertex * pivotX.dimension],
			pivotYz.data[vertex * pivotYz.dimension],
			1 - pivotYz.data[vertex * pivotYz.dimension + 1],
		];
		const key = `${u} ${v} ${pivot.join(' ')}`;
		let piece = pieceOf.get(key);
		if (piece === undefined) {
			piece = pieces.push({ u, v, pivot });
			pieceOf.set(key, piece);
		}
		bones[vertex] = piece;
	}
	const boneCount = pieces.length + 1;
	if (boneCount > MAX_BONES) {
		return { reason: `a rigid-body mesh of ${pieces.length} pieces, more than ${MAX_BONES - 1}` };
	}

	const { frameCount, cycleRate, cycleStart } = bake;
	// the baked loop's frame j shows the game's frame at the middle of its span, so a negative rate plays it
	// backwards and the start time shifts it
	const frameRate = Math.abs(cycleRate) * frameCount || 1;
	const matrices = new Float32Array(frameCount * boneCount * 12);
	const texel = (texture: VatTexels, u: number, v: number): Float32Array => {
		// point sampling with repeat wrapping, as the VAT textures are set up
		const x = (((Math.floor(u * texture.width) % texture.width) + texture.width) % texture.width) * 4;
		const y = ((Math.floor(v * texture.height) % texture.height) + texture.height) % texture.height;
		return texture.texels.subarray(y * texture.width * 4 + x, y * texture.width * 4 + x + 4);
	};
	for (let frame = 0; frame < frameCount; frame++) {
		const time = (frame + 0.5) / frameRate;
		const cycle = (time - cycleStart) * cycleRate;
		const shown = Math.floor((cycle - Math.floor(cycle)) * frameCount);
		const rest = shown === 0 && !bake.animateFirstFrame;
		for (let bone = 0; bone < boneCount; bone++) {
			const m = (frame * boneCount + bone) * 12;
			const piece = bone === 0 ? null : pieces[bone - 1];
			// vertices whose UV1 v is at most 0.1 collapse to the object's origin, even in the rest pose
			if (piece !== null && piece.v <= 0.1) {
				continue;
			}
			if (piece === null || rest) {
				matrices.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0], m);
				continue;
			}
			const { u, v, pivot } = piece;
			const at: [number, number] = [u * bake.uScale, 1 - bake.vScale * (1 - v + shown / frameCount)];
			const p = texel(position, ...at);
			const r = texel(rotation, ...at);
			const [a, b, c] = bake.hdr
				? [r[0], r[1], r[2]]
				: [(r[0] - 0.5) * 2, (r[1] - 0.5) * 2, (r[2] - 0.5) * 2];
			const d = Math.sqrt(Math.max(1 - a * a - b * b - c * c, 0));
			// the rotation texture leaves out the largest component, which the position's alpha names
			const slot = p[3] * 4;
			let q: [x: number, y: number, z: number, w: number];
			switch (Math.floor(slot)) {
				case 1: {
					q = [d, b, c, a];
					break;
				}
				case 2: {
					q = [a, -d, c, -b];
					break;
				}
				case 3: {
					q = [a, b, -d, -c];
					break;
				}
				default: {
					q = [a, b, c, d];
					break;
				}
			}
			const scale =
				bake.scale * (bake.maxPieceScale === null ? 1 : bake.maxPieceScale * (1 - (slot - Math.floor(slot))));
			const [x, y, z, w] = q;
			const rows = [
				[1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
				[2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
				[2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)],
			];
			for (let row = 0; row < 3; row++) {
				const [m0, m1, m2] = rows[row].map((value) => value * scale);
				const offset = bake.min[row] + p[row] * bake.range[row];
				matrices.set([m0, m1, m2, offset - (m0 * pivot[0] + m1 * pivot[1] + m2 * pivot[2])], m + row * 4);
			}
		}
	}
	return {
		mesh: {
			...mesh,
			skin: {
				bonesPerVertex: 1,
				bindPoseCount: boneCount,
				boneNameHashCount: 0,
				hasBlendWeights: true,
				hasBlendIndices: true,
				weights: {
					dimension: 1,
					format: VertexAttributeFormat.Float32,
					data: new Float32Array(mesh.vertexCount).fill(1),
				},
				indices: { dimension: 1, format: VertexAttributeFormat.Float32, data: bones },
			},
		},
		motion: { boneCount, frameCount, frameRate, matrices },
	};
};
