/**
 * zstd decoding through zstddec's wasm build, which is an order of magnitude faster than a JS decoder on
 * texture blobs. the module instance is per realm, so each worker initializes its own.
 *
 * @module
 */

import { ZSTDDecoder } from 'zstddec';

const decoder = new ZSTDDecoder();

/** resolves once the decoder's wasm is instantiated; await before {@link decompressZstd} */
export const zstdReady: Promise<void> = decoder.init();

/**
 * @param frame one zstd frame
 * @param rawLength the decoded length, if known; otherwise read from the frame header
 * @returns the decoded bytes, in a buffer of their own
 * @throws {Error} if the frame doesn't decode to `rawLength` bytes
 */
export const decompressZstd = (frame: Uint8Array, rawLength?: number): Uint8Array<ArrayBuffer> => {
	// The package's JSON frames intentionally omit a content-size field. The regular decoder asks the WASM
	// binding for that size, but its 64-bit return is truncated in some browsers and produces a zero-filled
	// buffer. Supplying a generous destination size avoids that ABI path; zstd returns the actual decoded
	// length, while blob/table entries with a recorded raw length keep their exact-sized fast path.
	let raw: Uint8Array<ArrayBuffer>;
	if (rawLength === undefined) {
		const JSON_DESTINATION_LIMIT = 64 * 1024 * 1024;
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- zstddec returns a slice of its wasm heap
		raw = decoder.decode(frame, JSON_DESTINATION_LIMIT) as Uint8Array<ArrayBuffer>;
	} else {
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- zstddec returns a slice of its wasm heap
		raw = decoder.decode(frame, rawLength) as Uint8Array<ArrayBuffer>;
	}
	if (rawLength === undefined ? raw.byteLength === 0 : raw.byteLength !== rawLength) {
		throw new Error(`zstd frame decoded to ${raw.byteLength} bytes, expected ${rawLength ?? 'more'}`);
	}
	return raw;
};
