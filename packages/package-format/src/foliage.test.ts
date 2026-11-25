import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
	decodeFoliageBlock,
	encodeFoliageBlock,
	FOLIAGE_INSTANCE_BYTES,
	type FoliageBlock,
	packFoliageInstance,
	unpackFoliageInstance,
} from './foliage.ts';
import { chainHashMap } from './instances.ts';

describe('FoliageBlock (EFFL)', () => {
	it('round-trips clusters, packed instances, and PLTT chain hash remapping', () => {
		const h0 = 0xaaaa_bbbb_cccc_ddddn;
		const h1 = 0x1234_5678_9abc_def0n;
		const instances = new Uint8Array(FOLIAGE_INSTANCE_BYTES * 3);
		for (let i = 0; i < instances.length; i++) {
			instances[i] = i & 0xff;
		}
		const block: FoliageBlock = {
			origin: [128, 0, -256],
			palette: BigUint64Array.of(h0, h1),
			clusters: [
				{
					chain: 0,
					firstInstance: 0,
					instanceCount: 2,
					center: [1, 2, 3],
					halfExtents: [8, 4, 8],
					rendererHalfSize: 0.75,
					sparsity: 1.5,
				},
				{
					chain: 1,
					firstInstance: 2,
					instanceCount: 1,
					center: [-4, 1, 5],
					halfExtents: [2, 2, 2],
					rendererHalfSize: 0.5,
					sparsity: 0.5,
				},
			],
			instances,
		};
		const encoded = encodeFoliageBlock(block);
		assert.deepEqual(decodeFoliageBlock(encoded), block);

		const index = chainHashMap([
			{ draws: [], flags: 0, distanceOrigin: null, contentHash: h1 },
			{ draws: [], flags: 0, distanceOrigin: null, contentHash: h0 },
		]);
		const resolved = decodeFoliageBlock(encoded, index);
		assert.equal(resolved.palette, undefined);
		assert.equal(resolved.clusters[0].chain, 1);
		assert.equal(resolved.clusters[1].chain, 0);
	});

	it('packs and unpacks 3D transforms with arbitrary rotation, non-uniform scale, and mirroring', () => {
		const origin: [number, number, number] = [100, 10, -50];
		const center: [number, number, number] = [4, 2, -3];
		const halfExtents: [number, number, number] = [8, 4, 8];

		// build a column-major TRS matrix from axis-angle, scale, and world position
		const makeMatrix = (
			axis: [number, number, number],
			angle: number,
			scale: [number, number, number],
			pos: [number, number, number],
		): Float32Array => {
			const len = Math.hypot(axis[0], axis[1], axis[2]);
			const [ax, ay, az] = [axis[0] / len, axis[1] / len, axis[2] / len];
			const s = Math.sin(angle * 0.5);
			const [qx, qy, qz, qw] = [ax * s, ay * s, az * s, Math.cos(angle * 0.5)];
			const xx = qx * qx;
			const yy = qy * qy;
			const zz = qz * qz;
			const xy = qx * qy;
			const xz = qx * qz;
			const yz = qy * qz;
			const wx = qw * qx;
			const wy = qw * qy;
			const wz = qw * qz;
			const [sx, sy, sz] = scale;
			return Float32Array.of(
				(1 - 2 * (yy + zz)) * sx,
				2 * (xy + wz) * sx,
				2 * (xz - wy) * sx,
				0,
				2 * (xy - wz) * sy,
				(1 - 2 * (xx + zz)) * sy,
				2 * (yz + wx) * sy,
				0,
				2 * (xz + wy) * sz,
				2 * (yz - wx) * sz,
				(1 - 2 * (xx + yy)) * sz,
				0,
				pos[0],
				pos[1],
				pos[2],
				1,
			);
		};

		const cases: { mat: Float32Array; mirrored: boolean }[] = [
			{ mat: makeMatrix([0, 1, 0], 0.7, [1.25, 0.85, 1.5], [105.5, 11.2, -51.7]), mirrored: false },
			{ mat: makeMatrix([1, 0.2, -0.4], 2.4, [0.9, 1.8, 0.9], [97.1, 13.5, -59.8]), mirrored: false },
			{ mat: makeMatrix([0.3, -1, 0.6], 3.0, [-1.1, 1.3, 0.7], [111.9, 8.1, -45.2]), mirrored: true },
		];
		const buf = new Uint8Array(FOLIAGE_INSTANCE_BYTES * cases.length);
		const unpacked = new Float32Array(12);
		for (const [i, { mat, mirrored }] of cases.entries()) {
			packFoliageInstance(buf, i * FOLIAGE_INSTANCE_BYTES, mat, origin, center, halfExtents);
			const gotMirrored = unpackFoliageInstance(
				buf,
				i * FOLIAGE_INSTANCE_BYTES,
				center,
				halfExtents,
				unpacked,
				0,
			);
			assert.equal(gotMirrored, mirrored);
			// compare row-major 3×4 against column-major 4×4 (relative to origin)
			const expected = [
				mat[0],
				mat[4],
				mat[8],
				mat[12] - origin[0],
				mat[1],
				mat[5],
				mat[9],
				mat[13] - origin[1],
				mat[2],
				mat[6],
				mat[10],
				mat[14] - origin[2],
			];
			for (let k = 0; k < 12; k++) {
				assert.ok(
					Math.abs(unpacked[k] - expected[k]) < 2e-3,
					`case ${i} elem ${k}: got ${unpacked[k]}, expected ${expected[k]}`,
				);
			}
		}
	});
});
