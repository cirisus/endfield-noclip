import assert from 'node:assert/strict';
import { test } from 'node:test';

import { readColliderGeometry } from './collision-inputs.ts';

const source = () => ({
	m_BakedTriangleCollisionMesh: new Uint8Array(0),
	m_BakedConvexCollisionMesh: new Uint8Array(0),
	m_LocalAABB: { m_Center: { x: 1, y: 2, z: 3 }, m_Extent: { x: 1, y: 2, z: 3 } },
});

test('requires explicit empty-cook bounds handling and retains missing source identity', () => {
	for (const kind of ['triangle', 'convex'] as const) {
		const data = source();
		assert.throws(() => readColliderGeometry(data, kind, false), /exceeds/);
		const geometry = readColliderGeometry(data, kind, true);
		assert.equal(geometry.approximation, 'missing-cook-bounds');
		assert.deepEqual(geometry.vertices, []);
		assert.deepEqual(geometry.triangles, []);
		assert.deepEqual(geometry.bounds, { min: [0, 0, 0], max: [2, 4, 6] });
	}
});

test('rejects corrupt nonempty cooks and invalid source bounds even with bounds handling enabled', () => {
	for (const kind of ['triangle', 'convex'] as const) {
		const data = source();
		data.m_BakedTriangleCollisionMesh = Uint8Array.of(0);
		data.m_BakedConvexCollisionMesh = Uint8Array.of(0);
		assert.throws(() => readColliderGeometry(data, kind, true), /exceeds/);
	}
	for (const invalid of [-1, NaN, Infinity]) {
		const data = source();
		data.m_LocalAABB.m_Extent.x = invalid;
		assert.throws(() => readColliderGeometry(data, 'triangle', true), /invalid missing-cook/);
	}
});
