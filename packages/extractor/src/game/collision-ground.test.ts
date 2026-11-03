import assert from 'node:assert/strict';
import { test } from 'node:test';

import { readCollisionHeightfield } from '@endfield-noclip/formats/endfield/collision-heightfield';
import type { ColliderShape, EcsCollider } from '@endfield-noclip/formats/endfield/ecs-collider';
import type { CollisionMesh } from '@endfield-noclip/formats/unity/collision-mesh';

import { blockedByWalls } from '@oem/ganglia';
import { createCollisionWorld } from '@oem/ganglia/collision';

import { collisionGeometry, walkableCollisionIndices, type CollisionInputs } from './collision-ground.ts';
import { readColliderGeometry } from './collision-inputs.ts';

const filter = { options: 0, tag: 0, flags: 1, enabled: true, trigger: false, surface: 0, extra: 0 };
const identity = {
	position: [0, 0, 0] as [number, number, number],
	rotation: [0, 0, 0, 1] as [number, number, number, number],
};
const triangle: CollisionMesh = {
	vertices: [
		[0, 0, 0],
		[0, 0, 1],
		[1, 0, 0],
	],
	triangles: [[0, 1, 2]],
	faceRemap: null,
	materials: null,
	bounds: { min: [0, 0, 0], max: [1, 0, 1] },
};
const meshShape = (): ColliderShape => ({
	...identity,
	...filter,
	kind: 'mesh',
	mesh: 0,
	convex: false,
	cookingOptions: 0,
	scale: [1, 1, 1],
});
const input = (shapes: ColliderShape[] = [meshShape()]): CollisionInputs => ({
	version: 1,
	source: { buildGuid: 'build', contentHash: 'hash' },
	scene: 'map01',
	cell: { x: 0, z: 0 },
	selection: { sceneState: 0, area: 0, layerMask: 1 << 6 },
	coverage: { complete: false, remaining: ['global-chunks', 'mono-colliders'] },
	actors: [
		{
			id: 123,
			component: 4,
			file: 'first-cell',
			assets: ['mesh'],
			collider: {
				...identity,
				kind: 4,
				headerFlags: 0,
				layer: 6,
				tag: 0,
				shapes,
				complex: null,
				terrain: null,
				meshCount: 1,
			},
			shapeGeometry: shapes.map((shape) => (shape.kind === 'mesh' ? 'mesh' : null)),
			complexGeometry: null,
			terrainGeometry: null,
		},
	],
	excludedActors: [],
	geometries: { mesh: structuredClone(triangle) },
});
const close = (actual: number[], expected: number[]) =>
	actual.forEach((value, index) => assert.ok(Math.abs(value - expected[index]) < 1e-5));

test('places regular collision using actor and local shape transforms and mesh scale once', () => {
	const data = input(),
		actor = data.actors[0],
		shape = actor.collider.shapes[0];
	actor.collider.position = [10, 20, 30];
	actor.collider.rotation = [0, Math.SQRT1_2, 0, Math.SQRT1_2];
	shape.position = [1, 0, 0];
	if (shape.kind !== 'mesh') {
		throw new Error('expected mesh');
	}
	shape.scale = [2, 3, 4];
	const snapshot = structuredClone(data),
		result = collisionGeometry([data]);
	close(result.positions, [10, 20, 29, 14, 20, 29, 10, 20, 27]);
	assert.deepEqual(result.indices, [0, 1, 2]);
	assert.equal(result.records.length, 1);
	assert.equal(result.records[0].kind, 'mesh');
	assert.equal(result.records[0].count, 1);
	close(result.records[0].bounds.min, [10, 20, 27]);
	close(result.records[0].bounds.max, [14, 20, 29]);
	assert.deepEqual(data, snapshot);
});

test('applies compound shape rotation and preserves outward winding under negative scale', () => {
	const data = input(),
		shape = data.actors[0].collider.shapes[0];
	if (shape.kind !== 'mesh') {
		throw new Error('expected mesh');
	}
	shape.rotation = [0, Math.SQRT1_2, 0, Math.SQRT1_2];
	shape.scale = [-2, 1, 3];
	const result = collisionGeometry([data]);
	close(result.positions, [0, 0, 0, 3, 0, 0, 0, 0, 2]);
	assert.deepEqual(result.indices, [0, 2, 1]);
});

test('uses terrain vertices already scaled by the heightfield decoder', () => {
	const data = input([]),
		actor = data.actors[0];
	actor.collider.position = [10, 20, 30];
	actor.collider.terrain = { options: 0, tag: 0, flags: 1, enabled: true, surface: 0, scale: [2, 3, 4] };
	actor.terrainGeometry = 'terrain';
	data.geometries.terrain = {
		...triangle,
		vertices: [
			[0, 0, 0],
			[0, 3, 4],
			[2, 3, 0],
		],
	};
	const result = collisionGeometry([data]);
	assert.deepEqual(result.positions, [10, 20, 30, 10, 23, 34, 12, 23, 30]);
	assert.equal(result.records[0].kind, 'terrain');
});

test('deduplicates identical placements across cell and global inputs and rejects conflicts', () => {
	const a = input(),
		b = structuredClone(a);
	b.cell = 'global';
	b.actors[0].file = 'global-chunk';
	const result = collisionGeometry([a, b]);
	assert.equal(result.records.length, 1);
	assert.equal(result.coverage.duplicates, 1);
	assert.equal(result.coverage.actors, 1);
	b.actors[0].collider.position = [1, 0, 0];
	assert.throws(() => collisionGeometry([a, b]), /conflicting collision actor/);
	const c = structuredClone(a);
	c.geometries.mesh.vertices[0] = [1, 2, 3];
	assert.throws(() => collisionGeometry([a, c]), /conflicting collision geometry/);
});

test('rejects mismatched builds, scenes, selected states and collision layers', () => {
	for (const change of [
		(data: CollisionInputs) => {
			data.source.contentHash = 'other';
		},
		(data: CollisionInputs) => {
			data.scene = 'map02';
		},
		(data: CollisionInputs) => {
			data.selection.sceneState = 1;
		},
		(data: CollisionInputs) => {
			data.selection.layerMask = 1 << 5;
		},
	]) {
		const a = input(),
			b = structuredClone(a);
		change(b);
		assert.throws(() => collisionGeometry([a, b]), /must share a scene, build and selection/);
	}
	const data = input();
	data.actors[0].collider.layer = 5;
	assert.throws(() => collisionGeometry([data]), /selected layer mask/);
});

test('includes solid boxes but explicitly ignores disabled and trigger shapes', () => {
	const shape: ColliderShape = { ...identity, ...filter, kind: 'box', halfExtents: [1, 2, 3] };
	const data = input([shape, { ...shape, trigger: true }, { ...shape, enabled: false }]);
	const result = collisionGeometry([data]);
	assert.equal(result.positions.length, 24);
	assert.equal(result.indices.length, 36);
	assert.equal(result.records.length, 1);
	assert.equal(Math.min(...result.positions.filter((_, index) => index % 3 === 1)), -2);
	assert.equal(Math.max(...result.positions.filter((_, index) => index % 3 === 1)), 2);
});

test('retains complex-query and source-coverage gaps without treating them as regular solids', () => {
	const data = input(),
		complex: NonNullable<EcsCollider['complex']> = {
			mesh: 0,
			options: 9,
			tag: 2,
			flags: 1,
			scale: [1, 1, 1],
			extra: 0,
		};
	data.actors[0].collider.complex = complex;
	data.actors[0].complexGeometry = 'mesh';
	const result = collisionGeometry([data]);
	assert.equal(result.records.length, 1);
	assert.equal(result.coverage.complete, false);
	assert.deepEqual(result.coverage.remaining, ['global-chunks', 'mono-colliders']);
	assert.deepEqual(result.coverage.unresolved, [
		{ id: 123, component: 4, kind: 'complex', geometry: 'mesh', collider: complex },
	]);
	const unresolved = result.coverage.unresolved[0];
	assert.equal(unresolved.kind, 'complex');
	if (unresolved.kind !== 'complex') {
		throw new Error('expected complex geometry');
	}
	unresolved.collider.scale[0] = 50;
	assert.equal(complex.scale[0], 1);
});

test('fails on malformed geometry instead of dropping it', () => {
	const data = input();
	delete data.geometries.mesh;
	assert.throws(() => collisionGeometry([data]), /missing mesh geometry/);
	const malformed = input();
	malformed.geometries.mesh.triangles[0][2] = 99;
	assert.throws(() => collisionGeometry([malformed]), /invalid collision mesh triangle/);
});

test('circumscribes round solids with outward closed convex facets', () => {
	for (const shape of [
		{ ...identity, ...filter, kind: 'sphere' as const, radius: 1 },
		{ ...identity, ...filter, kind: 'capsule' as const, radius: 0.3, cylinderLength: 2 },
	]) {
		const result = collisionGeometry([input([shape])]);
		const radius = shape.kind === 'capsule' ? 2.3 : 1;
		const vertices: number[][] = [];
		for (let index = 0; index < result.positions.length; index += 3) {
			vertices.push(result.positions.slice(index, index + 3));
		}
		const edgeCounts = new Map<string, number>();
		for (let index = 0; index < result.indices.length; index += 3) {
			const face = result.indices.slice(index, index + 3);
			const [a, b, c] = face.map((vertexIndex) => vertices[vertexIndex]);
			const ab = b.map((value, axis) => value - a[axis]),
				ac = c.map((value, axis) => value - a[axis]);
			const normal = [
				ab[1] * ac[2] - ab[2] * ac[1],
				ab[2] * ac[0] - ab[0] * ac[2],
				ab[0] * ac[1] - ab[1] * ac[0],
			];
			const length = Math.hypot(...normal),
				dot = (point: number[]) => normal.reduce((sum, value, axis) => sum + value * point[axis], 0) / length;
			const plane = dot(a);
			assert.ok(plane >= radius);
			assert.ok(vertices.every((vertex) => dot(vertex) <= plane + 1e-9));
			for (let edge = 0; edge < 3; edge++) {
				const from = face[edge],
					to = face[(edge + 1) % 3];
				const key = from < to ? `${from}/${to}` : `${to}/${from}`;
				edgeCounts.set(key, (edgeCounts.get(key) ?? 0) + 1);
			}
		}
		assert.ok([...edgeCounts.values()].every((count) => count === 2));
		const approximation = result.coverage.approximations[0];
		assert.ok('envelopeRadius' in approximation);
		assert.equal(approximation.envelopeRadius, radius);
		assert.ok(approximation.outerRadius > radius);
		assert.equal(
			approximation.kind,
			shape.kind === 'capsule' ? 'capsule-axis-envelope' : 'circumscribed-sphere',
		);
		assert.equal(result.records[0].approximation, approximation.kind);
	}
});

test('transforms round-solid envelopes and keeps approximate support non-walkable on every layer', () => {
	const data = input([{ ...identity, ...filter, kind: 'sphere', radius: 1 }]);
	data.actors[0].collider.position = [10, 20, 30];
	data.actors[0].collider.shapes[0].position = [1, 2, 3];
	const result = collisionGeometry([data], { walkableLayers: 0 });
	const approximation = result.coverage.approximations[0];
	assert.equal(result.records[0].walkable, false);
	close(
		approximation.bounds.min.map((v, i) => (v + approximation.bounds.max[i]) / 2),
		[11, 22, 33],
	);
	assert.equal(collisionGeometry([data], { walkableLayers: 1 << 6 }).records[0].walkable, false);
	assert.equal(collisionGeometry([data]).records[0].walkable, false);
	assert.throws(
		() => collisionGeometry([data], { walkableLayers: -1 }),
		/invalid walkable collision layer mask/,
	);
	for (const radius of [0, -1, NaN]) {
		const invalid = input([{ ...identity, ...filter, kind: 'sphere', radius }]);
		assert.throws(() => collisionGeometry([invalid]), /invalid round collision radius/);
	}
});

test('excludes approximate support and initial interior occupancy while preserving body collision', () => {
	for (const shape of [
		{ ...identity, ...filter, kind: 'sphere' as const, radius: 1 },
		{ ...identity, ...filter, kind: 'capsule' as const, radius: 0.3, cylinderLength: 2 },
	]) {
		const geometry = collisionGeometry([input([shape])], { walkableLayers: 1 << 6 });
		const snapshot = [...geometry.indices];
		const raw = createCollisionWorld(geometry);
		const classified = createCollisionWorld({
			positions: geometry.positions,
			indices: walkableCollisionIndices(geometry),
		});
		const height = shape.kind === 'sphere' ? 1 : 2.3;
		const support = { maxUp: 0.5, maxDown: 0.5, maxSlope: 46 };
		assert.ok(raw.groundAt([0, height + 0.1, 0], support));
		assert.equal(classified.groundAt([0, height + 0.1, 0], support), null);
		const profile = { radius: 0.1, height: 0.2 };
		assert.ok(raw.sweepCapsule([-3, 0, 0], [3, 0, 0], profile));
		assert.ok(classified.sweepCapsule([-3, 0, 0], [3, 0, 0], profile));
		assert.equal(blockedByWalls([0, 0, 0], [0, 0, 0], geometry.exclusions, profile), true);
		assert.deepEqual(geometry.indices, snapshot);
	}
	const known = collisionGeometry([input()], { walkableLayers: 1 << 6 });
	assert.ok(
		createCollisionWorld({ positions: known.positions, indices: walkableCollisionIndices(known) }).groundAt(
			[0.2, 0, 0.2],
			{ maxUp: 0.1, maxDown: 0.1, maxSlope: 46 },
		),
	);
	assert.deepEqual(
		walkableCollisionIndices({ positions: known.positions, indices: known.indices }),
		known.indices,
	);
	assert.throws(
		() => walkableCollisionIndices({ ...known, records: [{ first: -1, count: 1, walkable: false }] }),
		/invalid collision triangle range/,
	);
});

const missingCook = () =>
	readColliderGeometry(
		{
			m_BakedTriangleCollisionMesh: new Uint8Array(0),
			m_LocalAABB: { m_Center: { x: 1, y: 2, z: 3 }, m_Extent: { x: 1, y: 1, z: 2 } },
		},
		'triangle',
		true,
	);

test('transforms missing-cook bounds into non-walkable obstacles and unknown occupied volumes', () => {
	const data = input(),
		actor = data.actors[0],
		shape = actor.collider.shapes[0];
	if (shape.kind !== 'mesh') {
		throw new Error('expected mesh');
	}
	data.geometries.mesh = missingCook();
	actor.collider.position = [10, 20, 30];
	actor.collider.rotation = [0, Math.SQRT1_2, 0, Math.SQRT1_2];
	shape.position = [1, 2, 3];
	shape.rotation = [0, Math.SQRT1_2, 0, Math.SQRT1_2];
	shape.scale = [-2, 3, 4];
	const snapshot = structuredClone(data),
		result = collisionGeometry([data], { walkableLayers: 1 << 6 });
	assert.equal(result.records[0].walkable, false);
	assert.equal(result.records[0].approximation, 'missing-cook-bounds');
	assert.equal(result.records[0].count, 12);
	close(result.records[0].bounds.min, [13, 25, 9]);
	close(result.records[0].bounds.max, [17, 31, 25]);
	assert.equal(result.coverage.complete, false);
	assert.equal(result.coverage.unresolved[0].kind, 'missing-cook-bounds');
	assert.equal(result.coverage.approximations[0].kind, 'missing-cook-bounds');
	const wall = result.exclusions[0],
		profile = { radius: 0.35, height: 1.66 };
	assert.equal(wall.state, 'unknown');
	assert.ok(wall.min.every((value, axis) => value < result.records[0].bounds.min[axis]));
	assert.ok(wall.max.every((value, axis) => value > result.records[0].bounds.max[axis]));
	assert.equal(blockedByWalls([15, 28, 17], [15, 28, 17], result.exclusions, profile), true);
	assert.equal(blockedByWalls([11, 28, 17], [19, 28, 17], result.exclusions, profile), true);
	assert.equal(blockedByWalls([11, 28, 17], [11, 28, 17], result.exclusions, profile), false);
	assert.deepEqual(data, snapshot);
});

test('keeps live and JSON-cached missing-cook bounds semantically identical', () => {
	const live = input();
	live.geometries.mesh = missingCook();
	live.geometries.mesh.bounds.min[0] = -0;
	const cached: CollisionInputs = JSON.parse(JSON.stringify(live));
	cached.actors[0].file = 'cached-cell';
	const result = collisionGeometry([live, cached]);
	assert.equal(result.coverage.duplicates, 1);
	assert.equal(result.records.length, 1);
	assert.equal(result.exclusions.length, 1);
	cached.geometries.mesh.bounds.max[0] += 0.001;
	assert.throws(() => collisionGeometry([live, cached]), /conflicting collision geometry/);
});

test('preserves an all-hole terrain patch without creating collision triangles', () => {
	const data = input([]),
		actor = data.actors[0];
	actor.collider.terrain = { options: 0, tag: 0, flags: 1, enabled: true, surface: 0, scale: [1, 1, 1] };
	actor.terrainGeometry = 'holes';
	data.geometries.holes = readCollisionHeightfield(Uint8Array.from([0, 128, 0, 128, 0, 128, 0, 128]), {
		width: 2,
		height: 2,
		scale: [1, 1, 1],
	});
	const result = collisionGeometry([data]);
	assert.equal(result.records[0].kind, 'terrain');
	assert.equal(result.records[0].count, 0);
	assert.deepEqual(result.indices, []);
	assert.equal(result.positions.length, 12);
});

test('deduplicates fresh decoded negative zeros against their JSON cache representation', () => {
	const live = input();
	live.actors[0].collider.rotation[1] = -0;
	live.actors[0].collider.shapes[0].position[2] = -0;
	live.geometries.mesh.vertices[0][0] = -0;
	const cached: CollisionInputs = JSON.parse(JSON.stringify(live));
	cached.actors[0].file = 'cached-cell';
	const result = collisionGeometry([live, cached]);
	assert.equal(result.coverage.duplicates, 1);
	assert.equal(result.records.length, 1);
	assert.ok(Object.is(live.actors[0].collider.rotation[1], -0));
	cached.actors[0].collider.position[0] = 0.001;
	assert.throws(() => collisionGeometry([live, cached]), /conflicting collision actor/);
});
