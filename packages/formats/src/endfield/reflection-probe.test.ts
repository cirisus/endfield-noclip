import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MonoComponentType, type MonoObject, type MonoValue } from './mono-objects.ts';
import { readReflectionProbe, ReflectionProbeShapeType } from './reflection-probe.ts';

const floatsBlob = (values: number[]): Uint8Array => {
	const bytes = new Uint8Array(values.length * 4);
	const view = new DataView(bytes.buffer);
	for (let i = 0; i < values.length; i++) {
		view.setFloat32(i * 4, values[i], true);
	}
	return bytes;
};

describe('readReflectionProbe', () => {
	it('returns undefined when the object has no ReflectionProbe component', () => {
		const object: MonoObject = { id: 1, name: 'other', components: [] };
		assert.equal(readReflectionProbe(object), undefined);
	});

	it('decodes box probe fields, column-major matrices, and mode-selected SH', () => {
		const bit = 16;
		const key = (field: number): number => (bit << 24) | (field << 16);
		const trs = [150, 0, 0, 0, 0, 60, 0, 0, 0, 0, 110, 0, -898, 293, 425, 1];
		const trInv = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 898, -293, -425, 1];
		const sh = Array.from({ length: 27 }, (_, i) => i * 0.01);
		const fields = new Map<number, MonoValue>([
			[key(0), { type: 'vector3', value: [300, 120, 220] }],
			[key(3), { type: 'vector3', value: [0.9, 0.9, 0.9] }],
			[key(4), { type: 'blob', value: floatsBlob(trs) }],
			[key(5), { type: 'blob', value: floatsBlob(trInv) }],
			[key(6), { type: 'float', value: 1.25 }],
			[key(7), { type: 'bool', value: true }],
			[key(8), { type: 'int', value: 2 }],
			[key(9), { type: 'int', value: 5 }],
			[key(11), { type: 'blob', value: floatsBlob(sh) }],
			[key(12), { type: 'string', value: 'Assets/ReflectionProbe-1.exr' }],
			[key(13), { type: 'int', value: ReflectionProbeShapeType.Box }],
			[key(15), { type: 'vector3', value: [150, 60, 110] }],
			[key(17), { type: 'uint64', value: 0x1234n }],
		]);
		const probe = readReflectionProbe({
			id: 42,
			name: 'rp_test#7_2A',
			components: [{ type: MonoComponentType.ReflectionProbe, fields }],
		});
		assert.ok(probe !== undefined);
		assert.equal(probe.id, 42);
		assert.deepEqual(probe.size, [300, 120, 220]);
		assert.deepEqual(probe.center, [-898, 293, 425]);
		assert.deepEqual(probe.boundsExtents, [150, 60, 110]);
		assert.deepEqual(probe.worldToLocal, [1, 0, 0, 898, 0, 1, 0, -293, 0, 0, 1, -425]);
		assert.equal(probe.intensity, 1.25);
		assert.equal(probe.boxProjection, true);
		assert.equal(probe.importance, 5);
		assert.equal(probe.shape, ReflectionProbeShapeType.Box);
		assert.equal(probe.sh?.length, 27);
		assert.equal(probe.texturePath, 'Assets/ReflectionProbe-1.exr');
		assert.equal(probe.textureHash, 0x1234n);
	});
});
