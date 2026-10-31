import assert from 'node:assert/strict';
import { test } from 'node:test';

import { conditionVisible, resolveSceneValues } from '@endfield-noclip/package-format/conditions';
import type { SceneControl, StatesInfo } from '@endfield-noclip/package-format/states';

import { pointPresets } from './oem-presets.ts';

const quest = (id: string, step: number | null): SceneControl => ({
	kind: 'quest',
	id: `quest:${id}`,
	name: id,
	story: step === null ? null : { mission: 'e1m1', step },
	rule: null,
	assumption: 'story finished',
	drivers: [],
	levelTags: [],
	derived: null,
	default: 3,
	values: [0, 2, 3, 4, 5].map((value) => ({ value, label: String(value) })),
});
const states = (controls: SceneControl[]): StatesInfo => ({
	controls,
	conditionalSets: [],
	groups: [],
	streamAreas: null,
	missions: [{ id: 'e1m1', name: 'mission', category: 'main', chapter: null, episode: null, levelId: null }],
});

test('keeps completed defaults when they already satisfy a point', () => {
	const presets = pointPresets(states([quest('a', 1)]), {
		alternatives: [[{ control: 'quest:a', mask: 8 }]],
	});
	assert.deepEqual(presets[0].picks, {});
	assert.equal(presets[0].satisfies, true);
});

test('applies an AND alternative without flattening it into independent choices', () => {
	const s = states([quest('a', 1), quest('b', 2)]);
	const condition = {
		alternatives: [
			[
				{ control: 'quest:a', mask: 8 },
				{ control: 'quest:b', mask: 4 },
			],
		],
	};
	const presets = pointPresets(s, condition).filter((p) => p.satisfies);
	assert.ok(presets.length);
	for (const p of presets) {
		assert.equal(conditionVisible(condition, resolveSceneValues(s, p.picks)), true);
	}
	assert.equal(presets[0].picks['quest:a'], undefined);
	assert.equal(presets[0].picks['quest:b'], 2);
});

test('rejects an impossible reversed quest ordering', () => {
	const s = states([quest('a', 1), quest('b', 2)]);
	const p = pointPresets(s, {
		alternatives: [
			[
				{ control: 'quest:a', mask: 1 },
				{ control: 'quest:b', mask: 8 },
			],
		],
	});
	assert.equal(
		p.some((entry) => entry.satisfies),
		false,
	);
});

test('preserves OR alternatives and refuses to invent an unplaceable quest state', () => {
	const s = states([quest('a', 1), quest('unknown', null)]);
	assert.equal(
		pointPresets(s, { alternatives: [[{ control: 'quest:unknown', mask: 4 }]] }).some((p) => p.satisfies),
		false,
	);
	assert.equal(
		pointPresets(s, {
			alternatives: [[{ control: 'quest:unknown', mask: 4 }], [{ control: 'quest:a', mask: 4 }]],
		}).some((p) => p.satisfies),
		true,
	);
});
