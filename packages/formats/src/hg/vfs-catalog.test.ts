import assert from 'node:assert/strict';
import { test } from 'node:test';

import { chacha20 } from '@noble/ciphers/chacha.js';

import { FormatError, fromHex } from '../binary/binary-reader.ts';

import { decryptVfsFileSliceInPlace, parseVfsCatalog } from './vfs-catalog.ts';

const TEST_KEY = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const utf8 = new TextEncoder();

interface SyntheticFile {
	name: string;
	chunkMd5?: string;
	dataMd5: string;
	offset: number;
	length: number;
	blockType: number;
	ivSeed: bigint | null;
}

interface SyntheticChunk {
	md5: string;
	length: number;
	files: SyntheticFile[];
}

const buildCatalog = (options: {
	version?: number;
	codeVersion?: number;
	groupName: string;
	groupHash: string;
	blockType: number;
	chunks: SyntheticChunk[];
}): Uint8Array => {
	const version = options.version ?? 1;
	const codeVersion = options.codeVersion ?? 5;
	const tagLength = codeVersion === 5 ? 8 : 4;
	const buf = new Uint8Array(4096);
	const view = new DataView(buf.buffer);
	let at = 0;
	const writeShortString = (value: string): void => {
		const encoded = utf8.encode(value);
		view.setInt16(at, encoded.length, true);
		at += 2;
		buf.set(encoded, at);
		at += encoded.length;
	};

	view.setUint32(at, version, true);
	at = 12;
	view.setUint32(at, codeVersion, true);
	at += 8;
	writeShortString(options.groupName);
	buf.set(fromHex(options.groupHash), at);
	at += 8;

	const fileCount = options.chunks.reduce((sum, chunk) => sum + chunk.files.length, 0);
	const chunksLength = options.chunks.reduce((sum, chunk) => sum + chunk.length, 0);
	view.setInt32(at, fileCount, true);
	at += 4;
	view.setBigInt64(at, BigInt(chunksLength), true);
	at += 8;
	buf[at++] = options.blockType;
	view.setInt32(at, options.chunks.length, true);
	at += 4;

	for (const chunk of options.chunks) {
		buf.set(fromHex(chunk.md5), at);
		at += 32;
		view.setBigInt64(at, BigInt(chunk.length), true);
		at += 8;
		buf[at++] = options.blockType;
		at += tagLength;
		view.setInt32(at, chunk.files.length, true);
		at += 4;
		for (const file of chunk.files) {
			writeShortString(file.name);
			at += 8;
			buf.set(fromHex(file.chunkMd5 ?? chunk.md5), at);
			at += 16;
			buf.set(fromHex(file.dataMd5), at);
			at += 16;
			view.setBigInt64(at, BigInt(file.offset), true);
			at += 8;
			view.setBigInt64(at, BigInt(file.length), true);
			at += 8;
			buf[at++] = file.blockType;
			buf[at++] = file.ivSeed === null ? 0 : 1;
			if (file.ivSeed !== null) {
				view.setBigInt64(at, file.ivSeed, true);
				at += 8;
			}
			at += tagLength;
		}
	}

	const raw = buf.slice(0, at);
	chacha20(TEST_KEY, raw.subarray(0, 12), raw.subarray(12), raw.subarray(12), 1);
	return raw;
};

test('parseVfsCatalog decodes headers and lazily resolves entries', () => {
	const chunkMd5 = '0123456789ABCDEF0123456789ABCDEF';
	const otherChunkMd5 = 'FEDCBA9876543210FEDCBA9876543210';
	const dataMd5A = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
	const dataMd5B = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
	const raw = buildCatalog({
		version: 3,
		codeVersion: 5,
		groupName: 'Bundle',
		groupHash: '7064D8E2',
		blockType: 11,
		chunks: [
			{
				md5: chunkMd5,
				length: 4096,
				files: [
					{
						name: 'Data/Bundles/Windows/main/a.ab',
						dataMd5: dataMd5A,
						offset: 0,
						length: 1024,
						blockType: 11,
						ivSeed: null,
					},
					{
						name: 'Data/Bundles/Windows/main/b.ab',
						chunkMd5: otherChunkMd5,
						dataMd5: dataMd5B,
						offset: 1024,
						length: 512,
						blockType: 11,
						ivSeed: 0x1234_5678_9abc_def0n,
					},
				],
			},
		],
	});

	const catalog = parseVfsCatalog(raw, TEST_KEY);
	assert.equal(catalog.version, 3);
	assert.equal(catalog.groupName, 'Bundle');
	assert.equal(catalog.groupHash, '7064D8E2');
	assert.equal(catalog.blockType, 11);
	assert.equal(catalog.fileCount, 2);
	assert.equal(catalog.chunksLength, 4096);
	assert.equal(catalog.has('Data/Bundles/Windows/main/a.ab'), true);
	assert.equal(catalog.has('missing'), false);
	assert.equal(catalog.get('missing'), undefined);
	assert.deepEqual(
		[...catalog.names()],
		['Data/Bundles/Windows/main/a.ab', 'Data/Bundles/Windows/main/b.ab'],
	);
	assert.deepEqual(catalog.get('Data/Bundles/Windows/main/a.ab'), {
		name: 'Data/Bundles/Windows/main/a.ab',
		chunkMd5,
		dataMd5: dataMd5A,
		offset: 0,
		length: 1024,
		blockType: 11,
		ivSeed: null,
	});
	assert.deepEqual(catalog.get('Data/Bundles/Windows/main/b.ab'), {
		name: 'Data/Bundles/Windows/main/b.ab',
		chunkMd5: otherChunkMd5,
		dataMd5: dataMd5B,
		offset: 1024,
		length: 512,
		blockType: 11,
		ivSeed: 0x1234_5678_9abc_def0n,
	});
	assert.equal([...catalog].length, 2);
});

test('parseVfsCatalog supports codeVersion 4 and rejects bad keys or out-of-bounds entries', () => {
	const chunkMd5 = '0123456789ABCDEF0123456789ABCDEF';
	const dataMd5 = 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';
	const raw = buildCatalog({
		codeVersion: 4,
		groupName: 'Table',
		groupHash: '42A8FCA6',
		blockType: 2,
		chunks: [
			{
				md5: chunkMd5,
				length: 100,
				files: [{ name: 'a.bytes', dataMd5, offset: 0, length: 100, blockType: 2, ivSeed: 42n }],
			},
		],
	});
	const catalog = parseVfsCatalog(raw, TEST_KEY);
	assert.equal(catalog.get('a.bytes')?.ivSeed, 42n);

	const wrongKey = new Uint8Array(32).fill(0xff);
	assert.throws(() => parseVfsCatalog(raw, wrongKey), FormatError);

	const overrun = buildCatalog({
		groupName: 'Table',
		groupHash: '42A8FCA6',
		blockType: 2,
		chunks: [
			{
				md5: chunkMd5,
				length: 50,
				files: [{ name: 'a.bytes', dataMd5, offset: 10, length: 50, blockType: 2, ivSeed: null }],
			},
		],
	});
	assert.throws(() => parseVfsCatalog(overrun, TEST_KEY), FormatError);
});

test('decryptVfsFileSliceInPlace is seekable on 64-byte boundaries', () => {
	const plain = Uint8Array.from({ length: 192 }, (_, i) => i);
	const cipher = plain.slice();
	decryptVfsFileSliceInPlace(cipher, { position: 0, key: TEST_KEY, version: 2, ivSeed: 99n });

	const slice = cipher.slice(64, 150);
	decryptVfsFileSliceInPlace(slice, { position: 64, key: TEST_KEY, version: 2, ivSeed: 99n });
	assert.deepEqual(slice, plain.subarray(64, 150));

	assert.throws(
		() => decryptVfsFileSliceInPlace(slice, { position: 32, key: TEST_KEY, version: 2, ivSeed: 99n }),
		FormatError,
	);
});
