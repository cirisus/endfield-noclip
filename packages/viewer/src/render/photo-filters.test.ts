import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { MinMaxCurveInfo } from '@endfield-noclip/package-format/particles';
import type { PhotoEffect, PhotoFilter } from '@endfield-noclip/package-format/photo-filters';

import { deriveEnvironment, type EnvironmentInput } from './environment.ts';
import { parsePhotoFilters, photoProfile } from './photo-filters.ts';

const constant = (scalar: number): MinMaxCurveInfo => ({
	mode: 0,
	scalar,
	min: 0,
	curve: null,
	minCurve: null,
});
const effect = (): PhotoEffect => ({
	name: 'billboard',
	matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
	tint: [1, 1, 1, 1],
	ignorePostExposure: false,
	particles: {
		renderMode: 0,
		alignment: 0,
		stretch: null,
		sizedByScale: true,
		duration: 5,
		looping: true,
		startDelay: constant(0),
		maxParticles: 10,
		emissionBound: 6,
		simulationSpeed: 1,
		startLifetime: constant(2),
		rate: constant(3),
		startSize: [constant(1), constant(1), constant(1)],
		startRotation: [constant(0), constant(0), constant(0)],
		startColor: { mode: 0, max: [1, 1, 1, 1], min: [1, 1, 1, 1], maxGradient: null, minGradient: null },
		colorOverLifetime: null,
		sizeOverLifetime: null,
		rotationOverLifetime: null,
		shape: null,
		motion: {
			kind: 'free',
			startSpeed: constant(1),
			gravityModifier: constant(0),
			velocity: null,
			clamp: null,
		},
		ringBuffer: null,
		textureSheet: null,
		pivot: [0, 0, 0],
		meshWeights: [1],
		mesh: 0,
		bursts: [],
	},
	texture: {
		width: 4,
		height: 4,
		format: 'bc7-rgba-unorm-srgb',
		levels: [Buffer.alloc(16).toString('base64')],
		sampler: {
			addressModeU: 'repeat',
			addressModeV: 'repeat',
			addressModeW: 'repeat',
			minFilter: 'linear',
			magFilter: 'linear',
			mipmapFilter: 'nearest',
			maxAnisotropy: 1,
			mipBias: 0,
		},
	},
});

const filter = (): PhotoFilter => ({
	id: 'test',
	name: 'Test',
	unsupported: [],
	grading: null,
	vignette: { intensity: 0.7 },
	lut: {
		size: 4,
		format: 'bc7-rgba-unorm',
		data: Buffer.alloc(64).toString('base64'),
		contribution: 1,
	},
});
const library = (filters: PhotoFilter[]) => ({
	format: 'endfield-noclip.photo-filters',
	version: 2,
	filters,
});

test('rejects incompatible libraries, duplicate ids, malformed grading and invalid GPU payload sizes', () => {
	assert.equal(parsePhotoFilters(library([filter()])).filters.length, 1);
	assert.throws(() => parsePhotoFilters({ ...library([]), version: 1 }), /unsupported/);
	assert.throws(() => parsePhotoFilters(library([filter(), filter()])), /invalid photo filter/);
	assert.throws(
		() => parsePhotoFilters(library([{ ...filter(), lut: { ...filter().lut!, data: '' } }])),
		/invalid LUT/,
	);
	assert.throws(
		() => parsePhotoFilters({ ...library([]), filters: [{ ...filter(), grading: {} }] }),
		/invalid grading/,
	);
	assert.throws(
		() => parsePhotoFilters(library([{ ...filter(), vignette: { intensity: NaN } }])),
		/invalid vignette/,
	);
});

test('photo overrides also apply without a scene profile and never mutate the shared defaults', () => {
	const before = deriveEnvironment(null);
	const filtered = deriveEnvironment(null, filter());
	assert.equal(filtered.post.vignette?.intensity, 0.7);
	assert.deepEqual(filtered.sunIlluminance, before.sunIlluminance);
	assert.deepEqual(filtered.grading, before.grading);
	assert.deepEqual(filtered.post.bloom, before.post.bloom);
	assert.deepEqual(deriveEnvironment(null), before);
});

test('bloom overrides preserve the scene tint and unrelated post sections, and none restores the scene', () => {
	// photoProfile only reads post and grading; the other scene sections are opaque here.
	const scene = {
		post: {
			bloom: {
				resolutionHighQuality: 4,
				thresholdHighQuality: 1.2,
				intensityHighQuality: 0.3,
				scatterHighQuality: 0.4,
				tint: [0.2, 0.5, 1, 1],
				blendMode: 0,
			},
			ambientOcclusion: null,
			vignette: null,
			screenSpaceReflection: null,
		},
	} as unknown as EnvironmentInput;
	const before = structuredClone(scene);
	const look = {
		...filter(),
		vignette: null,
		bloom: { thresholdHighQuality: 0.7, intensityHighQuality: 0.75 },
	};
	assert.equal(parsePhotoFilters(library([look])).filters.length, 1);
	const result = photoProfile(scene, look);
	assert.deepEqual(result.post?.bloom, { ...scene.post?.bloom, ...look.bloom });
	assert.equal(result.post?.vignette, null);
	assert.deepEqual(scene, before);
	assert.equal(photoProfile(scene, null), scene);
	assert.ok(Math.abs(deriveEnvironment(null, look).post.bloom!.intensity - (2 ** 0.75 - 1)) < 1e-12);
	assert.throws(
		() => parsePhotoFilters(library([{ ...look, bloom: { intensityHighQuality: Infinity } }])),
		/invalid bloom/,
	);
});

test('rejects malformed effect transforms, particle curves, texture mips and unsupported render states', () => {
	const parse = (fx: PhotoEffect) => parsePhotoFilters(library([{ ...filter(), effects: [fx] }]));
	assert.equal(parse(effect()).filters[0].effects?.length, 1);
	assert.throws(() => parse({ ...effect(), matrix: [1] }), /invalid effects/);
	const badCurve = effect();
	badCurve.particles.startSize[0] = { ...constant(1), mode: 1, curve: null };
	assert.throws(() => parse(badCurve), /invalid effects/);
	const delayed = effect();
	delayed.particles.startDelay = { ...constant(2), mode: 3, min: 1 };
	assert.equal(parse(delayed).filters[0].effects?.length, 1);
	delayed.particles.startDelay = constant(-1);
	assert.throws(() => parse(delayed), /invalid effects/);
	const badMotion = effect();
	badMotion.particles.motion = {
		kind: 'free',
		startSpeed: constant(1),
		gravityModifier: constant(1),
		velocity: null,
		clamp: null,
	};
	assert.throws(() => parse(badMotion), /invalid effects/);
	const speedLimited = effect();
	speedLimited.particles.motion = {
		kind: 'free',
		startSpeed: constant(1),
		gravityModifier: constant(0),
		velocity: null,
		clamp: { kind: 'limit', limit: constant(1), dampen: 1 },
	};
	assert.throws(() => parse(speedLimited), /invalid effects/);
	const badMip = effect();
	badMip.texture.levels = [Buffer.alloc(1).toString('base64')];
	assert.throws(() => parse(badMip), /invalid effects/);
	const badSampler = effect();
	badSampler.texture.sampler.maxAnisotropy = 4;
	assert.throws(() => parse(badSampler), /invalid effects/);
});
