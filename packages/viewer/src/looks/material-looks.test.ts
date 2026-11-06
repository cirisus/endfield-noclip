import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { MaterialCull, ReadyMaterial } from '@endfield-noclip/package-format/materials';

import { LookFlags, LookRow } from './look.ts';
import { materialLooks } from './material-looks.ts';

/** a ready material drawing `surface` */
const described = (
	id: number,
	surface: ReadyMaterial['surface'],
	cull: MaterialCull = 'back',
): ReadyMaterial => ({ id, status: 'ready', cull, surface });

test('undrawn surfaces are not drawn, and unsupported ones show an unlit, shadowless, two-sided magenta checker', () => {
	const [undrawn, unsupported] = materialLooks({
		entries: [
			described(0, { kind: 'undrawn', reason: 'a water proxy' }),
			described(1, { kind: 'unsupported', reason: 'additive' }),
		],
	});
	assert.deepEqual([undrawn.drawn, undrawn.unsupported], [false, false]);
	assert.deepEqual([unsupported.drawn, unsupported.unsupported], [true, true]);
	assert.equal(unsupported.flags, LookFlags.Unlit);
	assert.equal(unsupported.castsShadows, false);
	assert.equal(unsupported.cull, 'none');
	assert.deepEqual(Array.from(unsupported.params.subarray(LookRow.tint, LookRow.tint + 4)), [1, 0, 1, -1]);
	assert.equal(unsupported.params[LookRow.surface + 2], 0.5);
});

test('unconverted materials show as unsupported', () => {
	const [failed] = materialLooks({ entries: [{ id: 0, status: 'failed' }] });
	assert.equal(failed.unsupported, true);
});
