import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createGroundPlanner, type Surface, type Vec3, type Wall } from '@oem/ganglia';
import { createCollisionWorld } from '@oem/ganglia/collision';

import { traversalDevice } from './traversal-devices.ts';
import { deviceConnections } from './traversal-links.ts';

const source = { buildGuid: 'build', contentHash: 'hash' };
const profile = { radius: 0.2, height: 1.6 };
const settings = { _slopeLimit: 45, _gravity: 40, _fallingGravity: 38, _maxFallingSpeed: 70, _apexTime: 0.1 };
const floor = (id: string, x: number, y: number): Surface => ({
	id,
	vertices: [
		[x - 2, y, -2],
		[x - 2, y, 2],
		[x + 2, y, 2],
		[x + 2, y, -2],
	],
});
const parameter = (key: string, value: number | boolean | Vec3) => {
	const float = (v: number) => {
		const view = new DataView(new ArrayBuffer(4));
		view.setFloat32(0, v, true);
		return String(view.getInt32(0, true));
	};
	return {
		key,
		value: {
			type: Array.isArray(value)
				? 11
				: typeof value === 'boolean'
					? 1
					: key === 'state' || key === 'shape'
						? 3
						: 5,
			valueArray: (Array.isArray(value) ? value : [value]).map((v) => ({
				valueBit64:
					typeof v === 'boolean'
						? String(Number(v))
						: key === 'state' || key === 'shape'
							? String(v)
							: float(v),
			})),
		},
	};
};
const template = (type: string, values: ReturnType<typeof parameter>[]) => ({
	source: 'template',
	config: values,
	saved: [],
	variants: [],
	components: [
		{ type, properties: values },
		{
			type: 'Beyond_Gameplay_Core_TriggerObserverComponentDataForMemoryPack',
			properties: [
				parameter('shape', 2),
				parameter('radius', 2),
				parameter('center', [0, 1, 0]),
				parameter('size', [1, 1, 1]),
				parameter('interactive_direction_check', false),
				parameter('check_area_offset', [0, 0, 0]),
				parameter('check_area_radius', 2),
				parameter('check_area_height', 2),
				parameter('check_angle', 360),
				parameter('check_angle_offset', 0),
				parameter('player_direction_check', false),
				parameter('in_trigger_volume_performance', false),
			],
		},
	],
});
const device = (id: string, templateId: string, position: Vec3, target?: string) =>
	traversalDevice(
		{
			entityDataIdKey: templateId,
			levelLogicId: id,
			position,
			rotation: [0, 0, 0],
			scale: [1, 1, 1],
			createState: 0,
			isLocked: false,
			progressLockCondition: null,
			properties: target
				? [{ key: 'target', value: { type: 13, valueArray: [{ valueBit64: target }] } }]
				: [],
			componentProperties: [],
			mapProperties: [],
			globalProperties: [],
		},
		'level',
	)!;
const setup = (surfaces: Surface[], walls: Wall[] = []) => {
	const positions: number[] = [],
		indices: number[] = [];
	for (const surface of surfaces) {
		const first = positions.length / 3;
		positions.push(...surface.vertices.flat());
		indices.push(first, first + 1, first + 2, first, first + 2, first + 3);
	}
	return {
		scene: 'scene',
		source,
		surfaces,
		world: createCollisionWorld({ positions, indices }),
		settings,
		profile,
		walls,
	};
};

test('fixed launch joins supported ground, preserves device timing and rejects reverse, disabled and obstructed uses', () => {
	const surfaces = [floor('start', 0, 0), floor('end', 8, 4)];
	const entry = device('1', 'int_jumpmachine', [0, 0, 0]);
	entry.placement.componentProperties.push([169, [parameter('input_affect', false)]]);
	const values = [
		parameter('height', 7),
		parameter('target_position', [8, 4, 0]),
		parameter('state', 1),
		parameter('free_jump', false),
		parameter('use_electric', false),
		parameter('unlock_height_limit', false),
		parameter('input_affect', true),
	];
	const input = {
		version: 1,
		scene: 'scene',
		source,
		devices: [entry],
		templates: { int_jumpmachine: template('JumpMachineComponentData', values) },
	};
	const options = setup(surfaces);
	const result = deviceConnections(input, options);
	assert.equal(result.connections.length, 1);
	const planner = createGroundPlanner(surfaces, {
		speed: 4,
		maxVertical: 0.3,
		profile,
		walls: [],
		connections: result.connections,
	});
	const route = planner.plan([{ id: 'start', position: [-1, 0, 0], cost: 0, state: 'available' }], [9, 4, 0]);
	assert.equal(route.status, 'complete');
	if (route.status !== 'complete') {
		throw new Error('expected launch');
	}
	assert.deepEqual(
		route.segments.map((s) => s.mode),
		['walk', 'launch', 'walk'],
	);
	assert.equal(
		planner.plan([{ id: 'end', position: [9, 4, 0], cost: 0, state: 'available' }], [-1, 0, 0]).status,
		'no-verified-route',
	);
	const blocked = setup(surfaces, [{ min: [3, -1, -3], max: [4, 20, 3], state: 'active' }]);
	assert.equal(deviceConnections(input, blocked).connections.length, 0);
	entry.placement.isLocked = true;
	assert.equal(deviceConnections(input, options).connections.length, 0);
	assert.throws(
		() => deviceConnections({ ...input, source: { ...source, contentHash: 'other' } }, options),
		/share scene and build/,
	);
});

test('all reciprocal ropes are enabled while support, collision and geometry constraints still apply', () => {
	const surfaces = [floor('lower', 0, 0), floor('upper', 4, 6)];
	const lower = device('1', 'int_rope_port', [1.8, 0, 0], '2'),
		upper = device('2', 'int_rope_port', [1.8, 6, 0], '1');
	const input = {
		version: 1,
		scene: 'scene',
		source,
		devices: [lower, upper],
		templates: {
			int_rope_port: template('InteractiveVerticalRopeComponentData', [
				parameter('state', 1),
				parameter('speed', 8),
				parameter('duration', 1),
			]),
		},
	};
	const options = setup(surfaces);
	const result = deviceConnections(input, options);
	assert.equal(result.connections.length, 1);
	assert.equal(result.connections[0].mode, 'rope');
	assert.deepEqual(result.connections[0].points[0], result.connections[0].points[1]);
	assert.equal(result.connections[0].times[1], 1);
	const planner = createGroundPlanner(surfaces, {
		speed: 4,
		maxVertical: 0.3,
		profile,
		walls: [],
		connections: result.connections,
	});
	const route = planner.plan([{ id: 'start', position: [0, 0, 0], cost: 0, state: 'available' }], [4, 6, 0]);
	assert.equal(route.status, 'complete');
	lower.placement.properties.push(parameter('state', 0));
	lower.placement.isLocked = true;
	assert.equal(deviceConnections(input, options).connections.length, 1);
	assert.equal(
		deviceConnections(input, setup(surfaces, [{ min: [1, 1, -3], max: [4, 8, 3], state: 'active' }]))
			.connections.length,
		0,
	);
});
