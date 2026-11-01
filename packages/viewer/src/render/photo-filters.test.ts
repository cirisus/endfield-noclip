import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { PhotoFilter } from '@endfield-noclip/package-format/photo-filters';

import { deriveEnvironment } from './environment.ts';
import { parsePhotoFilters } from './photo-filters.ts';

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
	version: 1,
	filters,
});

test('rejects incompatible libraries, duplicate ids, malformed grading and invalid GPU payload sizes', () => {
	assert.equal(parsePhotoFilters(library([filter()])).filters.length, 1);
	assert.throws(() => parsePhotoFilters({ ...library([]), version: 2 }), /unsupported/);
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
