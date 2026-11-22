import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FormatError } from '../binary/binary-reader.ts';

import { StringPathHashTable } from './string-path-hash.ts';

/** builds a StringPathHash table the way the game lays it out: slot = hash mod count */
const build = (pairs: [bigint, string][]): Uint8Array => {
	const count = pairs.length;
	const stringsOffset = 8 + 24 * count;
	const strings = pairs.map(([, path]) => {
		const bytes = new Uint8Array(4 + path.length * 2 + 2);
		const view = new DataView(bytes.buffer);
		view.setUint32(0, path.length * 2, true);
		for (let i = 0; i < path.length; i++) {
			view.setUint16(4 + i * 2, path.charCodeAt(i), true);
		}
		return bytes;
	});
	const out = new Uint8Array(stringsOffset + strings.reduce((sum, s) => sum + s.length, 0));
	const view = new DataView(out.buffer);
	view.setUint32(0, stringsOffset, true);
	view.setUint32(4, count, true);

	const relative: number[] = [];
	let cursor = 0;
	for (const s of strings) {
		out.set(s, stringsOffset + cursor);
		relative.push(cursor);
		cursor += s.length;
	}

	// group buckets by slot, then lay them out contiguously after the slot table
	const bySlot = new Map<number, number[]>();
	pairs.forEach(([hash], i) => {
		const slot = Number(hash % BigInt(count));
		bySlot.getOrInsertComputed(slot, () => []).push(i);
	});
	let bucket = 8 + 8 * count;
	for (const [slot, members] of bySlot) {
		view.setUint32(8 + slot * 8, bucket, true);
		view.setUint32(8 + slot * 8 + 4, members.length, true);
		for (const i of members) {
			view.setBigUint64(bucket + 4, pairs[i][0], true);
			view.setUint32(bucket + 12, relative[i], true);
			bucket += 16;
		}
	}
	return out;
};

test('lookup finds paths through their slot', () => {
	const table = new StringPathHashTable(
		build([
			[0x10n, 'Data/a.bytes'],
			[0x13n, 'assets/b.mat'],
			[0xffff_ffff_ffff_fff0n, 'assets/c.fbx##c'],
		]),
	);
	assert.equal(table.count, 3);
	assert.equal(table.lookup(0x10n), 'Data/a.bytes');
	assert.equal(table.lookup(0x13n), 'assets/b.mat');
	assert.equal(table.lookup(0xffff_ffff_ffff_fff0n), 'assets/c.fbx##c');
	assert.equal(table.lookup(0x11n), undefined);
	assert.equal([...table.entries()].length, 3);
});

test('lookup reports collisions as ambiguous', () => {
	const table = new StringPathHashTable(
		build([
			[7n, 'x'],
			[7n, 'y'],
		]),
	);
	assert.deepEqual(table.lookupAll(7n), ['x', 'y']);
	assert.equal(table.lookup(7n), undefined);
});

test('entries filters by predicate when given', () => {
	const table = new StringPathHashTable(
		build([
			[1n, 'assets/water.mat'],
			[2n, 'assets/rock.mat'],
			[3n, 'assets/waterfall.mat'],
		]),
	);
	assert.deepEqual(
		// oxlint-disable-next-line unicorn/no-array-sort -- sorts a fresh copy
		[...table.entries((path) => path.includes('water'))].sort(([a], [b]) => Number(a - b)),
		[
			[1n, 'assets/water.mat'],
			[3n, 'assets/waterfall.mat'],
		],
	);
});

test('hashesOf matches case-insensitively on both first scan and indexed lookups', () => {
	const table = new StringPathHashTable(
		build([
			[10n, 'Assets/Foo/Bar.prefab'],
			[20n, 'Assets/Foo/Baz.prefab'],
			[30n, 'assets/foo/bar.prefab'],
			[40n, 'Assets/Café/Test.mat'],
		]),
	);
	assert.deepEqual(
		table.hashesOf('assets/foo/bar.prefab').toSorted((a, b) => Number(a - b)),
		[10n, 30n],
	);
	// second lookup uses the length index
	assert.deepEqual(table.hashesOf('ASSETS/FOO/BAZ.PREFAB'), [20n]);
	assert.deepEqual(table.hashesOf('assets/café/test.mat'), [40n]);
	assert.deepEqual(table.hashesOf('assets/foo/missing.prefab'), []);
});

test('reports buckets outside the file as format errors', () => {
	const bytes = build([[1n, 'x']]);
	new DataView(bytes.buffer).setUint32(8, 0xffff, true);
	assert.throws(() => new StringPathHashTable(bytes).lookup(1n), FormatError);
});

test('rejects an inconsistent header', () => {
	const bytes = build([[1n, 'x']]);
	new DataView(bytes.buffer).setUint32(0, 9, true);
	assert.throws(() => new StringPathHashTable(bytes), FormatError);
});
