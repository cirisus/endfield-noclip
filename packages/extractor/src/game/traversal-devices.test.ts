import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ropePairs, traversalDevice } from './traversal-devices.ts';

const placement = (id: string, y: number, target: string) => ({
	entityDataIdKey: 'int_rope_port',
	levelLogicId: id,
	position: [0, y, 0],
	rotation: [0, 0, 0],
	scale: [1, 1, 1],
	createState: 0,
	properties: [{ key: 'target', value: { type: 13, valueArray: [{ valueBit64: target }] } }],
	componentProperties: [],
	isLocked: false,
	progressLockCondition: null,
});

test('pairs reciprocal rope references without inventing nearest or reverse jump links', () => {
	const top = traversalDevice(placement('1', 10, '2'), 'level')!;
	const bottom = traversalDevice(placement('2', 0, '1'), 'level')!;
	const nearby = traversalDevice(placement('3', 0, '99'), 'level')!;
	const result = ropePairs([top, bottom, nearby]);
	assert.equal(result.pairs.length, 1);
	assert.deepEqual(result.pairs[0], {
		top: '1',
		bottom: '2',
		ascent: 'rope',
		descent: 'drop',
		availability: 'unknown',
		motionValidation: 'unresolved',
		requiresGroundProjection: true,
	});
	assert.deepEqual(result.unpaired, ['3']);
	assert.equal(ropePairs([top, { ...bottom, level: 'other' }]).pairs.length, 0);
	assert.throws(() => ropePairs([top, top]), /duplicate/);
});

test('keeps device parameter scopes and does not convert authored state into player availability', () => {
	for (const template of ['int_jumpmachine_vertical', 'int_jumpmachine_free', 'int_accelerate_buff']) {
		const raw = { ...placement('4', 5, '8'), entityDataIdKey: template };
		const device = traversalDevice(raw, 'level')!;
		assert.equal(device.kind, template === 'int_accelerate_buff' ? 'accelerate' : 'launch');
		assert.equal(device.availability, 'unknown');
		assert.deepEqual(device.placement.componentProperties, raw.componentProperties);
		assert.equal(device.target, null);
	}
	assert.equal(traversalDevice({ entityDataIdKey: 'unrelated' }, 'level'), null);
	const invalid = placement('1', 10, '2');
	invalid.properties[0].value.type = 5;
	assert.throws(() => traversalDevice(invalid, 'level'), /target/);
	assert.throws(() => traversalDevice(placement('1', NaN, '2'), 'level'), /transform/);
});
