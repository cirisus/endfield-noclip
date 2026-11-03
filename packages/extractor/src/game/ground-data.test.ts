import assert from 'node:assert/strict';
import { test } from 'node:test';

import { planGroundRoute } from '@oem/ganglia';

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
const walls = { version: 2, source, scene: 'scene', walls: [], hazards: [] };
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
test('excludes reset volumes even when the navmesh contains a continuous walkable face', () => {
	const clear = groundData(navigation, walls, request);
	assert.equal(
		planGroundRoute(clear.surfaces, clear.arrivals, clear.targets[0].position, clear.options).status,
		'complete',
	);
	const blocked = groundData(
		navigation,
		{
			...walls,
			hazards: [
				{
					kind: 'repatriation',
					state: 'unknown',
					min: [0.3, -0.1, 0.3],
					max: [0.5, 0.1, 0.5],
				},
			],
		},
		request,
	);
	assert.equal(
		planGroundRoute(blocked.surfaces, blocked.arrivals, blocked.targets[0].position, blocked.options).status,
		'no-verified-route',
	);
	assert.throws(() => groundData(navigation, { ...walls, version: 1 }, request), /share/);
});
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
	assert.deepEqual(groundData(navigation, walls, query, { travel }).arrivals[0].position, [0.2, 0, 0.2]);
	assert.throws(
		() =>
			groundData(navigation, walls, query, {
				travel: { ...travel, source: { ...source, buildGuid: 'other' } },
			}),
		/build/,
	);
	assert.throws(
		() =>
			groundData(navigation, walls, query, {
				travel: {
					...travel,
					points: [{ id: 'tp', scene: 'another', position: [0, 0, 0] }],
				},
			}),
		/array/,
	);
});

test('uses a build-bound default capsule and preserves explicit profile overrides', () => {
	const movement = { version: 1, source, defaultProfile: { radius: 0.35, height: 1.66 } };
	const query = { ...request, profile: undefined };
	const data = groundData(navigation, walls, query, { movement });
	assert.deepEqual(data.options.profile, movement.defaultProfile);
	assert.equal(data.profileSource, 'most-common-character');
	assert.deepEqual(groundData(navigation, walls, request, { movement }).options.profile, request.profile);
	assert.throws(() => groundData(navigation, walls, query), /provide a profile/);
	assert.throws(
		() =>
			groundData(navigation, walls, query, {
				movement: { ...movement, source: { ...source, buildGuid: 'other' } },
			}),
		/share/,
	);
});

test('passes filled reset footprints to the planner instead of blocking their empty corners', () => {
	const polygon = [
		[-10, -10],
		[10, -10],
		[10, -9],
		[-9, -9],
		[-9, 10],
		[-10, 10],
	];
	const hazard = { kind: 'repatriation', state: 'unknown', min: [-10, -1, -10], max: [10, 1, 10], polygon };
	const data = groundData(navigation, { ...walls, hazards: [hazard] }, request);
	assert.deepEqual(data.options.walls[0].polygon, polygon);
	assert.equal(
		planGroundRoute(data.surfaces, data.arrivals, data.targets[0].position, data.options).status,
		'complete',
	);
	const boundsOnly = groundData(
		navigation,
		{ ...walls, hazards: [{ ...hazard, polygon: undefined }] },
		request,
	);
	assert.equal(
		planGroundRoute(
			boundsOnly.surfaces,
			boundsOnly.arrivals,
			boundsOnly.targets[0].position,
			boundsOnly.options,
		).status,
		'no-verified-route',
	);
});

test('imports sustained sprint from matching movement data and retains explicit resource policy', () => {
	const movement = {
		version: 1,
		source,
		defaultProfile: request.profile,
		sustainedSprint: { speed: 5, sprintSpeed: 7, sprintAcceleration: 60 },
		assets: [
			{
				path: 'Gameplay/MovementSetting_Default.asset',
				settings: {
					_runSpeed: 5,
					_sprintSpeed: 7,
					_sprintAcceleration: 60,
					_stepOffset: 0.4,
					_stepDownOffset: 0.6,
				},
			},
		],
	};
	const data = groundData(navigation, walls, request, { movement });
	assert.deepEqual(data.options.locomotion, { speed: 5, sprintSpeed: 7, sprintAcceleration: 60 });
	const route = planGroundRoute(data.surfaces, data.arrivals, data.targets[0].position, data.options);
	assert.equal(route.status, 'complete');
	if (route.status !== 'complete') {
		throw new Error('expected sprint route');
	}
	assert.equal(route.segments[0].gait, 'sprint');
	const locomotion = {
		speed: 3,
		sprintSpeed: 6,
		sprintAcceleration: 20,
		stamina: { capacity: 10, initial: 5, sprintDrain: 2, recoveryRate: 1, recoveryDelay: 1, reserve: 1 },
	};
	const imported = groundData(navigation, walls, { ...request, locomotion }, { movement }).options.locomotion;
	assert.equal(imported?.stamina?.initial, 5);
	assert.equal(imported?.stamina?.activationCost, 0);
	assert.equal(imported?.stamina?.sprintDrain, 2);
});

test('resolves only explicit completed mission gates and retains reset exclusions', () => {
	const wall = {
		min: [0.3, -0.1, 0.3],
		max: [0.5, 2, 0.5],
		state: 'unknown',
		padding: 0,
		points: [
			[0.3, 0.3],
			[0.5, 0.5],
		],
		scriptId: '0',
		defaultOn: true,
		condition: {
			checkType: 1,
			missionData: {
				isRiseAny: false,
				isDownAny: false,
				riseReason: [{ id: 'mission', isQuest: false, detailState: 2, isSame: true }],
				downReason: [{ id: 'mission', isQuest: false, detailState: 2, isSame: false }],
			},
		},
	};
	const exclusions = {
		...walls,
		walls: [wall],
		hazards: [
			{
				kind: 'repatriation',
				state: 'active',
				min: [1, -1, 1],
				max: [2, 2, 2],
			},
		],
	};
	assert.equal(groundData(navigation, exclusions, request).options.walls[0].state, 'unknown');
	const resolved = groundData(navigation, exclusions, { ...request, progression: 'completed' });
	assert.equal(resolved.progression, 'completed');
	assert.deepEqual(
		resolved.options.walls.map((value) => value.state),
		['inactive', 'active'],
	);
	assert.throws(
		() => groundData(navigation, exclusions, { ...request, progression: 'arbitrary' }),
		/snapshot/,
	);
});
