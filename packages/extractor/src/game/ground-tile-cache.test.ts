import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import type { Surface } from '@oem/ganglia';
import type { BuildOptions, CollisionGeometry } from '@oem/ganglia/build';

import { groundTileCache } from './ground-tile-cache.ts';

test('tile reuse binds geometry, physical settings and source and ignores corrupt files', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'ground-tiles-'));
	try {
		const source = { buildGuid: 'build', contentHash: 'content' };
		const geometry: CollisionGeometry = { positions: [0, 0, 0, 0, 0, 2, 2, 0, 0], indices: [0, 1, 2] };
		const options: BuildOptions = {
			profile: { radius: 0.35, height: 1.66 },
			cellSize: 0.15,
			cellHeight: 0.05,
			stepUp: 0.4,
			stepDown: 0.6,
			maxSlope: 46,
			bounds: { min: [0, 0], max: [2, 2] },
		};
		const surfaces: Surface[] = [
			{
				id: '0',
				vertices: [
					[0, 0, 0],
					[0, 0, 2],
					[2, 0, 0],
				],
			},
		];
		const cache = await groundTileCache(directory, source);
		assert.equal(await cache.load(geometry, options), null);
		await cache.save(geometry, options, surfaces);
		assert.deepEqual(await (await groundTileCache(directory, source)).load(geometry, options), surfaces);
		assert.equal(
			await cache.load({ ...geometry, positions: geometry.positions.map((v) => v + 1) }, options),
			null,
		);
		assert.equal(await cache.load(geometry, { ...options, stepUp: 0.3 }), null);
		assert.equal(
			await cache.load(geometry, { ...options, profile: { ...options.profile, radius: 0.4 } }),
			null,
		);
		assert.equal(
			await (await groundTileCache(directory, { ...source, contentHash: 'new' })).load(geometry, options),
			null,
		);
		const [prefix] = await readdir(directory),
			[file] = await readdir(join(directory, prefix));
		await writeFile(join(directory, prefix, file), '{broken');
		assert.equal(await cache.load(geometry, options), null);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
