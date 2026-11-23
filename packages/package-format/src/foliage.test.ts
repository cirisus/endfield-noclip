import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
	decodeFoliageBlock,
	encodeFoliageBlock,
	FOLIAGE_INSTANCE_BYTES,
	type FoliageBlock,
} from './foliage.ts';
import { chainHashMap } from './instances.ts';

describe('FoliageBlock (EFFL)', () => {
	it('round-trips clusters, packed instances, and PLTT chain hash remapping', () => {
		const h0 = 0xaaaa_bbbb_cccc_ddddn;
		const h1 = 0x1234_5678_9abc_def0n;
		const instances = new Uint8Array(FOLIAGE_INSTANCE_BYTES * 3);
		for (let i = 0; i < instances.length; i++) {
			instances[i] = i & 0xff;
		}
		const block: FoliageBlock = {
			origin: [128, 0, -256],
			palette: BigUint64Array.of(h0, h1),
			clusters: [
				{
					chain: 0,
					firstInstance: 0,
					instanceCount: 2,
					center: [1, 2, 3],
					halfExtents: [8, 4, 8],
					rendererHalfSize: 0.75,
				},
				{
					chain: 1,
					firstInstance: 2,
					instanceCount: 1,
					center: [-4, 1, 5],
					halfExtents: [2, 2, 2],
					rendererHalfSize: 0.5,
				},
			],
			instances,
		};
		const encoded = encodeFoliageBlock(block);
		assert.deepEqual(decodeFoliageBlock(encoded), block);

		const index = chainHashMap([
			{ draws: [], flags: 0, distanceOrigin: null, contentHash: h1 },
			{ draws: [], flags: 0, distanceOrigin: null, contentHash: h0 },
		]);
		const resolved = decodeFoliageBlock(encoded, index);
		assert.equal(resolved.palette, undefined);
		assert.equal(resolved.clusters[0].chain, 1);
		assert.equal(resolved.clusters[1].chain, 0);
	});
});
