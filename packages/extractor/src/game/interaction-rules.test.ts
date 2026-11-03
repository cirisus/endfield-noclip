import assert from 'node:assert/strict';
import { test } from 'node:test';

import { interactionGoal, interactionPoint, interactionRules } from './interaction-rules.ts';

const source = { buildGuid: 'build', contentHash: 'content', path: 'template.json' };
const bits = (value: number) => {
	const data = new DataView(new ArrayBuffer(4));
	data.setFloat32(0, value, true);
	return String(data.getInt32(0, true));
};
const field = (key: string, type: number | string, values: string[]) => ({
	key,
	value: { type, valueArray: values.map((valueBit64) => ({ valueBit64 })) },
});
const template = () => ({
	componentList: [
		{
			$type: 'Beyond_Gameplay_Core_TriggerObserverComponentDataForMemoryPack',
			propertyList: [
				field('shape', 3, ['2']),
				field('radius', 5, [bits(2)]),
				field('center', 11, [bits(0), bits(0.5), bits(0)]),
				field('size', 11, [bits(1), bits(1), bits(1)]),
				field('interactive_direction_check', 1, ['1']),
				field('check_area_offset', 11, [bits(0), bits(0), bits(1)]),
				field('check_area_radius', 5, [bits(2)]),
				field('check_area_height', 5, [bits(3)]),
				field('check_angle', 5, [bits(120)]),
				field('check_angle_offset', 5, [bits(-30)]),
				field('player_direction_check', 1, ['0']),
				field('in_trigger_volume_performance', 1, ['1']),
			],
		},
	],
});

test('retains authored trigger and independent directional checks without expanding to a foot radius', () => {
	const value = template(),
		before = structuredClone(value);
	const result = interactionRules(value, source)!;
	assert.deepEqual(result.trigger, { shape: 2, radius: 2, center: [0, 0.5, 0], size: [1, 1, 1] });
	assert.deepEqual(result.direction, {
		enabled: true,
		offset: [0, 0, 1],
		radius: 2,
		height: 3,
		angle: 120,
		angleOffset: -30,
		playerDirectionCheck: false,
	});
	assert.equal(result.scope, 'base-template');
	assert.ok(result.unresolved.includes('runtime-line-of-sight'));
	assert.deepEqual(value, before);
});

test('reads authored JSON parameter names identically to current numeric tags', () => {
	const value = template();
	value.componentList[0].$type = 'Beyond.Gameplay.Core.TriggerObserverComponentData, Gameplay.Beyond';
	const types = new Map<number, string>([
		[1, 'Bool'],
		[3, 'Int'],
		[5, 'Float'],
		[11, 'Vector3'],
	]);
	for (const property of value.componentList[0].propertyList) {
		property.value.type = types.get(Number(property.value.type))!;
	}
	assert.deepEqual(interactionRules(value, source), interactionRules(template(), source));
});

test('absent components stay unknown and malformed or ambiguous authoring fails', () => {
	assert.equal(interactionRules({ componentList: [] }, source), null);
	const value = template();
	assert.throws(
		() => interactionRules({ componentList: [...value.componentList, ...value.componentList] }, source),
		/ambiguous/,
	);
	value.componentList[0].propertyList[1].value.type = 3;
	assert.throws(() => interactionRules(value, source), /parameter radius/);
	assert.throws(() => interactionRules(template(), { ...source, buildGuid: '' }), /identity/);
});

const placement = () => ({
	levelLogicId: '123',
	entityDataIdKey: 'item',
	position: [1, 2, 3],
	rotation: [0, 45, 0],
	scale: [1, 1, 1],
	properties: [],
	componentProperties: [],
	mapProperties: [],
	globalProperties: [],
	createState: 0,
	isLocked: false,
	progressLockCondition: null,
});

test('placed points retain transforms and base-rule compatibility when trigger scopes are untouched', () => {
	const base = { ...template(), id: 'item', templateVariant: [] };
	const row = placement(),
		before = structuredClone(row);
	const result = interactionPoint(row, 'level', base, interactionRules(base, source));
	assert.equal(result.effective.status, 'base-rule-compatible');
	assert.deepEqual(result.position, [1, 2, 3]);
	assert.deepEqual(result.rotation, [0, 45, 0]);
	assert.equal(result.availability, 'unknown');
	assert.deepEqual(row, before);
});

test('placement overrides selected variant properties after base values', () => {
	const radius = field('radius', 5, [bits(4)]);
	const base = {
		...template(),
		id: 'base',
		templateVariant: [
			[
				'item',
				{
					diffProperties: [],
					componentDiffProperties: [['Comp_TriggerObserver', { value: [radius] }]],
				},
			],
		],
	};
	const row = { ...placement(), componentProperties: [[0, [field('radius', 5, [bits(6)])]]] };
	const result = interactionPoint(row, 'level', base, interactionRules(base, source));
	assert.equal(result.effective.status, 'overrides-applied');
	assert.deepEqual(result.effective.order, ['base', 'selected-variant', 'placement']);
	assert.equal(result.rules!.trigger.radius, 6);
	assert.equal(result.baseRules!.trigger.radius, 2);
	assert.equal(result.rules!.scope, 'placed-effective');
	assert.equal(result.overrides.triggerCandidates.components.length, 1);
	assert.equal(result.overrides.triggerCandidates.variantComponents.length, 1);
});

test('unknown variants, missing triggers and malformed point transforms remain explicit', () => {
	const base = { ...template(), id: 'base', templateVariant: [] };
	const result = interactionPoint(placement(), 'level', base, interactionRules(base, source));
	assert.ok(result.effective.unresolved.includes('variant-unavailable'));
	const missing = interactionPoint(placement(), 'level', null, null);
	assert.ok(missing.effective.unresolved.includes('template-unavailable'));
	assert.ok(missing.effective.unresolved.includes('trigger-rules-unavailable'));
	assert.throws(
		() => interactionPoint({ ...placement(), rotation: [0, Number.NaN, 0] }, 'level', base, null),
		/transform/,
	);
});

test('identical overrides and unrelated components retain base-rule compatibility', () => {
	const base = { ...template(), id: 'item', templateVariant: [] };
	const row = {
		...placement(),
		componentProperties: [
			[0, [field('radius', 5, [bits(2)])]],
			[61, [field('radius', 5, [bits(99)])]],
		],
	};
	const result = interactionPoint(row, 'level', base, interactionRules(base, source));
	assert.equal(result.effective.status, 'base-rule-compatible');
	assert.equal(result.overrides.triggerCandidates.components.length, 1);
});

const configuredTemplate = (changes: ReturnType<typeof field>[]) => {
	const value = { ...template(), id: 'item', templateVariant: [] };
	for (const change of changes) {
		const index = value.componentList[0].propertyList.findIndex((property) => property.key === change.key);
		value.componentList[0].propertyList[index] = change;
	}
	return value;
};

test('normal-channel sphere goals use the effective radius and an independent player probe', () => {
	const base = configuredTemplate([
		field('center', 11, [bits(0), bits(0), bits(0)]),
		field('interactive_direction_check', 1, ['0']),
	]);
	const row = { ...placement(), componentProperties: [[0, [field('radius', 5, [bits(2)])]]] };
	const point = interactionPoint(row, 'level', base, interactionRules(base, source));
	assert.deepEqual(point.navigationGoal?.position, [1, 1.6, 3]);
	assert.equal(point.navigationGoal?.interaction.radius, 2.5);
	assert.equal(point.navigationGoal?.model, 'normal-trigger-probe-v1');
	assert.deepEqual(point.navigationGoal?.source, source);
	const scaled = interactionPoint(
		{ ...row, scale: [2, 2, 2] },
		'level',
		base,
		interactionRules(base, source),
	);
	assert.equal(scaled.navigationGoal?.interaction.radius, 4.5);
});

test('chest-style full 180 degree gates produce a 90 degree half-angle in the authored yaw frame', () => {
	const base = configuredTemplate([
		field('radius', 5, [bits(3)]),
		field('center', 11, [bits(0), bits(0), bits(0)]),
		field('check_area_offset', 11, [bits(0), bits(0), bits(0)]),
		field('check_area_radius', 5, [bits(3)]),
		field('check_area_height', 5, [bits(3)]),
		field('check_angle', 5, [bits(180)]),
		field('check_angle_offset', 5, [bits(0)]),
	]);
	const point = interactionPoint(
		{ ...placement(), rotation: [0, 90, 0] },
		'level',
		base,
		interactionRules(base, source),
	);
	const goal = point.navigationGoal!;
	assert.equal(goal.interaction.radius, 3.5);
	assert.equal(goal.interaction.maxVertical, 3);
	assert.equal(goal.interaction.halfAngle, 90);
	assert.ok(Math.abs(goal.interaction.facing![0] - 1) < 1e-6);
	assert.ok(Math.abs(goal.interaction.facing![2]) < 1e-6);
	const scaled = interactionPoint(
		{ ...placement(), scale: [2, 2, 2] },
		'level',
		base,
		interactionRules(base, source),
	);
	assert.equal(scaled.navigationGoal?.interaction.radius, 3.5);
});

test('unsupported offsets, shapes, transforms and referenced properties do not create a navigation goal', () => {
	const base = { ...template(), id: 'item', templateVariant: [] };
	const offset = interactionPoint(placement(), 'level', base, interactionRules(base, source));
	assert.equal(offset.navigationGoal, null);
	assert.ok(offset.navigationUnresolved.includes('different-trigger-and-direction-centers'));
	const global = interactionPoint(
		{ ...placement(), properties: [field('radius', 5, [bits(99)])] },
		'level',
		base,
		interactionRules(base, source),
	);
	assert.equal(global.rules, null);
	assert.equal(global.navigationGoal, null);
	const wrongType = interactionPoint(
		{ ...placement(), componentProperties: [[0, [field('radius', 7, ['0'])]]] },
		'level',
		base,
		interactionRules(base, source),
	);
	assert.ok(wrongType.effective.unresolved.includes('typed-component-property-unresolved'));
	assert.equal(wrongType.navigationGoal, null);
	for (const changes of [
		[field('shape', 3, ['1'])],
		[field('player_direction_check', 1, ['1'])],
		[field('check_angle', 5, [bits(270)])],
	]) {
		const changed = configuredTemplate(changes);
		assert.equal(
			interactionPoint(placement(), 'level', changed, interactionRules(changed, source)).navigationGoal,
			null,
		);
	}
	const direct = { ...offset, rotation: [20, 0, 0] as [number, number, number] };
	assert.equal(interactionGoal(direct).goal, null);
});

test('an incompatible intermediate variant stays unresolved even if placement later supplies a valid value', () => {
	const base = {
		...template(),
		id: 'base',
		templateVariant: [
			[
				'item',
				{
					diffProperties: [],
					componentDiffProperties: [['Comp_TriggerObserver', { value: [field('radius', 3, ['4'])] }]],
				},
			],
		],
	};
	const row = { ...placement(), componentProperties: [[0, [field('radius', 5, [bits(6)])]]] };
	const result = interactionPoint(row, 'level', base, interactionRules(base, source));
	assert.equal(result.rules, null);
	assert.equal(result.navigationGoal, null);
	assert.ok(result.effective.unresolved.includes('typed-component-property-unresolved'));
});

test('a direction-free sphere retains rotated offset centers and nonuniform entity scale', () => {
	const base = configuredTemplate([
		field('interactive_direction_check', 1, ['0']),
		field('center', 11, [bits(0), bits(1), bits(0)]),
	]);
	const row = { ...placement(), rotation: [90, 0, 0], scale: [2, 3, 4] };
	const point = interactionPoint(row, 'level', base, interactionRules(base, source));
	assert.ok(point.navigationGoal);
	const position = point.navigationGoal.position;
	assert.ok(Math.abs(position[0] - 1) < 1e-6);
	assert.ok(Math.abs(position[1] - 1.6) < 1e-6);
	assert.ok(Math.abs(position[2] - 6) < 1e-6);
	assert.equal(point.navigationGoal.interaction.radius, 8.5);
	assert.equal('facing' in point.navigationGoal.interaction, false);
	assert.deepEqual(point.navigationGoal.source, source);
});

test('tilted direction gates remain unresolved even when their angular range is full', () => {
	const changes = [
		field('center', 11, [bits(0), bits(0), bits(0)]),
		field('check_area_offset', 11, [bits(0), bits(0), bits(0)]),
	];
	const cone = configuredTemplate(changes);
	const row = { ...placement(), rotation: [30, 50, 20] };
	const unresolved = interactionPoint(row, 'level', cone, interactionRules(cone, source));
	assert.equal(unresolved.navigationGoal, null);
	assert.ok(unresolved.navigationUnresolved.includes('tilted-direction-gate-unresolved'));
	const whole = configuredTemplate([...changes, field('check_angle', 5, [bits(360)])]);
	const resolved = interactionPoint(row, 'level', whole, interactionRules(whole, source));
	assert.equal(resolved.navigationGoal, null);
	assert.ok(resolved.navigationUnresolved.includes('tilted-direction-gate-unresolved'));
	const upright = interactionPoint(
		{ ...row, rotation: [0, 50, 0] },
		'level',
		whole,
		interactionRules(whole, source),
	);
	assert.ok(upright.navigationGoal);
	assert.equal(upright.navigationGoal.interaction.radius, 2.5);
	assert.equal(upright.navigationGoal.interaction.maxVertical, 3);
	assert.equal('facing' in upright.navigationGoal.interaction, false);
});
