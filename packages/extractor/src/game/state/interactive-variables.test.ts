import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { WorldIndex } from '../world/world-index.ts';

import { GameState } from './game-state.ts';
import {
	interactiveStateGates,
	loadInteractiveVariables,
	nameInteractiveVariable,
} from './interactive-variables.ts';
import { sceneControl } from './scene-control.ts';

test('an interactive-backed map variable is named and placed after its interactive', async () => {
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- only json is read
	const world = {
		json: async () => ({
			mapVarAutoNameList: {
				map02: ['__mapVar_interactive_23400133061_state', '__mapVar_interactive_7_hp_ratio'],
			},
			mapVarIntKeyList: { map02: [30, 31] },
			mapVarBelongEntityList: { map02: [23400133061, 7] },
			mapVarDefaultValueList: { map02: [1, 100] },
		}),
	} as unknown as WorldIndex;
	const variables = await loadInteractiveVariables(world, { map: 'map02', mapId: 85 });
	assert.deepEqual(
		[...variables],
		[
			['mapVar:85:#30', { interactive: '23400133061', property: 'state', initial: 1 }],
			['mapVar:85:#31', { interactive: '7', property: 'hp_ratio', initial: 100 }],
		],
	);
	const control = sceneControl({
		kind: 'mapVar',
		id: 'mapVar:85:#30',
		name: '#30 (map map02)',
		values: [],
		default: 0,
		assumption: 'assumed 0',
	});
	nameInteractiveVariable(control, variables.get('mapVar:85:#30')!, {
		template: 'int_Hyper_erosion_sludge_core',
		position: [1, 2, 3],
	});
	assert.equal(control.name, 'Hyper sludge core');
	assert.deepEqual(control.place?.position, [1, 2, 3]);
	assert.match(control.assumption, /interactive 23400133061’s state, which a fresh world starts at 1/);
});

test('interactiveStateGates builds off/on gates only for tracked state map variables', async () => {
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- only json is read
	const world = {
		json: async () => ({
			mapVarAutoNameList: {
				map02: [
					'__mapVar_interactive_22800030026_state',
					'__mapVar_interactive_999_state',
					'__mapVar_interactive_7_hp_ratio',
				],
			},
			mapVarIntKeyList: { map02: [27, 28, 29] },
			mapVarBelongEntityList: { map02: [22800030026, 999, 7] },
			mapVarDefaultValueList: { map02: [0, 0, 100] },
		}),
	} as unknown as WorldIndex;
	const variables = { map: 'map02', mapId: 85, ids: {}, names: {} };
	const game = new GameState({ variables });
	const cond0 = { kind: 'mapVar' as const, mapId: '85', name: '#27', compare: 0 as const, target: 0 };
	const cond1 = { kind: 'mapVar' as const, mapId: '85', name: '#27', compare: 0 as const, target: 1 };
	const hpCond = { kind: 'mapVar' as const, mapId: '85', name: '#29', compare: 0 as const, target: 1 };
	game.note([cond0, cond1, hpCond]);
	game.requirements(cond0);
	game.requirements(hpCond);

	const gates = await interactiveStateGates(world, variables, game);
	assert.deepEqual([...gates.keys()], ['22800030026']);
	// ranges: 0 unset, 1 < 0, 2 = 0, 3 = 1, 4 > 1
	assert.deepEqual(gates.get('22800030026'), {
		off: [[{ control: 'mapVar:85:#27', mask: (1 << 0) | (1 << 1) | (1 << 2) | (1 << 4) }]],
		on: [[{ control: 'mapVar:85:#27', mask: 1 << 3 }]],
	});
});
