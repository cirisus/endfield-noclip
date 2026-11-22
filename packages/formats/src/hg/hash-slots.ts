import { FormatError } from '../binary/binary-reader.ts';
import type { ByteView } from '../binary/byte-view.ts';

/** one slot of a stored hash table: where its bucket entries start and how many there are */
export interface HashSlot {
	/** as stored; what it's relative to depends on the table */
	offset: number;
	count: number;
}

/**
 * reads the slot for a key from a Hypergryph stored hash table, whose slot array is `capacity × (u32 offset,
 * u32 count)` indexed by `unsigned key mod capacity`
 *
 * @param view the file
 * @param slotsStart offset of the slot array
 * @param capacity number of slots
 * @param key the unsigned 64-bit key
 * @returns the key's slot, or `undefined` for an empty table
 * @throws {FormatError} if the slot lies outside the file
 */
export const hashSlot = (
	view: ByteView,
	slotsStart: number,
	capacity: number,
	key: bigint,
): HashSlot | undefined => {
	if (capacity === 0) {
		return undefined;
	}
	return slotAt(view, slotsStart, Number(key % BigInt(capacity)));
};

/**
 * @param view the file
 * @param slotsStart offset of the slot array
 * @param index slot index
 * @returns the slot
 * @throws {FormatError} if the slot lies outside the file
 */
const slotAt = (view: ByteView, slotsStart: number, index: number): HashSlot => {
	const at = slotsStart + index * 8;
	return { offset: view.u32(at), count: view.u32(at + 4) };
};

const utf16 = new TextDecoder('utf-16le');

/**
 * reads a Hypergryph length-prefixed UTF-16LE string (`u32 byteLength ‖ UTF-16LE ‖ u16 0`)
 *
 * @param view backing buffer
 * @param at byte offset of the length prefix
 * @returns decoded string
 * @throws {FormatError} on odd byte length or out-of-bounds read
 */
export const readLengthPrefixedUtf16 = (view: ByteView, at: number): string => {
	const byteLength = view.u32(at);
	if (byteLength % 2 !== 0) {
		throw new FormatError(`UTF-16 string at ${at} has an odd byte length ${byteLength}`);
	}
	view.check(at + 4, byteLength + 2);
	return utf16.decode(view.bytes.subarray(at + 4, at + 4 + byteLength));
};
