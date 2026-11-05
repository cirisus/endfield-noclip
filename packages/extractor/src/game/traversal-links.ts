import { trsMatrix, transformPoint, unityEulerQuaternion } from '@endfield-noclip/formats/unity/transform';
import type { TypeTreeObject } from '@endfield-noclip/formats/unity/type-tree';
import { isObject, numberField } from '@endfield-noclip/formats/unity/values';

import {
	createWallChecker,
	createGoalProjector,
	jumpConnection,
	jumpDuration,
	type GroundConnection,
	type Surface,
	type Vec3,
	type Wall,
} from '@oem/ganglia';
import type { CollisionWorld } from '@oem/ganglia/collision';

import { interactionPoint, interactionRules } from './interaction-rules.ts';
import { ropePairs, type traversalDevice } from './traversal-devices.ts';

type Device = NonNullable<ReturnType<typeof traversalDevice>>;
type Source = { buildGuid: string; contentHash: string };
type Input = {
	version: number;
	scene: string;
	source: Source;
	devices: Device[];
	templates: Record<string, unknown>;
};
type Options = {
	scene: string;
	source: Source;
	surfaces: Surface[];
	world: CollisionWorld;
	settings: TypeTreeObject;
	profile: { radius: number; height: number };
	walls: Wall[];
};
const distance = (a: Vec3, b: Vec3) => Math.hypot(...a.map((v, i) => v - b[i]));
const vector = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);

const float = (b: bigint) => {
	const data = new DataView(new ArrayBuffer(4));
	data.setUint32(0, Number(BigInt.asUintN(32, b)), true);
	return data.getFloat32(0, true);
};

// this reader handles only direct scalar/vector device values. expressions retain unknown state.
const parameter = (value: unknown): unknown => {
	if (!isObject(value) || !Array.isArray(value.valueArray)) {
		return undefined;
	}
	const bits: bigint[] = [];
	for (const atom of value.valueArray) {
		if (!isObject(atom) || typeof atom.valueBit64 !== 'string' || !/^-?\d+$/.test(atom.valueBit64)) {
			return undefined;
		}
		bits.push(BigInt(atom.valueBit64));
	}
	if (value.type === 1 && bits.length === 1 && (bits[0] === 0n || bits[0] === 1n)) {
		return bits[0] === 1n;
	}
	if (value.type === 3 && bits.length === 1) {
		return Number(bits[0]);
	}
	if (value.type === 5 && bits.length === 1) {
		return float(bits[0]);
	}
	if (value.type === 11 && bits.length === 3) {
		return bits.map(float);
	}
	return undefined;
};
const properties = (list: unknown) =>
	new Map(
		(Array.isArray(list) ? list : []).flatMap((p) =>
			isObject(p) && typeof p.key === 'string' ? [[p.key, parameter(p.value)] as const] : [],
		),
	);
const effective = (device: Device, raw: unknown, component: string) => {
	const forcedState = (key: string) =>
		component === 'InteractiveVerticalRopeComponentData' && (key === 'state' || key === 'is_locked');
	if (!isObject(raw) || !Array.isArray(raw.components)) {
		return null;
	}
	const selected = raw.components.find(
		(c) => isObject(c) && typeof c.type === 'string' && c.type.includes(component),
	);
	if (!isObject(selected)) {
		return null;
	}
	const values = properties(selected.properties);
	for (const list of [raw.config, raw.saved]) {
		for (const [key, value] of properties(list)) {
			values.set(key, value);
		}
	}
	const variants = Array.isArray(raw.variants) ? raw.variants : [];
	const entry = variants.find((v) => Array.isArray(v) && v[0] === device.template);
	const variant = Array.isArray(entry) && isObject(entry[1]) ? entry[1] : null;
	if (variant) {
		for (const [key, value] of properties(variant.diffProperties)) {
			values.set(key, value);
		}
		for (const diff of Array.isArray(variant.componentDiffProperties)
			? variant.componentDiffProperties
			: []) {
			if (
				Array.isArray(diff) &&
				typeof diff[0] === 'string' &&
				diff[0].includes(component.replace('ComponentData', '')) &&
				isObject(diff[1])
			) {
				for (const [key, value] of properties(diff[1].value)) {
					values.set(key, value);
				}
			}
		}
	}
	for (const [key, value] of properties(device.placement.properties)) {
		values.set(key, value);
	}
	// component-scoped/runtime overrides need an explicit resolver before replacing direct fields.
	for (const override of device.placement.componentProperties) {
		// the versioned interactive schema uses key 169 for the jump-machine component.
		if (Array.isArray(override) && override[0] === 169 && component === 'JumpMachineComponentData') {
			for (const [key, value] of properties(override[1])) {
				if (properties(device.placement.properties).has(key)) {
					return null;
				}
				values.set(key, value);
			}
			continue;
		}
		if (
			Array.isArray(override) &&
			[...properties(override[1])].some(
				([key, value]) =>
					!forcedState(key) && values.has(key) && JSON.stringify(values.get(key)) !== JSON.stringify(value),
			)
		) {
			return null;
		}
	}
	if (
		[...properties(device.placement.mapProperties), ...properties(device.placement.globalProperties)].some(
			([key]) => !forcedState(key),
		)
	) {
		return null;
	}
	return values;
};

const completedGate = (condition: unknown) => {
	if (condition === null) {
		return true;
	}
	if (
		!isObject(condition) ||
		typeof condition.$type !== 'string' ||
		!condition.$type.match(/SimpleConditionCheck(Mission|Quest)State/) ||
		typeof (condition.missionId ?? condition.questId) !== 'string' ||
		(condition.missionId ?? condition.questId) === '' ||
		typeof condition.compareTarget !== 'number'
	) {
		return false;
	}
	const target = condition.compareTarget;
	switch (condition.compareOperator) {
		case 0: {
			return 3 === target;
		}
		case 1: {
			return 3 !== target;
		}
		case 2: {
			return 3 > target;
		}
		case 3: {
			return 3 >= target;
		}
		case 4: {
			return 3 < target;
		}
		case 5: {
			return 3 <= target;
		}
		default: {
			return false;
		}
	}
};
const available = (d: Device, p: Map<string, unknown>) =>
	d.placement.isLocked === false &&
	d.placement.createState === 0 &&
	p.get('state') === 1 &&
	p.get('is_locked') !== true &&
	completedGate(d.placement.progressLockCondition) &&
	d.scale.every((v) => v === 1);
const offset = (d: Device, p: Vec3): Vec3 => {
	const v = transformPoint(trsMatrix(d.position, unityEulerQuaternion(d.rotation), [1, 1, 1]), p);
	return [v[0], v[1], v[2]];
};

/**
 * builds fixed device macro-actions with all vertical ropes enabled and completed tasks. launch devices
 * retain their authored enabled/unlocked state. every action ends on collision-checked support.
 *
 * @param input build-bound traversal-device export
 * @param options matching physical surfaces, collision world, movement settings and exclusions
 * @returns directed connections and per-device acceptance or rejection evidence
 * @throws for mismatched scene/build or malformed export containers
 */
export const deviceConnections = (input: Input, options: Options) => {
	if (
		input.version !== 1 ||
		input.scene !== options.scene ||
		input.source.buildGuid !== options.source.buildGuid ||
		input.source.contentHash !== options.source.contentHash ||
		!Array.isArray(input.devices) ||
		!isObject(input.templates)
	) {
		throw new Error('device inputs must share scene and build');
	}
	const { surfaces, world, profile, settings } = options;
	const blocked = createWallChecker(options.walls, profile);
	const project = createGoalProjector(surfaces);
	const entry = (device: Device) => {
		const raw = input.templates[device.template];
		if (!isObject(raw) || !Array.isArray(raw.components) || typeof raw.source !== 'string') {
			return null;
		}
		const template = {
			componentList: raw.components
				.filter(isObject)
				.map((c) => ({ $type: c.type, propertyList: c.properties })),
			templateVariant: raw.variants,
		};
		const rules = interactionRules(template, { ...input.source, path: raw.source });
		return interactionPoint(
			{
				...device.placement,
				entityDataIdKey: device.template,
				levelLogicId: device.id,
				position: device.position,
				rotation: device.rotation,
				scale: device.scale,
			},
			device.level,
			template,
			rules,
		).navigationGoal;
	};
	const connections: GroundConnection[] = [];
	const outcomes: { id: string; mode: string; reason: string }[] = [];
	const inside = (p: Vec3) =>
		!world.bounds ||
		[p[0], p[2]].every(
			(v, i) =>
				v - profile.radius - 0.02 >= world.bounds!.min[i] &&
				v + profile.radius + 0.02 <= world.bounds!.max[i],
		);
	const support = (seed: Vec3) => {
		if (!inside(seed)) {
			return null;
		}
		const hit = world.groundAt(seed, {
			maxUp: 0.5,
			maxDown: 0.5,
			maxSlope: numberField(settings, '_slopeLimit'),
			radius: profile.radius,
		});
		if (!hit) {
			return null;
		}
		const foot: Vec3 = [hit.position[0], hit.position[1] + 0.01, hit.position[2]];
		if (
			!project(foot, { maxVertical: profile.radius }).length ||
			blocked(foot, foot) ||
			world.sweepCapsule(foot, foot, profile)
		) {
			return null;
		}
		return foot;
	};
	const clear = (points: Vec3[]) =>
		points.every(inside) &&
		points.every(
			(point, i) =>
				!blocked(i ? points[i - 1] : point, point) &&
				!world.sweepCapsule(i ? points[i - 1] : point, point, profile),
		);
	const nearby = (d: Device) => {
		const goal = entry(d);
		if (!goal) {
			return [];
		}
		const points: Vec3[] = project(goal.position, { maxVertical: 0.5, interaction: goal.interaction })
			.slice(0, 32)
			.map((p) => p.position);
		points.unshift(offset(d, [0, 0, -profile.radius]), offset(d, [0, 0, profile.radius]));
		for (const radius of [profile.radius * 2, 1]) {
			for (let i = 0; i < 8; i++) {
				points.push(
					offset(d, [Math.cos((i * Math.PI) / 4) * radius, 0, Math.sin((i * Math.PI) / 4) * radius]),
				);
			}
		}
		return points.map(support).filter((p): p is Vec3 => {
			if (!p || distance(p, goal.position) > goal.interaction.radius) {
				return false;
			}
			const { maxVertical, facing, halfAngle } = goal.interaction;
			if (maxVertical !== undefined && Math.abs(p[1] - goal.position[1]) > maxVertical) {
				return false;
			}
			const dx = p[0] - goal.position[0],
				dz = p[2] - goal.position[2];
			return (
				!facing ||
				halfAngle === undefined ||
				dx * facing[0] + dz * facing[2] >= Math.hypot(dx, dz) * Math.cos((halfAngle * Math.PI) / 180) - 1e-9
			);
		});
	};
	const byId = new Map(input.devices.map((d) => [d.id, d]));
	for (const pair of ropePairs(input.devices).pairs) {
		const lower = byId.get(pair.bottom)!,
			upper = byId.get(pair.top)!;
		if (!inside(lower.position) || !inside(upper.position)) {
			continue;
		}
		const p = effective(lower, input.templates[lower.template], 'InteractiveVerticalRopeComponentData');
		const q = effective(upper, input.templates[upper.template], 'InteractiveVerticalRopeComponentData');
		let reason = 'device-model-unresolved';
		if (p && q && lower.scale.every((value) => value === 1) && upper.scale.every((value) => value === 1)) {
			reason = 'support-or-clearance-unresolved';
			const requestedSpeed = Number(p.get('move_speed'));
			const speed = requestedSpeed > 0 ? requestedSpeed : Number(p.get('speed')),
				overhead = Number(p.get('duration'));
			if (Number.isFinite(speed) && speed > 0 && Number.isFinite(overhead) && overhead >= 0) {
				const from = nearby(lower),
					to = nearby(upper);
				let accepted = false;
				for (const a of from) {
					for (const b of to) {
						// rise outside the ledge before transferring onto its supported exit.
						const points: Vec3[] = [a, a, [a[0], b[1] + 0.1, a[2]], [b[0], b[1] + 0.1, b[2]], b];
						if (!clear(points)) {
							continue;
						}
						const times = [0, overhead];
						for (let i = 2; i < points.length; i++) {
							times.push(times[i - 1] + distance(points[i - 1], points[i]) / speed);
						}
						connections.push({
							id: `rope/${lower.id}/${upper.id}`,
							mode: 'rope',
							state: 'open',
							points,
							times,
							endpointTolerance: profile.radius,
						});
						accepted = true;
						break;
					}
					if (accepted) {
						break;
					}
				}
				if (accepted) {
					reason = 'accepted';
				}
			}
		}
		outcomes.push({ id: lower.id, mode: 'rope', reason });
	}
	for (const d of input.devices) {
		if (d.kind !== 'launch' || !inside(d.position)) {
			continue;
		}
		const p = effective(d, input.templates[d.template], 'JumpMachineComponentData');
		let reason = 'device-state-or-model-unresolved';
		if (
			p &&
			available(d, p) &&
			p.get('free_jump') === false &&
			p.get('use_electric') === false &&
			p.get('unlock_height_limit') === false
		) {
			const aim = p.get('target_position'),
				height = Number(p.get('height'));
			const start = nearby(d)[0],
				end = vector(aim) ? support(aim) : null;
			reason = 'support-or-clearance-unresolved';
			if (start && end && Number.isFinite(height) && height > 0) {
				const model = {
					gravity: numberField(settings, '_gravity'),
					fallingGravity: numberField(settings, '_fallingGravity'),
					maxFallingSpeed: numberField(settings, '_maxFallingSpeed'),
					apexTime: numberField(settings, '_apexTime'),
					maxJumpHeight: Math.max(height, end[1] + 3 - start[1]),
					mode: 'jump' as const,
				};
				const duration = jumpDuration(start[1], end[1], model);
				if (duration) {
					const arc = jumpConnection(start, end, {
						...model,
						profile,
						walls: options.walls,
						maxHorizontalSpeed: distance(start, end) / duration + 1,
						sweep: (a, b, body) => world.sweepCapsule(a, b, body),
					});
					if (arc) {
						connections.push({
							...arc,
							id: `launch/${d.id}`,
							mode: 'launch',
							state: 'open',
							endpointTolerance: profile.radius,
						});
						reason = 'accepted';
					}
				}
			}
		}
		outcomes.push({ id: d.id, mode: 'launch', reason });
	}
	return {
		connections,
		outcomes,
		snapshot: 'completed-tasks/all-ropes-enabled/authored-launch-devices',
		motionValidation: 'model-based',
	};
};
