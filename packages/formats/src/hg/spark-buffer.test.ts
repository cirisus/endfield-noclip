import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseSparkBean, parseSparkTable, SparkType } from './spark-buffer.ts';

/** little byte-buffer builder with natural alignment */
class Buffer {
	bytes: number[] = [];

	get pos(): number {
		return this.bytes.length;
	}
	align(to: number): void {
		while (this.bytes.length % to !== 0) {
			this.bytes.push(0);
		}
	}
	u8(value: number): void {
		this.bytes.push(value);
	}
	u32(value: number): number {
		this.align(4);
		const at = this.pos;
		this.bytes.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
		return at;
	}
	i64(value: bigint): void {
		this.align(8);
		for (let i = 0n; i < 8n; i++) {
			this.bytes.push(Number((BigInt.asUintN(64, value) >> (i * 8n)) & 0xffn));
		}
	}
	f32(value: number): void {
		this.align(4);
		const view = new DataView(new ArrayBuffer(4));
		view.setFloat32(0, value, true);
		this.bytes.push(...new Uint8Array(view.buffer));
	}
	f64(value: number): void {
		this.align(8);
		const view = new DataView(new ArrayBuffer(8));
		view.setFloat64(0, value, true);
		this.bytes.push(...new Uint8Array(view.buffer));
	}
	cString(text: string): number {
		const at = this.pos;
		this.bytes.push(...new TextEncoder().encode(text), 0);
		return at;
	}
	patch(at: number, value: number): void {
		this.bytes[at] = value & 0xff;
		this.bytes[at + 1] = (value >>> 8) & 0xff;
		this.bytes[at + 2] = (value >>> 16) & 0xff;
		this.bytes[at + 3] = (value >>> 24) & 0xff;
	}
}

/** a LevelDescTable-like table: string key → bean { id: string, showName: bean I18nText { id: i64, text } } */
const buildBeanTable = (idType: number = SparkType.String): Uint8Array => {
	const b = new Buffer();
	const header = [b.u32(12), b.u32(0), b.u32(0)];

	// types
	b.u32(2);
	b.u8(SparkType.Bean);
	b.u32(0xaaaa);
	b.cString('LevelDescData');
	b.u32(2);
	b.cString('id');
	b.u8(idType);
	b.cString('showName');
	b.u8(SparkType.Bean);
	b.u32(0xbbbb);
	b.u8(SparkType.Bean);
	b.u32(0xbbbb);
	b.cString('I18nText');
	b.u32(2);
	b.cString('id');
	b.u8(SparkType.Long);
	b.cString('text');
	b.u8(SparkType.String);

	// root
	b.patch(header[1], b.pos);
	b.u8(SparkType.Map);
	b.cString('LevelDescTable');
	b.u8(SparkType.String);
	b.u8(SparkType.Bean);
	b.u32(0xaaaa);

	// strings
	const key = b.cString('map02_lv001');

	// values
	b.align(8);
	const bean = b.u32(key);
	const showPointer = b.u32(0);
	b.align(8);
	b.patch(showPointer, b.pos);
	b.i64(-5n);
	b.u32(0xffffffff);

	// data: one slot with one entry
	b.align(4);
	b.patch(header[2], b.pos);
	b.u32(1);
	const slot = b.u32(0);
	b.u32(1);
	b.patch(slot, b.pos);
	b.u32(key);
	b.u32(bean);
	return new Uint8Array(b.bytes);
};

test('decodes a string-keyed bean table', () => {
	const table = parseSparkTable(buildBeanTable());
	assert.equal(table.name, 'LevelDescTable');
	assert.deepEqual(table.entries, [
		['map02_lv001', { id: 'map02_lv001', showName: { id: -5n, text: null } }],
	]);
});

test('decodes an int64-keyed string table', () => {
	const b = new Buffer();
	const header = [b.u32(12), b.u32(0), b.u32(0)];
	b.u32(0);
	b.patch(header[1], b.pos);
	b.u8(SparkType.Map);
	b.cString('I18nTextTable_EN');
	b.u8(SparkType.Long);
	b.u8(SparkType.String);
	const hello = b.cString('hello');
	const world = b.cString('world');
	b.align(4);
	b.patch(header[2], b.pos);
	b.u32(2);
	const slot0 = b.u32(0);
	b.u32(2);
	b.u32(0);
	b.u32(0);
	b.patch(slot0, b.pos);
	b.i64(10n);
	b.u32(hello);
	b.i64(12n);
	b.u32(world);
	assert.deepEqual(parseSparkTable(new Uint8Array(b.bytes)).entries, [
		[10n, 'hello'],
		[12n, 'world'],
	]);
});

test('decodes a string-keyed int table', () => {
	const b = new Buffer();
	const header = [b.u32(12), b.u32(0), b.u32(0)];
	b.u32(0);
	b.patch(header[1], b.pos);
	b.u8(SparkType.Map);
	b.cString('SpaceshipAreaUnlockNeedCenterLvTable');
	b.u8(SparkType.String);
	b.u8(SparkType.Int);
	const key = b.cString('construction_area_2');
	b.align(4);
	b.patch(header[2], b.pos);
	b.u32(1);
	const slot = b.u32(0);
	b.u32(1);
	b.patch(slot, b.pos);
	b.u32(key);
	b.u32(3);
	assert.deepEqual(parseSparkTable(new Uint8Array(b.bytes)).entries, [['construction_area_2', 3]]);
});

test('decodes an int-keyed bean table with enum and array fields', () => {
	const b = new Buffer();
	const header = [b.u32(12), b.u32(0), b.u32(0)];
	// types: an enum (skipped), then a bean { roomType: enum, fields: int[] }
	b.u32(2);
	b.u8(SparkType.Enum);
	b.u32(0xcccc);
	b.cString('RoomType');
	b.u32(2);
	b.cString('ControlCenter');
	b.u32(0);
	b.cString('GrowCabin');
	b.u32(2);
	b.u8(SparkType.Bean);
	b.u32(0xaaaa);
	b.cString('LevelData');
	b.u32(2);
	b.cString('roomType');
	b.u8(SparkType.Enum);
	b.u32(0xcccc);
	b.cString('fields');
	b.u8(SparkType.Array);
	b.u8(SparkType.Int);
	// root
	b.patch(header[1], b.pos);
	b.u8(SparkType.Map);
	b.cString('LevelTable');
	b.u8(SparkType.Int);
	b.u8(SparkType.Bean);
	b.u32(0xaaaa);
	// values
	const array = b.u32(2);
	b.u32(4);
	b.u32(5);
	const bean = b.u32(2);
	b.u32(array);
	// data
	b.patch(header[2], b.pos);
	b.u32(1);
	const slot = b.u32(0);
	b.u32(1);
	b.patch(slot, b.pos);
	b.u32(2);
	b.u32(bean);
	assert.deepEqual(parseSparkTable(new Uint8Array(b.bytes)).entries, [[2, { roomType: 2, fields: [4, 5] }]]);
});

test('decodes a map field stored like the root map, keyed by its key strings', () => {
	const b = new Buffer();
	const header = [b.u32(12), b.u32(0), b.u32(0)];
	// types: a bean { levels: map<int, string> }, like SettlementBasicData.settlementLevelMap
	b.u32(1);
	b.u8(SparkType.Bean);
	b.u32(0xaaaa);
	b.cString('SettlementData');
	b.u32(1);
	b.cString('levels');
	b.u8(SparkType.Map);
	b.u8(SparkType.Int);
	b.u8(SparkType.String);
	// root
	b.patch(header[1], b.pos);
	b.u8(SparkType.Map);
	b.cString('SettlementTable');
	b.u8(SparkType.String);
	b.u8(SparkType.Bean);
	b.u32(0xaaaa);
	const key = b.cString('stm_hongs_2');
	const first = b.cString('f1m19d1');
	const second = b.cString('f1m19d2');
	// the field's map: two slots, the second holding two entries
	const nested = b.u32(2);
	const slots = [b.u32(0), b.u32(0), b.u32(0), b.u32(2)];
	b.patch(slots[2], b.pos);
	b.u32(1);
	b.u32(first);
	b.u32(2);
	b.u32(second);
	const bean = b.u32(nested);
	// data
	b.patch(header[2], b.pos);
	b.u32(1);
	const slot = b.u32(0);
	b.u32(1);
	b.patch(slot, b.pos);
	b.u32(key);
	b.u32(bean);
	assert.deepEqual(parseSparkTable(new Uint8Array(b.bytes)).entries, [
		['stm_hongs_2', { levels: { 1: 'f1m19d1', 2: 'f1m19d2' } }],
	]);
});

test('decodes bool, byte, float and double fields with natural alignment', () => {
	const b = new Buffer();
	const header = [b.u32(12), b.u32(0), b.u32(0)];
	// types: a bean { flag: bool, count: byte, scale: float, weight: double }
	b.u32(1);
	b.u8(SparkType.Bean);
	b.u32(0xaaaa);
	b.cString('DungeonData');
	b.u32(4);
	b.cString('flag');
	b.u8(SparkType.Bool);
	b.cString('count');
	b.u8(SparkType.Byte);
	b.cString('scale');
	b.u8(SparkType.Float);
	b.cString('weight');
	b.u8(SparkType.Double);
	// root
	b.patch(header[1], b.pos);
	b.u8(SparkType.Map);
	b.cString('DungeonTable');
	b.u8(SparkType.Int);
	b.u8(SparkType.Bean);
	b.u32(0xaaaa);
	// values: bool and byte share the first word, the double starts on the next 8-byte boundary
	b.align(8);
	const bean = b.pos;
	b.u8(1);
	b.u8(7);
	b.f32(0.5);
	b.f64(2.25);
	// data
	b.patch(header[2], b.u32(1));
	const slot = b.u32(0);
	b.u32(1);
	b.patch(slot, b.pos);
	b.u32(3);
	b.u32(bean);
	assert.deepEqual(parseSparkTable(new Uint8Array(b.bytes)).entries, [
		[3, { flag: true, count: 7, scale: 0.5, weight: 2.25 }],
	]);
});

test('rejects unsupported field types', () => {
	assert.throws(() => parseSparkTable(buildBeanTable(42)), /unsupported spark type 42 in LevelDescData\.id/);
});

test('reads byte-sized booleans before aligned fields and rejects invalid values', () => {
	const b = new Buffer();
	const header = [b.u32(12), b.u32(0), b.u32(0)];
	b.u32(1);
	b.u8(SparkType.Bean);
	b.u32(1);
	b.cString('Filter');
	b.u32(2);
	b.cString('enabled');
	b.u8(SparkType.Bool);
	b.cString('order');
	b.u8(SparkType.Int);
	b.patch(header[1], b.pos);
	b.u8(SparkType.Map);
	b.cString('Filters');
	b.u8(SparkType.Int);
	b.u8(SparkType.Bean);
	b.u32(1);
	b.align(4);
	const bean = b.pos;
	b.u8(1);
	b.u32(17);
	b.patch(header[2], b.pos);
	b.u32(1);
	const slot = b.u32(0);
	b.u32(1);
	b.patch(slot, b.pos);
	b.u32(5);
	b.u32(bean);
	assert.deepEqual(parseSparkTable(new Uint8Array(b.bytes)).entries, [[5, { enabled: true, order: 17 }]]);
	b.bytes[bean] = 0;
	assert.deepEqual(parseSparkTable(new Uint8Array(b.bytes)).entries, [[5, { enabled: false, order: 17 }]]);
	b.bytes[bean] = 2;
	assert.throws(() => parseSparkTable(new Uint8Array(b.bytes)), /invalid spark boolean/);
});

test('decodes a direct bean root with nested fields and keeps root contracts strict', () => {
	const b = new Buffer();
	const header = [b.u32(12), b.u32(0), b.u32(0)];
	b.u32(2);
	b.u8(SparkType.Bean);
	b.u32(0xaaaa);
	b.cString('Settings');
	b.u32(2);
	b.cString('capacity');
	b.u8(SparkType.Int);
	b.cString('nested');
	b.u8(SparkType.Bean);
	b.u32(0xbbbb);
	b.u8(SparkType.Bean);
	b.u32(0xbbbb);
	b.cString('Nested');
	b.u32(1);
	b.cString('rate');
	b.u8(SparkType.Float);
	b.patch(header[1], b.pos);
	b.u8(SparkType.Bean);
	b.cString('Settings');
	b.u32(0xaaaa);
	b.align(4);
	const nested = b.pos;
	b.f32(0.5);
	b.patch(header[2], b.pos);
	b.u32(8);
	b.u32(nested);
	const bytes = new Uint8Array(b.bytes);
	assert.deepEqual(parseSparkBean(bytes), {
		name: 'Settings',
		value: { capacity: 8, nested: { rate: 0.5 } },
	});
	assert.throws(() => parseSparkTable(bytes), /expected spark map root/);
	assert.throws(() => parseSparkBean(buildBeanTable()), /expected spark bean root/);
	b.patch(header[1] + 4, 0xffffffff);
	assert.throws(() => parseSparkBean(new Uint8Array(b.bytes)), /spark|bounds|range/i);
});
