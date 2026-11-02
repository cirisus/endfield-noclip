import assert from 'node:assert/strict';
import { it } from 'node:test';

import { isPointView } from './oem.ts';

it('accepts versioned clear and fallback views but rejects malformed camera values or old bindings', () => {
	const view = {
		key: 'noclip-point-view-v3:' + 'a'.repeat(64),
		position: [1, 2, 3],
		yaw: 0,
		pitch: -0.3,
		clear: true,
	};
	assert.equal(isPointView(view), true);
	assert.equal(isPointView({ ...view, key: 'noclip-point-view-v4:' + 'a'.repeat(64) }), true);
	assert.equal(isPointView({ ...view, clear: false }), true);
	for (const value of [
		{ ...view, position: [1, 2] },
		{ ...view, position: [1, 2, NaN] },
		{ ...view, pitch: 3 },
		{ ...view, key: 'noclip-point-view-v1:' + 'a'.repeat(64) },
		{ ...view, clear: undefined },
	]) {
		assert.equal(isPointView(value), false);
	}
});
