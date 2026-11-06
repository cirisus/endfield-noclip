import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { velocityBasis } from './vector-math.ts';

describe('velocityBasis', () => {
	it('points forward along the velocity with its right level', () => {
		const [right, up, forward] = velocityBasis([3, 4, 0]);
		assert.deepEqual(forward, [0.6, 0.8, 0]);
		assert.ok(Math.abs(right[1]) < 1e-12);
		assert.ok(up[1] > 0);
		// straight up, right falls back to the world's +x; a still particle faces +z
		assert.deepEqual(velocityBasis([0, 2, 0])[0], [1, 0, 0]);
		assert.deepEqual(
			velocityBasis([0, 0, 0]).map((axis) => axis.map((value) => value + 0)),
			[
				[1, 0, 0],
				[0, 1, 0],
				[0, 0, 1],
			],
		);
	});
});
