import assert from 'node:assert/strict';
import { test } from 'node:test';

import { readEcsCollider } from './ecs-collider.ts';

const fixture = (kind: number) => {
	const bytes: number[] = [];
	const word = (value: number, float = false) => {
		const b = new Uint8Array(4),
			view = new DataView(b.buffer);
		if (float) {
			view.setFloat32(0, value, true);
		} else {
			view.setUint32(0, value, true);
		}
		bytes.push(...b);
	};
	const floats = (...values: number[]) => values.forEach((v) => word(v, true));
	const words = (...values: number[]) => values.forEach((v) => word(v));
	floats(10, 20, 30, 0, 0, 0, 1);
	words(kind, 6, 7);
	return { floats, words, bytes: () => Uint8Array.from(bytes) };
};

test('retains actor transform and distinguishes enabled, trigger and disabled primitives', () => {
	const f = fixture(1);
	f.floats(2, 3, 4);
	f.words(123, 456, 3 | (9 << 2), 789);
	const actor = readEcsCollider(f.bytes());
	assert.deepEqual(actor.position, [10, 20, 30]);
	assert.equal(actor.layer, 6);
	assert.deepEqual(actor.shapes[0], {
		kind: 'box',
		position: [0, 0, 0],
		rotation: [0, 0, 0, 1],
		halfExtents: [2, 3, 4],
		options: 123,
		tag: 456,
		flags: 39,
		enabled: true,
		trigger: true,
		surface: 9,
		extra: 789,
	});
	const disabled = f.bytes();
	new DataView(disabled.buffer).setUint32(60, 0, true);
	assert.equal(readEcsCollider(disabled).shapes[0].enabled, false);
});

test('preserves compound mesh ordering and local poses across all shape sections', () => {
	const f = fixture(5);
	f.words(1, 1, 1, 1, 1, 1);
	f.words(11, 12, 13);
	f.floats(1, 2, 3);
	f.words(14);
	f.floats(1, 2, 3, 0, 0, 0, 1);
	f.words(21, 22, 1);
	f.floats(2, 3, 4);
	f.words(23);
	f.floats(4, 5, 6, 0, 0, 0, 1);
	f.words(31, 32, 1);
	f.floats(0.5, 2);
	f.words(33);
	f.floats(7, 8, 9);
	f.words(41, 42, 3);
	f.floats(0.75);
	f.words(43);
	for (const scale of [1, -1]) {
		f.floats(3, 4, 5, 0, 0, 0, 1);
		f.words(51, 52, 1, 30);
		f.floats(scale, 2, 3);
		f.words(53);
	}
	const actor = readEcsCollider(f.bytes());
	assert.equal(actor.meshCount, 3);
	assert.deepEqual(actor.complex, { mesh: 0, options: 11, tag: 12, flags: 13, scale: [1, 2, 3], extra: 14 });
	assert.deepEqual(
		actor.shapes.map((s) => s.kind),
		['box', 'capsule', 'sphere', 'mesh', 'mesh'],
	);
	assert.deepEqual(actor.shapes[1], {
		kind: 'capsule',
		position: [4, 5, 6],
		rotation: [0, 0, 0, 1],
		options: 31,
		tag: 32,
		flags: 1,
		enabled: true,
		trigger: false,
		surface: 0,
		radius: 0.5,
		cylinderLength: 2,
		extra: 33,
	});
	assert.deepEqual(
		actor.shapes.filter((s) => s.kind === 'mesh').map((s) => [s.mesh, s.convex, s.scale[0]]),
		[
			[1, false, 1],
			[2, true, -1],
		],
	);
});

test('separates terrain inputs and refuses truncated, unsupported or malformed collider data', () => {
	const f = fixture(6);
	f.words(0, 0, 1);
	f.floats(1, 256, 1);
	assert.deepEqual(readEcsCollider(f.bytes()).terrain?.scale, [1, 256, 1]);
	for (let n = 0; n < f.bytes().length; n++) {
		assert.throws(() => readEcsCollider(f.bytes().subarray(0, n)));
	}
	assert.throws(() => readEcsCollider(Uint8Array.from([...f.bytes(), 0])), /trailing/);
	for (const [offset, value] of [
		[28, 99],
		[32, 32],
		[0, 0x7f800000],
		[24, 0],
		[52, 0xbf800000],
	]) {
		const b = f.bytes();
		new DataView(b.buffer).setUint32(offset, value, true);
		assert.throws(() => readEcsCollider(b));
	}
	const compound = fixture(5);
	compound.words(0, 0xffffffff, 0, 0, 0, 0);
	assert.throws(() => readEcsCollider(compound.bytes()), /counts/);
});
