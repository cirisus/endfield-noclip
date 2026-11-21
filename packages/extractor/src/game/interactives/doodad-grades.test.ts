import assert from 'node:assert/strict';
import { test } from 'node:test';

import { gradeForm, gradeMasks } from './doodad-grades.ts';

test('gradeForm picks the last form whose need the level meets', () => {
	// Wuling's Si's Painting crates and Jingyu Valley's, against one shared control's levels
	const painting = [0, 1, 9, 15, 24];
	const valley = [0, 1, 6, 9, 15];
	const levels = [1, 6, 9, 15, 24];
	assert.deepEqual(
		levels.map((level) => gradeForm(painting, level)),
		[1, 1, 2, 3, 4],
	);
	assert.deepEqual(
		levels.map((level) => gradeForm(valley, level)),
		[1, 2, 3, 4, 4],
	);
});

test('gradeForm has no form below the first need', () => {
	assert.equal(gradeForm([0, 6, 9, 15, 24], 1), null);
});

test('gradeMasks merges forms that share a model and keeps the template model below the first need', () => {
	const form = (model: string) => ({ model });
	const forms = ['crate_1', 'crate_2', 'crate_3', 'crate_3'].map(form);
	assert.deepEqual(gradeMasks([0, 1, 6, 9, 15], [24, 1, 6, 9, 15], form('base'), forms), [
		{ form: form('crate_1'), mask: 1 << 1 },
		{ form: form('crate_2'), mask: 1 << 6 },
		{ form: form('crate_3'), mask: ((1 << 9) | (1 << 15) | (1 << 24)) >>> 0 },
	]);
	assert.deepEqual(gradeMasks([0, 6, 9, 15, 24], [1, 6], form('base'), forms), [
		{ form: form('base'), mask: 1 << 1 },
		{ form: form('crate_1'), mask: 1 << 6 },
	]);
});
