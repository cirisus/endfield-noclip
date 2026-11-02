import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { MaterialCull, ReadyMaterial, TextureSlot } from '@endfield-noclip/package-format/materials';
import type { LitLayer, LitSurface, MaskChannel } from '@endfield-noclip/package-format/surfaces';

import {
	DitherRow,
	EmissivePulseRow,
	ErosionRow,
	LayerBlendRow,
	LayerSource,
	LookFlags,
	LookRow,
	materialLooks,
	UV1_SHIFT,
} from './materials.ts';

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

test('unconverted materials show as unsupported, and glass is transparent and shadowless with its blending flag', () => {
	const [failed, blended, premultiplied] = materialLooks({
		entries: [
			{ id: 0, status: 'failed' },
			described(1, litSurface({ blend: 'alphaBlend', opacity: 0.5, alphaClip: 0.5, alphaFromNormal: true })),
			described(2, litSurface({ blend: 'premultiplied' })),
		],
	});
	assert.equal(failed.unsupported, true);
	assert.deepEqual(
		[blended.transparent, blended.cutout, blended.castsShadows, blended.params[LookRow.detail2 + 2]],
		[true, false, false, 0],
	);
	assert.equal(blended.params[LookRow.emissive2 + 3], 0.5);
	assert.notEqual(blended.flags & LookFlags.AlphaNormal, 0);
	assert.deepEqual([premultiplied.transparent, premultiplied.params[LookRow.detail2 + 2]], [true, 1]);
});

/** a two-basemap Lit surface with no optional parts */
const litSurface = (overrides: Partial<LitSurface> = {}): LitSurface => ({
	kind: 'lit',
	layout: 'twoBasemap',
	metallicFromBaseAlpha: false,
	textures: { base: null, normal: null, mro: null, emissive: null },
	alphaClip: null,
	alphaFromNormal: false,
	blend: 'opaque',
	opacity: 1,
	tint: [1, 1, 1],
	tintCover: 0,
	brighterScale: 1,
	roughness: [0, 1],
	metallic: 0,
	normalScale: 1,
	occlusionStrength: 1,
	f0: 0.04,
	transmission: 0,
	emission: null,
	triChannel: null,
	detail: null,
	overlay: null,
	foliage: null,
	keepsLitDecalsOff: false,
	...overrides,
});

test('matte paintings are unlit, cast no shadows and test the texture alpha against their threshold', () => {
	const entry = described(0, {
		kind: 'mattePainting',
		texture: { texture: 7, uv: 0, scale: [1, 1], offset: [0, 0] },
		color: [2, 2, 2],
		alphaClip: 0.2,
		highlight: { threshold: 1, intensity: 4 },
		ignorePostExposure: 1,
	});
	const [look] = materialLooks({ entries: [entry] });
	assert.equal(look.castsShadows, false);
	assert.equal(look.cutout, true);
	assert.equal(look.textures[0], 7);
	assert.deepEqual(Array.from(look.params.subarray(0, 4)), [2, 2, 2, Math.fround(0.2)]);
	assert.deepEqual(Array.from(look.params.subarray(LookRow.surface, LookRow.surface + 2)), [1, 4]);
});

test('dithered effects shade as opaque shadowless surfaces, or unlit, and dither through the normal slot by a red alpha', () => {
	const main = { texture: 6, uv: 0, scale: [2, 2] as [number, number], offset: [0, 0] as [number, number] };
	const [rock, spot, mask] = materialLooks({
		entries: [
			described(
				0,
				{
					kind: 'dithered',
					baseMap: { ...main, texture: 3, scale: [4, 4] },
					normalMap: { ...main, texture: 5, scale: [1, 1] },
					color: [10, 2.14, 0],
					dither: null,
					lighting: { roughness: 1, metallic: 0, normalScale: 1.5 },
					ignorePostExposure: 1,
				},
				'none',
			),
			described(1, {
				kind: 'dithered',
				baseMap: main,
				normalMap: null,
				color: [0.2, 0.2, 0.2],
				dither: { texture: main, redAlpha: false, alphaScale: 0.75, exponent: 1, tiling: 1 },
				lighting: null,
				ignorePostExposure: 1,
			}),
			described(2, {
				kind: 'dithered',
				baseMap: null,
				normalMap: null,
				color: [0.2, 0.2, 0.2],
				dither: { texture: main, redAlpha: true, alphaScale: 0.5, exponent: 14, tiling: 0.1 },
				lighting: null,
				ignorePostExposure: 1,
			}),
		],
	});
	assert.deepEqual([rock.cutout, rock.castsShadows, rock.cull], [false, false, 'none']);
	assert.deepEqual(rock.textures.slice(0, 3), [3, 5, -1]);
	assert.equal(rock.flags, LookFlags.BaseMap | LookFlags.NormalMap | LookFlags.NormalRag);
	assert.deepEqual(Array.from(rock.params.subarray(LookRow.surface, LookRow.surface + 4)), [1, 1, 0, 1.5]);
	assert.deepEqual(Array.from(rock.params.subarray(LookRow.uv, LookRow.uv + 4)), [4, 4, 0, 0]);
	assert.equal(spot.cutout, true);
	assert.notEqual(spot.flags & LookFlags.Unlit, 0);
	assert.equal(spot.params[LookRow.tint + 3], -1);
	assert.deepEqual(Array.from(spot.params.subarray(DitherRow.dither, DitherRow.dither + 4)), [0.75, 1, 1, 0]);
	assert.deepEqual(mask.textures.slice(0, 2), [-1, 6]);
	assert.equal(mask.flags & (LookFlags.BaseMap | LookFlags.AlphaNormal), LookFlags.AlphaNormal);
	assert.deepEqual(Array.from(mask.params.subarray(LookRow.uv + 4, LookRow.uv + 8)), [2, 2, 0, 0]);
	assert.deepEqual(Array.from(mask.params.subarray(DitherRow.dither, DitherRow.dither + 4)), [
		0.5,
		14,
		Math.fround(0.1),
		1,
	]);
});

test('pulsing emission takes the free parallax rows; a surface with a glow keeps its emission still', () => {
	const slot = (texture: number): TextureSlot => ({ texture, uv: 0, scale: [1, 1], offset: [0, 0] });
	const emission = {
		color: [23.97, 23.97, 23.97] as [number, number, number],
		source: 'map' as const,
		maskChannel: 0,
		albedoAffect: 1,
		ignorePostExposure: 1,
		pulse: { rate: 1 / Math.PI, phase: 0, interval: 1, minimum: 0, depth: 1 },
	};
	const glow = {
		kind: 'parallax' as const,
		pattern: slot(6),
		patternTiling: 2,
		noise: 7,
		noiseTiling: 3,
		depth: 0.314,
		steps: 3,
		fresnelPower: 1,
		pulseRate: 0,
		pulsePhasePerMetre: 0,
		pulseMinimum: 0.2,
		bright: [2.8, 0.7, 0] as [number, number, number],
		dark: [0, 0, 0] as [number, number, number],
		maskChannel: 2,
		ignorePostExposure: 1,
		near: { outer: 25, inner: 3, strength: 20 },
	};
	const textures = { base: slot(1), normal: null, mro: null, emissive: slot(2) };
	const [pulsing, glowing] = materialLooks({
		entries: [
			described(0, litSurface({ textures, emission })),
			described(1, litSurface({ textures, emission, overlay: glow })),
		],
	});
	const pulse = Array.from(pulsing.params.subarray(EmissivePulseRow.pulse, EmissivePulseRow.pulse + 4));
	assert.deepEqual(pulse, [1 / Math.PI, 0, 1, 0].map(Math.fround));
	assert.equal(pulsing.params[EmissivePulseRow.strength], 1);
	assert.deepEqual(
		Array.from(pulsing.params.subarray(LookRow.emissive, LookRow.emissive + 3)),
		[23.97, 23.97, 23.97].map(Math.fround),
	);
	assert.equal(pulsing.flags & (LookFlags.ParallaxMap | LookFlags.LayerBlend), 0);
	// the glow's rows: three steps, a pulse between 0.2 and 1, the HDR colour as stored
	const row = (at: number) => Array.from(glowing.params.subarray(at, at + 4));
	assert.deepEqual(glowing.textures.slice(5), [6, 7]);
	assert.deepEqual(row(LookRow.uv + 5 * 4), [2, 2, 0, 0]);
	assert.deepEqual(row(LookRow.uv + 6 * 4), [3, 3, 0, 0]);
	assert.deepEqual(row(LookRow.parallax), [0.314, 3, 1, 0.4].map(Math.fround));
	assert.equal(glowing.params[LookRow.parallax2 + 3], Math.fround(0.6));
	assert.deepEqual(row(LookRow.parallaxColor), [2.8, 0.7, 0, 2].map(Math.fround));
	assert.deepEqual(row(LookRow.parallaxBright).slice(0, 3), [25, 3, 20]);
});

test('erosion rock: its maps tile by their own scales on UV set 0, the ramp streams whole', () => {
	const entry = described(0, {
		kind: 'erosion',
		textures: {
			baseNormal: { texture: 1, tiling: 1 },
			metalMix: { texture: 2, tiling: 1 },
			flowRamp: 3,
			detailNormal: { texture: 4, tiling: 5 },
			noisePattern: { texture: 5, tiling: 3 },
		},
		baseColor: [0.214, 0.214, 0.214],
		roughness: 0,
		detailRoughnessCover: 0,
		metallic: 0,
		metallicOffset: 0,
		metallicColor: [1, 1, 1],
		normalScale: 1,
		detailNormalScale: 1,
		occlusionStrength: 1,
		f0: 0.04,
		noise: { depth: 0, tint: [1, 1, 1], alphaTint: [1, 1, 1], min: 0, emissiveStrength: 0, fadeDistance: 1 },
		flow: {
			tiling: 0,
			noiseStrength: 0,
			scroll: 0.05,
			speedOffset: 0,
			colorOffset: 0,
			top: [1, 1, 1],
			bottom: [4, 4, 4],
			colorStrength: 0,
			emissiveStrength: 0,
			roughness: 0,
		},
	});
	const [look] = materialLooks({ entries: [entry] });
	assert.deepEqual(look.textures, [-1, 1, 2, 3, 4, 5, 5]);
	assert.equal(look.flags & (0x7f << UV1_SHIFT), 0);
	assert.notEqual(look.flags & LookFlags.Erosion, 0);
	assert.equal(look.uvScales[3], 0);
	const uv = (index: number) =>
		Array.from(look.params.subarray(LookRow.uv + index * 4, LookRow.uv + index * 4 + 4));
	assert.deepEqual(
		[uv(1), uv(4), uv(5), uv(6)],
		[
			[1, 1, 0, 0],
			[5, 5, 0, 0],
			[3, 3, 0, 0],
			[1, 1, 0, 0],
		],
	);
	assert.ok(Math.abs(look.params[ErosionRow.base] - 0.214) < 1e-3);
	assert.deepEqual(
		Array.from(look.params.subarray(ErosionRow.flowBottom, ErosionRow.flowBottom + 3)),
		[4, 4, 4],
	);
	assert.equal(look.params[ErosionRow.flow + 2], Math.fround(0.05));
});

test('Lit slots: UV set 1 maps, the tri-channel mask in the mask slot except under an MRO map, detail', () => {
	const slot = (texture: number, uv = 0, scale = 1): TextureSlot => ({
		texture,
		uv,
		scale: [scale, scale],
		offset: [0, 0],
	});
	const channel = (strength: number): MaskChannel => ({
		albedo: [1, 0.214, 0],
		strength,
		roughness: 1,
		metallic: 0,
		scale: 0,
		offset: 0,
	});
	const triChannel: LitSurface['triChannel'] = {
		mask: slot(4),
		channels: [channel(0.5), channel(0), channel(0)],
	};
	const detail = {
		texture: slot(5, 1, 5),
		mode: 1,
		maskMode: 0,
		normalIntensity: 1,
		pbrIntensity: 0,
		fade: [0, 0] as [number, number],
		brighterScale: 1,
		overlay: [0, 0, 0] as [number, number, number],
		overlayCover: 0,
	};
	const textures = { base: slot(1, 1, 5), normal: slot(2), mro: null, emissive: null };
	const [crystal, mro] = materialLooks({
		entries: [
			described(0, litSurface({ textures, triChannel, detail })),
			described(1, litSurface({ layout: 'mro', textures: { ...textures, mro: slot(3) }, triChannel })),
		],
	});
	assert.deepEqual(crystal.textures, [1, 2, 4, -1, 5, -1, -1]);
	assert.notEqual(crystal.flags & LookFlags.TriChannelMask, 0);
	assert.notEqual(crystal.flags & LookFlags.NormalOcclusion, 0);
	// base and detail sample UV set 1
	assert.equal((crystal.flags >> UV1_SHIFT) & 0x7f, 0b10001);
	const row = (at: number) => Array.from(crystal.params.subarray(at, at + 4));
	assert.deepEqual(row(LookRow.maskAlbedo), [1, 0.214, 0, 0.5].map(Math.fround));
	assert.equal(crystal.params[LookRow.maskAlbedo + 4 + 3], 0);
	// the MRO map takes the mask slot, so the tri-channel mask isn't drawn
	assert.equal(mro.textures[2], 3);
	assert.equal(mro.flags & LookFlags.TriChannelMask, 0);
	assert.notEqual(mro.flags & LookFlags.NormalRag, 0);
});

/** a top layer with no moss */
const topLayer = (overrides: Partial<LitLayer> = {}): LitLayer => ({
	kind: 'layer',
	base: 2,
	bump: 3,
	tiling: 2,
	offset: [0.25, 0.5],
	uvType: 2,
	coverage: { kind: 'top' },
	top: { bumped: 0, threshold: -1, smoothness: 0.5 },
	heightTransition: 0.056,
	tint: [2, 0.42808229, 0],
	saturation: 0.75,
	colorBlendMode: 0,
	additiveIntensity: 1,
	metallicType: 0,
	metallic: 0,
	bumpScale: 1,
	baseNormalIntensity: 0,
	aoStrength: 1,
	aoType: 0,
	moss: null,
	...overrides,
});

test('moss rock: the top layer takes the parallax slots and rows, its own tiling and the default grey height', () => {
	const normal: TextureSlot = { texture: 1, uv: 0, scale: [1, 1], offset: [0, 0] };
	const [look] = materialLooks({
		entries: [
			described(
				0,
				litSurface({ textures: { base: null, normal, mro: null, emissive: null }, overlay: topLayer() }),
			),
		],
	});
	assert.deepEqual(look.textures, [-1, 1, -1, -1, -1, 2, 3]);
	assert.notEqual(look.flags & LookFlags.LayerBlend, 0);
	const row = (at: number) => Array.from(look.params.subarray(at, at + 4));
	assert.deepEqual(row(LookRow.uv + 5 * 4), [2, 2, 0.25, 0.5]);
	assert.deepEqual(row(LookRow.uv + 6 * 4), [2, 2, 0.25, 0.5]);
	assert.deepEqual(row(LayerBlendRow.coverage), [0, -1, 0.5, 2]);
	assert.deepEqual(row(LayerBlendRow.height), [1, Math.fround(0.056), 0.5, LayerSource.Top]);
	// the tint linearized, times the brighter scale; saturation 1 − 0.25
	assert.deepEqual(row(LayerBlendRow.color), [2, 0.42808229, 0, 0.75].map(Math.fround));
	// no moss: the fuzzy shading is neutral
	assert.deepEqual(row(LayerBlendRow.fuzzy), [0, 0, 1, 0]);
	assert.deepEqual(row(LayerBlendRow.fuzzy2), [0, 1, 1, 0]);
});

test('moss mounds: the mask layer takes its mask map into the emissive slot, untiled on its UV set, and shades as moss', () => {
	const base: TextureSlot = { texture: 0, uv: 0, scale: [3, 3], offset: [0, 0] };
	const emissive: TextureSlot = { texture: 5, uv: 0, scale: [3, 3], offset: [0, 0] };
	const moss = {
		coreDarkness: 0.2,
		edgeBrightness: 0,
		edgeShadowRange: 0.01,
		edgeShadowOffset: 0,
		edgeShadowIntensity: 0,
		darkPower: 0.1,
		brightPower: 6,
		normalStrength: 0,
	};
	const maskLayer = topLayer({ coverage: { kind: 'maskMap', texture: 4, uv: 1 }, moss });
	const [mound, channel, emissiveMapped] = materialLooks({
		entries: [
			described(
				0,
				litSurface({ textures: { base, normal: null, mro: null, emissive: null }, overlay: maskLayer }),
			),
			described(1, litSurface({ overlay: topLayer({ coverage: { kind: 'baseAlpha' } }) })),
			// an emissive map leaves no slot for the mask map
			described(2, litSurface({ textures: { base, normal: null, mro: null, emissive }, overlay: maskLayer })),
		],
	});
	assert.deepEqual(mound.textures, [0, -1, -1, 4, -1, 2, 3]);
	assert.notEqual(mound.flags & LookFlags.LayerBlend, 0);
	assert.notEqual(mound.flags & LookFlags.EmissiveMap, 0);
	assert.notEqual(mound.flags & (1 << (UV1_SHIFT + 3)), 0);
	const row = (at: number) => Array.from(mound.params.subarray(at, at + 4));
	assert.deepEqual(row(LookRow.uv + 3 * 4), [1, 1, 0, 0]);
	assert.equal(row(LayerBlendRow.height)[3], LayerSource.MaskMap);
	assert.deepEqual(row(LayerBlendRow.fuzzy), [0.2, 0, 0.01, 0].map(Math.fround));
	assert.deepEqual(row(LayerBlendRow.fuzzy2), [0, 0.1, 6, 0].map(Math.fround));
	assert.equal(channel.params[LayerBlendRow.height + 3], LayerSource.BaseAlpha);
	assert.equal(channel.textures[3], -1);
	assert.equal(emissiveMapped.flags & LookFlags.LayerBlend, 0);
	assert.deepEqual(emissiveMapped.textures.slice(3), [5, -1, -1, -1]);
});

test('foliage: leaves and grass fill the foliage rows, and surfaces keeping lit decals off set their bit', () => {
	const [leaf, grass] = materialLooks({
		entries: [
			described(
				0,
				litSurface({
					layout: 'roughnessInB',
					f0: 0.07,
					transmission: 0.2,
					foliage: {
						kind: 'leaf',
						occlusionShadow: 0.5,
						fakeShadow: { strength: 0.25, power: 2 },
						diffuseUsesVertexNormal: 1,
						aoTransmission: [0, 0.01],
						aoSubsurface: [0, 0.01],
						subsurface: 0.3,
						transmissionDistanceFade: 1,
						canopy: null,
					},
					keepsLitDecalsOff: true,
				}),
			),
			described(
				1,
				litSurface({
					layout: 'roughnessInB',
					foliage: {
						kind: 'grass',
						bendNormalUpward: 0.5,
						cameraLean: 0.25,
						maskOnDiffuse: 1,
						maskOnTransmission: 0,
						twoSidedNormal: true,
						subsurface: 0.1,
						ao: [1, 2, 0.5],
						sunMask: [3, 4, 0.25],
					},
				}),
			),
		],
	});
	const row = (look: typeof leaf, at: number) => Array.from(look.params.subarray(at, at + 4));
	assert.notEqual(leaf.flags & (LookFlags.Foliage | LookFlags.FoliageLeaf | LookFlags.NormalRoughness), 0);
	assert.deepEqual(row(leaf, LookRow.foliage), [0.5, 0.25, 2, 1]);
	assert.deepEqual(row(leaf, LookRow.surface2).slice(1, 3), [0.07, 0.2].map(Math.fround));
	assert.equal(leaf.params[LookRow.detail2 + 3], 1);
	assert.equal(grass.flags & LookFlags.FoliageLeaf, 0);
	assert.deepEqual(row(grass, LookRow.foliage), [0.5, 0.25, 1, 0]);
	assert.deepEqual(row(grass, LookRow.foliageAo), [1, 2, 0.5, 1]);
	assert.deepEqual(row(grass, LookRow.foliage2), [0.1, 3, 4, 0.25].map(Math.fround));
	assert.equal(grass.params[LookRow.detail2 + 3], 0);
});

test('only authored post-focus queues move supported transparent surfaces after depth of field', () => {
	const queues = [undefined, 3659, 3660, 3700, 3740, 3741];
	const entries = queues.map((renderQueue, id) => {
		const entry = described(id, litSurface({ blend: 'alphaBlend' }));
		if (renderQueue !== undefined) {
			entry.renderQueue = renderQueue;
		}
		return entry;
	});
	entries.push({ ...described(entries.length, litSurface()), renderQueue: 3700 });
	entries.push({
		...described(entries.length, { kind: 'unsupported', reason: 'unknown shader' }),
		renderQueue: 3700,
	});
	assert.deepEqual(
		materialLooks({ entries }).map((look) => look.afterDof),
		[null, null, 3660, 3700, 3740, null, null, null],
	);
});
