import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
	completedWallState,
	enabledWallState,
	completedScriptWallState,
	terminalScriptStage,
	createWallResolver,
} from './air-wall-state.ts';
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

test('level-script defaults require a control scan including group-id writers', () => {
	const data = { ...wall(), level: 'level', groupId: '42', condition: { checkType: 0, missionData: null } };
	assert.equal(completedWallState(data), 'unknown');
	const resolve = createWallResolver({ scripts: [], ownLevels: new Set(['level']), undecoded: 0 });
	assert.equal(completedWallState({ ...data, completed: resolve(data) }), 'inactive');
	assert.equal(resolve({ ...data, defaultOn: true }).state, 'active');
	assert.equal(resolve({ ...data, scriptId: '42' }).state, 'unknown');
	const active = { ID: 0, $type: 'ScriptEvent_OnScriptActive', nextID: 1 };
	const enter = { ID: 2, $type: 'ScriptEvent_OnLeaderEnterTriggerVolume', nextID: 3 };
	const pointer = { paramSource: 0, constValue: { useSlotId: false, logicId: '42' } };
	const script: Script = {
		id: 'controller',
		level: 'level',
		data: {},
		headers: [active, enter],
		getters: new Map(),
		nodes: new Map<number, Script['data']>([
			[0, active],
			[2, enter],
			[
				1,
				{ ID: 1, $type: 'AirWallEnable', airWallPtr: pointer, enable: { paramSource: 0, constValue: false } },
			],
			[
				3,
				{ ID: 3, $type: 'AirWallEnable', airWallPtr: pointer, enable: { paramSource: 0, constValue: true } },
			],
		]),
	};
	const controlled = createWallResolver({ scripts: [script], ownLevels: new Set(['level']), undecoded: 0 })(
		data,
	);
	assert.equal(controlled.state, 'unknown');
	assert.equal(controlled.controllers[0].script, 'controller');
	assert.equal(completedWallState({ ...data, completed: controlled }), 'unknown');
	script.nodes.set(3, {
		ID: 3,
		$type: 'AirWallEnable',
		airWallPtr: pointer,
		enable: { paramSource: 0, constValue: false },
	});
	assert.equal(
		createWallResolver({ scripts: [script], ownLevels: new Set(['level']), undecoded: 0 })(data).state,
		'inactive',
	);
	assert.equal(
		createWallResolver({ scripts: [script], ownLevels: new Set(['level']), undecoded: 1 })(data).state,
		'unknown',
	);
	assert.equal(
		createWallResolver({ scripts: [script], ownLevels: new Set(), undecoded: 0 })({
			...data,
			defaultOn: true,
		}).state,
		'unknown',
	);
	const changed = {
		...active,
		$type: 'ScriptEvent_OnScriptStageChanged',
		filterMode: true,
		newStageFilter: { paramSource: 0, constValue: 2 },
	};
	script.headers = [changed];
	script.nodes.set(0, changed);
	assert.equal(
		completedScriptWallState(script, { logicId: '42' }, { stage: null, initialState: 'unknown' }),
		'unknown',
	);
	const dynamicFilter = { ...changed, newStageFilter: { paramSource: 300, path: 'stage' } };
	script.headers = [dynamicFilter];
	script.nodes.set(0, dynamicFilter);
	assert.equal(
		completedScriptWallState(script, { logicId: '42' }, { stage: 2, initialState: 'active' }),
		'unknown',
	);
	script.nodes.set(1, {
		ID: 1,
		$type: 'AirWallEnable',
		airWallPtr: { paramSource: 300, path: 'target' },
		enable: { paramSource: 0, constValue: true },
	});
	const unresolved = createWallResolver({ scripts: [script], ownLevels: new Set(['level']), undecoded: 0 })(
		data,
	);
	assert.equal(unresolved.state, 'unknown');
	assert.deepEqual(unresolved.unresolvedTargets, ['level/controller']);
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
	assert.equal(
		completedScriptWallState(script, { slotId: 8 }, { stage: 3, initialState: 'unknown' }),
		'inactive',
	);
	assert.equal(
		completedScriptWallState(script, { slotId: 8 }, { stage: 2, initialState: 'unknown' }),
		'unknown',
	);
	assert.equal(
		completedScriptWallState(script, { slotId: 99 }, { stage: 3, initialState: 'unknown' }),
		'unknown',
	);
	script.nodes.set(6, {
		ID: 6,
		$type: 'AirWallEnable',
		airWallPtr: pointer,
		enable: { paramSource: 0, constValue: true },
	});
	script.nodes.set(4, { ...enter, nextID: 6 });
	assert.equal(
		completedScriptWallState(script, { slotId: 8 }, { stage: 3, initialState: 'unknown' }),
		'unknown',
	);
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

test('completed disabling modules clear their referenced walls while preserving independent writers', () => {
	const target = {
		...wall(),
		level: 'level',
		groupId: '42',
		scriptId: 'controller',
		slotId: 8,
		defaultOn: true,
	};
	const pointer = { useSlotId: true, logicId: 'controller', slotId: 8 };
	const module = { $type: 'EncounterData', disableWhenCompleted: true, airWallPtrList: [pointer] };
	const script: Script = {
		id: 'controller',
		level: 'level',
		data: { modules: [['encounter', module]] },
		headers: [],
		nodes: new Map(),
		getters: new Map(),
	};
	const resolve = () =>
		createWallResolver({ scripts: [script], ownLevels: new Set(['level']), undecoded: 0 })(target);
	assert.equal(resolve().state, 'inactive');
	assert.equal(resolve().controllers[0].module, 'encounter');
	module.disableWhenCompleted = false;
	assert.equal(resolve().state, 'unknown');
	module.disableWhenCompleted = true;
	pointer.slotId = 9;
	assert.equal(resolve().state, 'unknown');
	pointer.slotId = 8;
	const header = { ID: 0, $type: 'ScriptEvent_OnLeaderEnterTriggerVolume', nextID: 1 };
	script.headers = [header];
	script.nodes.set(0, header);
	script.nodes.set(1, {
		ID: 1,
		$type: 'AirWallEnable',
		airWallPtr: { paramSource: 0, constValue: pointer },
		enable: { paramSource: 0, constValue: true },
	});
	assert.equal(resolve().state, 'unknown');
	script.headers = [];
	script.nodes.clear();
	assert.equal(
		createWallResolver({ scripts: [script], ownLevels: new Set(), undecoded: 0 })(target).state,
		'unknown',
	);
	script.data.modules = [
		[
			'nest',
			{
				$type: 'FogNestControllerData',
				disableWhenCompleted: true,
				airWallIdList: [{ useSlotId: false, logicId: '42', slotId: 0 }],
			},
		],
	];
	assert.equal(
		createWallResolver({ scripts: [script], ownLevels: new Set(['level']), undecoded: 0 })({
			...target,
			scriptId: '0',
		}).state,
		'inactive',
	);
});

test('completed mission guards prune enable paths without guessing dynamic property values', () => {
	const enable = {
		ID: 1,
		$type: 'AirWallEnable',
		airWallPtr: { paramSource: 0, constValue: { useSlotId: true, slotId: 8 } },
		enable: { paramSource: 0, constValue: true },
	};
	const disable = { ...enable, ID: 3, enable: { paramSource: 0, constValue: false } };
	const active = { ID: 0, $type: 'ScriptEvent_OnScriptActive', nextID: 3 };
	const trigger = {
		ID: 2,
		$type: 'ScriptEvent_OnLeaderEnterTriggerVolume',
		nextID: 1,
		validate: { paramSource: -1, idRef: 4 },
	};
	const script: Script = {
		id: 'controller',
		level: 'level',
		data: {},
		headers: [active, trigger],
		nodes: new Map<number, Script['data']>([
			[0, active],
			[1, enable],
			[2, trigger],
			[3, disable],
		]),
		getters: new Map([
			[
				4,
				{
					$type: 'CheckMissionOrQuestIsProcessing',
					missionId: { paramSource: 0, constValue: 'mission' },
					isQuest: { paramSource: 0, constValue: false },
				},
			],
		]),
	};
	assert.equal(
		completedScriptWallState(script, { slotId: 8 }, { stage: null, initialState: 'unknown' }),
		'inactive',
	);
	script.getters.set(4, {
		$type: 'GetterBool',
		value: { paramSource: 300, constValue: false, path: 'finished' },
	});
	assert.equal(
		completedScriptWallState(script, { slotId: 8 }, { stage: null, initialState: 'unknown' }),
		'unknown',
	);
	script.headers = [{ ...active, validate: { paramSource: -1, idRef: 4 } }];
	script.nodes.set(0, script.headers[0]);
	assert.equal(
		completedScriptWallState(script, { slotId: 8 }, { stage: null, initialState: 'active' }),
		'unknown',
	);
});

test('level briefs supply completed stages and parameterized global wall targets', () => {
	const active = { ID: 0, $type: 'ScriptEvent_OnScriptActive', nextID: 1 };
	const pointer = { paramSource: 200, path: 'gate' };
	const script: Script = {
		id: 'controller',
		level: 'level',
		data: { maxStage: 0 },
		headers: [active],
		nodes: new Map<number, Script['data']>([
			[0, active],
			[
				1,
				{
					ID: 1,
					$type: 'SwitchInt',
					value: { paramSource: -1, idRef: 9 },
					caseValueList: [0, 1],
					caseIDList: [2, 2],
					defaultID: 3,
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
		getters: new Map([[9, { $type: 'GetLevelScriptStage', scriptPtr: { paramSource: 1002 } }]]),
	};
	const brief = {
		maxStage: 2,
		properties: [
			{ key: 'gate', value: { type: 44, valueArray: [{ valueBit64: '42' }, { valueBit64: '0' }] } },
		],
	};
	const input = {
		scripts: [script],
		ownLevels: new Set(['level']),
		undecoded: 0,
		briefs: new Map<string, unknown>([['level/controller', brief]]),
	};
	const target = { ...wall(), level: 'level', groupId: '42', condition: { checkType: 0 } };
	const result = createWallResolver(input)(target);
	assert.equal(result.state, 'inactive');
	assert.equal(result.controllers[0].binding, 'group');
	assert.equal(result.controllers[0].stage, 2);
	brief.maxStage = 0;
	assert.equal(createWallResolver(input)(target).state, 'unknown');
	script.nodes.set(1, { ID: 1, $type: 'CheckBoolIfTrue', value: { paramSource: -1, idRef: 10 }, nextID: 2 });
	script.getters.set(10, {
		$type: 'CheckLevelScriptStage',
		scriptPtr: { paramSource: 1002 },
		comparer: { paramSource: 0, constValue: 4 },
		value: { paramSource: 0, constValue: 2 },
	});
	brief.maxStage = 2;
	assert.equal(createWallResolver(input)(target).state, 'inactive');
	brief.maxStage = 0;
	assert.equal(createWallResolver(input)(target).state, 'unknown');
});

test('fully enabled traversal opens controlled barriers while preserving uncontrolled boundary defaults', () => {
	const fixed = {
		scriptId: '0',
		defaultOn: true,
		condition: { checkType: 0 },
		completed: { controllers: [] },
	};
	assert.equal(enabledWallState(fixed), 'active');
	assert.equal(enabledWallState({ ...fixed, scriptId: 'controller' }), 'inactive');
	assert.equal(enabledWallState({ ...fixed, completed: { controllers: [{ script: 'other' }] } }), 'inactive');
	assert.equal(enabledWallState({ ...fixed, condition: { checkType: 1 } }), 'inactive');
});
