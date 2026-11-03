import assert from 'node:assert/strict';
import { test } from 'node:test';

import { readConvexMesh } from './convex-mesh.ts';

const fixture = () => {
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
	raw('CVXM');
	u32(13);
	u32(0);
	raw('ICE');
	bytes.push(1);
	raw('CLHL');
	u32(9);
	[4, 6, 4, 12].forEach(u32);
	[0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1].forEach(f32);
	const norm = 1 / Math.sqrt(3);
	const planes = [
		[0, 0, -1, 0],
		[0, -1, 0, 0],
		[-1, 0, 0, 0],
		[norm, norm, norm, -norm],
	];
	planes.forEach((p, i) => {
		p.forEach(f32);
		bytes.push(i * 3, 0, 3, 0);
	});
	const indexOffset = bytes.length;
	bytes.push(0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3);
	bytes.push(0, 1, 0, 2, 0, 3, 1, 2, 1, 3, 2, 3);
	bytes.push(0, 1, 2, 0, 1, 3, 0, 2, 3, 1, 2, 3);
	[0, 0, 0, 0, 1, 1, 1].forEach(f32);
	Array<number>(13).fill(1).forEach(f32);
	f32(-1);
	[0.1, 0.1, 0.1, 0.1].forEach(f32);
	return { bytes: Uint8Array.from(bytes), indexOffset };
};

test('preserves a closed outward tetrahedron without inventing original triangle indices', () => {
	const hull = readConvexMesh(fixture().bytes);
	assert.deepEqual(hull.triangles, [
		[0, 2, 1],
		[0, 1, 3],
		[0, 3, 2],
		[1, 2, 3],
	]);
	assert.equal(hull.faceRemap, null);
	assert.deepEqual(hull.bounds, { min: [0, 0, 0], max: [1, 1, 1] });
});

test('rejects unsupported, open, inverted, nonfinite and truncated hull data', () => {
	const { bytes, indexOffset } = fixture();
	for (const offset of [3, 8, 24, indexOffset]) {
		const invalid = bytes.slice();
		invalid[offset] = 255;
		assert.throws(() => readConvexMesh(invalid));
	}
	const inverted = bytes.slice();
	inverted[indexOffset + 1] = 1;
	inverted[indexOffset + 2] = 2;
	assert.throws(() => readConvexMesh(inverted), /winding/);
	const open = bytes.slice();
	open.set(open.subarray(92, 108), 152);
	open.set(open.subarray(indexOffset, indexOffset + 3), indexOffset + 9);
	assert.throws(() => readConvexMesh(open), /not closed/);
	const nonfinite = bytes.slice();
	new DataView(nonfinite.buffer).setFloat32(44, NaN, true);
	assert.throws(() => readConvexMesh(nonfinite), /nonfinite/);
	assert.throws(() => readConvexMesh(bytes.subarray(0, bytes.length - 1)), /exceeds/);
	assert.throws(() => readConvexMesh(Uint8Array.from([...bytes, 0])), /trailing/);
});
