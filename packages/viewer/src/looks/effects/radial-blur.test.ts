import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { EffectTexture, RadialBlurSurface } from '@endfield-noclip/package-format/surfaces';

import { materialLooks } from '../material-looks.ts';
import { described } from '../test-materials.ts';

import { EffectKind, EffectRow, SlotSource } from './effect-look.ts';
import { RadialBlurRow } from './radial-blur.ts';

const texture = (id: number, overrides: Partial<EffectTexture> = {}): EffectTexture => ({
	texture: id,
	scale: [1, 1],
	offset: [0, 0],
	scroll: [0, 0],
	rotation: [1, 0],
	customScroll: [0, 0],
	...overrides,
});

test('a radial blur packs its parameters and picks radialBlurThrough under depthTest always', () => {
	const surface: RadialBlurSurface = {
		kind: 'radialBlur',
		depthTest: 'always',
		intensity: 0.15,
		power: 2,
		alpha: 1.5,
		inParticle: true,
		withScreenDepth: true,
		centerOffset: [0.1, -0.2],
		direction: null,
		mask: {
			texture: { ...texture(4, { customScroll: [0, 0.5] }), source: 'polar' },
			redAlpha: true,
		},
		softDistance: 3,
		near: [1, 5, 100, 120],
	};
	const [look] = materialLooks({ entries: [described(surface, 'none')] });
	assert.equal(look.queue, 'radialBlurThrough');
	assert.deepEqual(look.textures, [4, null, null, null, null, null, null]);
	assert.equal(look.params[EffectRow.slotBits], SlotSource.Polar * 32 + 16);
	assert.deepEqual(
		[...look.params.subarray(RadialBlurRow.blur, RadialBlurRow.blur + 4)].map(
			(v) => Math.round(v * 100) / 100,
		),
		[0.15, 2, 1.5, 1],
	);
	assert.deepEqual([...look.params.subarray(RadialBlurRow.options, RadialBlurRow.options + 4)], [1, 1, 0, 0]);
	assert.deepEqual(
		[...look.params.subarray(RadialBlurRow.center, RadialBlurRow.center + 4)].map(
			(v) => Math.round(v * 100) / 100,
		),
		[0.1, -0.2, 0, 0],
	);
	assert.equal(look.params[EffectRow.soft], 3);
	assert.deepEqual([...look.params.subarray(EffectRow.near, EffectRow.near + 4)], [1, 5, 100, 120]);
	assert.equal(look.params[EffectRow.misc], 1);
	assert.equal(look.params[EffectRow.unfogged + 1], EffectKind.RadialBlur);
});

test('a depth-tested directional blur picks the radialBlur queue and packs its direction', () => {
	const surface: RadialBlurSurface = {
		kind: 'radialBlur',
		depthTest: 'less-equal',
		intensity: 0.1,
		power: 1,
		alpha: 1,
		inParticle: false,
		withScreenDepth: false,
		centerOffset: [0, 0],
		direction: [0.6, 0.8],
		mask: null,
		softDistance: 0,
		near: null,
	};
	const [look] = materialLooks({ entries: [described(surface, 'back')] });
	assert.equal(look.queue, 'radialBlur');
	assert.deepEqual(look.textures, [null, null, null, null, null, null, null]);
	assert.deepEqual([...look.params.subarray(RadialBlurRow.options, RadialBlurRow.options + 4)], [0, 0, 1, 0]);
	assert.deepEqual(
		[...look.params.subarray(RadialBlurRow.center + 2, RadialBlurRow.center + 4)].map(
			(v) => Math.round(v * 100) / 100,
		),
		[0.6, 0.8],
	);
});
