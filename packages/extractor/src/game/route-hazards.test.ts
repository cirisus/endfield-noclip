import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { TypeTreeObject } from '@endfield-noclip/formats/unity/type-tree';

import { routeHazards } from './route-hazards.ts';

const payload = {
	$type: 'Beyond_Gameplay_LevelFunctionAreaData_RepatriateZoneDataForMemoryPack',
	lifeRatio: 1,
};
test('maps payload indices independently of slots and never treats defaultOff as verified inactive', () => {
	const data: { functionArea: TypeTreeObject } = {
		functionArea: {
			baseData: [
				{ functionType: 2, index: 1 },
				{ functionType: 1, index: 0, defaultOff: true },
			],
			ranges: [
				{ m_center: [0, 0, 0], m_size: [1, 1, 1] },
				{ m_center: [10, 2, 20], m_size: [4, 2, 8] },
			],
			specificDatas: [payload, { $type: 'other' }],
			functionAreaConditions: [],
		},
	};
	const zones = routeHazards(data);
	assert.equal(zones.length, 1);
	assert.equal(zones[0].slot, 1);
	assert.equal(zones[0].state, 'unknown');
	assert.deepEqual(zones[0].min, [8, 1, 16]);
	assert.deepEqual(zones[0].max, [12, 3, 24]);
	assert.throws(() => routeHazards({ functionArea: { ...data.functionArea, specificDatas: [] } }), /payload/);
	assert.throws(() => routeHazards({ functionArea: { ...data.functionArea, ranges: [] } }), /range/);
});

test('retains payload-free temporary reset zones', () => {
	const zones = routeHazards({
		functionArea: {
			baseData: [{ functionType: 15, index: -1 }],
			ranges: [{ m_center: [0, 0, 0], m_size: [2, 2, 2] }],
			specificDatas: [],
			functionAreaConditions: [],
		},
	});
	assert.equal(zones.length, 1);
	assert.equal(zones[0].payload, null);
	assert.equal(zones[0].state, 'unknown');
});

test('unaddressed reset zones follow the direct client enable branch regardless of defaultOff', () => {
	for (const defaultOff of [false, true]) {
		const shape = { functionType: 1, index: 0, uniqueId: 0n, hasCondition: false, defaultOff };
		const area = {
			baseData: [shape],
			ranges: [{ m_center: [0, 0, 0], m_size: [2, 2, 2] }],
			specificDatas: [payload],
			functionAreaConditions: [],
		};
		assert.equal(routeHazards({ functionArea: area })[0].state, 'active');
		assert.equal(
			routeHazards({ functionArea: { ...area, baseData: [{ ...shape, uniqueId: 1n }] } })[0].state,
			'unknown',
		);
		assert.equal(
			routeHazards({ functionArea: { ...area, baseData: [{ ...shape, hasCondition: true }] } })[0].state,
			'unknown',
		);
	}
});

test('exports an upright rotated hazard footprint while retaining unknown activation', () => {
	const shape = {
		functionType: 1,
		index: 0,
		shapeType: 3,
		defaultOff: true,
		postion: [10, 2, 20],
		euler: [0, 90, 0],
		offset: [0, 0, 0],
		bufferDistance: 0,
		posList: [
			[0, 0],
			[4, 0],
			[4, 1],
			[1, 1],
			[1, 4],
			[0, 4],
		],
	};
	const area = {
		baseData: [shape],
		ranges: [{ m_center: [12, 3.5, 18], m_size: [4, 3, 4] }],
		specificDatas: [payload],
		functionAreaConditions: [],
	};
	const [zone] = routeHazards({ functionArea: area });
	assert.equal(zone.state, 'unknown');
	assert.equal(zone.polygon?.length, 6);
	for (const [i, p] of [
		[10, 20],
		[10, 16],
		[11, 16],
		[11, 19],
		[14, 19],
		[14, 20],
	].entries()) {
		assert.ok(zone.polygon && Math.hypot(zone.polygon[i][0] - p[0], zone.polygon[i][1] - p[1]) < 1e-5);
	}
	const [tilted] = routeHazards({ functionArea: { ...area, baseData: [{ ...shape, euler: [10, 90, 0] }] } });
	assert.equal(tilted.polygon, undefined);
	assert.deepEqual(tilted.min, zone.min);
	assert.throws(
		() => routeHazards({ functionArea: { ...area, ranges: [{ m_center: [0, 0, 0], m_size: [1, 1, 1] }] } }),
		/disagrees/,
	);
});
