import { FormatError } from '../binary/binary-reader.ts';
import { ByteView } from '../binary/byte-view.ts';
import { decodeLz4Block } from '../binary/lz4.ts';

// USPC v1 string pools (`Data/Json/StringPool/StringPool<n>.byte`, JsonData group). pooled JsonData payloads
// (LevelConfig, LevelData) store i32 string ids instead of strings. layout per Variante/endfield_research_kit
// (MIT, `scene_string_pool.py`).
//
//   block 0 only: u32 blockFileCount
//   u32 magic 'USPC', u32 version (1), u32 flags (1 = LZ4), u32 count, u32 rawSize, u32 packedSize, body
//   raw body: u32 count, count × u32 offset, count × (u32 byteLength ‖ UTF-8)

const MAGIC = 0x43505355;

/** native string ids with special meaning */
export const StringId = {
	Null: -2,
	Empty: -1,
} as const;

/** one decoded string-pool block whose entries are UTF-8-decoded on demand */
export class StringPoolBlock {
	readonly #view: ByteView;
	readonly #dataStart: number;
	/** number of strings in this block */
	readonly length: number;

	/**
	 * @param view decompressed block body (`u32 count ‖ count × u32 offset ‖ entries`)
	 * @param length number of strings in the block
	 */
	constructor(view: ByteView, length: number) {
		this.#view = view;
		this.length = length;
		this.#dataStart = 4 + length * 4;
	}

	/**
	 * @param index 0-based index within the block
	 * @returns the string, or `undefined` if `index` is out of range
	 */
	get(index: number): string | undefined {
		if (index < 0 || index >= this.length) {
			return undefined;
		}
		const at = this.#dataStart + this.#view.u32(4 + index * 4);
		const size = this.#view.u32(at);
		return this.#view.utf8(at + 4, size);
	}
}

/**
 * decodes and validates one pool block file; strings are decoded lazily via {@link StringPoolBlock.get}
 *
 * @param bytes the `.byte` file
 * @param options.first whether this is `StringPool0.byte`, which carries a leading block count
 * @returns the validated block
 * @throws {FormatError} on framing errors
 */
export const parseStringPoolBlock = (bytes: Uint8Array, options: { first: boolean }): StringPoolBlock => {
	if (options.first && bytes.length < 4) {
		throw new FormatError('string pool block is too short');
	}
	const body = options.first ? bytes.subarray(4) : bytes;
	if (body.length < 24) {
		throw new FormatError('string pool block is too short');
	}
	const head = new ByteView(body, 'string pool header');
	const magic = head.u32(0);
	const version = head.u32(4);
	const flags = head.u32(8);
	const count = head.u32(12);
	const rawSize = head.u32(16);
	const packedSize = head.u32(20);
	if (magic !== MAGIC || version !== 1 || (flags !== 0 && flags !== 1) || body.length !== packedSize + 24) {
		throw new FormatError('unsupported string pool header');
	}
	const raw = flags === 1 ? decodeLz4Block(body.subarray(24), rawSize) : body.subarray(24);
	const view = new ByteView(raw, 'string pool');
	if (raw.length !== rawSize || raw.length < 4 || view.u32(0) !== count) {
		throw new FormatError('string pool count or size mismatch');
	}

	const dataStart = 4 + count * 4;
	if (dataStart > raw.length) {
		throw new FormatError('string pool offset table overruns its block');
	}
	let cursor = dataStart;
	for (let i = 0; i < count; i++) {
		if (dataStart + view.u32(4 + i * 4) !== cursor) {
			throw new FormatError(`string pool entry ${i} is out of sequence`);
		}
		if (cursor + 4 > raw.length) {
			throw new FormatError(`string pool entry ${i} overruns its block`);
		}
		const size = view.u32(cursor);
		cursor += 4;
		if (cursor + size > raw.length) {
			throw new FormatError(`string pool entry ${i} overruns its block`);
		}
		cursor += size;
	}
	if (cursor !== raw.length) {
		throw new FormatError('string pool block has trailing bytes');
	}
	return new StringPoolBlock(view, count);
};

/**
 * resolves pooled string ids. every block holds as many strings as block 0, so id `i` lives in block `⌊i /
 * blockSize⌋`.
 */
export class StringPool {
	readonly #blocks: readonly (StringPoolBlock | readonly string[])[];

	/** @param blocks decoded blocks in file-number order */
	constructor(blocks: readonly (StringPoolBlock | readonly string[])[]) {
		if (blocks.length === 0) {
			throw new FormatError('string pool needs at least one block');
		}
		this.#blocks = blocks;
	}

	/**
	 * @param id pooled string id
	 * @returns the string, `null` for {@link StringId.Null}, `''` for {@link StringId.Empty}
	 * @throws {FormatError} if the id isn't in the pool
	 */
	get(id: number): string | null {
		if (id === StringId.Null) {
			return null;
		}
		if (id === StringId.Empty) {
			return '';
		}
		const size = this.#blocks[0].length;
		let value: string | undefined;
		if (id >= 0 && size > 0) {
			const block = this.#blocks[Math.floor(id / size)];
			if (block !== undefined) {
				const index = id % size;
				value = block instanceof StringPoolBlock ? block.get(index) : block[index];
			}
		}
		if (value === undefined) {
			throw new FormatError(`string id ${id} is not in the pool`);
		}
		return value;
	}
}
