import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
	computeShapeMeshCdf,
	decodeLutsTable,
	encodeLutsTable,
	GradientLutFormat,
	sampleCurveLut,
	sampleGradientLut,
	type LutsTable,
} from './luts.ts';

describe('LutsTable (EFLU)', () => {
	it('round-trips curves, gradients, and particle shape meshes and evaluates LUTs', () => {
		const table: LutsTable = {
			curves: [
				{
					minVal: -2,
					maxVal: 6,
					flags: 0,
					samples: new Uint16Array([0, 32768, 65535]),
				},
			],
			gradients: [
				{
					format: GradientLutFormat.Rgba8,
					sampleCount: 2,
					samples: new Uint8Array([0, 0, 0, 255, 255, 128, 0, 0]),
				},
			],
			shapeMeshes: [
				{
					primSize: 3,
					hasColor: true,
					positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
					normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
					colors: new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255]),
					primitives: new Uint32Array([0, 1, 2]),
					areaCdf: computeShapeMeshCdf([0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 1, 2], 3),
				},
				{
					primSize: 2,
					hasColor: false,
					positions: new Float32Array([0, 0, 0, 3, 4, 0]),
					normals: null,
					colors: null,
					primitives: new Uint32Array([0, 1]),
					areaCdf: computeShapeMeshCdf([0, 0, 0, 3, 4, 0], [0, 1], 2),
				},
			],
		};

		const decoded = decodeLutsTable(encodeLutsTable(table));
		assert.deepEqual(decoded, table);
		assert.equal(decoded.shapeMeshes[0].areaCdf[0], 0.5);
		assert.equal(decoded.shapeMeshes[1].normals, null);
		assert.equal(decoded.shapeMeshes[1].areaCdf[0], 5);

		assert.ok(Math.abs(sampleCurveLut(decoded.curves[0], 0) - -2) < 1e-4);
		assert.ok(Math.abs(sampleCurveLut(decoded.curves[0], 0.5) - 2) < 1e-3);
		assert.ok(Math.abs(sampleCurveLut(decoded.curves[0], 1) - 6) < 1e-4);

		const rgba = sampleGradientLut(decoded.gradients[0], 0.5, [0, 0, 0, 0]);
		assert.ok(Math.abs(rgba[0] - 0.5) < 1e-2);
		assert.ok(Math.abs(rgba[1] - 0.25) < 1e-2);
		assert.ok(Math.abs(rgba[3] - 0.5) < 1e-2);
	});
});
