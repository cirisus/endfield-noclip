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
const fixture = () => ({
	ground: {
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

const execute = async (data: ReturnType<typeof fixture>, extra: Record<string, unknown> = {}) => {
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
	assert.ok(Math.abs(scope.padding - (0.25 + (10 * 0.1 ** 2) / 8 + 0.01)) < 1e-12);
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
