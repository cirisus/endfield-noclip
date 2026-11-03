import assert from 'node:assert/strict';
import { test } from 'node:test';

import { readCollisionMesh } from './collision-mesh.ts';

const fixture = (width: number) => {
	const bytes: number[] = [];
	const raw = (s: string) => bytes.push(...new TextEncoder().encode(s));
	const u32 = (n: number) => {
		const b = new Uint8Array(4);
		new DataView(b.buffer).setUint32(0, n, true);
		bytes.push(...b);
	};
	const f32 = (n: number) => {
		const b = new Uint8Array(4);
		new DataView(b.buffer).setFloat32(0, n, true);
		bytes.push(...b);
	};
	raw('NXS');
	bytes.push(1);
	raw('MESH');
	u32(15);
	u32(1);
	u32(2 | (width === 1 ? 4 : width === 2 ? 8 : 0));
	u32(3);
	u32(1);
	[0, 0, 0, 1, 0, 0, 0, 0, 1].forEach(f32);
	const indices = bytes.length;
	for (const n of [0, 1, 2]) {
		bytes.push(n, ...Array<number>(width - 1).fill(0));
	}
	u32(0);
	bytes.push(0); // original face 0, stored in one byte
	raw('BV4 ');
	u32(3);
	[0, 0, 0, 2].forEach(f32);
	u32(0);
	[1, 1, 1, 1, 1, 1].forEach(f32);
	u32(1);
	u32(0);
	f32(0.001);
	[0, 0, 0, 1, 0, 1].forEach(f32);
	u32(1);
	bytes.push(0);
	return { bytes: Uint8Array.from(bytes), indices };
};

test('reads all triangle index widths without confusing cooked order with original faces', () => {
	for (const width of [1, 2, 4]) {
		const mesh = readCollisionMesh(fixture(width).bytes);
		assert.deepEqual(mesh.triangles, [[0, 1, 2]]);
		assert.deepEqual(mesh.vertices, [
			[0, 0, 0],
			[1, 0, 0],
			[0, 0, 1],
		]);
		assert.deepEqual(mesh.faceRemap, [0]);
		assert.deepEqual(mesh.bounds, { min: [0, 0, 0], max: [1, 0, 1] });
	}
});

test('rejects unsupported formats, invalid indices, nonfinite vertices and truncated tails', () => {
	const { bytes, indices } = fixture(1);
	for (const offset of [3, 8, 12, 16, indices]) {
		const broken = bytes.slice();
		broken[offset] = 255;
		assert.throws(() => readCollisionMesh(broken));
	}
	const nonfinite = bytes.slice();
	new DataView(nonfinite.buffer).setFloat32(28, Infinity, true);
	assert.throws(() => readCollisionMesh(nonfinite), /nonfinite/);
	assert.throws(() => readCollisionMesh(bytes.subarray(0, bytes.length - 1)), /exceeds/);
	assert.throws(() => readCollisionMesh(Uint8Array.from([...bytes, 0])), /trailing/);
});
