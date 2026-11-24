import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
	CLOTH_META_RECORD_BYTES,
	CLOTH_NODE_RECORD_BYTES,
	CLOTH_PAIR_RECORD_BYTES,
	decodeClothDataBlob,
	decodeClothTable,
	encodeClothDataBlob,
	encodeClothTable,
} from './cloth.ts';
import { decodeInstanceBlock, encodeInstanceBlock } from './instances.ts';

test('cloth table round-trips empty and populated tables', () => {
	const empty = decodeClothTable(encodeClothTable({ blob: null, windNoiseTexture: null, cloths: [] }));
	assert.deepEqual(empty, { blob: null, windNoiseTexture: null, cloths: [] });

	const table = {
		blob: 42,
		windNoiseTexture: 7,
		cloths: [
			{ skeletonOffset: 0, nodeCount: 105 },
			{ skeletonOffset: 105, nodeCount: 300 },
		],
	};
	assert.deepEqual(decodeClothTable(encodeClothTable(table)), table);
});

test('cloth data blob round-trips simulation buffers', () => {
	const meta = new Uint8Array(2 * CLOTH_META_RECORD_BYTES).fill(0x1a);
	const nodes = new Uint8Array(5 * CLOTH_NODE_RECORD_BYTES).fill(0x2b);
	const batches = new Uint8Array(1 * CLOTH_PAIR_RECORD_BYTES).fill(0x3c);
	const cache = new Uint8Array(2 * CLOTH_PAIR_RECORD_BYTES).fill(0x4d);
	const decoded = decodeClothDataBlob(
		encodeClothDataBlob({
			clothCount: 2,
			nodeCount: 5,
			batchVec4Count: 1,
			cacheVec4Count: 2,
			meta,
			nodes,
			batches,
			cache,
		}),
	);
	assert.equal(decoded.clothCount, 2);
	assert.equal(decoded.nodeCount, 5);
	assert.equal(decoded.batchVec4Count, 1);
	assert.equal(decoded.cacheVec4Count, 2);
	assert.deepEqual(decoded.meta, meta);
	assert.deepEqual(decoded.nodes, nodes);
	assert.deepEqual(decoded.batches, batches);
	assert.deepEqual(decoded.cache, cache);
});

test('instance block CLTH sparse section round-trips', () => {
	const block = {
		origin: [10, 20, 30] as [number, number, number],
		chains: new Uint32Array([0, 1, 2]),
		transforms: new Float32Array(36),
		bounds: new Float32Array(18),
		decals: { rows: new Uint32Array(), values: new Float32Array() },
		spins: { rows: new Uint32Array(), values: new Float32Array() },
		floaters: { rows: new Uint32Array(), values: new Uint32Array() },
		rides: { rows: new Uint32Array(), values: new Uint32Array() },
		paths: [],
		cloths: { rows: new Uint32Array([0, 2]), values: new Uint32Array([5, 11]) },
	};
	const decoded = decodeInstanceBlock(encodeInstanceBlock(block));
	assert.deepEqual(decoded.cloths, block.cloths);
});
