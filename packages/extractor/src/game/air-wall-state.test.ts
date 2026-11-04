import assert from 'node:assert/strict';
import { test } from 'node:test';

import { completedWallState, completedScriptWallState, terminalScriptStage } from './air-wall-state.ts';
import type { Script } from './script-drivers.ts';

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
	assert.equal(completedWallState(wall([], [reason(3)])), 'inactive');
	assert.equal(completedWallState({ ...wall([], [reason(3)]), defaultOn: true }), 'inactive');
	assert.equal(completedWallState(wall([], [])), 'inactive');
	assert.equal(completedWallState({ ...wall([], []), defaultOn: true }), 'active');
	const emptyAny = wall([], [reason(3)]);
	emptyAny.condition.missionData.isRiseAny = true;
	assert.equal(completedWallState(emptyAny), 'inactive');
});

test('unowned unconditional walls use the authored switch in the selected snapshot', () => {
	const data = { ...wall(), condition: { checkType: 0, missionData: null } };
	assert.equal(completedWallState(data), 'inactive');
	assert.equal(completedWallState({ ...data, defaultOn: true }), 'active');
	assert.equal(completedWallState({ ...data, scriptId: '42' }), 'unknown');
});

test('unsupported, script-owned and incomplete gates preserve unresolved activation', () => {
	const data = wall();
	assert.equal(completedWallState({ ...data, scriptId: '42' }), 'unknown');
	assert.equal(completedWallState({ ...data, condition: { checkType: 2 } }), 'unknown');
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

test('completed-world script walls follow terminal stage and retain conflicting trigger states', () => {
	const pointer = { paramSource: 0, constValue: { useSlotId: true, slotId: 8 } };
	const active = { ID: 0, $type: 'ScriptEvent_OnScriptActive', nextID: 1 };
	const enter = { ID: 4, $type: 'ScriptEvent_OnLeaderEnterTriggerVolume', nextID: 5 };
	const script: Script = {
		id: 'script',
		level: 'level',
		data: {},
		headers: [active, enter],
		getters: new Map([[9, { $type: 'GetLevelScriptStage', scriptPtr: { paramSource: 1002 } }]]),
		nodes: new Map<number, Script['data']>([
			[0, active],
			[4, enter],
			[
				1,
				{
					ID: 1,
					$type: 'SwitchInt',
					value: { idRef: 9 },
					caseValueList: [0, 1, 2, 3],
					caseIDList: [-1, 2, 3, 3],
				},
			],
			[
				5,
				{
					ID: 5,
					$type: 'SwitchInt',
					value: { idRef: 9 },
					caseValueList: [0, 1, 2, 3],
					caseIDList: [-1, 2, 2, -1],
				},
			],
			[
				2,
				{ ID: 2, $type: 'AirWallEnable', airWallPtr: pointer, enable: { paramSource: 0, constValue: true } },
			],
			[
				3,
				{ ID: 3, $type: 'AirWallEnable', airWallPtr: pointer, enable: { paramSource: 0, constValue: false } },
			],
		]),
	};
	assert.equal(terminalScriptStage(script), 3);
	assert.equal(completedScriptWallState(script, 8, 3), 'inactive');
	assert.equal(completedScriptWallState(script, 8, 2), 'unknown');
	assert.equal(completedScriptWallState(script, 99, 3), 'unknown');
	script.nodes.set(6, {
		ID: 6,
		$type: 'AirWallEnable',
		airWallPtr: pointer,
		enable: { paramSource: 0, constValue: true },
	});
	script.nodes.set(4, { ...enter, nextID: 6 });
	assert.equal(completedScriptWallState(script, 8, 3), 'unknown');
	assert.equal(
		completedWallState({
			...wall(),
			scriptId: 'script',
			completed: {
				model: 'script-terminal-stage-v1',
				stage: 3,
				state: 'inactive',
			},
		}),
		'inactive',
	);
});
