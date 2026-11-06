import assert from 'node:assert/strict';
import { it } from 'node:test';

import { coalesceRanges } from './coalesce.ts';

const KiB = 1024;

it('takes in close neighbours of the same archive around the highest-priority seed', () => {
	const reads = coalesceRanges(
		[
			{ archive: 1, start: 0, end: 10 * KiB, priority: 1 },
			{ archive: 1, start: 20 * KiB, end: 30 * KiB, priority: 5 },
			{ archive: 1, start: 200 * KiB, end: 210 * KiB, priority: 2 },
			{ archive: 2, start: 30 * KiB, end: 40 * KiB, priority: 3 },
		],
		8,
	);
	assert.deepEqual(reads, [
		{ members: [0, 1], start: 0, end: 30 * KiB },
		{ members: [3], start: 30 * KiB, end: 40 * KiB },
		{ members: [2], start: 200 * KiB, end: 210 * KiB },
	]);
});

it('stops at the read limit and keeps reads within their span', () => {
	const ranges = Array.from({ length: 4 }, (_, i) => ({
		archive: 1,
		start: i * 1024 * KiB,
		end: (i + 1) * 1024 * KiB,
		priority: 4 - i,
	}));
	const reads = coalesceRanges(ranges, 1);
	assert.deepEqual(reads, [{ members: [0, 1], start: 0, end: 2048 * KiB }]);
});
