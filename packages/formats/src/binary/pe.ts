/**
 * just enough PE/COFF parsing to scan a Windows binary's data sections for embedded constants: section table,
 * rva↔offset mapping, and a byte-permutation finder.
 */

import { FormatError } from './binary-reader.ts';
import { ByteView } from './byte-view.ts';

/** one PE section header */
export interface PeSection {
	name: string;
	/** address relative to the image base, once loaded */
	virtualAddress: number;
	virtualSize: number;
	/** byte offset of the section's bytes within the file */
	rawOffset: number;
	rawSize: number;
	/** IMAGE_SCN_* flags */
	characteristics: number;
}

/** a parsed PE image, retaining the backing bytes */
export interface PeImage {
	data: Uint8Array;
	view: ByteView;
	imageBase: bigint;
	sections: PeSection[];
}

const IMAGE_SCN_CNT_CODE = 0x0000_0020;
const IMAGE_SCN_MEM_WRITE = 0x8000_0000;

/**
 * parses the PE header and section table of a 64-bit (PE32+) image.
 *
 * @param data entire file
 * @returns the image base and section table
 * @throws {FormatError} if the file isn't a PE32+ image
 */
export const parsePe = (data: Uint8Array): PeImage => {
	const view = new ByteView(data, 'PE');
	if (data.length < 0x40 || view.u16(0) !== 0x5a4d) {
		throw new FormatError('not a PE file (no MZ signature)');
	}
	const peOffset = view.u32(0x3c);
	if (view.u32(peOffset) !== 0x0000_4550) {
		throw new FormatError('bad PE signature');
	}
	const sectionCount = view.u16(peOffset + 6);
	const optionalSize = view.u16(peOffset + 20);
	const optional = peOffset + 24;
	if (view.u16(optional) !== 0x020b) {
		throw new FormatError('not a PE32+ (64-bit) image');
	}
	const imageBase = view.u64(optional + 24);

	const sections: PeSection[] = [];
	const table = optional + optionalSize;
	for (let i = 0; i < sectionCount; i++) {
		const base = table + 40 * i;
		view.check(base, 40);
		let name = '';
		for (let j = 0; j < 8 && data[base + j] !== 0; j++) {
			name += String.fromCharCode(data[base + j]);
		}
		sections.push({
			name,
			virtualSize: view.u32(base + 8),
			virtualAddress: view.u32(base + 12),
			rawSize: view.u32(base + 16),
			rawOffset: view.u32(base + 20),
			characteristics: view.u32(base + 36),
		});
	}
	return { data, view, imageBase, sections };
};

/** @returns the sections that hold initialized, non-code data (where constants live) */
export const dataSections = (image: PeImage): PeSection[] => {
	return image.sections.filter(
		(section) => section.rawSize > 0 && !(section.characteristics & IMAGE_SCN_CNT_CODE),
	);
};

/** @returns the sections that hold executable code */
export const codeSections = (image: PeImage): PeSection[] => {
	return image.sections.filter(
		(section) => section.rawSize > 0 && section.characteristics & IMAGE_SCN_CNT_CODE,
	);
};

/** @returns whether a section is writable (`.data` rather than `.rdata`) */
export const isWritable = (section: PeSection): boolean => {
	return (section.characteristics & IMAGE_SCN_MEM_WRITE) !== 0;
};

/**
 * @param image parsed image
 * @param fileOffset byte offset within the file
 * @returns the containing section's rva, or `undefined` if the offset is outside every section
 */
export const offsetToRva = (image: PeImage, fileOffset: number): number | undefined => {
	for (const section of image.sections) {
		if (fileOffset >= section.rawOffset && fileOffset < section.rawOffset + section.rawSize) {
			return section.virtualAddress + (fileOffset - section.rawOffset);
		}
	}
	return undefined;
};

/**
 * @param image parsed image
 * @param va virtual address
 * @returns its file offset, or `undefined` if no section's initialized raw data holds it
 */
export const vaToOffset = (image: PeImage, va: bigint): number | undefined => {
	const rva = va - image.imageBase;
	if (rva < 0n || rva > 0xffffffffn) {
		return undefined;
	}
	const address = Number(rva);
	for (const section of image.sections) {
		const size = Math.min(section.rawSize, section.virtualSize);
		if (address >= section.virtualAddress && address < section.virtualAddress + size) {
			return section.rawOffset + (address - section.virtualAddress);
		}
	}
	return undefined;
};

/**
 * @param image parsed image
 * @param va virtual address
 * @returns the file offset
 * @throws {FormatError} if no section's initialized raw data holds `va`
 */
export const requireVaOffset = (image: PeImage, va: bigint): number => {
	const offset = vaToOffset(image, va);
	if (offset === undefined) {
		throw new FormatError(`address 0x${va.toString(16)} is outside the image's data`);
	}
	return offset;
};

/**
 * finds every window of `data[start, end)` that is a permutation of the 256 byte values 0..255. such windows
 * are rare, so a match is almost always a substitution box or similar lookup table.
 *
 * uses a sliding 256-byte histogram, so it's linear in the scanned range.
 *
 * @param data bytes to scan
 * @param start inclusive start offset
 * @param end exclusive end offset
 * @returns file offsets of each 256-byte permutation window
 */
export const findBytePermutations = (data: Uint8Array, start: number, end: number): number[] => {
	const window = 256;
	const limit = Math.min(end, data.length);
	if (limit - start < window) {
		return [];
	}
	const counts = new Int32Array(256);
	let distinct = 0;
	const bump = (value: number, delta: number): void => {
		const before = counts[value];
		counts[value] = before + delta;
		if (before === 0) {
			distinct++;
		} else if (counts[value] === 0) {
			distinct--;
		}
	};

	for (let i = start; i < start + window; i++) {
		bump(data[i], 1);
	}
	const hits: number[] = [];
	for (let left = start; left + window <= limit; left++) {
		if (distinct === 256) {
			hits.push(left);
		}
		bump(data[left], -1);
		if (left + window < limit) {
			bump(data[left + window], 1);
		}
	}
	return hits;
};

const buildAesSbox = (): Uint8Array => {
	const sbox = new Uint8Array(256);
	// multiplicative inverse in GF(2^8) via log/antilog tables over generator 3, then the affine transform
	const exp = new Uint8Array(256);
	const log = new Uint8Array(256);
	let x = 1;
	for (let i = 0; i < 255; i++) {
		exp[i] = x;
		log[x] = i;
		x ^= (x << 1) ^ (x & 0x80 ? 0x11b : 0);
		x &= 0xff;
	}
	const inverse = (a: number): number => (a === 0 ? 0 : exp[(255 - log[a]) % 255]);
	for (let i = 0; i < 256; i++) {
		const inv = inverse(i);
		let s = inv;
		for (let r = 0; r < 4; r++) {
			s ^= ((inv << (r + 1)) | (inv >> (7 - r))) & 0xff;
		}
		sbox[i] = s ^ 0x63;
	}
	return sbox;
};

/** the standard AES (Rijndael) substitution box, to exclude when hunting for a custom one */
export const AES_SBOX: Uint8Array = buildAesSbox();

/** @returns whether `a` and `b` hold the same bytes */
export const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean => {
	if (a.length !== b.length) {
		return false;
	}
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) {
			return false;
		}
	}
	return true;
};
