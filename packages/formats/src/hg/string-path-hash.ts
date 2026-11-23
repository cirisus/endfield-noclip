import { FormatError } from '../binary/binary-reader.ts';
import { ByteView } from '../binary/byte-view.ts';

import { hashSlot, readLengthPrefixedUtf16 } from './hash-slots.ts';

// `Data/ExtendData/Main/StringPathHash.bin` (ExtendData group) and
// `Data/ExtendData/Initial/InitStringPathHash.bin` (InitialExtendData group): stored hash table from 64-bit
// path hashes to asset/`Data/` paths (layout in docs/game-data/assets.md#lookup-tables). layout per
// Variante/endfield_research_kit (MIT, `scripts/game_data/extend_data_binary.py`).

const SLOTS_START = 8;
const BUCKET_SIZE = 16;

/** read-only view of a StringPathHash table; lookups decode only what they touch */
export class StringPathHashTable {
	readonly #view: ByteView;
	readonly #stringsOffset: number;
	#byLength: Map<number, number[]> | undefined;
	/** counts single-length scans so the full length index is only built when the table is queried repeatedly */
	#lengthScans = 0;
	/** number of slots, which is also the number of buckets and strings */
	readonly count: number;

	/**
	 * @param bytes the whole file; not copied
	 * @throws {FormatError} if the header doesn't describe the file
	 */
	constructor(bytes: Uint8Array) {
		if (bytes.length < 8) {
			throw new FormatError('string path hash file is too short');
		}
		this.#view = new ByteView(bytes, 'string path hash');
		this.#stringsOffset = this.#view.u32(0);
		this.count = this.#view.u32(4);
		if (this.#stringsOffset !== 8 + 24 * this.count || this.#stringsOffset > bytes.length) {
			throw new FormatError(`string path hash header is inconsistent (count ${this.count})`);
		}
	}

	/**
	 * @param hash path hash as stored (unsigned)
	 * @returns every distinct path stored under the hash; usually exactly one
	 * @throws {FormatError} if the table references data outside the file
	 */
	lookupAll(hash: bigint): string[] {
		const slot = hashSlot(this.#view, SLOTS_START, this.count, hash);
		const found: string[] = [];
		if (slot === undefined) {
			return found;
		}
		const view = this.#view;
		const stringsOffset = this.#stringsOffset;
		for (let i = 0; i < slot.count; i++) {
			const bucket = slot.offset + i * BUCKET_SIZE;
			if (view.u64(bucket + 4) === hash) {
				const path = readLengthPrefixedUtf16(view, stringsOffset + view.u32(bucket + 12));
				if (!found.includes(path)) {
					found.push(path);
				}
			}
		}
		return found;
	}

	/**
	 * @param hash path hash as stored (unsigned)
	 * @returns the path, or `undefined` if the hash is unknown or ambiguous
	 * @throws {FormatError} if the table references data outside the file
	 */
	lookup(hash: bigint): string | undefined {
		const found = this.lookupAll(hash);
		return found.length === 1 ? found[0] : undefined;
	}

	/**
	 * yields every `(hash, path)` bucket in slot order (repeated pairs are yielded repeatedly). when
	 * `predicate` is given, each bucket's 64-bit hash is read only for matching paths.
	 *
	 * @param predicate optional path filter
	 * @throws {FormatError} if the table references data outside the file
	 */
	*entries(predicate?: (path: string) => boolean): Generator<[hash: bigint, path: string]> {
		const view = this.#view;
		const dv = view.view;
		const stringsOffset = this.#stringsOffset;
		for (const bucket of this.#buckets()) {
			const path = readLengthPrefixedUtf16(view, stringsOffset + dv.getUint32(bucket + 12, true));
			if (predicate === undefined || predicate(path)) {
				yield [dv.getBigUint64(bucket + 4, true), path];
			}
		}
	}

	/**
	 * finds every distinct hash stored under `path`, matched case-insensitively, without decoding non-matching
	 * strings
	 *
	 * @param path asset path (caller normalizes path separators)
	 * @returns distinct hashes in slot order
	 * @throws {FormatError} if the table references data outside the file
	 */
	hashesOf(path: string): bigint[] {
		const wanted = path.toLowerCase();
		const len = wanted.length;
		const byteLength = len * 2;
		const wantedCodes = new Uint16Array(len);
		let ascii = true;
		for (let i = 0; i < len; i++) {
			const code = wanted.charCodeAt(i);
			wantedCodes[i] = code;
			if (code >= 0x80) {
				ascii = false;
			}
		}
		const view = this.#view;
		const { bytes, view: dv, length: fileLen } = view;
		const stringsOffset = this.#stringsOffset;
		const hashes: bigint[] = [];

		const checkBucket = (bucket: number, at: number): void => {
			if (ascii) {
				const start = at + 4;
				if (start + byteLength + 2 > fileLen) {
					throw new FormatError(`string path hash string at 0x${at.toString(16)} is out of bounds`);
				}
				// scan from the end: asset paths share long prefixes, so mismatches fail almost immediately
				for (let i = len - 1; i >= 0; i--) {
					const p = start + i * 2;
					let code = bytes[p] | (bytes[p + 1] << 8);
					if (code >= 65 && code <= 90) {
						code += 32;
					} else if (code >= 0x80) {
						// non-ASCII candidate can't match a pure-ASCII wanted string (unless exotic case-folding)
						if (readLengthPrefixedUtf16(view, at).toLowerCase() !== wanted) {
							return;
						}
						break;
					}
					if (code !== wantedCodes[i]) {
						return;
					}
				}
			} else if (readLengthPrefixedUtf16(view, at).toLowerCase() !== wanted) {
				return;
			}
			const hash = dv.getBigUint64(bucket + 4, true);
			if (!hashes.includes(hash)) {
				hashes.push(hash);
			}
		};

		// a single lookup scans once without allocating a full length map; repeated lookups index the table
		if (this.#byLength === undefined && this.#lengthScans === 0) {
			this.#lengthScans++;
			const slotTotal = this.count;
			for (let s = 0; s < slotTotal; s++) {
				const slotAt = SLOTS_START + s * 8;
				const offset = dv.getUint32(slotAt, true);
				const slotCount = dv.getUint32(slotAt + 4, true);
				if (slotCount === 0) {
					continue;
				}
				if (offset + slotCount * BUCKET_SIZE > fileLen) {
					throw new FormatError(`string path hash bucket at 0x${offset.toString(16)} is out of bounds`);
				}
				for (let i = 0; i < slotCount; i++) {
					const bucket = offset + i * BUCKET_SIZE;
					const at = stringsOffset + dv.getUint32(bucket + 12, true);
					if (at + 4 > fileLen) {
						throw new FormatError(`string path hash string at 0x${at.toString(16)} is out of bounds`);
					}
					if (dv.getUint32(at, true) === byteLength) {
						checkBucket(bucket, at);
					}
				}
			}
			return hashes;
		}
		for (const bucket of this.#bucketsByLength().get(byteLength) ?? []) {
			checkBucket(bucket, stringsOffset + dv.getUint32(bucket + 12, true));
		}
		return hashes;
	}

	/** yields every bucket offset in slot order after checking each non-empty slot's bounds */
	*#buckets(): Generator<number> {
		const dv = this.#view.view;
		const fileLen = this.#view.length;
		for (let s = 0; s < this.count; s++) {
			const slotAt = SLOTS_START + s * 8;
			const offset = dv.getUint32(slotAt, true);
			const count = dv.getUint32(slotAt + 4, true);
			if (count === 0) {
				continue;
			}
			if (offset + count * BUCKET_SIZE > fileLen) {
				throw new FormatError(`string path hash bucket at 0x${offset.toString(16)} is out of bounds`);
			}
			for (let i = 0; i < count; i++) {
				yield offset + i * BUCKET_SIZE;
			}
		}
	}

	/**
	 * one pass over every bucket on first indexed use, so each later scan for a path visits only the buckets
	 * whose path has its length (a few bytes per bucket)
	 *
	 * @returns bucket offsets by their path's byte length, in slot order
	 */
	#bucketsByLength(): Map<number, number[]> {
		if (this.#byLength === undefined) {
			const byLength = new Map<number, number[]>();
			const dv = this.#view.view;
			const stringsOffset = this.#stringsOffset;
			const fileLen = this.#view.length;
			const slotTotal = this.count;
			for (let s = 0; s < slotTotal; s++) {
				const slotAt = SLOTS_START + s * 8;
				const offset = dv.getUint32(slotAt, true);
				const slotCount = dv.getUint32(slotAt + 4, true);
				if (slotCount === 0) {
					continue;
				}
				if (offset + slotCount * BUCKET_SIZE > fileLen) {
					throw new FormatError(`string path hash bucket at 0x${offset.toString(16)} is out of bounds`);
				}
				for (let i = 0; i < slotCount; i++) {
					const bucket = offset + i * BUCKET_SIZE;
					const at = stringsOffset + dv.getUint32(bucket + 12, true);
					if (at + 4 > fileLen) {
						throw new FormatError(`string path hash string at 0x${at.toString(16)} is out of bounds`);
					}
					const length = dv.getUint32(at, true);
					let list = byLength.get(length);
					if (list === undefined) {
						list = [];
						byLength.set(length, list);
					}
					list.push(bucket);
				}
			}
			this.#byLength = byLength;
		}
		return this.#byLength;
	}
}
