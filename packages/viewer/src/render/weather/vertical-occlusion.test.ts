import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
	fitVerticalOcclusion,
	VERTICAL_OCCLUSION_HEIGHT,
	VERTICAL_OCCLUSION_SIZE,
} from './vertical-occlusion.ts';

const mulMat4 = (m: Float32Array, x: number, y: number, z: number): [number, number, number] => [
	m[0] * x + m[4] * y + m[8] * z + m[12],
	m[1] * x + m[5] * y + m[9] * z + m[13],
	m[2] * x + m[6] * y + m[10] * z + m[14],
];

describe('fitVerticalOcclusion', () => {
	it('projects camera-relative positions consistently between render matrix and shader params', () => {
		const eye: [number, number, number] = [12.3, 45.7, -88.9];
		const range = 100;
		const fit = fitVerticalOcclusion(eye, range, VERTICAL_OCCLUSION_HEIGHT, VERTICAL_OCCLUSION_SIZE);
		const [cx, topRelY, cz, invSpan] = fit.originAndInvSpan;
		const [invHeight, height] = fit.metrics;

		for (const rel of [
			[0, 0, 0],
			[25, 10, -40],
			[-60, -30, 55],
		] as const) {
			const [nx, ny, nz] = mulMat4(fit.render, rel[0], rel[1], rel[2]);
			const renderU = nx * 0.5 + 0.5;
			const renderV = 0.5 - ny * 0.5;
			const shaderU = 0.5 + (rel[0] - cx) * invSpan;
			const shaderV = 0.5 - (rel[2] - cz) * invSpan;
			const shaderZ = (topRelY - rel[1]) * invHeight;
			assert.ok(Math.abs(renderU - shaderU) < 1e-6);
			assert.ok(Math.abs(renderV - shaderV) < 1e-6);
			assert.ok(Math.abs(nz - shaderZ) < 1e-6);
			// height reconstruction matches original relative y
			const reconstructedY = topRelY - nz * height;
			assert.ok(Math.abs(reconstructedY - rel[1]) < 1e-4);
		}
	});

	it('maps higher surfaces to smaller depth values so less-equal compare shelters lower points', () => {
		const fit = fitVerticalOcclusion([0, 0, 0], 100);
		const [, , zRoof] = mulMat4(fit.render, 0, 10, 0);
		const [, , zFloor] = mulMat4(fit.render, 0, 0, 0);
		assert.ok(zRoof < zFloor);
		assert.ok(zRoof > 0 && zFloor < 1);
	});
});
