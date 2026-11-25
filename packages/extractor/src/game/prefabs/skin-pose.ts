import {
	inverseAffine,
	multiplyMatrices,
	trsMatrix,
	transformBounds,
} from '@endfield-noclip/formats/unity/transform';
import type { TypeTreeObject } from '@endfield-noclip/formats/unity/type-tree';
import {
	arrayField,
	asPPtr,
	isObject,
	numberField,
	objectField,
	vector3Field,
	vector4Field,
	type Aabb,
} from '@endfield-noclip/formats/unity/values';
import type { ParticleEmitterMotion } from '@endfield-noclip/package-format/particles';

import { objectKey, type AssetResolver, type ObjectRef } from '../assets/assets.ts';
import type { LocalTransform } from '../effects/particle-mesh.ts';

import { type ClipBinding, type ClipPaths, posedLocal } from './pose-paths.ts';
import type { PrefabPose, SkinMotion } from './prefab.ts';

// a prefab's skinned renderers in their authored pose, and its Transforms posed again at each frame of a
// looping clip

/** bone matrices that move less than this between frames hold still */
const STILL = 1e-5;

/** a Transform as the renderer walk met it, for posing it again at each frame of a clip */
export interface PosedNode {
	/** the Transform's {@link objectKey} */
	key: string;
	/** the parent Transform's key, `null` for the prefab root */
	parent: string | null;
	/** the local transform as saved */
	saved: LocalTransform;
	/** the Transform's clip bindings ({@link ClipBinding}) */
	below: readonly ClipBinding[];
}

/** a skinned renderer posed by {@link poseSkin} */
export interface PosedSkin {
	skin: Float32Array[];
	bounds: Aabb;
	/** per bone, its Transform's {@link objectKey} */
	bones: string[];
	/** per bone, its bind pose */
	binds: Float32Array[];
}

/** every Transform's prefab-space matrix at each frame of a pose's looping clip */
export interface PoseFrames {
	frameRate: number;
	/** per frame, by Transform key */
	matrices: Map<string, Float32Array>[];
}

const boxBounds = (min: readonly number[], max: readonly number[]): Aabb => ({
	center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2],
	extents: [(max[0] - min[0]) / 2, (max[1] - min[1]) / 2, (max[2] - min[2]) / 2],
});

/**
 * expands an optimized Animator's Avatar skeleton (`m_HasTransformHierarchy == false`) into virtual bone
 * transforms and {@link PosedNode}s under the Animator's Transform, so skinned meshes with empty `m_Bones`
 * can pose and animate through the same path as Transform-hierarchy skeletons
 *
 * @param avatar the Avatar object's fields
 * @param animator the Animator GameObject's Transform key and its {@link ClipPaths}
 * @param pose the prefab pose, `null` for the saved rest pose
 * @param transforms prefab-space Transform matrices, updated with each virtual bone
 * @param nodes walk nodes, appended with each virtual bone in parent-before-child order
 * @returns by bone CRC32 hash (`m_ID`), the virtual bone's key in `transforms`, or `null` if the Avatar lacks
 *   a usable skeleton
 */
export const placeAvatarBones = (
	avatar: TypeTreeObject,
	animator: { transformKey: string; paths: ClipPaths },
	pose: PrefabPose | null,
	transforms: Map<string, Float32Array>,
	nodes: PosedNode[],
): Map<number, string> | null => {
	const rootMatrix = transforms.get(animator.transformKey);
	const constant = avatar.m_Avatar;
	if (rootMatrix === undefined || !isObject(constant)) {
		return null;
	}
	const skeleton = objectField(objectField(constant, 'm_AvatarSkeleton'), 'data');
	const skeletonNodes = arrayField(skeleton, 'm_Node');
	const ids = arrayField(skeleton, 'm_ID');
	const defaultX = arrayField(objectField(objectField(constant, 'm_DefaultPose'), 'data'), 'm_X');
	const bindX = arrayField(objectField(objectField(constant, 'm_AvatarSkeletonPose'), 'data'), 'm_X');
	const poseX = defaultX.length === skeletonNodes.length ? defaultX : bindX;
	if (
		skeletonNodes.length === 0 ||
		ids.length !== skeletonNodes.length ||
		poseX.length !== skeletonNodes.length
	) {
		return null;
	}
	const clipTransforms = (pose?.clips ?? []).map((clip) => clip.transforms);
	const byHash = new Map<number, string>();
	for (let i = 0; i < skeletonNodes.length; i++) {
		const entry = skeletonNodes[i];
		const id = ids[i];
		const x = poseX[i];
		if (!isObject(entry) || typeof id !== 'number' || !isObject(x)) {
			return null;
		}
		const parentId = numberField(entry, 'm_ParentId');
		if (parentId >= i) {
			return null;
		}
		const key = `${animator.transformKey}#avatar:${i}`;
		const parentKey = parentId < 0 ? animator.transformKey : `${animator.transformKey}#avatar:${parentId}`;
		const parentMatrix = transforms.get(parentKey);
		if (parentMatrix === undefined) {
			return null;
		}
		const saved: LocalTransform = {
			position: vector3Field(x, 't'),
			rotation: vector4Field(x, 'q'),
			scale: vector3Field(x, 's'),
		};
		// clips bound to this Animator have path '' on it; skip id 0 on the skeleton root, which is the Animator itself
		const below: ClipBinding[] = animator.paths.map((path) =>
			path === '' && (parentId >= 0 || id !== 0) ? id : null,
		);
		nodes.push({ key, parent: parentKey, saved, below });
		const local = posedLocal(saved, clipTransforms, below);
		transforms.set(
			key,
			multiplyMatrices(parentMatrix, trsMatrix(local.position, local.rotation, local.scale)),
		);
		byHash.set(id >>> 0, key);
	}
	return byHash;
};

/**
 * bakes a skinned renderer's authored pose: each bone's prefab-space matrix times its bind pose
 *
 * @param resolver bundle reader
 * @param renderer the SkinnedMeshRenderer
 * @param mesh its mesh's fields
 * @param meshBounds the mesh's own bounds
 * @param transforms every Transform's prefab-space matrix, by key
 * @param avatarBones bone keys by CRC32 hash from an enclosing optimized Animator's Avatar, or `null`
 * @returns the bone matrices, the bounds every weighted position lies in, and per bone its Transform's key
 *   and bind pose; or why the skeleton can't be posed
 */
export const poseSkin = async (
	resolver: Pick<AssetResolver, 'resolve'>,
	renderer: { ref: ObjectRef; data: TypeTreeObject },
	mesh: TypeTreeObject,
	meshBounds: Aabb,
	transforms: ReadonlyMap<string, Float32Array>,
	avatarBones: ReadonlyMap<number, string> | null,
): Promise<PosedSkin | { reason: string }> => {
	const bones = arrayField(renderer.data, 'm_Bones');
	const bindPoses = arrayField(mesh, 'm_BindPose');
	if (bindPoses.length === 0) {
		return { reason: 'invalid skeleton' };
	}
	const boneKeys: string[] = [];
	if (bones.length > 0) {
		if (bones.length !== bindPoses.length) {
			return { reason: 'invalid skeleton' };
		}
		for (const pointer of bones) {
			// oxlint-disable-next-line no-await-in-loop -- bones are few and their reads cached
			const bone = await resolver.resolve(renderer.ref, asPPtr(pointer));
			if (bone === null) {
				return { reason: 'unresolved bone' };
			}
			boneKeys.push(objectKey(bone));
		}
	} else {
		// optimized Game Objects (`m_HasTransformHierarchy == false`): bones live in the Avatar and match m_BoneNameHashes
		const hashes = arrayField(mesh, 'm_BoneNameHashes');
		if (avatarBones === null || hashes.length !== bindPoses.length) {
			return { reason: 'invalid skeleton' };
		}
		for (const hash of hashes) {
			const boneKey = typeof hash === 'number' ? avatarBones.get(hash >>> 0) : undefined;
			if (boneKey === undefined) {
				return { reason: 'unresolved bone' };
			}
			boneKeys.push(boneKey);
		}
	}
	const skin: Float32Array[] = [];
	const binds: Float32Array[] = [];
	const min = [Infinity, Infinity, Infinity];
	const max = [-Infinity, -Infinity, -Infinity];
	for (const [i, boneKey] of boneKeys.entries()) {
		const boneMatrix = transforms.get(boneKey);
		const bind = bindPoses[i];
		if (!boneMatrix || !isObject(bind)) {
			return { reason: 'unresolved bone' };
		}
		const bindMatrix = new Float32Array(
			Array.from({ length: 16 }, (_, k) => numberField(bind, 'e' + (k % 4) + Math.floor(k / 4))),
		);
		const posed = multiplyMatrices(boneMatrix, bindMatrix);
		skin.push(posed);
		binds.push(bindMatrix);
		const transformed = transformBounds(meshBounds, posed);
		for (let axis = 0; axis < 3; axis++) {
			min[axis] = Math.min(min[axis], transformed.center[axis] - transformed.extents[axis]);
			max[axis] = Math.max(max[axis], transformed.center[axis] + transformed.extents[axis]);
		}
	}
	// weighted positions lie inside this union, including poses whose bones move beyond the bind bounds
	return { skin, bounds: boxBounds(min, max), bones: boneKeys, binds };
};

/**
 * poses the prefab's Transforms at each frame of the pose's first looping clip that moves any; the pose's
 * other clips hold their end poses, and its looping clips play on those frames
 *
 * @param nodes the walk's Transforms, parents first
 * @param pose the pose the walk drew
 * @returns the frames, or `null` when nothing keeps moving a Transform
 */
export const poseFrames = (nodes: readonly PosedNode[], pose: PrefabPose): PoseFrames | null => {
	const playing = pose.clips.find(
		(clip) => clip.motion !== null && clip.motion.loops && clip.motion.paths.length > 0,
	)?.motion;
	if (playing === undefined || playing === null || playing.duration <= 0 || playing.sampleRate <= 0) {
		return null;
	}
	const frameRate = playing.sampleRate;
	const frameCount = Math.max(Math.round(playing.duration * frameRate), 1);
	const matrices: Map<string, Float32Array>[] = [];
	for (let frame = 0; frame < frameCount; frame++) {
		const time = frame / frameRate;
		const sampled = pose.clips.map((clip) =>
			clip.motion?.loops === true ? clip.motion.sample(time % clip.motion.duration) : clip.transforms,
		);
		const posed = new Map<string, Float32Array>();
		for (const node of nodes) {
			const parent = node.parent === null ? undefined : posed.get(node.parent);
			if (parent === undefined) {
				// the root keeps the caller's placement
				posed.set(node.key, trsMatrix([0, 0, 0], [0, 0, 0, 1], [1, 1, 1]));
				continue;
			}
			const local = posedLocal(node.saved, sampled, node.below);
			posed.set(node.key, multiplyMatrices(parent, trsMatrix(local.position, local.rotation, local.scale)));
		}
		matrices.push(posed);
	}
	return { frameRate, matrices };
};

/**
 * @param frames the prefab's Transforms at each frame of its looping clip
 * @param posed the renderer's skeleton: per bone, its Transform's key and bind pose
 * @param meshBounds the mesh's own bounds
 * @returns the bones' skinning matrices at each frame and the bounds they keep the mesh in, or `null` when no
 *   bone moves
 */
export const skinMotion = (
	frames: PoseFrames,
	posed: Pick<PosedSkin, 'bones' | 'binds'>,
	meshBounds: Aabb,
): { motion: SkinMotion; bounds: Aabb } | null => {
	const boneCount = posed.bones.length;
	const frameCount = frames.matrices.length;
	const matrices = new Float32Array(frameCount * boneCount * 12);
	const min = [Infinity, Infinity, Infinity];
	const max = [-Infinity, -Infinity, -Infinity];
	let moves = false;
	for (const [frame, byKey] of frames.matrices.entries()) {
		for (let bone = 0; bone < boneCount; bone++) {
			const boneMatrix = byKey.get(posed.bones[bone]);
			if (boneMatrix === undefined) {
				return null;
			}
			const skin = multiplyMatrices(boneMatrix, posed.binds[bone]);
			const at = (frame * boneCount + bone) * 12;
			// column-major to rows3x4
			for (let row = 0; row < 3; row++) {
				for (let column = 0; column < 4; column++) {
					matrices[at + row * 4 + column] = skin[column * 4 + row];
				}
			}
			for (let k = 0; k < 12; k++) {
				moves ||= Math.abs(matrices[at + k] - matrices[bone * 12 + k]) > STILL;
			}
			const box = transformBounds(meshBounds, skin);
			for (let axis = 0; axis < 3; axis++) {
				min[axis] = Math.min(min[axis], box.center[axis] - box.extents[axis]);
				max[axis] = Math.max(max[axis], box.center[axis] + box.extents[axis]);
			}
		}
	}
	if (!moves) {
		return null;
	}
	return {
		motion: { boneCount, frameCount, frameRate: frames.frameRate, matrices },
		bounds: boxBounds(min, max),
	};
};

/** the most frames a second an emitter's motion keeps: emission points between them barely differ */
const EMITTER_FRAME_RATE = 30;

/**
 * @param frames the prefab's Transforms at each frame of its looping clip
 * @param emitter the system's Transform key, its prefab-space matrix as the walk placed it (the clip's end
 *   pose), the emitter matrix its draw is placed with, and whether its particles are simulated in the world
 * @param reach the bounds its particles reach, in the emitter's frame
 * @returns the emitter's motion relative to its draw's frame and the bounds its particles reach in that frame
 *   over the whole clip, or `null` when the clip doesn't move it or ends it scaled to nothing
 */
export const emitterMotion = (
	frames: PoseFrames,
	emitter: { transform: string; placed: Float32Array; matrix: Float32Array; inWorld: boolean },
	reach: Aabb,
): { motion: ParticleEmitterMotion; bounds: Aabb } | null => {
	const step = Math.max(Math.round(frames.frameRate / EMITTER_FRAME_RATE), 1);
	// the emitter matrix is the Transform's times a fixed correction (a scaling mode dropping the parents'
	// scale), so the Transform's motion, seen from the emitter's frame, is the emitter's
	let toEmitter: Float32Array;
	let fromPlaced: Float32Array;
	try {
		toEmitter = inverseAffine(emitter.matrix);
		fromPlaced = multiplyMatrices(inverseAffine(emitter.placed), emitter.matrix);
	} catch (error) {
		// an emitter the clip ends scaled to nothing has no frame to move from, so it holds its end pose
		if (error instanceof RangeError) {
			return null;
		}
		throw error;
	}
	const values: number[] = [];
	const min = [Infinity, Infinity, Infinity];
	const max = [-Infinity, -Infinity, -Infinity];
	let moves = false;
	for (let frame = 0; frame < frames.matrices.length; frame += step) {
		const transform = frames.matrices[frame].get(emitter.transform);
		if (transform === undefined) {
			return null;
		}
		const relative = multiplyMatrices(toEmitter, multiplyMatrices(transform, fromPlaced));
		// column-major to rows3x4, rounded: the motion is stored in the package's JSON
		for (let row = 0; row < 3; row++) {
			for (let column = 0; column < 4; column++) {
				const value = Math.round(relative[column * 4 + row] * 1e5) / 1e5;
				moves ||= Math.abs(value - (row === column ? 1 : 0)) > STILL;
				values.push(value);
			}
		}
		const box = transformBounds(reach, relative);
		for (let axis = 0; axis < 3; axis++) {
			min[axis] = Math.min(min[axis], box.center[axis] - box.extents[axis]);
			max[axis] = Math.max(max[axis], box.center[axis] + box.extents[axis]);
		}
	}
	if (!moves) {
		return null;
	}
	return {
		motion: { inWorld: emitter.inWorld, frameRate: frames.frameRate / step, frames: values },
		bounds: boxBounds(min, max),
	};
};
