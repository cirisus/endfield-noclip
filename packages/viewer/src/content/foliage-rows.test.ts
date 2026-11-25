import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
	FOLIAGE_INSTANCE_BYTES,
	type FoliageBlock,
	packFoliageInstance,
} from '@endfield-noclip/package-format/foliage';
import { RowFlags } from '@endfield-noclip/package-format/instances';

import { buildFoliageRows } from './foliage-rows.ts';
import { ROW_WORDS, RowKind, RowWord } from './instance-rows.ts';

describe('buildFoliageRows', () => {
	it('expands foliage clusters into GPU instance rows, coalesces chain runs, and tracks mirroring', () => {
		const origin: [number, number, number] = [64, 0, -64];
		const c0: [number, number, number] = [2, 1, 3];
		const e0: [number, number, number] = [4, 2, 4];
		const instances = new Uint8Array(FOLIAGE_INSTANCE_BYTES * 3);

		// identity translated to (66, 1, -61)
		const m0 = Float32Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 66, 1, -61, 1);
		// mirrored X translated to (65, 2, -62)
		const m1 = Float32Array.of(-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 65, 2, -62, 1);
		// identity translated to (67, 0, -60)
		const m2 = Float32Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 67, 0, -60, 1);

		packFoliageInstance(instances, 0, m0, origin, c0, e0);
		packFoliageInstance(instances, FOLIAGE_INSTANCE_BYTES, m1, origin, c0, e0);
		packFoliageInstance(instances, FOLIAGE_INSTANCE_BYTES * 2, m2, origin, c0, e0);

		const block: FoliageBlock = {
			origin,
			clusters: [
				{ chain: 7, firstInstance: 0, instanceCount: 1, center: c0, halfExtents: e0, rendererHalfSize: 1 },
				{ chain: 7, firstInstance: 1, instanceCount: 1, center: c0, halfExtents: e0, rendererHalfSize: 1 },
				{ chain: 9, firstInstance: 2, instanceCount: 1, center: c0, halfExtents: e0, rendererHalfSize: 1 },
			],
			instances,
		};

		const { built, rowFlags } = buildFoliageRows(block);
		assert.equal(built.count, 3);
		// first two clusters share chain 7 and coalesce into one run
		assert.deepEqual([...built.runs], [7, 0, 2, 9, 2, 1]);
		assert.deepEqual([...rowFlags], [0, RowFlags.Mirrored, 0]);
		assert.equal(built.rows[RowWord.info], RowKind.Detail);
		const f32 = new Float32Array(built.rows.buffer);
		assert.ok(Math.abs(f32[3] - 2) < 1e-3);
		assert.ok(Math.abs(f32[ROW_WORDS] + 1) < 1e-3);
	});
});
