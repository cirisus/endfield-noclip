import { isObject } from '@endfield-noclip/formats/unity/values';

import type { GroundArrival, GroundOptions, LocomotionOptions, Surface, Vec3, Wall } from '@oem/ganglia';

import { completedWallState, enabledWallState } from './air-wall-state.ts';
import { navigationPortals } from './navigation-portals.ts';

const object = (value: unknown): Record<string, unknown> => {
	if (!isObject(value)) {
		throw new Error('expected routing object');
	}
	return value;
};
const list = (value: unknown): unknown[] => {
	if (!Array.isArray(value)) {
		throw new Error('expected routing array');
	}
	return value;
};
const number = (value: unknown): number => {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		throw new Error('expected finite routing number');
	}
	return value;
};
const string = (value: unknown): string => {
	if (typeof value !== 'string' || !value.length) {
		throw new Error('expected routing identifier');
	}
	return value;
};
const vector = (value: unknown): Vec3 => {
	const p = list(value);
	if (p.length !== 3) {
		throw new Error('expected routing position');
	}
	return [number(p[0]), number(p[1]), number(p[2])];
};

const optionalFlag = (value: unknown) => {
	if (value !== undefined && typeof value !== 'boolean') {
		throw new Error('invalid stamina recovery flag');
	}
	return value;
};

/**
 * @param navigation current navmesh export
 * @param exclusions current air-wall export
 * @param request explicit asset/area selection, state identifier, ground endpoints and profile
 * @returns source-bound surfaces and queries; unknown walls remain blocked
 * @throws for mismatched builds, missing assets, unsupported transforms or invalid selections
 */
export const groundData = (
	navigation: unknown,
	exclusions: unknown,
	request: unknown,
	inputs: { travel?: unknown; movement?: unknown } = {},
) => {
	const { travel, movement } = inputs;
	const nav = object(navigation),
		walls = object(exclusions),
		query = object(request);
	const source = object(nav.source),
		wallSource = object(walls.source);
	if (
		nav.version !== 1 ||
		walls.version !== 2 ||
		nav.scene !== walls.scene ||
		string(source.buildGuid) !== wallSource.buildGuid ||
		string(source.contentHash) !== wallSource.contentHash
	) {
		throw new Error('navigation and walls must share a scene and build');
	}
	const release = string(query.release),
		state = string(query.state);
	if (
		query.progression !== undefined &&
		query.progression !== 'completed' &&
		query.progression !== 'fully-enabled'
	) {
		throw new Error('unsupported route progression snapshot');
	}
	const selected = new Set(list(query.assets).map(string));
	const areas = new Set(list(query.areas).map(number));
	if (!selected.size || !areas.size || [...areas].some((a) => !Number.isInteger(a) || a < 0 || a > 31)) {
		throw new Error('explicit assets and area whitelist required');
	}
	let defaultProfile: unknown;
	let defaultLocomotion: unknown;
	let steps = { up: 0, down: 0 };
	if (movement !== undefined) {
		const settings = object(movement),
			movementSource = object(settings.source);
		if (
			settings.version !== 1 ||
			source.buildGuid !== movementSource.buildGuid ||
			source.contentHash !== movementSource.contentHash
		) {
			throw new Error('movement settings must share the navigation build');
		}
		defaultProfile = settings.defaultProfile;
		defaultLocomotion = settings.sustainedSprint;
		const defaults = list(settings.assets ?? [])
			.map(object)
			.find(
				(asset) => typeof asset.path === 'string' && asset.path.endsWith('/MovementSetting_Default.asset'),
			);
		if (defaults) {
			const values = object(defaults.settings);
			steps = { up: number(values['_stepOffset']), down: number(values['_stepDownOffset']) };
		}
	}
	if (query.profile === undefined && defaultProfile === undefined) {
		throw new Error('provide a profile or build-bound movement settings');
	}
	const profile = object(query.profile ?? defaultProfile);
	const radius = number(profile.radius),
		height = number(profile.height);
	const speed = number(query.speed),
		maxVertical = number(query.maxVertical);
	if (radius < 0 || height <= 0 || speed <= 0 || maxVertical < 0) {
		throw new Error('invalid walking profile');
	}
	const surfaces: Surface[] = [];
	const boundaries: Parameters<typeof navigationPortals>[0] = [];
	const found = new Set<string>();
	for (const value of list(nav.assets)) {
		const asset = object(value),
			name = string(asset.asset);
		if (!selected.has(name)) {
			continue;
		}
		if (found.has(name)) {
			throw new Error('duplicate navigation asset');
		}
		found.add(name);
		const position = vector(asset.position),
			rotation = object(asset.rotation),
			settings = object(asset.settings);
		if (rotation.x !== 0 || rotation.y !== 0 || rotation.z !== 0 || rotation.w !== 1) {
			throw new Error('rotated navigation assets are not supported');
		}
		if (radius > number(settings.agentRadius) || height > number(settings.agentHeight)) {
			throw new Error('player exceeds baked agent clearance');
		}
		for (const [ti, tileValue] of list(asset.tiles).entries()) {
			const tile = object(tileValue),
				vertices = list(tile.vertices).map(vector);
			for (const [pi, polygonValue] of list(tile.polygons).entries()) {
				const polygon = object(polygonValue);
				if (!areas.has(number(polygon.area))) {
					continue;
				}
				if (polygon.type !== 0) {
					throw new Error('unsupported navigation polygon type');
				}
				const points = list(polygon.vertices).map((indexValue) => {
					const i = number(indexValue);
					if (!Number.isInteger(i) || !vertices[i]) {
						throw new Error('invalid navigation index');
					}
					const v = vertices[i];
					return [v[0] + position[0], v[1] + position[1], v[2] + position[2]] satisfies Vec3;
				});
				const origin = points[0];
				const area = points.reduce((sum, p, i) => {
					const q = points[(i + 1) % points.length];
					return sum + (p[0] - origin[0]) * (q[2] - origin[2]) - (q[0] - origin[0]) * (p[2] - origin[2]);
				}, 0);
				if (Math.abs(area) <= 1e-8) {
					continue;
				}
				const neighbours = list(polygon.neighbours).map(number);
				if (
					neighbours.length !== points.length ||
					neighbours.some((n) => !Number.isInteger(n) || n < 0 || n > 65535)
				) {
					throw new Error('invalid navigation neighbours');
				}
				const id = `${name}/${ti}/${pi}`;
				for (const [edge, neighbour] of neighbours.entries()) {
					if (neighbour & 0x8000) {
						boundaries.push({
							id,
							side: neighbour & 0xff,
							climb: number(settings.agentClimb),
							a: points[edge],
							b: points[(edge + 1) % points.length],
						});
					}
				}
				surfaces.push({
					id,
					vertices: points,
					portals: neighbours.flatMap((neighbour, index) => (neighbour === 0 ? [] : [index])),
				});
			}
		}
	}
	if (found.size !== selected.size || !surfaces.length) {
		throw new Error('selected navigation assets are missing or empty');
	}
	const exclusionsList: Wall[] = list(walls.walls).map((value) => {
		const wall = object(value);
		// resolve only the explicitly selected completed-progression snapshot.
		// Unsupported conditions and unresolved script-stage analyses remain blocked.
		if (wall.state !== 'unknown') {
			throw new Error('expected unresolved exported wall state');
		}
		return {
			min: vector(wall.min),
			max: vector(wall.max),
			state:
				query.progression === 'fully-enabled'
					? enabledWallState(wall)
					: query.progression === 'completed'
						? completedWallState(wall)
						: 'unknown',
			padding: number(wall.padding),
			points: list(wall.points).map((pointValue) => {
				const p = list(pointValue);
				if (p.length !== 2) {
					throw new Error('invalid wall polyline');
				}
				return [number(p[0]), number(p[1])];
			}),
		};
	});
	for (const value of list(walls.hazards)) {
		const hazard = object(value);
		const hazardState = hazard.state;
		if (hazard.kind !== 'repatriation' || (hazardState !== 'unknown' && hazardState !== 'active')) {
			throw new Error('unsupported route hazard');
		}
		const polygon =
			hazard.polygon === undefined
				? undefined
				: list(hazard.polygon).map((p): [number, number] => {
						const point = list(p);
						if (point.length !== 2) {
							throw new Error('invalid hazard polygon');
						}
						return [number(point[0]), number(point[1])];
					});
		if (polygon && polygon.length < 3) {
			throw new Error('invalid hazard polygon');
		}
		exclusionsList.push({ min: vector(hazard.min), max: vector(hazard.max), state: hazardState, polygon });
	}
	const landings = new Map<string, Vec3>();
	if (travel !== undefined) {
		const table = object(travel),
			travelSource = object(table.source);
		if (
			table.version !== 1 ||
			source.buildGuid !== travelSource.buildGuid ||
			source.contentHash !== travelSource.contentHash
		) {
			throw new Error('teleports must share the navigation build');
		}
		for (const value of list(table.points)) {
			const point = object(value);
			if (point.scene === nav.scene) {
				const id = string(point.id);
				if (landings.has(id)) {
					throw new Error('duplicate travel point');
				}
				landings.set(id, vector(point.position));
			}
		}
	}
	const arrivals: GroundArrival[] = list(query.arrivals).map((value) => {
		const arrival = object(value);
		if (arrival.state !== 'available' && arrival.state !== 'locked' && arrival.state !== 'unknown') {
			throw new Error('invalid arrival availability');
		}
		return {
			id: string(arrival.id),
			position:
				arrival.position === undefined ? vector(landings.get(string(arrival.id))) : vector(arrival.position),
			cost: number(arrival.cost),
			state: arrival.state,
		};
	});
	const targets = list(query.targets).map((value) => {
		const target = object(value);
		return { id: string(target.id), position: vector(target.position) };
	});
	if (new Set(targets.map((t) => t.id)).size !== targets.length) {
		throw new Error('duplicate routing target');
	}
	let locomotion: LocomotionOptions | undefined;
	const selectedLocomotion = query.locomotion ?? defaultLocomotion;
	if (selectedLocomotion !== undefined) {
		const policy = object(selectedLocomotion);
		locomotion = {
			speed: number(policy.speed),
			sprintSpeed: number(policy.sprintSpeed),
			sprintAcceleration: number(policy.sprintAcceleration),
		};
		if (policy.sprintThrough !== undefined) {
			locomotion.sprintThrough = list(policy.sprintThrough).map((mode) => {
				if (mode !== 'jump' && mode !== 'drop' && mode !== 'rope' && mode !== 'launch') {
					throw new Error('invalid sprint continuation mode');
				}
				return mode;
			});
		}
		if (policy.stamina !== undefined) {
			const resource = object(policy.stamina);

			locomotion.stamina = {
				capacity: number(resource.capacity),
				initial: number(resource.initial ?? resource.capacity),
				activationCost: number(resource.activationCost ?? 0),
				sprintDrain: number(resource.sprintDrain ?? 0),
				recoveryRate: number(resource.recoveryRate),
				recoveryDelay: number(resource.recoveryDelay),
				reserve: number(resource.reserve),
				recoveryDuringSprint: optionalFlag(resource.recoveryDuringSprint),
				recoveryDuringNonWalk: optionalFlag(resource.recoveryDuringNonWalk),
			};
		}
	}

	const options: GroundOptions = {
		speed,
		maxVertical,
		profile: { radius, height },
		walls: exclusionsList,
		locomotion,
		portals: navigationPortals(boundaries, steps),
	};
	return {
		release,
		source,
		scene: string(nav.scene),
		state,
		...(query.progression !== undefined ? { progression: query.progression } : {}),
		assets: [...selected],
		areas: [...areas],
		profileSource: query.profile === undefined ? 'most-common-character' : 'explicit',
		surfaces,
		options,
		arrivals,
		targets,
	};
};
