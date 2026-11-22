import { chacha20 } from '@noble/ciphers/chacha.js';

import { BinaryReader, FormatError, toHex } from '../binary/binary-reader.ts';
import { ByteView } from '../binary/byte-view.ts';

// #region types

/** one logical file stored inside a `.chk` chunk */
export interface VfsFileEntry {
	/** logical path, e.g. `Data/Streaming/PC/map02/Streaming/InitChunkData_0_0_0_0.bytes` */
	name: string;
	/** md5 name of the chunk holding the bytes, i.e. `<chunkMd5>.chk` */
	chunkMd5: string;
	/** md5 of the logical file's decrypted bytes, uppercase hex */
	dataMd5: string;
	offset: number;
	length: number;
	blockType: number;
	/** per-file ChaCha20 seed; `null` when the file is stored in the clear */
	ivSeed: bigint | null;
}

/** XORs `input` with a ChaCha20 keystream starting at `counter`, writing to `output` (which may alias `input`) */
export type ChaCha20Cipher = (
	key: Uint8Array,
	nonce: Uint8Array,
	counter: number,
	input: Uint8Array,
	output: Uint8Array,
) => void;

/** where a slice sits in an encrypted logical file, and the file's key material */
export interface VfsSliceCipher {
	/** offset of the slice within the logical file; must be a multiple of 64 */
	position: number;
	/** 32-byte VFS key */
	key: Uint8Array;
	/** catalog version */
	version: number;
	/** the entry's seed */
	ivSeed: bigint;
}

// #endregion

/** bytes before the encrypted body: `u32 version ‖ 8 bytes`, which together form the nonce */
const CATALOG_HEAD_LENGTH = 12;

/** sentinel in `#entryChunk` when a file's chunk md5 differs from its enclosing chunk's */
const FOREIGN_CHUNK = 0xffffffff;

const defaultChaCha20: ChaCha20Cipher = (key, nonce, counter, input, output) => {
	chacha20(key, nonce, input, output, counter);
};

/**
 * a decrypted `<group>.blc` catalog, the game's `VFBlockMainInfo`. the game calls a group a VFS block; this
 * project says group because "block" already names several other layers.
 *
 * entries are indexed by logical path during parsing and decoded on demand from the decrypted catalog bytes,
 * so mounting a large catalog (such as `Bundle`) avoids allocating per-file objects, MD5 hex strings, and
 * `bigint` seeds for untouched files.
 */
export class VfsCatalog {
	/** catalog version; also forms part of per-file nonces */
	readonly version: number;
	/** human name (`groupCfgName`), e.g. `Bundle`, `Streaming` */
	readonly groupName: string;
	/** 8 hex digits, matching the directory name */
	readonly groupHash: string;
	/** the group's `EVFSBlockType` value, e.g. 11 for `Bundle`; chunks and files repeat it */
	readonly blockType: number;
	readonly fileCount: number;
	readonly chunksLength: number;

	readonly #view: ByteView;
	readonly #chunkMd5s: string[];
	readonly #files: Map<string, number>;
	readonly #entryChunk: Uint32Array;
	readonly #entryDataOffset: Uint32Array;

	/**
	 * @param fields validated catalog header and index tables; construct via {@link parseVfsCatalog}
	 * @internal
	 */
	constructor(fields: {
		version: number;
		groupName: string;
		groupHash: string;
		blockType: number;
		fileCount: number;
		chunksLength: number;
		plain: Uint8Array;
		chunkMd5s: string[];
		files: Map<string, number>;
		entryChunk: Uint32Array;
		entryDataOffset: Uint32Array;
	}) {
		this.version = fields.version;
		this.groupName = fields.groupName;
		this.groupHash = fields.groupHash;
		this.blockType = fields.blockType;
		this.fileCount = fields.fileCount;
		this.chunksLength = fields.chunksLength;
		this.#view = new ByteView(fields.plain, 'vfs catalog');
		this.#chunkMd5s = fields.chunkMd5s;
		this.#files = fields.files;
		this.#entryChunk = fields.entryChunk;
		this.#entryDataOffset = fields.entryDataOffset;
	}

	/**
	 * @param name logical file path
	 * @returns whether the catalog lists a file with that path
	 */
	has(name: string): boolean {
		return this.#files.has(name);
	}

	/**
	 * @param name logical file path
	 * @returns the decoded entry, or `undefined` if absent
	 */
	get(name: string): VfsFileEntry | undefined {
		const index = this.#files.get(name);
		return index === undefined ? undefined : this.#entry(name, index);
	}

	/** @returns an iterator over every logical file path in catalog order */
	names(): MapIterator<string> {
		return this.#files.keys();
	}

	/** yields every file entry in catalog order */
	*entries(): Generator<VfsFileEntry> {
		for (const [name, index] of this.#files) {
			yield this.#entry(name, index);
		}
	}

	/** @see entries */
	[Symbol.iterator](): Generator<VfsFileEntry> {
		return this.entries();
	}

	#entry(name: string, index: number): VfsFileEntry {
		const at = this.#entryDataOffset[index];
		const chunkIndex = this.#entryChunk[index];
		const chunkMd5 =
			chunkIndex === FOREIGN_CHUNK ? toHex(this.#view.subarray(at, 16)) : this.#chunkMd5s[chunkIndex];
		const dataMd5 = toHex(this.#view.subarray(at + 16, 16));
		const offset = this.#view.i64Number(at + 32);
		const length = this.#view.i64Number(at + 40);
		const blockType = this.#view.u8(at + 48);
		const ivSeed = this.#view.u8(at + 49) !== 0 ? this.#view.i64(at + 50) : null;
		return { name, chunkMd5, dataMd5, offset, length, blockType, ivSeed };
	}
}

/**
 * decrypts and parses a `.blc` catalog.
 *
 * @param raw entire `.blc` file
 * @param key 32-byte VFS ChaCha20 key
 * @param options.chacha20 optional ChaCha20 implementation (defaults to the pure-JS fallback)
 * @returns the parsed catalog
 * @throws {FormatError} if the key is wrong or the layout is unrecognized
 */
export const parseVfsCatalog = (
	raw: Uint8Array,
	key: Uint8Array,
	options?: { chacha20?: ChaCha20Cipher },
): VfsCatalog => {
	if (key.length !== 32) {
		throw new FormatError('vfs key must be 32 bytes');
	}
	if (raw.length <= CATALOG_HEAD_LENGTH) {
		throw new FormatError('vfs catalog is too short');
	}

	const plain = new Uint8Array(raw.length);
	plain.set(raw.subarray(0, CATALOG_HEAD_LENGTH));
	const decrypt = options?.chacha20 ?? defaultChaCha20;
	decrypt(
		key,
		raw.subarray(0, CATALOG_HEAD_LENGTH),
		1,
		raw.subarray(CATALOG_HEAD_LENGTH),
		plain.subarray(CATALOG_HEAD_LENGTH),
	);

	const r = new BinaryReader(plain, { littleEndian: true });
	const version = r.u32();
	if (version === 0 || version > 100) {
		throw new FormatError(`unexpected vfs catalog version ${version}`);
	}
	r.offset = CATALOG_HEAD_LENGTH;

	// the game's `codeVersion`; 5 widens each chunk's and file's tag (`VFSFileTag`) from a 4-byte legacy value
	// to 8 bytes. the tags aren't needed to read files, so they're skipped
	const codeVersion = r.u32();
	if (codeVersion !== 4 && codeVersion !== 5) {
		throw new FormatError(`unknown vfs catalog code version ${codeVersion}; is the key correct?`);
	}
	const tagLength = codeVersion === 5 ? 8 : 4;
	r.skip(4);

	const groupName = readShortString(r);
	const groupHash = toHex(r.bytesView(8).subarray(0, 4));
	const fileCount = r.i32();
	const chunksLength = r.i64Number();
	const blockType = r.u8();
	const chunkCount = r.i32();
	if (fileCount < 0 || chunkCount < 0 || chunkCount > 100_000) {
		throw new FormatError(`implausible vfs catalog counts: ${fileCount} files, ${chunkCount} chunks`);
	}

	const chunkMd5s: string[] = [];
	const files = new Map<string, number>();
	const entryChunk = new Uint32Array(fileCount);
	const entryDataOffset = new Uint32Array(fileCount);
	let parsedFiles = 0;

	for (let c = 0; c < chunkCount; c++) {
		const md5Offset = r.offset;
		r.skip(16);
		const md5 = toHex(plain.subarray(md5Offset, md5Offset + 16));
		chunkMd5s.push(md5);
		// contentMd5 isn't needed to read files
		r.skip(16);
		const length = r.i64Number();
		// chunk blockType + tag
		r.skip(1 + tagLength);

		const itemCount = r.i32();
		if (itemCount < 0) {
			throw new FormatError(`negative file count in chunk ${md5}`);
		}
		if (parsedFiles + itemCount > fileCount) {
			throw new FormatError(`vfs catalog declares ${fileCount} files but holds more`);
		}
		for (let i = 0; i < itemCount; i++) {
			const name = readShortString(r);
			// the name hash isn't needed to read files
			r.skip(8);
			const dataOffset = r.offset;
			// chunkMd5 (16) + dataMd5 (16)
			r.skip(32);
			const offset = r.i64Number();
			const fileLength = r.i64Number();
			r.skip(1);
			const encrypted = r.bool();
			if (encrypted) {
				r.skip(8);
			}
			// the file tag follows the optional seed; reading it first yields bogus nonces
			r.skip(tagLength);
			if (offset < 0 || fileLength < 0 || offset + fileLength > length) {
				throw new FormatError(`vfs entry ${name} lies outside its chunk`);
			}
			const index = parsedFiles++;
			entryChunk[index] = bytesEqual16(plain, dataOffset, md5Offset) ? c : FOREIGN_CHUNK;
			entryDataOffset[index] = dataOffset;
			files.set(name, index);
		}
	}

	if (parsedFiles !== fileCount) {
		throw new FormatError(`vfs catalog declares ${fileCount} files but holds ${parsedFiles}`);
	}
	if (r.remaining > 16) {
		throw new FormatError(`vfs catalog has ${r.remaining} trailing bytes`);
	}

	return new VfsCatalog({
		version,
		groupName,
		groupHash,
		blockType,
		fileCount,
		chunksLength,
		plain,
		chunkMd5s,
		files,
		entryChunk,
		entryDataOffset,
	});
};

/**
 * decrypts a slice of an encrypted logical file in place. ChaCha20 is seekable, so any 64-byte-aligned window
 * can be decrypted without the bytes before it.
 *
 * @param data ciphertext covering file bytes `[position, position + data.length)`; overwritten with the
 *   plaintext
 * @param cipher the slice's position and key material
 * @param options.chacha20 optional ChaCha20 implementation (defaults to the pure-JS fallback)
 * @throws {FormatError} if `position` isn't 64-byte aligned
 */
export const decryptVfsFileSliceInPlace = (
	data: Uint8Array,
	cipher: VfsSliceCipher,
	options?: { chacha20?: ChaCha20Cipher },
): void => {
	if (cipher.position % 64 !== 0) {
		throw new FormatError('vfs decryption must start on a 64-byte boundary');
	}
	const nonce = new Uint8Array(12);
	const view = new DataView(nonce.buffer);
	view.setUint32(0, cipher.version, true);
	view.setBigInt64(4, cipher.ivSeed, true);
	const decrypt = options?.chacha20 ?? defaultChaCha20;
	decrypt(cipher.key, nonce, 1 + cipher.position / 64, data, data);
};

const bytesEqual16 = (bytes: Uint8Array, a: number, b: number): boolean => {
	for (let i = 0; i < 16; i++) {
		if (bytes[a + i] !== bytes[b + i]) {
			return false;
		}
	}
	return true;
};

const readShortString = (r: BinaryReader): string => {
	const length = r.i16();
	if (length < 0) {
		throw new FormatError(`negative string length at 0x${(r.offset - 2).toString(16)}`);
	}
	return r.utf8(length);
};
