import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import type { Wall } from '@oem/ganglia';

import { createRouteCache } from '../route-cache.ts';

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
					_stepDownOffset: 0.6,
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
	stage: 'all' | 'walking' | 'devices' = 'all',
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
			...(stage === 'all' ? [] : [stage === 'walking' ? '--ground-only' : '--devices-only']),
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
	const result = await execute(fixture(), {}, 'walking');
	assert.equal(result.status, 'candidate');
	assert.equal(result.optimizing, false);
	assert.ok(result.route.segments.every((segment: { mode: string }) => segment.mode === 'walk'));
	assert.equal(result.diagnostics.collisionScope, undefined);
});

test('known-action queries finish without jump discovery when no device inputs are supplied', async () => {
	const result = await execute(fixture(), {}, 'devices');
	assert.equal(result.status, 'candidate');
	assert.equal(result.optimizing, false);
	assert.equal(result.diagnostics.collisionScope, undefined);
	assert.equal(result.diagnostics.searches, undefined);
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
	// local shortcut refinement is a separate post-feasibility phase; it must not
	// multiply the two broad searches by the number of interaction faces.
	assert.equal(
		result.diagnostics.searches.filter((search: { reason: string }) => search.reason !== 'route-shortcuts')
			.length,
		2,
	);
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

test('settles authored arrivals within the player step-down limit without snapping to another storey', async () => {
	for (const [height, expected] of [
		[0.54, 'candidate'],
		[0.59, 'candidate'],
		[1.8, 'unavailable'],
		[-0.54, 'unavailable'],
	] as const) {
		const data = fixture();
		data.request.arrival.position[1] = height;
		const result = await execute(data, {}, 'walking');
		assert.equal(result.status, expected);
		if (expected === 'candidate') {
			assert.deepEqual(result.route.points[0], [1, 0, 1]);
			assert.equal(result.diagnostics.arrival.requested[1], height);
		} else {
			assert.equal(result.reason, 'arrival-unmapped');
		}
	}
});

test('factory centres project only inside their explicit source volume and still obey exclusions', async () => {
	const data = fixture();
	const arrival = { ...data.request.arrival, position: [1, 12, 1], groundRange: [-1, 20] };
	const result = await execute(data, { arrival }, 'walking');
	assert.equal(result.status, 'candidate');
	assert.deepEqual(result.route.points[0], [1, 0, 1]);
	const outside = await execute(data, { arrival: { ...arrival, groundRange: [2, 20] } }, 'walking');
	assert.equal(outside.reason, 'arrival-unmapped');
	await assert.rejects(execute(data, { arrival: { ...arrival, groundRange: [20, -1] } }), /support range/);
	data.ground.options.walls = [{ min: [0, -1, 0], max: [2, 2, 2], state: 'active' }];
	assert.equal((await execute(data, { arrival }, 'walking')).status, 'unavailable');
});

test('preparation reuse preserves independent target searches and invalidates changed exclusions', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'player-route-reuse-'));
	try {
		const data = fixture({ min: [0, 0], max: [10, 10] });
		const ground = { ...data.ground, build: { ...data.ground.build, cellSize: 0.15, cellHeight: 0.05 } };
		const movement = {
			...data.movement,
			assets: [
				{ ...data.movement.assets[0], settings: { ...data.movement.assets[0].settings, _stepOffset: 0.4 } },
			],
		};
		for (const [name, value] of Object.entries({ ground, collision: data.collision, movement })) {
			await writeFile(join(directory, name + '.json'), JSON.stringify(value));
		}
		const cache = createRouteCache();
		const output = join(directory, 'cached.json');
		const request = join(directory, 'request.json');
		const args = [
			'--ground',
			join(directory, 'ground.json'),
			'--collision',
			join(directory, 'collision.json'),
			'--movement-settings',
			join(directory, 'movement.json'),
			'--request',
			request,
			'-o',
			output,
		];
		for (const [index, target] of [
			[9, 0, 9],
			[9, 0, 9],
			[8, 0, 8],
			[8, 0, 8],
		].entries()) {
			await writeFile(request, JSON.stringify({ ...data.request, target }));
			await run(args, { cache, progress: () => {} });
			const reused = JSON.parse(await readFile(output, 'utf8'));
			await run([...args.slice(0, -1), join(directory, 'fresh.json')]);
			const fresh = JSON.parse(await readFile(join(directory, 'fresh.json'), 'utf8'));
			assert.deepEqual(reused.route, fresh.route);
			assert.deepEqual(reused.connections, fresh.connections);
			assert.equal(reused.diagnostics.prepareReuse.ground, index > 0);
			assert.equal(reused.diagnostics.prepareReuse.collision, index > 0);
			assert.equal(reused.diagnostics.prepareReuse.refinement, index === 1 || index === 3);
		}
		await writeFile(
			request,
			JSON.stringify({ ...data.request, walls: [{ min: [0, -1, 0], max: [2, 2, 2], state: 'active' }] }),
		);
		await run([...args, '--ground-only'], { cache, progress: () => {} });
		const blocked = JSON.parse(await readFile(output, 'utf8'));
		assert.equal(blocked.status, 'unavailable');
		assert.equal(blocked.diagnostics.prepareReuse.ground, false);
		const wrong = { ...movement, defaultProfile: { radius: 0.3, height: 1 } };
		await writeFile(join(directory, 'movement.json'), JSON.stringify(wrong));
		await assert.rejects(run(args, { cache, progress: () => {} }), /share body profile/);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test('the IPC worker keeps ordered progress and survives a failed request before reusing terrain', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'player-route-worker-'));
	const child = fork(new URL('../route-worker.ts', import.meta.url), [], {
		execArgv: [],
		stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
	});
	const messages: { type: string; id?: string; progress?: { phase: string }; error?: string }[] = [];
	let stdout = '',
		stderr = '';
	child.stdout?.on('data', (bytes) => {
		stdout += String(bytes);
	});
	child.stderr?.on('data', (bytes) => {
		stderr += String(bytes);
	});
	child.on('message', (value) => {
		messages.push(value as (typeof messages)[number]);
	});
	const waitFor = (id: string | undefined, terminal: string[]) =>
		new Promise<void>((resolve, reject) => {
			const ready = () => messages.some((value) => value.id === id && terminal.includes(value.type));
			if (ready()) {
				resolve();
				return;
			}
			const timer = setTimeout(() => {
				cleanup();
				reject(new Error('worker request timed out: ' + String(id)));
			}, 10000);
			const listener = () => {
				if (ready()) {
					cleanup();
					resolve();
				}
			};
			const exited = () => {
				cleanup();
				reject(new Error('worker exited before completion'));
			};
			const cleanup = () => {
				clearTimeout(timer);
				child.off('message', listener);
				child.off('exit', exited);
			};
			child.on('message', listener);
			child.on('exit', exited);
		});
	try {
		await waitFor(undefined, ['ready']);
		child.send({ id: 'bad', args: [] });
		await waitFor('bad', ['error']);
		assert.match(messages.find((value) => value.id === 'bad')!.error!, /usage/);
		const data = fixture();
		for (const [name, value] of Object.entries(data)) {
			await writeFile(join(directory, name + '.json'), JSON.stringify(value));
		}
		for (const [index, target] of [
			[9, 0, 9],
			[8, 0, 8],
		].entries()) {
			await writeFile(join(directory, 'request.json'), JSON.stringify({ ...data.request, target }));
			const output = join(directory, 'result-' + index + '.json');
			const args = [
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
				'--ground-only',
			];
			const id = 'query-' + index;
			child.send({ id, args });
			await waitFor(id, ['done', 'error']);
			const events = messages.filter((value) => value.id === id);
			assert.equal(events.at(-1)!.type, 'done');
			assert.equal(events[0].progress!.phase, 'read-inputs');
			const result = JSON.parse(await readFile(output, 'utf8'));
			assert.equal(result.status, 'candidate');
			assert.deepEqual(result.route.points.at(-1), target);
			assert.equal(result.diagnostics.prepareReuse.ground, index > 0);
		}
		assert.equal(stdout, '', 'structured progress must use the ordered IPC channel');
		assert.equal(stderr, '');
	} finally {
		if (child.exitCode === null && child.signalCode === null) {
			const exited = once(child, 'exit');
			child.kill();
			await exited;
		}
		await rm(directory, { recursive: true, force: true });
	}
});
