import assert from 'node:assert/strict';
import { test } from 'node:test';

import { groundData } from './ground-data.ts';

const source = { buildGuid: 'build', contentHash: 'content' };
const navigation = {
	version: 1,
	source,
	scene: 'scene',
	assets: [
		{
			asset: 'base',
			position: [0, 0, 0],
			rotation: { x: 0, y: 0, z: 0, w: 1 },
			settings: { agentRadius: 0.41, agentHeight: 2.1 },
			tiles: [
				{
					vertices: [
						[0, 0, 0],
						[2, 0, 0],
						[0, 0, 2],
					],
					polygons: [
						{ vertices: [0, 1, 2], area: 0, type: 0, neighbours: [0, 0, 0] },
						{ vertices: [0, 1, 2], area: 3, type: 0, neighbours: [0, 0, 0] },
					],
				},
			],
		},
	],
};
const walls = { version: 1, source, scene: 'scene', walls: [] };
const request = {
	release: 'release',
	state: 'explicit-state',
	assets: ['base'],
	areas: [0],
	profile: { radius: 0.4, height: 2 },
	speed: 3,
	maxVertical: 0.3,
	arrivals: [{ id: 'player', position: [0.2, 0, 0.2], state: 'available', cost: 0 }],
	targets: [{ id: 'target', position: [0.4, 0, 0.4] }],
};
test('imports only explicitly selected areas with matching build and clearance', () => {
	assert.equal(groundData(navigation, walls, request).surfaces.length, 1);
	assert.throws(
		() => groundData({ ...navigation, source: {} }, { ...walls, source: {} }, request),
		/identifier/,
	);
	assert.throws(
		() => groundData(navigation, { ...walls, source: { ...source, contentHash: 'other' } }, request),
		/share/,
	);
	assert.throws(() => groundData(navigation, walls, { ...request, assets: ['missing'] }), /missing/);
	assert.throws(
		() => groundData(navigation, walls, { ...request, profile: { radius: 1, height: 2 } }),
		/clearance/,
	);
});

test('resolves travel landing IDs only within the selected build and scene', () => {
	const travel = { version: 1, source, points: [{ id: 'tp', scene: 'scene', position: [0.2, 0, 0.2] }] };
	const query = { ...request, arrivals: [{ id: 'tp', state: 'available', cost: 5 }] };
	assert.deepEqual(groundData(navigation, walls, query, travel).arrivals[0].position, [0.2, 0, 0.2]);
	assert.throws(
		() => groundData(navigation, walls, query, { ...travel, source: { ...source, buildGuid: 'other' } }),
		/build/,
	);
	assert.throws(
		() =>
			groundData(navigation, walls, query, {
				...travel,
				points: [{ id: 'tp', scene: 'another', position: [0, 0, 0] }],
			}),
		/array/,
	);
});
