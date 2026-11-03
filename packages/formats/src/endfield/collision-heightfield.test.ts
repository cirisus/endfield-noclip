import assert from 'node:assert/strict';
import { test } from 'node:test';

import { readCollisionHeightfield } from './collision-heightfield.ts';

const samples = (values: number[]) => {
	const bytes = new Uint8Array(values.length * 2),
		view = new DataView(bytes.buffer);
	values.forEach((v, i) => view.setUint16(i * 2, v, true));
	return bytes;
};

test('preserves collision heights, rectangular axes, upward winding and alternating diagonals', () => {
	const mesh = readCollisionHeightfield(samples([0, 32766, 0, 8192, 0, 16383]), {
		width: 3,
		height: 2,
		scale: [2, 100, 3],
	});
	assert.deepEqual(mesh.vertices[1], [2, 100, 0]);
	assert.deepEqual(mesh.vertices[5], [4, 50, 3]);
	assert.deepEqual(mesh.triangles, [
		[0, 3, 4],
		[0, 4, 1],
		[1, 4, 2],
		[2, 4, 5],
	]);
	for (const face of mesh.triangles) {
		const [a, b, c] = face.map((i) => mesh.vertices[i]);
		assert.ok((b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]) > 0);
	}
});

test('holes remove complete incident quads, including triangles without the hole vertex', () => {
	const baseline = [1, 2, 3, 4];
	for (let corner = 0; corner < 4; corner++) {
		const values = [...baseline];
		values[corner] |= 0x8000;
		const mesh = readCollisionHeightfield(samples(values), { width: 2, height: 2, scale: [1, 32766, 1] });
		assert.equal(mesh.triangles.length, 0);
		assert.equal(mesh.vertices[corner][1], baseline[corner]);
	}
	const mesh = readCollisionHeightfield(samples([0x8001, 2, 3, 4, 5, 6]), {
		width: 3,
		height: 2,
		scale: [1, 1, 1],
	});
	assert.deepEqual(mesh.triangles, [
		[1, 4, 2],
		[2, 4, 5],
	]);
});

test('rejects unsupported scales and incomplete sample data without filling the gaps', () => {
	const bytes = samples([0, 1, 2, 3]);
	const options = { width: 2, height: 2, scale: [1, 1, 1] as const };
	assert.throws(() => readCollisionHeightfield(bytes.subarray(1), options));
	assert.throws(() => readCollisionHeightfield(bytes, { ...options, width: 1 }));
	assert.throws(() => readCollisionHeightfield(bytes, { ...options, scale: [1, 0, 1] }));
	assert.throws(() => readCollisionHeightfield(bytes, { ...options, scale: [1, Number.NaN, 1] }));
});
