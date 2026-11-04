import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import type { Wall } from '@oem/ganglia';

import { run } from './player-route.ts';

const source = { buildGuid: 'build', contentHash: 'content' };
const profile = { radius: 0.25, height: 1 };
const selection = { sceneState: 0, area: 0 };
const locomotion = { speed: 1, sprintSpeed: 2, sprintAcceleration: 1 };
const fixture = (bounds?: { min: number[]; max: number[] }) => ({
	ground: {
		...(bounds ? { build: { bounds } } : {}),
		version: 1,
		scene: 'scene',
		source,
		selection,
		coverage: { complete: false },
		surfaces: [
			{
				id: 'floor',
				vertices: [
					[0, 0, 0],
					[10, 0, 0],
					[10, 0, 10],
					[0, 0, 10],
				],
			},
		],
		options: { speed: 1, maxVertical: 0.5, walls: [] as Wall[], profile },
	},
	collision: {
		scene: 'scene',
		source,
		selection,
		coverage: { complete: false },
		options: { profile },
		positions: [0, 0, 0, 10, 0, 0, 10, 0, 10, 0, 0, 10],
		indices: [0, 2, 1, 0, 3, 2],
	},
	movement: {
		version: 1,
		source,
		defaultProfile: profile,
		sustainedSprint: locomotion,
		assets: [
			{
				path: 'MovementSetting/MovementSetting_Default.asset',
				settings: {
					_gravity: 10,
					_fallingGravity: 10,
					_maxJumpHeight: 1,
					_maxFallingSpeed: 10,
					_apexTime: 0,
					_inAirMaxHorizontalSpeedSprint: 2,
					_inAirMaxHorizontalSpeedRun: 1,
					_inAirAcceleration: 60,
					_inAirDecelerationNoInputSprint: 10,
					_slopeLimit: 45,
				},
			},
		],
	},
	request: {
		scene: 'scene',
		source,
		arrival: { id: 'player', state: 'available', cost: 0, position: [1, 0, 1] },
		target: [9, 0, 9],
		walls: [],
	},
});

const execute = async (
	data: ReturnType<typeof fixture>,
	extra: Record<string, unknown> = {},
	groundOnly = false,
) => {
	const directory = await mkdtemp(join(tmpdir(), 'player-route-'));
	try {
		const files = ['ground', 'collision', 'movement', 'request'] as const;
		for (const file of files) {
			await writeFile(
				join(directory, file + '.json'),
				JSON.stringify(file === 'request' ? { ...data.request, ...extra } : data[file]),
			);
		}
		const output = join(directory, 'result.json');
		await run([
			'--ground',
			join(directory, 'ground.json'),
			'--collision',
			join(directory, 'collision.json'),
			'--movement-settings',
			join(directory, 'movement.json'),
			'--request',
			join(directory, 'request.json'),
			'-o',
			output,
			...(groundOnly ? ['--ground-only'] : []),
		]);
		return JSON.parse(await readFile(output, 'utf8'));
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
};

test('plans arbitrary ground endpoints through the CLI and retains source/coverage/resource timing', async () => {
	const result = await execute(fixture());
	assert.equal(result.status, 'candidate');
	assert.equal(result.motionValidation, 'model-based');
	assert.deepEqual(result.source, source);
	assert.deepEqual(result.route.points[0], [1, 0, 1]);
	assert.deepEqual(result.route.points.at(-1), [9, 0, 9]);
	assert.ok(result.route.cost < Math.hypot(8, 8));
	assert.deepEqual(result.connections, []);
	assert.equal(result.coverage.ground.complete, false);
});

test('the foreground walking stage finishes before airborne collision indexing', async () => {
	const result = await execute(fixture(), {}, true);
	assert.equal(result.status, 'candidate');
	assert.equal(result.optimizing, false);
	assert.ok(result.route.segments.every((segment: { mode: string }) => segment.mode === 'walk'));
	assert.equal(result.diagnostics.collisionScope, undefined);
});

test('plans to the supplied interaction region instead of snapping an outside marker onto another floor', async () => {
	const result = await execute(fixture(), { target: [13, 0, 5], interaction: { radius: 4 } });
	assert.equal(result.status, 'candidate');
	const end = result.route.points.at(-1);
	assert.ok(Math.hypot(end[0] - 13, end[1], end[2] - 5) <= 4);
	assert.ok(end[0] <= 10);
	const below = await execute(fixture(), { target: [9, 2, 9] });
	assert.equal(below.status, 'candidate');
	assert.equal(below.groundedTarget[1], 0);
});

test('rejects mismatched source and capsule inputs and keeps unavailable arrival state explicit', async () => {
	const wrongSource = fixture();
	wrongSource.collision.source = { ...source, contentHash: 'other' };
	await assert.rejects(execute(wrongSource), /share a scene and build/);
	const wrongProfile = fixture();
	wrongProfile.collision.options.profile = { ...profile, radius: 0.3 };
	await assert.rejects(execute(wrongProfile), /share body profile/);
	const unavailable = await execute(fixture(), {
		arrival: { id: 'locked', state: 'unknown', cost: 0, position: [1, 0, 1] },
	});
	assert.equal(unavailable.status, 'unavailable');
	assert.equal(unavailable.reason, 'arrival-unavailable');
});

test('model-discovered jumps exceeding running air speed retain their sprint-entry requirement', async () => {
	const data = fixture();
	data.ground.surfaces = [
		{
			id: 'left',
			vertices: [
				[0, 0, 0],
				[2, 0, 0],
				[2, 0, 2],
				[0, 0, 2],
			],
		},
		{
			id: 'right',
			vertices: [
				[3, 0, 0],
				[6, 0, 0],
				[6, 0, 2],
				[3, 0, 2],
			],
		},
	];
	data.collision.positions = [0, 0, 0, 2, 0, 0, 2, 0, 2, 0, 0, 2, 3, 0, 0, 6, 0, 0, 6, 0, 2, 3, 0, 2];
	data.collision.indices = [0, 2, 1, 0, 3, 2, 4, 6, 5, 4, 7, 6];
	data.request.target = [5, 0, 1];
	data.movement.assets[0].settings = {
		...data.movement.assets[0].settings,
		_inAirMaxHorizontalSpeedSprint: 4,
	};
	const result = await execute(data);
	assert.equal(result.status, 'candidate');
	assert.ok(result.connections.length > 0);
	assert.ok(
		result.connections.some((connection: { requiredGait?: string }) => connection.requiredGait === 'sprint'),
	);
	assert.ok(result.route.segments.some((segment: { mode: string }) => segment.mode === 'jump'));
	const scope = result.diagnostics.collisionScope;
	assert.ok(Math.abs(scope.padding - (0.25 + (Math.hypot(10, 60) * 0.1 ** 2) / 8 + 0.01)) < 1e-12);
	assert.deepEqual(scope.bounds.min, [-scope.padding, -scope.padding]);
	assert.deepEqual(scope.bounds.max, [6 + scope.padding, 2 + scope.padding]);
});

test('mandatory physical exclusions survive an empty caller wall list at the start and goal', async () => {
	for (const center of [1, 9]) {
		const data = fixture();
		data.ground.options.walls = [
			{ min: [center - 0.5, -1, center - 0.5], max: [center + 0.5, 2, center + 0.5], state: 'unknown' },
		];
		const result = await execute(data);
		assert.equal(result.status, 'unavailable');
		assert.equal(result.route, undefined);
	}
});

test('searches a many-face interaction goal once and retains the reachable landing region', async () => {
	const data = fixture();
	const floor = (id: string, x0: number, x1: number) => ({
		id,
		vertices: [
			[x0, 0, 0],
			[x1, 0, 0],
			[x1, 0, 2],
			[x0, 0, 2],
		],
	});
	data.ground.surfaces = [floor('start', 0, 2)];
	for (let index = 0; index < 20; index++) {
		data.ground.surfaces.push(floor('landing/' + index, 3 + index * 0.15, 3 + (index + 1) * 0.15));
	}
	data.collision.positions = [0, 0, 0, 2, 0, 0, 2, 0, 2, 0, 0, 2, 3, 0, 0, 6, 0, 0, 6, 0, 2, 3, 0, 2];
	data.collision.indices = [0, 2, 1, 0, 3, 2, 4, 6, 5, 4, 7, 6];
	const result = await execute(data, { target: [5, 1, 1], interaction: { radius: 1.5 } });
	assert.equal(result.status, 'candidate');
	assert.equal(result.diagnostics.strategy, 'surface-action-graph');
	assert.equal(result.diagnostics.searches.length, 2);
	assert.ok(result.diagnostics.searches[0].goalFaces > 8);
	assert.equal(result.diagnostics.searches[0].reason, 'searched');
	assert.ok(result.diagnostics.searches[0].accepted > 0);
	const end = result.route.points.at(-1);
	assert.ok(Math.hypot(end[0] - 5, end[1] - 1, end[2] - 1) <= 1.5 + 1e-8);
});

test('compares jump-down actions even when the ground-only route already succeeds', async () => {
	const data = fixture();
	const floor = (id: string, x0: number, x1: number, y: number, z0: number, z1: number) => ({
		id,
		vertices: [
			[x0, y, z0],
			[x1, y, z0],
			[x1, y, z1],
			[x0, y, z1],
		],
	});
	data.ground.surfaces = [
		floor('upper', 0, 4, 4, -2, 2),
		{
			id: 'ramp',
			vertices: [
				[0, 4, 2],
				[4, 4, 2],
				[4, 0, 20],
				[0, 0, 20],
			],
		},
		floor('back', 0, 15, 0, 20, 24),
		floor('lower', 7, 15, 0, -2, 20),
	];
	const triangles = data.ground.surfaces.flatMap((surface) => [
		[surface.vertices[0], surface.vertices[2], surface.vertices[1]],
		[surface.vertices[0], surface.vertices[3], surface.vertices[2]],
	]);
	data.collision.positions = triangles.flat(2);
	data.collision.indices = Array.from({ length: triangles.length * 3 }, (_, index) => index);
	data.request.arrival.position = [2, 4, 0];
	data.request.target = [10, 0, 0];
	data.movement.assets[0].settings = {
		...data.movement.assets[0].settings,
		_maxJumpHeight: 2,
		_inAirMaxHorizontalSpeedSprint: 3,
	};
	const result = await execute(data);
	assert.equal(result.status, 'candidate');
	assert.equal(result.diagnostics.groundStatus, 'complete');
	assert.ok(result.route.cost < result.diagnostics.baselineCost / 2);
	assert.equal(result.diagnostics.selectedCost, result.route.cost);
	assert.ok(result.route.segments.some((segment: { mode: string }) => segment.mode === 'jump'));
});

test('retains the selected physical build extent around empty air', async () => {
	const result = await execute(fixture({ min: [-2, -3], max: [12, 13] }));
	const scope = result.diagnostics.collisionScope;
	assert.deepEqual(scope.bounds.min, [-2 - scope.padding, -3 - scope.padding]);
	assert.deepEqual(scope.bounds.max, [12 + scope.padding, 13 + scope.padding]);
	await assert.rejects(execute(fixture({ min: [2, 0], max: [1, 10] })), /build bounds/);
});
