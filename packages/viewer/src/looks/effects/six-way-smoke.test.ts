import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { EffectTexture, SixWaySmokeSurface } from '@endfield-noclip/package-format/surfaces';

import { EffectKind, EffectRow } from './effect-look.ts';
import { SixWayFlags, SixWayRow, sixWaySmokeLook } from './six-way-smoke.ts';

const texture = (id: number, overrides: Partial<EffectTexture> = {}): EffectTexture => ({
	texture: id,
	scale: [1, 1],
	offset: [0, 0],
	scroll: [0, 0],
	rotation: [1, 0],
	customScroll: [0, 0],
	...overrides,
});

test('six-way smoke samples its negative lightmap at the positive one’s UVs, and packs its stack', () => {
	const smoke: SixWaySmokeSurface = {
		kind: 'sixWaySmoke',
		positive: { ...texture(1, { scale: [2, 2], rotation: [0, -1] }), disturbShare: 1 },
		negative: 2,
		disturb: [{ texture: texture(3), intensity: [0.11, 0.09], normal: false }, null],
		disturbBias: 0,
		mask: { texture: { ...texture(4), disturbShare: 0.5 }, redAlpha: true },
		blend: null,
		blendTint: [0.5, 0.5, 0.5, 1],
		dissolve: null,
		tint: [1, 1, 1, 3],
		vertexColor: true,
		brighten: { threshold: 1, intensity: 0 },
		absorptionRange: 1.934,
		envSaturation: 1,
		soft: { distance: 0.5, bias: 0 },
		near: { on: false, range: [0, 1, 1e5, 2e5] },
		unfogged: false,
	};
	const look = sixWaySmokeLook(smoke);
	const { params } = look;
	assert.deepEqual(look.textures, [1, 3, -1, 4, -1, -1, 2]);
	assert.deepEqual(
		[...params.subarray(EffectRow.uv + 24, EffectRow.uv + 28)],
		[...params.subarray(EffectRow.uv, EffectRow.uv + 4)],
	);
	assert.equal(
		params[SixWayRow.flags],
		SixWayFlags.Disturb1 | SixWayFlags.Mask | SixWayFlags.MaskRedAlpha | SixWayFlags.VertexColor,
	);
	assert.ok(Math.abs(params[SixWayRow.flags + 2] - 1.934) < 1e-6);
	assert.deepEqual([...params.subarray(SixWayRow.disturbUse, SixWayRow.disturbUse + 2)], [1, 0.5]);
	assert.ok(Math.abs(params[SixWayRow.disturb + 1] - 0.09) < 1e-6);
	assert.equal(params[EffectRow.unfogged + 1], EffectKind.SixWaySmoke);
	assert.equal(params[EffectRow.tint + 3], 3);
});
