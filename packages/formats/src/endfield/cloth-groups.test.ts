import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FormatError } from '../binary/binary-reader.ts';
import { FlatBufferWriter as Writer } from '../binary/flatbuffer-writer.ts';

import {
	CLOTH_GROUP_META_BYTES,
	CLOTH_GROUP_PROXY_TYPE,
	CLOTH_META_BYTES,
	CLOTH_NODE_BYTES,
	CLOTH_PAIR_BYTES,
	hasClothGroups,
	readClothGroups,
} from './cloth-groups.ts';

const encoder = new TextEncoder();
const GROUP_ID = (3 << 27) | 0x77bfa12;
const AUDIO_ID = (3 << 27) | 0x77bfa13;

const writeBlobProperties = (w: Writer, field: number, entries: [key: number, bytes: Uint8Array][]): void => {
	const table = w.table([0, 0, 0, 4, 4, 4]);
	w.link(field, table.at);
	w.u32s(
		table.fields[3],
		entries.map(([key]) => key),
	);
	w.u8s(
		table.fields[4],
		entries.map(() => 17),
	);
	const links = w.offsets(table.fields[5], entries.length);
	entries.forEach(([, bytes], i) => {
		const outer = w.table([4]);
		w.link(links[i], outer.at);
		const inner = w.table([4]);
		w.link(outer.fields[0], inner.at);
		const vector = w.vector(1, bytes.length);
		w.bytes.set(bytes, vector.start);
		w.link(inner.fields[0], vector.at);
	});
};

const buildChunk = (proxyType: number, props: [number, Uint8Array][]): Uint8Array => {
	const w = new Writer();
	const fields = w.chunkRoot();
	w.u32s(fields[3], [GROUP_ID, AUDIO_ID]);
	w.u8s(fields[4], [3, 3]);
	const rowLinks = w.offsets(fields[5], 2);
	[
		{ name: 'ClothGroupInfo_3156577478#3_77BFA12', type: proxyType, props },
		{ name: 'AudioEmitter_01#3_77BFA13', type: 2, props: [] as [number, Uint8Array][] },
	].forEach((object, i) => {
		const row = w.table([4, 0, 1, 4]);
		w.link(rowLinks[i], row.at);
		const name = encoder.encode(object.name);
		const vector = w.vector(1, name.length);
		w.bytes.set(name, vector.start);
		w.link(row.fields[0], vector.at);
		w.view.setUint8(row.fields[2], object.type);
		writeBlobProperties(w, row.fields[3], object.props);
	});
	return w.finish();
};

const buildGroupMeta = (
	groupHash: number,
	worldXZ: [number, number],
	cloths: { hash: number; nodes: number; batches: number; cache: number }[],
): Uint8Array => {
	const buf = new Uint8Array(CLOTH_GROUP_META_BYTES);
	const dv = new DataView(buf.buffer);
	dv.setInt32(0, cloths.length, true);
	dv.setUint32(4, groupHash, true);
	dv.setFloat32(8, worldXZ[0], true);
	dv.setFloat32(12, worldXZ[1], true);
	cloths.forEach((c, i) => {
		dv.setUint32(16 + i * 4, c.hash, true);
		dv.setInt32(32 + i * 4, c.nodes, true);
		dv.setInt32(48 + i * 4, c.batches, true);
		dv.setInt32(64 + i * 4, c.cache, true);
	});
	return buf;
};

test('readClothGroups decodes a cloth group proxy and ignores other proxy types', () => {
	const meta = buildGroupMeta(
		3156577478,
		[-184.25, -1293.5],
		[
			{ hash: 3156577478, nodes: 10, batches: 1, cache: 0 },
			{ hash: 123456, nodes: 20, batches: 2, cache: 5 },
		],
	);
	const clothMeta = new Uint8Array(2 * CLOTH_META_BYTES).fill(0x11);
	const nodes = new Uint8Array(30 * CLOTH_NODE_BYTES).fill(0x22);
	const batches = new Uint8Array(2 * CLOTH_PAIR_BYTES).fill(0x33);
	const cache = new Uint8Array(3 * CLOTH_PAIR_BYTES).fill(0x44);
	const raw = buildChunk(CLOTH_GROUP_PROXY_TYPE, [
		[0xff000000, meta],
		[0xff010000, clothMeta],
		[0xff020000, nodes],
		[0xff030000, batches],
		[0xff040000, cache],
	]);

	assert.equal(hasClothGroups(raw), true);
	const groups = readClothGroups(raw);
	assert.equal(groups.length, 1);
	const [group] = groups;
	assert.equal(group.id, GROUP_ID);
	assert.equal(group.levelTag, 3);
	assert.equal(group.groupHash, 3156577478);
	assert.deepEqual(group.worldPosXZ, [-184.25, -1293.5]);
	assert.deepEqual(group.cloths, [
		{ hash: 3156577478, nodeCount: 10, batchCount: 1, cacheCount: 0 },
		{ hash: 123456, nodeCount: 20, batchCount: 2, cacheCount: 5 },
	]);
	assert.equal(group.metaBytes.length, clothMeta.length);
	assert.equal(group.nodeBytes.length, nodes.length);
	assert.equal(group.batchBytes.length, batches.length);
	assert.equal(group.cacheBytes.length, cache.length);
});

test('hasClothGroups is false when no proxy has type 8', () => {
	const raw = buildChunk(7, []);
	assert.equal(hasClothGroups(raw), false);
	assert.deepEqual(readClothGroups(raw), []);
});

test('readClothGroups rejects mismatched blob sizes', () => {
	const meta = buildGroupMeta(1, [0, 0], [{ hash: 1, nodes: 10, batches: 1, cache: 0 }]);
	const raw = buildChunk(CLOTH_GROUP_PROXY_TYPE, [
		[0xff000000, meta],
		[0xff010000, new Uint8Array(CLOTH_META_BYTES)],
		[0xff020000, new Uint8Array(9 * CLOTH_NODE_BYTES)],
		[0xff030000, new Uint8Array(CLOTH_PAIR_BYTES)],
		[0xff040000, new Uint8Array(CLOTH_PAIR_BYTES)],
	]);
	assert.throws(() => readClothGroups(raw), FormatError);
});
