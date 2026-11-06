import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FormatError } from '../binary/binary-reader.ts';

import { readLevelDataPrefix, readLevelInteractives, UnsupportedLevelData } from './level-interactives.ts';

const fixture = (options: { gated: boolean; unsupported: boolean; areas: boolean }): Uint8Array => {
	const bytes = new Uint8Array(1024);
	const view = new DataView(bytes.buffer);
	let at = 0;
	const u8 = (v: number): void => {
		view.setUint8(at++, v);
	};
	const i32 = (v: number): void => {
		view.setInt32(at, v, true);
		at += 4;
	};
	const u64 = (v: bigint): void => {
		view.setBigUint64(at, v, true);
		at += 8;
	};
	const f32 = (v: number): void => {
		view.setFloat32(at, v, true);
		at += 4;
	};
	u8(43);
	i32(0);
	i32(0);
	i32(0);
	// a populated blackbox is unsupported
	u8(options.unsupported ? 15 : 255);
	u8(255);
	i32(0);
	i32(0);
	i32(0);
	i32(0);
	for (let i = 0; i < 5; i++) {
		i32(0);
	}
	u8(1);
	i32(0);
	i32(0);
	u8(4);
	for (let i = 0; i < 3; i++) {
		i32(0);
	}
	if (options.areas) {
		// a scene toast (union tag 14) with two titles and a null one, an AI bark block (tag 2), then a
		// hide-by-type area (tag 9) whitelisting one logic id
		i32(3);
		u8(14);
		u8(6);
		i32(-1);
		u8(255);
		u8(1);
		i32(8);
		i32(0);
		i32(232);
		u8(1);
		i32(8);
		u8(2);
		u8(1);
		u8(1);
		u8(9);
		u8(4);
		i32(1);
		i32(1);
		u64(5n);
		i32(0);
		i32(0);
	} else {
		i32(0);
	}
	i32(0);
	i32(0);
	i32(2);
	for (let n = 0; n < 2; n++) {
		u8(25);
		i32(0);
		u64(0n);
		i32(n);
		u64(0n);
		i32(7);
		i32(32);
		u8(0);
		u8(0);
		u64(100n + BigInt(n));
		u8(0);
		for (const f of [1, 2, 3, 0, 90, 0, 1, 1, 1]) {
			f32(f);
		}
		u8(0);
		if (n === 0) {
			// one component (type 26) with one string parameter
			i32(1);
			i32(26);
			i32(1);
			u8(2);
			i32(9);
			u8(2);
			i32(7);
			i32(1);
			u8(2);
			u64(0n);
			i32(10);
		} else {
			i32(0);
		}
		i32(-1);
		i32(0);
		u8(0);
		u8(0);
		// isLocked on the first placement only
		u8(n === 0 ? 1 : 0);
		i32(-1);
		i32(0);
		f32(0);
		if (options.gated && n === 0) {
			u8(18);
			u8(3);
			i32(0);
			i32(3);
			i32(8);
		} else {
			u8(255);
		}
		if (n === 1) {
			// one entity property: an int `state` of 2
			i32(1);
			u8(2);
			i32(11);
			u8(2);
			i32(3);
			i32(1);
			u8(2);
			u64(2n);
			i32(12);
		} else {
			i32(0);
		}
	}
	return bytes.slice(0, at);
};

const STRINGS = new Map([
	[7, 'test_facility'],
	[8, 'test_quest'],
	[9, 'system_inst_key'],
	[10, 'construction_area_2'],
	[11, 'state'],
	[12, ''],
]);

const string = (id: number): string => {
	const value = STRINGS.get(id);
	assert.ok(value !== undefined);
	return value;
};

test('reads the complete interactive list through nullable properties and quest locks', () => {
	const rows = readLevelInteractives(fixture({ gated: true, unsupported: false, areas: false }), string);
	assert.equal(rows.length, 2);
	assert.deepEqual(
		rows.map((r) => [r.id, r.createState]),
		[
			[100n, 0],
			[101n, 1],
		],
	);
	assert.deepEqual(rows[0].position, [1, 2, 3]);
	assert.deepEqual(rows[0].rotation, [0, 90, 0]);
	assert.equal(rows[0].template, 'test_facility');
	assert.deepEqual(
		rows[0].componentProperties,
		new Map([
			[26, [{ key: 'system_inst_key', type: 7, values: [{ bits: 0n, text: 'construction_area_2' }] }]],
		]),
	);
	assert.equal(rows[1].componentProperties.size, 0);
	assert.deepEqual(
		rows.map((r) => r.isLocked),
		[true, false],
	);
	assert.deepEqual(rows[0].properties, []);
	assert.deepEqual(rows[1].properties, [{ key: 'state', type: 3, values: [{ bits: 2n, text: '' }] }]);
});

test('an unsupported prefix cannot be bypassed to find a plausible placement later in the file', () => {
	assert.throws(
		() => readLevelInteractives(fixture({ gated: false, unsupported: true, areas: false }), string),
		UnsupportedLevelData,
	);
});

test('a truncated second placement rejects the whole list', () => {
	const bytes = fixture({ gated: false, unsupported: false, areas: false });
	assert.throws(() => readLevelInteractives(bytes.subarray(0, bytes.length - 2), string), FormatError);
});

test('reads past scene toast, AI bark and hide-by-type function areas, counting the last', () => {
	const prefix = readLevelDataPrefix(fixture({ gated: false, unsupported: false, areas: true }), string);
	assert.equal(prefix.interactives.length, 2);
	assert.equal(prefix.hideByTypeAreas, 1);
});
