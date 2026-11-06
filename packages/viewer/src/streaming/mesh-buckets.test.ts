import assert from 'node:assert/strict';
import { it } from 'node:test';

import { casterLayersOf } from './mesh-buckets.ts';

it('casts into the cascades only as a realtime caster, and into the far layer only as a static one', () => {
	// RayTracing, Realtime, Static, the four cascades and CastShadow
	assert.deepEqual(casterLayersOf(0x0bf8_0000), { realtime: true, static: true });
	// CastShadow and RayTracing alone: no sun shadow map
	assert.deepEqual(casterLayersOf(0x0808_0000), { realtime: false, static: false });
	// static, without the realtime flag or cascade bits
	assert.deepEqual(casterLayersOf(0x0108_0000), { realtime: false, static: true });
	// realtime flags without CastShadow
	assert.deepEqual(casterLayersOf(0x02f0_0000), { realtime: false, static: false });
	// nothing recorded (prefab renderers): every layer
	assert.deepEqual(casterLayersOf(0), { realtime: true, static: true });
});
