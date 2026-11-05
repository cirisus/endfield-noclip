import assert from 'node:assert/strict';
import { it } from 'node:test';

import type { SceneControl } from './states.ts';
import { completedProgressionPicks, openTraversalPicks, storyPointPicks, storyPoints } from './story.ts';

const control = (
	kind: 'quest' | 'mission',
	id: string,
	mission: string,
	step: number | null,
): SceneControl => ({
	kind,
	id: `${kind}:${id}`,
	name: id,
	rule: null,
	assumption: '',
	followsCamera: false,
	story: { mission, step },
	levelTags: [0],
	values: [],
	default: 3,
	derived: null,
});

const CONTROLS = [
	control('mission', 'e1m1', 'e1m1', null),
	control('quest', 'e1m1_q#2', 'e1m1', 2),
	control('quest', 'e1m1_q#5', 'e1m1', 5),
	control('quest', 'e1m1_q#side', 'e1m1', 5.5),
	control('quest', 'e1m2_q#1', 'e1m2', 1),
	control('quest', 'e1m2_q#x', 'e1m2', null),
];
const MISSIONS = ['e1m1', 'e1m2'];

it('completes quests at their completed state and maximizes facilities without overriding derived or runtime gates', () => {
	const quest = {
		...control('quest', 'a', 'e1m1', 1),
		default: 0,
		values: [0, 2, 3, 5].map((value) => ({ value, label: String(value) })),
	};
	const facility: SceneControl = {
		...quest,
		kind: 'facility',
		id: 'facility:a',
		default: 0,
		values: [0, 2, 7].map((value) => ({ value, label: String(value) })),
	};
	const controls = [
		quest,
		{ ...quest, id: 'quest:already-completed', default: 3 },
		facility,
		{ ...facility, id: 'facility:derived', derived: 0 },
		{ ...facility, kind: 'area' as const, id: 'area:1' },
		{ ...facility, kind: 'controlNexus' as const, id: 'controlNexus:a' },
		{ ...facility, kind: 'cabinLevel' as const, id: 'cabinLevel:a' },
		{
			...facility,
			kind: 'cabin' as const,
			id: 'cabin:a',
			values: [
				{ value: 0, label: 'empty' },
				{ value: 1, label: 'built' },
			],
		},
	];
	const before = structuredClone(controls);
	assert.deepEqual(completedProgressionPicks(controls), {
		'quest:a': 3,
		'facility:a': 7,
		'controlNexus:a': 7,
		'cabinLevel:a': 7,
		'cabin:a': 1,
	});
	assert.deepEqual(controls, before);
});

it('a story point completes what came before it and leaves what follows unstarted', () => {
	assert.deepEqual(storyPointPicks(CONTROLS, MISSIONS, { mission: 0, step: 5 }), {
		'mission:e1m1': 2,
		'quest:e1m1_q#2': 3,
		'quest:e1m1_q#5': 2,
		'quest:e1m1_q#side': 0,
		'quest:e1m2_q#1': 0,
		'quest:e1m2_q#x': 0,
	});
	assert.deepEqual(storyPointPicks(CONTROLS, MISSIONS, { mission: 1, step: 0 }), {
		'mission:e1m1': 3,
		'quest:e1m1_q#2': 3,
		'quest:e1m1_q#5': 3,
		'quest:e1m1_q#side': 3,
		'quest:e1m2_q#1': 0,
	});
	// the finished story is the default, so its picks are dropped
	assert.deepEqual(
		Object.values(storyPointPicks(CONTROLS, MISSIONS, null)).every((value) => value === null),
		true,
	);
});

it('lists a point per mission start and per step quest controls sit at, once per step', () => {
	const controls = [...CONTROLS, control('quest', 'e1m1_q#side2', 'e1m1', 5.5)];
	assert.deepEqual(
		storyPoints(controls, MISSIONS).map(({ point, quests }) => [point, quests.map(({ id }) => id)]),
		[
			[{ mission: 0, step: 0 }, []],
			[{ mission: 0, step: 2 }, ['quest:e1m1_q#2']],
			[{ mission: 0, step: 5 }, ['quest:e1m1_q#5']],
			[{ mission: 0, step: 5.5 }, ['quest:e1m1_q#side', 'quest:e1m1_q#side2']],
			[{ mission: 1, step: 0 }, []],
			[{ mission: 1, step: 1 }, ['quest:e1m2_q#1']],
			[null, []],
		],
	);
});

it('opens traversal doors without destroying supports or overriding derived gates', () => {
	const door: SceneControl = {
		...control('quest', 'a', 'mission', 1),
		kind: 'door',
		id: 'door:a',
		default: 0,
		values: [
			{ value: 0, label: 'closed' },
			{ value: 1, label: 'open' },
		],
	};
	const controls: SceneControl[] = [
		door,
		{ ...door, kind: 'activation', id: 'activation:a' },
		{ ...door, kind: 'destruction', id: 'destruction:a' },
		{ ...door, id: 'door:derived', derived: 0 },
	];
	assert.deepEqual(openTraversalPicks(controls), { 'door:a': 1, 'activation:a': 1 });
});
