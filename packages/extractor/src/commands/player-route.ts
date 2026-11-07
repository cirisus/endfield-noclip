import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isDeepStrictEqual, parseArgs } from 'node:util';

import { isObject, numberField } from '@endfield-noclip/formats/unity/values';

import {
	createGroundPlanner,
	jumpDuration,
	planJumpRoute,
	projectPoint,
	retimeGroundRoute,
	type GroundArrival,
	type GroundOptions,
	type InteractionGoal,
	type LocomotionOptions,
	type Surface,
	type Vec3,
	type Wall,
} from '@oem/ganglia';
import type { BuildOptions, CollisionGeometry } from '@oem/ganglia/build';
import { createCollisionWorld } from '@oem/ganglia/collision';

import { walkableCollisionIndices, type CollisionRecord } from '../game/collision-ground.ts';
import { refineGoalGround } from '../game/ground-refinement.ts';
import { deviceConnections } from '../game/traversal-links.ts';
import type { RouteCache } from '../route-cache.ts';

type Source = { buildGuid: string; contentHash: string };
type Profile = { radius: number; height: number };
type Ground = {
	version: number;
	scene: string;
	source: Source;
	selection: unknown;
	coverage: unknown;
	surfaces: Surface[];
	options: GroundOptions;
	build?: Partial<BuildOptions & { tileCells: number }>;
};
type Collision = CollisionGeometry & {
	records?: CollisionRecord[];
	scene: string;
	source: Source;
	selection: unknown;
	coverage: unknown;
	options: { profile: Profile };
};
type Movement = {
	version: number;
	source: Source;
	defaultProfile: Profile;
	sustainedSprint: LocomotionOptions;
	assets: { path: string; settings: unknown }[];
};
type Request = {
	scene: string;
	source: Source;
	arrival: GroundArrival & { groundRange?: [number, number] };
	target: Vec3;
	interaction?: InteractionGoal;
	walls: Wall[];
	waypoints?: Vec3[];
};

export const summary =
	'compare bounded ground, device, jump and drop action combinations with physical collision checks';
export const usage =
	'usage: endfield-extract player-route --ground <file> --collision <file> --movement-settings <file> --request <file> -o <result> [--ground-only | --devices-only] [--devices <file>]';

const vector = (point: unknown): point is Vec3 =>
	Array.isArray(point) && point.length === 3 && point.every(Number.isFinite);
const sameSource = (a: Source, b: Source) =>
	a &&
	b &&
	typeof a.buildGuid === 'string' &&
	a.buildGuid.length > 0 &&
	typeof a.contentHash === 'string' &&
	a.contentHash.length > 0 &&
	a.buildGuid === b.buildGuid &&
	a.contentHash === b.contentHash;
const sameProfile = (a: Profile, b: Profile) => a && b && a.radius === b.radius && a.height === b.height;
const targetSupport = (surfaces: Surface[], target: Vec3) => {
	const nearest = projectPoint(surfaces, target, { maxVertical: 0.5 });
	if (nearest) {
		return nearest;
	}
	let below: ReturnType<typeof projectPoint> = null;
	for (const surface of surfaces) {
		const support = projectPoint([surface], target, { maxVertical: 4 });
		if (support && support.position[1] <= target[1] && (!below || support.position[1] > below.position[1])) {
			below = support;
		}
	}
	return below;
};

type Context = { cache: RouteCache; progress: (progress: Record<string, unknown>) => void };

/**
 * @param args matching physical ground, selected collision, movement and arbitrary endpoint request files
 * @param context optional single-worker preparation storage and ordered progress sink
 * @returns after writing a source-bound candidate route or an explicit unavailable result
 * @throws for mismatched source/profile/selection or malformed required input; no gap links are inferred on
 *   failure
 */
export const run = async (args: string[], context?: Context): Promise<void> => {
	const started = performance.now();
	const progress =
		context?.progress ?? ((value: Record<string, unknown>) => console.log(JSON.stringify(value)));
	const memo = async <T>(
		slot: Parameters<RouteCache['memo']>[0],
		key: string,
		create: () => T | Promise<T>,
	) => {
		if (context) {
			return context.cache.memo(slot, key, create);
		}
		return { value: await create(), reused: false };
	};
	const { values } = parseArgs({
		args,
		options: {
			ground: { type: 'string' },
			collision: { type: 'string' },
			'movement-settings': { type: 'string' },
			request: { type: 'string' },
			output: { type: 'string', short: 'o' },
			'ground-only': { type: 'boolean', default: false },
			'devices-only': { type: 'boolean', default: false },
			devices: { type: 'string' },
		},
	});
	if (
		!values.ground ||
		!values.collision ||
		!values['movement-settings'] ||
		!values.request ||
		!values.output
	) {
		throw new Error(usage);
	}
	const files = [values.ground, values.collision, values['movement-settings'], values.request];
	if (files.some((path) => resolve(path) === resolve(values.output!))) {
		throw new Error('route output must not overwrite an input');
	}
	progress({ phase: 'read-inputs' });
	const generation = context
		? await context.cache.begin({
				ground: values.ground,
				collision: values.collision,
				movement: values['movement-settings'],
			})
		: '';
	const ground: Ground = context
		? await context.cache.read('ground', values.ground)
		: JSON.parse(await readFile(values.ground, 'utf8'));
	const input: [Promise<Collision>, Promise<Movement>, Promise<Request>] = [
		context
			? context.cache.read<Collision>('collision', values.collision)
			: readFile(values.collision, 'utf8').then(JSON.parse),
		context
			? context.cache.read<Movement>('movement', values['movement-settings'])
			: readFile(values['movement-settings'], 'utf8').then(JSON.parse),
		readFile(values.request, 'utf8').then(JSON.parse),
	];
	const [collision, movement, request] = await Promise.all(input).catch(async (error: unknown) => {
		// Drain parallel input reads before the worker clears its cache for the next request.
		await Promise.allSettled(input);
		throw error;
	});
	if (
		!ground ||
		!collision ||
		!movement ||
		!request ||
		ground.version !== 1 ||
		movement.version !== 1 ||
		!request.scene ||
		request.scene !== ground.scene ||
		request.scene !== collision.scene ||
		!sameSource(request.source, ground.source) ||
		!sameSource(request.source, collision.source) ||
		!sameSource(request.source, movement.source)
	) {
		throw new Error('physical route inputs must share a scene and build');
	}
	const profile = ground.options?.profile;
	if (
		!profile ||
		![profile.radius, profile.height].every((value) => Number.isFinite(value) && value > 0) ||
		profile.height < 2 * profile.radius ||
		!sameProfile(profile, collision.options?.profile) ||
		!sameProfile(profile, movement.defaultProfile) ||
		!isDeepStrictEqual(ground.selection, collision.selection)
	) {
		throw new Error('physical route inputs must share body profile and collision selection');
	}
	if (
		!Array.isArray(ground.surfaces) ||
		!Array.isArray(movement.assets) ||
		!Array.isArray(request.walls) ||
		!Array.isArray(ground.options.walls) ||
		!Array.isArray(collision.positions) ||
		collision.positions.length < 9 ||
		collision.positions.length % 3 !== 0 ||
		!Array.isArray(collision.indices) ||
		collision.indices.length < 3 ||
		collision.indices.length % 3 !== 0 ||
		!request.arrival ||
		!vector(request.arrival.position) ||
		!vector(request.target) ||
		!Number.isFinite(ground.options.maxVertical) ||
		ground.options.maxVertical < 0 ||
		!movement.sustainedSprint
	) {
		throw new Error('invalid physical route request');
	}
	retimeGroundRoute({ status: 'unmapped' }, movement.sustainedSprint);
	const defaults = movement.assets.find((asset) => asset.path.endsWith('/MovementSetting_Default.asset'));
	if (!defaults || !isObject(defaults.settings)) {
		throw new Error('missing default movement settings');
	}
	const settings = defaults.settings;
	const options: GroundOptions = {
		...ground.options,
		maxVertical: 0.5,
		walls: [...ground.options.walls, ...request.walls],
		locomotion: movement.sustainedSprint,
	};
	const coverage = { ground: ground.coverage, collision: collision.coverage };
	const timing: Record<string, number> = { input: performance.now() - started };
	const limits = { maxCandidates: 8000, maxLinks: 64, sampleSpacing: 1 };
	const prepareReuse: Record<string, boolean> = {};
	const diagnostics: Record<string, unknown> = {
		prepareReuse,
		limits,
		timingMs: timing,
		truncated: false,
	};
	let collisionQueryStats: (() => unknown) | undefined;
	const emit = async (result: object, optimizing = false) => {
		if (collisionQueryStats) {
			diagnostics.collisionQueries = collisionQueryStats();
		}
		timing.total = performance.now() - started;
		const temporary = `${values.output!}.${process.pid}.tmp`;
		try {
			await writeFile(
				temporary,
				JSON.stringify({
					version: 1,
					scene: request.scene,
					source: request.source,
					motionValidation: 'model-based',
					coverage,
					diagnostics,
					...result,
					optimizing,
				}),
			);
			await rename(temporary, values.output!);
		} finally {
			await rm(temporary, { force: true });
		}
	};
	// Authored landings may settle down by the player's step distance. A factory
	// centre is a volume seed instead: its source bounds explicitly constrain the
	// vertical projection. Neither rule changes general route floor matching.
	const settling = Math.max(0.5, numberField(settings, '_stepDownOffset') + (ground.build?.cellHeight ?? 0));
	const range = request.arrival.groundRange ?? [
		request.arrival.position[1] - settling,
		request.arrival.position[1] + 0.5,
	];
	if (!Array.isArray(range) || range.length !== 2 || !range.every(Number.isFinite) || range[0] > range[1]) {
		throw new Error('invalid arrival support range');
	}
	const maxVertical = Math.max(...range.map((height) => Math.abs(height - request.arrival.position[1])));
	let supportedStart: ReturnType<typeof projectPoint> = null;
	for (const surface of ground.surfaces) {
		const start = projectPoint([surface], request.arrival.position, { maxVertical });
		if (
			start &&
			start.position[1] >= range[0] &&
			start.position[1] <= range[1] &&
			(!supportedStart ||
				Math.abs(start.position[1] - request.arrival.position[1]) <
					Math.abs(supportedStart.position[1] - request.arrival.position[1]))
		) {
			supportedStart = start;
		}
	}
	if (!supportedStart || request.arrival.state !== 'available') {
		await emit({
			status: 'unavailable',
			reason: supportedStart ? 'arrival-unavailable' : 'arrival-unmapped',
		});
		return;
	}
	const arrival = { ...request.arrival, position: supportedStart.position };
	diagnostics.arrival = { requested: request.arrival.position, grounded: arrival.position };
	const target = request.interaction ? null : targetSupport(ground.surfaces, request.target);
	const goal = request.interaction ? request.target : target?.position;
	if (!goal) {
		await emit({ status: 'unavailable', reason: 'target-unmapped' });
		return;
	}
	progress({ phase: 'ground-search', surfaces: ground.surfaces.length });
	const groundStart = performance.now();
	const groundKey = JSON.stringify([generation, request.walls]);
	let groundPlanner: ReturnType<typeof createGroundPlanner> | undefined;
	{
		const preparedGround = await memo('ground', groundKey, () =>
			createGroundPlanner(ground.surfaces, { ...options }),
		);
		prepareReuse.ground = preparedGround.reused;
		groundPlanner = preparedGround.value;
	}
	const candidates = groundPlanner.project(goal, { maxVertical: 0.5, interaction: request.interaction });
	if (!candidates.length) {
		await emit({ status: 'unavailable', reason: 'target-region-unmapped' });
		return;
	}
	// Publish supported walking feasibility before indexing airborne collision and
	// spending the optional action-discovery budget. The parent keeps polling for
	// a faster complete route while this atomic provisional result is available.
	const walking = groundPlanner.plan([arrival], goal, {
		interaction: request.interaction,
	});
	timing.ground = performance.now() - groundStart;
	// Interactive optimization starts from an existing supported route. Bound its
	// optional shortcut comparison separately from unresolved reachability work.
	if (walking.status === 'complete') {
		limits.maxCandidates = 640;
		await emit(
			{ status: 'candidate', route: walking, connections: [], groundedTarget: walking.points.at(-1) },
			!values['ground-only'] && !(values['devices-only'] && !values.devices),
		);
		progress({ phase: 'ground-route', cost: walking.cost });
	}
	if (values['ground-only'] || (values['devices-only'] && !values.devices)) {
		if (walking.status !== 'complete') {
			await emit({ status: 'unavailable', reason: walking.status });
		}
		return;
	}
	const model = {
		gravity: numberField(settings, '_gravity'),
		fallingGravity: numberField(settings, '_fallingGravity'),
		maxJumpHeight: numberField(settings, '_maxJumpHeight'),
		maxFallingSpeed: numberField(settings, '_maxFallingSpeed'),
		apexTime: numberField(settings, '_apexTime'),
		maxHorizontalSpeed: numberField(settings, '_inAirMaxHorizontalSpeedSprint'),
		airAcceleration: numberField(settings, '_inAirAcceleration'),
		airDeceleration: numberField(settings, '_inAirDecelerationNoInputSprint'),
	};
	const maxSlope = numberField(settings, '_slopeLimit');
	const runAirSpeed = numberField(settings, '_inAirMaxHorizontalSpeedRun');
	if (!Number.isFinite(runAirSpeed) || runAirSpeed < 0) {
		throw new Error('invalid running air-speed limit');
	}
	let minY = Infinity,
		maxY = -Infinity;
	const minXZ = [Infinity, Infinity],
		maxXZ = [-Infinity, -Infinity];
	for (const surface of ground.surfaces) {
		for (const point of surface.vertices) {
			minY = Math.min(minY, point[1]);
			maxY = Math.max(maxY, point[1]);
			minXZ[0] = Math.min(minXZ[0], point[0]);
			minXZ[1] = Math.min(minXZ[1], point[2]);
			maxXZ[0] = Math.max(maxXZ[0], point[0]);
			maxXZ[1] = Math.max(maxXZ[1], point[2]);
		}
	}
	const builtBounds = ground.build?.bounds;
	if (builtBounds !== undefined) {
		if (
			!builtBounds ||
			![builtBounds.min, builtBounds.max].every(
				(point) => Array.isArray(point) && point.length === 2 && point.every(Number.isFinite),
			) ||
			builtBounds.min.some((value, axis) => value > builtBounds.max[axis])
		) {
			throw new Error('invalid physical ground build bounds');
		}
		// empty air inside the selected collision build remains available to jump arcs.
		// restricting the index to surface extrema can cut off a platform's outside edge.
		minXZ.splice(0, 2, ...builtBounds.min);
		maxXZ.splice(0, 2, ...builtBounds.max);
	}
	const maxDrop = maxY - minY;
	const maximumDuration = jumpDuration(maxDrop, 0, { ...model, mode: 'jump' });
	if (!maximumDuration || !Number.isFinite(maxDrop)) {
		throw new Error('invalid collision vertical extent');
	}
	const maxHorizontalDistance = maximumDuration * model.maxHorizontalSpeed;
	diagnostics.model = { ...model, runAirSpeed };
	progress({ phase: 'collision-index', triangles: collision.indices.length / 3 });
	// The complete body and curved-arc chord inflation must remain in the indexed world.
	const curveInflationMargin =
		(Math.hypot(
			Math.max(model.gravity, model.fallingGravity),
			Math.max(model.airAcceleration, model.airDeceleration),
		) *
			0.1 ** 2) /
			8 +
		0.01;
	const padding = profile.radius + curveInflationMargin;
	const bounds = {
		min: [minXZ[0] - padding, minXZ[1] - padding] as [number, number],
		max: [maxXZ[0] + padding, maxXZ[1] + padding] as [number, number],
	};
	diagnostics.collisionScope = { bounds, padding, curveInflationMargin };
	const indexStart = performance.now();
	const preparedCollision = await memo('collision', JSON.stringify([generation, bounds]), () => {
		const geometry = { positions: collision.positions, indices: walkableCollisionIndices(collision) };
		return { geometry, world: createCollisionWorld(geometry, { bounds }) };
	});
	prepareReuse.collision = preparedCollision.reused;
	const { geometry, world } = preparedCollision.value;
	const initialQueryStats = world.queryCacheStats;
	if (context && initialQueryStats) {
		collisionQueryStats = () => {
			const current = world.queryCacheStats;
			if (!current) {
				return undefined;
			}
			return {
				...current,
				runHits: current.hits - initialQueryStats.hits,
				runMisses: current.misses - initialQueryStats.misses,
			};
		};
	}

	timing.collision = performance.now() - indexStart;
	let knownRoute = walking;
	let knownConnections = options.connections ?? [];
	if (values.devices) {
		progress({ phase: 'device-links' });
		const deviceStart = performance.now();
		const deviceInput: Parameters<typeof deviceConnections>[0] = context
			? await context.cache.read('devices', values.devices)
			: JSON.parse(await readFile(values.devices, 'utf8'));
		const preparedDevices = await memo('devices', JSON.stringify([groundKey, deviceInput]), () =>
			deviceConnections(deviceInput, {
				scene: ground.scene,
				source: ground.source,
				surfaces: ground.surfaces,
				world,
				settings,
				profile,
				walls: options.walls,
			}),
		);
		prepareReuse.devices = preparedDevices.reused;
		const devices = preparedDevices.value;
		options.connections = [...(options.connections ?? []), ...devices.connections];
		diagnostics.devices = devices;
		const connected = groundPlanner.plan([arrival], goal, {
			interaction: request.interaction,
			connections: options.connections,
		});
		knownRoute = connected;
		knownConnections = options.connections;
		timing.devices = performance.now() - deviceStart;
		if (connected.status === 'complete') {
			limits.maxCandidates = 640;
			if (walking.status !== 'complete' || connected.cost < walking.cost) {
				await emit(
					{
						status: 'candidate',
						route: connected,
						connections: devices.connections,
						groundedTarget: connected.points.at(-1),
					},
					!values['devices-only'],
				);
			}
		}
	}
	if (values['devices-only']) {
		if (knownRoute.status === 'complete') {
			await emit({
				status: 'candidate',
				route: knownRoute,
				connections: knownConnections,
				groundedTarget: knownRoute.points.at(-1),
			});
		} else {
			await emit({ status: 'unavailable', reason: knownRoute.status });
		}
		return;
	}
	let surfaces = ground.surfaces;
	if (ground.build?.cellSize !== undefined && ground.build.cellHeight !== undefined && ground.build.bounds) {
		progress({ phase: 'goal-refinement' });
		const refineStart = performance.now();
		const refinementBuild = {
			profile,
			maxSlope,
			stepUp: numberField(settings, '_stepOffset'),
			stepDown: numberField(settings, '_stepDownOffset'),
			cellSize: ground.build.cellSize,
			cellHeight: ground.build.cellHeight,
			bounds: ground.build.bounds,
		};
		const preparedRefinement = await memo(
			'refinement',
			JSON.stringify([groundKey, goal, request.interaction, model]),
			async () => {
				if (!groundPlanner) {
					throw new Error('missing coarse ground preparation');
				}
				const refined = await refineGoalGround(geometry, surfaces, {
					build: refinementBuild,
					goal,
					project: groundPlanner.project,
					interaction: request.interaction,
					model,
					queryTriangles: world.trianglesInBounds?.bind(world),
				});
				if (refined.surfaces.length) {
					const combined = [...surfaces, ...refined.surfaces];
					// The one-shot CLI does not retain base preparation. Release its
					// old graph before allocating the full replacement, as before.
					groundPlanner = undefined;
					return {
						refined,
						surfaces: combined,
						planner: createGroundPlanner(combined, { ...options, connections: [] }),
					};
				}
				return { refined, surfaces, planner: groundPlanner };
			},
		);
		prepareReuse.refinement = preparedRefinement.reused;
		const { refined } = preparedRefinement.value;
		surfaces = preparedRefinement.value.surfaces;
		groundPlanner = preparedRefinement.value.planner;
		diagnostics.refinement = { bounds: refined.bounds, addedSurfaces: refined.surfaces.length };
		timing.refinement = performance.now() - refineStart;
	}
	progress({ phase: 'jump-discovery', goalFaces: candidates.length });
	const searchStart = performance.now();
	const result = planJumpRoute(surfaces, world, [arrival], goal, {
		...options,
		groundPlanner,
		interaction: request.interaction,
		runAirSpeed,
		maxSlope,
		maxDrop,
		maxHorizontalDistance,
		...limits,
		maxShortcutCandidates: 512,
		waypoints: request.waypoints,
		onProgress: progress,
		model,
	});
	timing.search = performance.now() - searchStart;
	Object.assign(diagnostics, result.diagnostics);
	const { route, connections } = result;
	progress({ phase: 'route-search', connections: connections.length });
	if (route.status === 'complete') {
		await emit({ status: 'candidate', route, connections, groundedTarget: route.points.at(-1) });
	} else {
		await emit({ status: 'unavailable', reason: route.status, connections });
	}
};
