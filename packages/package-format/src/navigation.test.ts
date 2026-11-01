import { strict as assert } from 'node:assert';
import { it } from 'node:test';

import { containsVolume, type Volume } from './navigation.ts';
const box: Volume = {
	kind: 'box',
	position: [10, 20, 30],
	rotation: [0, 90, 0],
	size: [4, 6, 10],
	radius: 1,
	points: [],
};
it('uses rotated three-dimensional bounds, including exact edges', () => {
	assert.equal(containsVolume(box, [14.9, 20, 30]), true);
	assert.equal(containsVolume(box, [10, 23, 30]), true);
	assert.equal(containsVolume(box, [10, 23.1, 30]), false);
	assert.equal(containsVolume(box, [10, 20, 32.1]), false);
});
it('tests the closed polygon rather than its rectangle and respects its height band', () => {
	const prism: Volume = {
		...box,
		kind: 'polygon',
		rotation: [0, 0, 0],
		points: [
			[0, 0],
			[8, 0],
			[0, 8],
		],
	};
	assert.equal(containsVolume(prism, [11, 20, 31]), true);
	assert.equal(containsVolume(prism, [17, 20, 37]), false);
	assert.equal(containsVolume(prism, [11, 24, 31]), false);
});
it('uses spherical distance rather than box extents', () => {
	assert.equal(containsVolume({ ...box, kind: 'sphere', radius: 2 }, [11, 21, 31]), true);
	assert.equal(containsVolume({ ...box, kind: 'sphere', radius: 2 }, [12, 22, 32]), false);
});
it('rejects invalid navigation geometry and mismatched release generations', async () => {
	const { isNavigation, matchesNavigation } = await import('./navigation.ts');
	const data = {
		version: 1 as const,
		release: 'r',
		source: { buildGuid: 'b', contentHash: 'h' },
		generations: { scene: 'g' },
		routes: [],
	};
	const catalog = {
		format: 'oem-noclip' as const,
		version: 1 as const,
		release: 'r',
		source: data.source,
		packages: { scene: { generation: 'g', path: 'packages/scene/', version: 27 } },
		files: {},
		pointIndex: {},
	};
	assert.equal(isNavigation(data), true);
	assert.equal(matchesNavigation(data, catalog), true);
	assert.equal(matchesNavigation({ ...data, generations: { scene: 'old' } }, catalog), false);
	assert.equal(matchesNavigation({ ...data, release: 'old' }, catalog), false);
	assert.equal(isNavigation({ ...data, routes: [{ scene: 'scene' }] }), false);
});
