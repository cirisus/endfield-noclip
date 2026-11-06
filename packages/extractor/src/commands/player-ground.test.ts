import assert from 'node:assert/strict';
import { test } from 'node:test';

import { run } from './player-ground.ts';

const args = (bounds: string, cellSize = '0.15') => [
	'map01',
	`--bounds=${bounds}`,
	'--scene-state',
	'0',
	'--area',
	'0',
	'--movement-settings',
	'unused.json',
	'--collision-output',
	'unused-collision.json',
	'-o',
	'unused-ground.json',
	'--cell-size',
	cellSize,
];

test('rejects unbounded source-cell loops before reading installation inputs', async () => {
	await assert.rejects(run(args('1e24,0,2e24,10')), /collision cell budget/);
	await assert.rejects(run(args('0,0,100000,100000')), /collision cell budget/);
});

test('rejects invalid voxel resolution and excessive tile work before extraction', async () => {
	await assert.rejects(run(args('0,0,10,10', '0')), /resolution or tile budget/);
	await assert.rejects(run(args('0,0,100,100', '0.0001')), /resolution or tile budget/);
});
