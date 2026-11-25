import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { multiplyMatrices, trsMatrix } from '@endfield-noclip/formats/unity/transform';
import type { TypeTreeObject } from '@endfield-noclip/formats/unity/type-tree';

import type { AssetResolver, ObjectRef } from '../assets/assets.ts';

import type { PrefabPose } from './prefab.ts';
import {
	emitterMotion,
	placeAvatarBones,
	poseFrames,
	poseSkin,
	skinMotion,
	type PoseFrames,
	type PosedNode,
} from './skin-pose.ts';

/** a quaternion turning `degrees` about z */
const aboutZ = (degrees: number): [number, number, number, number] => {
	const half = (degrees * Math.PI) / 360;
	return [0, 0, Math.sin(half), Math.cos(half)];
};

describe('emitterMotion', () => {
	// an emitter 10 m out along a hub's -x, the hub turning about z, as the waterwheels' pour emitters ride
	const arm = trsMatrix([-10, 0, 0], [0, 0, 0, 1], [1, 1, 1]);
	const at = (degrees: number) => multiplyMatrices(trsMatrix([0, 0, 0], aboutZ(degrees), [1, 1, 1]), arm);
	const frames = (angles: number[]): PoseFrames => ({
		frameRate: 60,
		matrices: angles.map((degrees) => new Map([['emitter', at(degrees)]])),
	});
	const reach = {
		center: [0, 0, 0] as [number, number, number],
		extents: [1, 1, 1] as [number, number, number],
	};

	it('gives each frame relative to the emitter where the clip ends, and the bounds it reaches', () => {
		// the walk places it at the end pose, 0°; the emitter's own frame is turned and scaled from its Transform's
		const placed = at(0);
		const matrix = multiplyMatrices(placed, trsMatrix([0, 0, 0], aboutZ(90), [2, 2, 2]));
		const angles = Array.from({ length: 120 }, (_, frame) => (frame < 60 ? 90 : 0));
		const moving = emitterMotion(
			frames(angles),
			{ transform: 'emitter', placed, matrix, inWorld: true },
			reach,
		);
		assert.ok(moving !== null);
		const { motion, bounds } = moving;
		// 60 a second kept at 30
		assert.equal(motion.frameRate, 30);
		assert.equal(motion.frames.length, 60 * 12);
		assert.equal(motion.inWorld, true);
		// a frame at the end pose is the identity
		assert.deepEqual(motion.frames.slice(59 * 12), [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]);
		// at 90° the emitter is 10 m below the hub instead of beside it, 10 m along +x and down from where it ends:
		// its own frame, turned 90° and sized 2, sees that as 5 back along its x (the world y) and 5 along its -y
		const first = motion.frames.slice(0, 12);
		assert.ok(Math.abs(first[3] + 5) < 1e-4);
		assert.ok(Math.abs(first[7] + 5) < 1e-4);
		assert.ok(bounds.extents[0] >= 3.5 && bounds.extents[1] >= 3.5);
	});

	it("is null when the clip doesn't move the emitter", () => {
		const placed = at(30);
		const still = emitterMotion(
			frames([30, 30, 30]),
			{ transform: 'emitter', placed, matrix: placed, inWorld: false },
			reach,
		);
		assert.equal(still, null);
	});

	it('is null when the clip ends the emitter scaled to nothing', () => {
		const placed = trsMatrix([-10, 0, 0], [0, 0, 0, 1], [0, 0, 0]);
		const shrunk = emitterMotion(
			frames([0, 90]),
			{ transform: 'emitter', placed, matrix: placed, inWorld: true },
			reach,
		);
		assert.equal(shrunk, null);
	});
});

/** encodes a column-major 4×4 matrix in Unity's `e<row><col>` TypeTree layout */
const matrixFields = (m: Float32Array): TypeTreeObject => {
	const out: TypeTreeObject = {};
	for (let row = 0; row < 4; row++) {
		for (let col = 0; col < 4; col++) {
			out[`e${row}${col}`] = m[col * 4 + row];
		}
	}
	return out;
};

describe('optimized Avatar skeletons', () => {
	const BONE_ROOT = 111;
	const BONE_TIP = 222;
	const avatar: TypeTreeObject = {
		m_Avatar: {
			m_AvatarSkeleton: {
				data: {
					m_Node: [{ m_ParentId: -1 }, { m_ParentId: 0 }, { m_ParentId: 1 }],
					m_ID: [0, BONE_ROOT, BONE_TIP],
				},
			},
			m_DefaultPose: {
				data: {
					m_X: [
						{ t: { x: 0, y: 0, z: 0 }, q: { x: 0, y: 0, z: 0, w: 1 }, s: { x: 1, y: 1, z: 1 } },
						{ t: { x: 0, y: 2, z: 0 }, q: { x: 0, y: 0, z: 0, w: 1 }, s: { x: 1, y: 1, z: 1 } },
						{ t: { x: 0, y: 3, z: 0 }, q: { x: 0, y: 0, z: 0, w: 1 }, s: { x: 1, y: 1, z: 1 } },
					],
				},
			},
			m_AvatarSkeletonPose: { data: { m_X: [] } },
		},
	};
	const mesh: TypeTreeObject = {
		m_BindPose: [
			matrixFields(trsMatrix([0, -2, 0], [0, 0, 0, 1], [1, 1, 1])),
			matrixFields(trsMatrix([0, -5, 0], [0, 0, 0, 1], [1, 1, 1])),
		],
		m_BoneNameHashes: [BONE_ROOT, BONE_TIP],
	};
	const meshBounds = {
		center: [0, 2.5, 0] as [number, number, number],
		extents: [1, 2.5, 1] as [number, number, number],
	};
	const dummyRenderer = { ref: {} as ObjectRef, data: { m_Bones: [] } };
	const dummyResolver: Pick<AssetResolver, 'resolve'> = { resolve: async () => null };

	it('poses empty-m_Bones skinned meshes from the Avatar skeleton and animates them under looping clips', async () => {
		const rootKey = 'root';
		const transforms = new Map<string, Float32Array>([
			[rootKey, trsMatrix([0, 0, 0], [0, 0, 0, 1], [1, 1, 1])],
		]);
		const nodes: PosedNode[] = [
			{
				key: rootKey,
				parent: null,
				saved: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
				below: [''],
			},
		];
		const pose: PrefabPose = {
			key: 'test',
			active: new Map(),
			clips: [
				{
					animator: null,
					transforms: new Map([[BONE_TIP, [{ kind: 'position', value: [1, 3, 0] }]]]),
					active: new Map(),
					materials: new Map(),
					renderers: new Map(),
					motion: {
						duration: 0.1,
						sampleRate: 20,
						loops: true,
						paths: [BONE_TIP],
						sample: (time) =>
							new Map([[BONE_TIP, [{ kind: 'position', value: [time > 0.025 ? 2 : 0, 3, 0] }]]]),
						materials: null,
					},
				},
			],
		};

		const avatarBones = placeAvatarBones(
			avatar,
			{ transformKey: rootKey, paths: [''] },
			pose,
			transforms,
			nodes,
		);
		assert.ok(avatarBones !== null);

		const posed = await poseSkin(dummyResolver, dummyRenderer, mesh, meshBounds, transforms, avatarBones);
		assert.ok('skin' in posed);
		// bone 0 is at rest (identity), bone 1 shifted +1 along x by the clip end pose
		assert.deepEqual([...posed.skin[0]], [...trsMatrix([0, 0, 0], [0, 0, 0, 1], [1, 1, 1])]);
		assert.deepEqual([...posed.skin[1]], [...trsMatrix([1, 0, 0], [0, 0, 0, 1], [1, 1, 1])]);

		const frames = poseFrames(nodes, pose);
		assert.ok(frames !== null);
		const moving = skinMotion(frames, posed, meshBounds);
		assert.ok(moving !== null);
		assert.equal(moving.motion.boneCount, 2);
		assert.equal(moving.motion.frameCount, 2);
		// frame 0 bone 1 x-offset = 0, frame 1 bone 1 x-offset = 2
		assert.equal(moving.motion.matrices[1 * 12 + 3], 0);
		assert.equal(moving.motion.matrices[(2 + 1) * 12 + 3], 2);
	});

	it('still reports invalid skeleton when m_Bones is empty without an Avatar', async () => {
		const posed = await poseSkin(dummyResolver, dummyRenderer, mesh, meshBounds, new Map(), null);
		assert.deepEqual(posed, { reason: 'invalid skeleton' });
	});
});
