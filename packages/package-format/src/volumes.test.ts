import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
	distanceInsideShape,
	pointInPolygon,
	pointInVolume,
	shapeReachesRect,
	type VolumeShape,
} from './volumes.ts';

describe('VolumeShape', () => {
	it('evaluates global, sphere, box, prism, and cylinder containment and depth', () => {
		const global: VolumeShape = { kind: 'global' };
		assert.equal(distanceInsideShape(global, [1e6, -1e6, 0]), Infinity);
		assert.equal(pointInVolume(global, [0, 0, 0]), true);

		const sphere: VolumeShape = { kind: 'sphere', center: [10, 0, 0], radius: 5 };
		assert.equal(distanceInsideShape(sphere, [13, 0, 0]), 2);
		assert.equal(pointInVolume(sphere, [15, 0, 0]), false);

		const box: VolumeShape = {
			kind: 'box',
			center: [0, 0, 0],
			toBox: [1, 0, 0, 0, 1, 0, 0, 0, 1],
			halfExtents: [4, 2, 6],
		};
		assert.equal(distanceInsideShape(box, [1, 0.5, 2]), 1.5);
		assert.equal(pointInVolume(box, [5, 0, 0]), false);

		const prism: VolumeShape = {
			kind: 'prism',
			polygon: [
				[0, 0],
				[10, 0],
				[10, 10],
				[0, 10],
			],
			minY: -2,
			maxY: 8,
		};
		assert.equal(pointInPolygon(prism.polygon, 5, 5), true);
		assert.equal(pointInPolygon(prism.polygon, 11, 5), false);
		assert.equal(distanceInsideShape(prism, [2, 1, 5]), 2);
		assert.equal(pointInVolume(prism, [5, 9, 5]), false);

		const cylinder: VolumeShape = { kind: 'cylinder', center: [0, 5, 0], radius: 3, halfHeight: 4 };
		assert.equal(distanceInsideShape(cylinder, [1, 5, 0]), 2);
		assert.equal(distanceInsideShape(cylinder, [0, 8, 0]), 1);
		assert.equal(pointInVolume(cylinder, [0, 10, 0]), false);
	});

	it('tests rect overlap for all shapes', () => {
		const rect = { minX: 0, minZ: 0, maxX: 10, maxZ: 10 };
		assert.equal(shapeReachesRect({ kind: 'sphere', center: [12, 0, 5], radius: 3 }, rect), true);
		assert.equal(shapeReachesRect({ kind: 'sphere', center: [14, 0, 5], radius: 3 }, rect), false);
		assert.equal(
			shapeReachesRect({ kind: 'cylinder', center: [-2, 0, 5], radius: 3, halfHeight: 1 }, rect),
			true,
		);
		assert.equal(
			shapeReachesRect(
				{
					kind: 'prism',
					polygon: [
						[12, 12],
						[15, 12],
						[15, 15],
					],
					minY: 0,
					maxY: 1,
				},
				rect,
			),
			false,
		);
	});
});
