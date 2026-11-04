import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isDeepStrictEqual, parseArgs } from 'node:util';

import { isObject, numberField } from '@endfield-noclip/formats/unity/values';

import {
	createGoalProjector,
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
import type { CollisionGeometry } from '@oem/ganglia/build';
import { createCollisionWorld } from '@oem/ganglia/collision';

import { walkableCollisionIndices, type CollisionRecord } from '../game/collision-ground.ts';

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
	build?: { bounds?: { min: [number, number]; max: [number, number] } };
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
	arrival: GroundArrival;
	target: Vec3;
	interaction?: InteractionGoal;
	walls: Wall[];
};

export const summary =
	'compare bounded ground, jump and drop action combinations with physical collision checks';
export const usage =
	'usage: endfield-extract player-route --ground <file> --collision <file> --movement-settings <file> --request <file> -o <result>';

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

/**
 * @param args matching physical ground, selected collision, movement and arbitrary endpoint request files
 * @returns after writing a source-bound candidate route or an explicit unavailable result
 * @throws for mismatched source/profile/selection or malformed required input; no gap links are inferred on
 *   failure
 */
export const run = async (args: string[]): Promise<void> => {
	const { values } = parseArgs({
		args,
		options: {
			ground: { type: 'string' },
			collision: { type: 'string' },
			'movement-settings': { type: 'string' },
			request: { type: 'string' },
			output: { type: 'string', short: 'o' },
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
	console.log(JSON.stringify({ phase: 'read-inputs' }));
	let input = await Promise.all(files.map((path) => readFile(path, 'utf8')));
	const ground: Ground = JSON.parse(input[0]),
		collision: Collision = JSON.parse(input[1]),
		movement: Movement = JSON.parse(input[2]),
		request: Request = JSON.parse(input[3]);
	input = [];
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
	const diagnostics: Record<string, unknown> = {
		limits: {
			maxCandidates: 8000,
			maxLinks: 64,
			sampleSpacing: 1,
		},
		truncated: false,
	};
	const emit = async (result: object) => {
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
				}),
			);
			await rename(temporary, values.output!);
		} finally {
			await rm(temporary, { force: true });
		}
	};
	const start = projectPoint(ground.surfaces, request.arrival.position, { maxVertical: 0.5 });
	if (!start || request.arrival.state !== 'available') {
		await emit({ status: 'unavailable', reason: start ? 'arrival-unavailable' : 'arrival-unmapped' });
		return;
	}
	const arrival = { ...request.arrival, position: start.position };
	const project = createGoalProjector(ground.surfaces);
	const target = request.interaction ? null : targetSupport(ground.surfaces, request.target);
	const goal = request.interaction ? request.target : target?.position;
	if (!goal) {
		await emit({ status: 'unavailable', reason: 'target-unmapped' });
		return;
	}
	const candidates = project(goal, { maxVertical: 0.5, interaction: request.interaction });
	if (!candidates.length) {
		await emit({ status: 'unavailable', reason: 'target-region-unmapped' });
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
	console.log(JSON.stringify({ phase: 'collision-index', triangles: collision.indices.length / 3 }));
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
	const world = createCollisionWorld(
		{ positions: collision.positions, indices: walkableCollisionIndices(collision) },
		{ bounds },
	);
	console.log(JSON.stringify({ phase: 'jump-discovery', goalFaces: candidates.length }));
	const result = planJumpRoute(ground.surfaces, world, [arrival], goal, {
		...options,
		interaction: request.interaction,
		runAirSpeed,
		maxSlope,
		maxDrop,
		maxHorizontalDistance,
		sampleSpacing: 1,
		maxCandidates: 8000,
		maxLinks: 64,
		model,
	});
	Object.assign(diagnostics, result.diagnostics);
	const { route, connections } = result;
	console.log(JSON.stringify({ phase: 'route-search', connections: connections.length }));
	if (route.status === 'complete') {
		await emit({ status: 'candidate', route, connections, groundedTarget: route.points.at(-1) });
	} else {
		await emit({ status: 'unavailable', reason: route.status, connections });
	}
};
