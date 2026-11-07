import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createRouteCache } from './route-cache.ts';

const inputs = async (directory: string, suffix = '') => {
	const files = {
		ground: join(directory, 'ground' + suffix),
		collision: join(directory, 'collision' + suffix),
		movement: join(directory, 'movement' + suffix),
	};
	await Promise.all(Object.values(files).map((path) => writeFile(path, JSON.stringify({ value: path }))));
	return files;
};

test('input changes invalidate prepared regions and races cannot reuse an older preparation', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'route-cache-'));
	try {
		const files = await inputs(directory);
		const other = await inputs(directory, '-other');
		const cache = createRouteCache();
		const generation = await cache.begin(files);
		const value = await cache.read('ground', files.ground);
		assert.equal(await cache.read('ground', files.ground), value);
		assert.equal((await cache.memo('ground', generation, () => 1)).reused, false);
		assert.deepEqual(await cache.memo('ground', generation, () => 2), { value: 1, reused: true });
		await writeFile(files.ground, '{"value":"changed"}');
		await assert.rejects(cache.read('ground', files.ground), /changed after preparation/);
		const next = await cache.begin(files);
		assert.notEqual(next, generation);
		assert.deepEqual(await cache.read('ground', files.ground), { value: 'changed' });
		assert.equal((await cache.memo('ground', next, () => 2)).value, 2);
		const switched = await cache.begin(other);
		assert.equal((await cache.memo('ground', switched, () => 3)).reused, false);
		await cache.begin(files);
		assert.equal((await cache.memo('ground', next, () => 4)).reused, false);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test('oversized regions and rejected preparations are never retained', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'route-cache-budget-'));
	try {
		const files = await inputs(directory);
		const disabled = createRouteCache(0);
		await disabled.begin(files);
		assert.notEqual(await disabled.read('ground', files.ground), await disabled.read('ground', files.ground));
		assert.equal((await disabled.memo('ground', 'key', () => 1)).reused, false);
		assert.equal((await disabled.memo('ground', 'key', () => 2)).value, 2);
		const cache = createRouteCache();
		await cache.begin(files);
		await assert.rejects(
			cache.memo('refinement', 'key', () => Promise.reject(new Error('failed'))),
			/failed/,
		);
		assert.deepEqual(await cache.memo('refinement', 'key', () => 3), { value: 3, reused: false });
		await cache.memo('ground', 'old-walls', () => 1);
		await cache.memo('refinement', 'same-goal', () => 2);
		await cache.memo('ground', 'new-walls', () => 3);
		assert.equal((await cache.memo('refinement', 'same-goal', () => 4)).reused, false);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
