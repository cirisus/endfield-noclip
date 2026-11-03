import assert from 'node:assert/strict';
import { test } from 'node:test';

import { completedWallState } from './air-wall-state.ts';

const reason = (detailState: number, isSame = true) => ({
	id: 'mission',
	isQuest: false,
	detailState,
	isSame,
});
const wall = (riseReason = [reason(2)], downReason = [reason(2, false)]) => ({
	scriptId: '0',
	defaultOn: false,
	condition: { checkType: 1, missionData: { isRiseAny: false, isDownAny: false, riseReason, downReason } },
});

test('completed progression resolves mission gates using client equality and rise/down priority', () => {
	assert.equal(completedWallState(wall()), 'inactive');
	assert.equal(completedWallState(wall([reason(3)])), 'active');
	assert.equal(completedWallState(wall([reason(3)], [reason(3)])), 'active');
	const neither = wall([reason(2)], [reason(3, false)]);
	assert.equal(completedWallState(neither), 'inactive');
	assert.equal(completedWallState({ ...neither, defaultOn: true }), 'active');
	const combined = wall([reason(2), reason(3)], [reason(3)]);
	assert.equal(completedWallState(combined), 'inactive');
	combined.condition.missionData.isRiseAny = true;
	assert.equal(completedWallState(combined), 'active');
});

test('unsupported, script-owned and incomplete gates preserve unresolved activation', () => {
	const data = wall();
	assert.equal(completedWallState({ ...data, scriptId: '42' }), 'unknown');
	assert.equal(completedWallState({ ...data, condition: { checkType: 0 } }), 'unknown');
	assert.equal(completedWallState(wall([], [])), 'unknown');
	assert.equal(
		completedWallState({
			...data,
			condition: {
				checkType: 1,
				missionData: { ...data.condition.missionData, riseReason: [{ id: '' }] },
			},
		}),
		'unknown',
	);
});
