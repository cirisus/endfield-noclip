import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { EffectTexture, WaterFoamSurface } from '@endfield-noclip/package-format/surfaces';

import { materialLooks } from '../material-looks.ts';
import { described } from '../test-materials.ts';

import { EffectKind, EffectRow } from './effect-look.ts';
import { BUBBLE_SLOT, EROSION_SLOTS, FLOATING_SLOTS, WaterFoamFlags, WaterFoamRow } from './water-foam.ts';

const texture = (id: number, overrides: Partial<EffectTexture> = {}): EffectTexture => ({
	texture: id,
	scale: [1, 1],
	offset: [0, 0],
	scroll: [0, 0],
	rotation: [1, 0],
	customScroll: [0, 0],
	...overrides,
});

test('a water foam box draws into the water’s foam, by the depth test its material names', () => {
	const foam: WaterFoamSurface = {
		kind: 'waterFoam',
		textures: {
			base: texture(1, { scroll: [0, -1.3] }),
			disturb: texture(2),
			mask: texture(3),
		},
		sources: { base: 1, disturb: 0, mask: 0, dissolve: 0 },
		maskMatrix: [1, 0, 0, 1],
		boxUv: [1, 1, 0, 0],
		baseColor: [0, 0, 0],
		tint: [3.4, 4.2, 4.2],
		baseAlpha: 1,
		maskAsAlpha: 1,
		disturbBias: 0,
		disturb: [0.1, 0.1],
		disturbUse: [1, 1, 0],
		edgeFade: [0, 0],
		clipToBox: false,
		depthTest: 'less-equal',
		mipBias: { base: 0, mask: 0, dissolve: 0 },
		blendMode: 1,
		opacity: 0.5,
		soft: { distance: 0.001, bias: 0.6 },
		dissolve: null,
		erosion: null,
		bubble: null,
		floating: null,
	};
	const [front, behind, through] = materialLooks({
		entries: [
			described(foam),
			described({ ...foam, depthTest: 'greater', clipToBox: true }, 'front'),
			described({ ...foam, depthTest: 'always', mipBias: { base: 3, mask: 2, dissolve: 2 } }),
		],
	});
	assert.deepEqual(
		[front.queue, behind.queue, through.queue],
		['waterFoam', 'waterFoamBehind', 'waterFoamThrough'],
	);
	assert.deepEqual([...through.params.subarray(WaterFoamRow.mip, WaterFoamRow.mip + 3)], [3, 2, 2]);
	assert.deepEqual([front.cull, behind.cull], ['back', 'front']);
	assert.deepEqual(front.textures, [1, 2, 3, null, null, null, null]);
	assert.equal(front.params[EffectRow.unfogged + 1], EffectKind.WaterFoam);
	assert.equal(front.params[WaterFoamRow.base + 3], 0.5);
	assert.equal(
		front.params[WaterFoamRow.tint + 3],
		WaterFoamFlags.Disturb | WaterFoamFlags.Mask | WaterFoamFlags.EdgeFade | WaterFoamFlags.Soft,
	);
	assert.equal(behind.params[WaterFoamRow.tint + 3] & WaterFoamFlags.ClipToBox, WaterFoamFlags.ClipToBox);
	assert.deepEqual([...front.params.subarray(WaterFoamRow.sources, WaterFoamRow.sources + 4)], [1, 0, 0, 0]);
	assert.equal(front.params[WaterFoamRow.disturb + 3], 1);
	assert.ok(Math.abs(front.params[WaterFoamRow.fade + 2] - 0.6) < 1e-6);
	assert.equal(front.params[EffectRow.anim + 1], Math.fround(-1.3));
});

test('a red tide’s erosion takes the slots after the base colour map, with its layers’ colours', () => {
	const layer = (id: number, threshold: number) => ({
		noise: texture(id, { scale: [20, 20], scroll: [-0.1, 0] }),
		color: [36, 2, 0] as [number, number, number],
		threshold,
	});
	const tide: WaterFoamSurface = {
		kind: 'waterFoam',
		textures: { base: texture(1), disturb: null, mask: null },
		sources: { base: 3, disturb: 2, mask: 3, dissolve: 0 },
		maskMatrix: [0, 1, -1, 0],
		boxUv: [1, 1, 0, 0],
		baseColor: [0, 0, 0],
		tint: [1, 0.06, 0.94],
		baseAlpha: 0,
		maskAsAlpha: 1,
		disturbBias: 1,
		disturb: [0, 0],
		disturbUse: [1, 1, 0],
		edgeFade: null,
		clipToBox: false,
		depthTest: 'less-equal',
		mipBias: { base: -16, mask: -16, dissolve: -16 },
		blendMode: 1,
		opacity: 1,
		soft: null,
		dissolve: null,
		bubble: null,
		floating: null,
		erosion: {
			flow: texture(3, { scale: [15, 1.29], offset: [-11.75, 0] }),
			flowNoise: texture(4),
			gradient: texture(5),
			layers: [layer(2, 0.15), layer(6, 0.14), layer(7, 0.34)],
			noiseStrength: 0.02,
			flowShift: 7,
			distance: 1.01,
			offset: 0.14,
			edgeColor: [0.4, 0.4, 0.4],
		},
	};
	const [look] = materialLooks({ entries: [described(tide)] });
	assert.deepEqual(look.textures, [1, 3, 4, 5, 2, 6, 7]);
	assert.equal(look.params[WaterFoamRow.tint + 3], WaterFoamFlags.Erosion);
	assert.deepEqual(
		[...look.params.subarray(WaterFoamRow.erosion, WaterFoamRow.erosion + 4)],
		[0.02, 7, 1.01, 0.14].map(Math.fround),
	);
	assert.deepEqual(
		[...look.params.subarray(WaterFoamRow.erosionLayers + 8, WaterFoamRow.erosionLayers + 12)],
		[36, 2, 0, 0.34].map(Math.fround),
	);
	// the layers' noises scroll as their slots do
	assert.equal(look.params[EffectRow.anim + (EROSION_SLOTS.layers + 1) * 4], Math.fround(-0.1));
});

test('acid bubbles and floating layers take slots 4–6 and pack their rows', () => {
	const base: WaterFoamSurface = {
		kind: 'waterFoam',
		textures: { base: texture(1), disturb: texture(2), mask: null },
		sources: { base: 2, disturb: 2, mask: 0, dissolve: 0 },
		maskMatrix: [1, 0, 0, 1],
		boxUv: [1, 1, 0, 0],
		baseColor: [0, 0, 0],
		tint: [0.58, 0.49, 0],
		baseAlpha: 1,
		maskAsAlpha: 1,
		disturbBias: 1,
		disturb: [0.15, 0.15],
		disturbUse: [1, 0, 0],
		edgeFade: null,
		clipToBox: false,
		depthTest: 'less-equal',
		mipBias: { base: 0, mask: 0, dissolve: 0 },
		blendMode: 0,
		opacity: 0.33,
		soft: null,
		dissolve: null,
		erosion: null,
		bubble: {
			texture: texture(3, { scale: [1.6, 1.6] }),
			color: [0.83, 0.77, 0],
			heightScale: 0.03,
			speed: 0.396,
			randomFactor: 7.67,
			randomFactor2: 0.22,
			peakTime: 0.028,
		},
		floating: {
			textures: [texture(4, { scale: [4.39, 4.69] }), texture(5, { scale: [13.28, 16.87] })],
			source: 2,
			color: [0, 0.44, 0.37],
			colorDark: [0, 1, 0.87],
			layerOffset: 4.75,
			strength: 0.15,
			strengthSpeed: 3.22,
			useDisturb: 1,
		},
	};
	const [look] = materialLooks({ entries: [described(base)] });
	assert.equal(look.textures[BUBBLE_SLOT], 3);
	assert.equal(look.textures[FLOATING_SLOTS[0]], 4);
	assert.equal(look.textures[FLOATING_SLOTS[1]], 5);
	assert.equal(
		look.params[WaterFoamRow.tint + 3],
		WaterFoamFlags.Disturb | WaterFoamFlags.Bubble | WaterFoamFlags.Floating0 | WaterFoamFlags.Floating1,
	);
	assert.deepEqual(
		[...look.params.subarray(WaterFoamRow.bubble, WaterFoamRow.bubble + 4)],
		[0.03, 0.396, 7.67, 0.22].map(Math.fround),
	);
	assert.deepEqual(
		[...look.params.subarray(WaterFoamRow.bubbleColor, WaterFoamRow.bubbleColor + 4)],
		[0.83, 0.77, 0, 0.028].map(Math.fround),
	);
	assert.deepEqual(
		[...look.params.subarray(WaterFoamRow.floating, WaterFoamRow.floating + 4)],
		[2, 4.75, 0.15, 3.22].map(Math.fround),
	);
	assert.deepEqual(
		[...look.params.subarray(WaterFoamRow.floatingColor, WaterFoamRow.floatingColor + 4)],
		[0, 0.44, 0.37, 1].map(Math.fround),
	);
	assert.deepEqual(
		[...look.params.subarray(WaterFoamRow.floatingColorDark, WaterFoamRow.floatingColorDark + 4)],
		[0, 1, 0.87, 0].map(Math.fround),
	);
});
