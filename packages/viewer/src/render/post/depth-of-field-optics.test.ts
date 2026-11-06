import assert from 'node:assert/strict';
import { test } from 'node:test';

import { focusCoefficients, type FocusLens } from './depth-of-field-optics.ts';

const lens: FocusLens = {
	focalLength: 100,
	aperture: 2,
	focusDistance: 10,
	sensorSpan: 24,
	pixels: 1440,
	near: 0.25,
	far: Infinity,
};

test('finite and infinite reversed depth agree with the thin-lens radius', () => {
	for (const far of [100, 10000, Infinity]) {
		const { offset, scale } = focusCoefficients({ ...lens, far });
		for (const distance of [1, 5, 10, 20, 100]) {
			const depth = (1 / distance - 1 / far) / (1 / lens.near - 1 / far);
			const expected = (0.1 * 100 * 1440 * (distance - 10)) / (2 * 2 * 24 * (10 - 0.1) * distance);
			assert.ok(Math.abs(offset - scale * depth - expected) < 1e-10);
		}
	}
});

test('stopping down halves blur and doubling resolution doubles its pixel radius', () => {
	const base = focusCoefficients(lens);
	const stopped = focusCoefficients({ ...lens, aperture: 4 });
	const larger = focusCoefficients({ ...lens, pixels: 2880 });
	assert.equal(stopped.offset, base.offset / 2);
	assert.equal(stopped.scale, base.scale / 2);
	assert.equal(larger.offset, base.offset * 2);
	assert.equal(larger.scale, base.scale * 2);
});

test('invalid physical inputs cannot contaminate GPU uniforms', () => {
	for (const key of ['focalLength', 'aperture', 'focusDistance', 'sensorSpan', 'pixels', 'near']) {
		for (const value of [0, -1, NaN, Infinity]) {
			assert.throws(() => focusCoefficients({ ...lens, [key]: value }), RangeError);
		}
	}
	for (const far of [0, 0.25, NaN, -Infinity]) {
		assert.throws(() => focusCoefficients({ ...lens, far }), RangeError);
	}
});
