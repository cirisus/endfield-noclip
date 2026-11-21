import assert from 'node:assert/strict';
import { test } from 'node:test';

import { gradeForm } from './doodad-grades.ts';

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
