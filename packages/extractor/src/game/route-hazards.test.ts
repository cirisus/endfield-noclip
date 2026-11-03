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
