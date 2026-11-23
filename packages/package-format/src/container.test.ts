import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
	checkStride,
	decodeContainer,
	decodeSparseSection,
	encodeContainer,
	encodeSparseSection,
	fourcc,
	fourccName,
	requireSection,
	sectionF32,
	sectionU32,
} from './container.ts';
import { PackageFormatError } from './errors.ts';

const MAGIC = fourcc('EFT2');
const TAG_HEAD = fourcc('HEAD');
const TAG_DATA = fourcc('DATA');
const TAG_OPT = fourcc('OPTN');
const TAG_REQ = fourcc('REQN');

describe('TLV container', () => {
	it('round-trips sections with 16-byte alignment and zero-copy views', () => {
		const floats = new Float32Array([1.5, -2.25, 3.75, 4.0]);
		const bytes = encodeContainer({
			magic: MAGIC,
			majorVersion: 2,
			flags: 3,
			sections: [
				{ tag: TAG_HEAD, required: true, data: new Uint8Array([1, 2, 3]) },
				{
					tag: TAG_DATA,
					required: true,
					data: new Uint8Array(floats.buffer),
					count: 4,
					stride: 4,
				},
			],
		});
		const decoded = decodeContainer(bytes, {
			magic: MAGIC,
			majorVersion: 2,
			knownTags: new Set([TAG_HEAD, TAG_DATA]),
			label: 'test container',
		});
		assert.equal(decoded.majorVersion, 2);
		assert.equal(decoded.flags, 3);
		const head = requireSection(decoded, TAG_HEAD, 'test container');
		assert.equal(head.offset % 16, 0);
		assert.deepEqual([...head.data], [1, 2, 3]);
		const data = requireSection(decoded, TAG_DATA, 'test container');
		assert.equal(data.offset % 16, 0);
		const view = sectionF32(data);
		assert.equal(view.buffer, bytes.buffer);
		assert.deepEqual([...view], [1.5, -2.25, 3.75, 4.0]);
	});

	it('skips unknown optional sections and rejects unknown required sections', () => {
		const withOptional = encodeContainer({
			magic: MAGIC,
			majorVersion: 2,
			sections: [
				{ tag: TAG_HEAD, required: true, data: new Uint8Array(4) },
				{ tag: TAG_OPT, required: false, data: new Uint8Array([9, 8, 7]) },
			],
		});
		const decoded = decodeContainer(withOptional, {
			magic: MAGIC,
			majorVersion: 2,
			knownTags: new Set([TAG_HEAD]),
			label: 'test container',
		});
		assert.equal(decoded.sections.has(TAG_HEAD), true);
		assert.equal(decoded.sections.has(TAG_OPT), false);

		const withRequired = encodeContainer({
			magic: MAGIC,
			majorVersion: 2,
			sections: [
				{ tag: TAG_HEAD, required: true, data: new Uint8Array(4) },
				{ tag: TAG_REQ, required: true, data: new Uint8Array(4) },
			],
		});
		assert.throws(
			() =>
				decodeContainer(withRequired, {
					magic: MAGIC,
					majorVersion: 2,
					knownTags: new Set([TAG_HEAD]),
					label: 'test container',
				}),
			(err: unknown) =>
				err instanceof PackageFormatError && /unknown required section 'REQN'/.test(err.message),
		);
	});

	it('accepts grown fixed-stride records and rejects shrunk ones', () => {
		const grown = encodeContainer({
			magic: MAGIC,
			majorVersion: 2,
			sections: [{ tag: TAG_DATA, required: true, data: new Uint8Array(2 * 24), count: 2, stride: 24 }],
		});
		const decoded = decodeContainer(grown, {
			magic: MAGIC,
			majorVersion: 2,
			knownTags: new Set([TAG_DATA]),
			label: 'test container',
		});
		const section = requireSection(decoded, TAG_DATA, 'test container');
		checkStride(section, 16, 'DATA');
		assert.throws(() => checkStride(section, 32, 'DATA'), PackageFormatError);
	});

	it('copies when reading typed-array sections from unaligned outer buffers', () => {
		const ints = new Uint32Array([10, 20, 30]);
		const bytes = encodeContainer({
			magic: MAGIC,
			majorVersion: 2,
			sections: [{ tag: TAG_DATA, required: true, data: new Uint8Array(ints.buffer), count: 3, stride: 4 }],
		});
		const shifted = new Uint8Array(bytes.length + 1);
		shifted.set(bytes, 1);
		const decoded = decodeContainer(shifted.subarray(1), {
			magic: MAGIC,
			majorVersion: 2,
			knownTags: new Set([TAG_DATA]),
			label: 'test container',
		});
		const view = sectionU32(requireSection(decoded, TAG_DATA, 'test container'));
		assert.deepEqual([...view], [10, 20, 30]);
	});

	it('encodes and decodes sparse row sections with ascending validation', () => {
		const rows = new Uint32Array([1, 4, 9]);
		const vals = new Float32Array([1, 2, 3, 4, 5, 6]);
		const payload = encodeSparseSection(rows, new Uint8Array(vals.buffer), 8);
		const bytes = encodeContainer({
			magic: MAGIC,
			majorVersion: 2,
			sections: [{ tag: TAG_DATA, data: payload, count: rows.length, stride: 8 }],
		});
		const decoded = decodeContainer(bytes, {
			magic: MAGIC,
			majorVersion: 2,
			knownTags: new Set([TAG_DATA]),
			label: 'test container',
		});
		const sparse = decodeSparseSection(requireSection(decoded, TAG_DATA, 'test container'), 8, 10, 'DATA');
		assert.deepEqual([...sparse.rows], [1, 4, 9]);
		assert.equal(sparse.stride, 8);
		assert.deepEqual(
			[...new Float32Array(sparse.values.buffer, sparse.values.byteOffset, sparse.values.byteLength / 4)],
			[1, 2, 3, 4, 5, 6],
		);
		assert.throws(
			() => decodeSparseSection(requireSection(decoded, TAG_DATA, 'test container'), 8, 9, 'DATA'),
			PackageFormatError,
		);
	});

	it('round-trips fourcc names', () => {
		assert.equal(fourccName(fourcc('EFIN')), 'EFIN');
		assert.throws(() => fourcc('AB'), RangeError);
	});
});
