/**
 * shared FourCC TLV binary container for v2 package tables and blobs.
 *
 * layout (all little-endian):
 *
 * - 16-byte header: `u32 magic, u16 majorVersion, u16 flags, u32 sectionCount, u32 reserved`
 * - `sectionCount × 24`-byte directory: `u32 tag, u32 flags, u32 offset, u32 byteLength, u32 count, u32 stride`
 * - section payloads, each starting at a 16-byte-aligned offset
 *
 * forward compatibility:
 *
 * - unknown sections without {@link SectionFlags.Required} are skipped
 * - unknown sections with {@link SectionFlags.Required} throw {@link PackageFormatError}
 * - fixed-stride record sections advance by `stride` (>= known minimum) so trailing fields are ignored
 *
 * @module
 */

import { viewOf } from './binary.ts';
import { PackageFormatError } from './errors.ts';

/** byte length of a container header */
export const CONTAINER_HEADER_SIZE = 16;

/** byte length of one section directory entry */
export const SECTION_ENTRY_SIZE = 24;

/** byte alignment of every section payload */
export const CONTAINER_ALIGN = 16;

/** @returns `n` rounded up to a multiple of {@link CONTAINER_ALIGN} */
export const align16 = (n: number): number => (n + 15) & ~15;

/** section directory flag bits */
export const SectionFlags = {
	/** reader must understand this section's tag; an unknown required section fails decode */
	Required: 1 << 0,
} as const;

/**
 * packs a 4-character ASCII FourCC into a little-endian `u32`
 *
 * @param tag 4-character ASCII tag, e.g. `'HEAD'`
 * @returns little-endian `u32` tag
 * @throws {RangeError} if `tag` isn't 4 ASCII characters
 */
export const fourcc = (tag: string): number => {
	if (tag.length !== 4) {
		throw new RangeError(`FourCC '${tag}' must be 4 characters`);
	}
	let value = 0;
	for (let i = 0; i < 4; i++) {
		const code = tag.charCodeAt(i);
		if (code > 0x7f) {
			throw new RangeError(`FourCC '${tag}' must be ASCII`);
		}
		value |= code << (i * 8);
	}
	return value >>> 0;
};

/**
 * formats a packed FourCC back into a 4-character string
 *
 * @param tag packed little-endian `u32` FourCC
 * @returns 4-character ASCII string
 */
export const fourccName = (tag: number): string =>
	String.fromCharCode(tag & 0xff, (tag >>> 8) & 0xff, (tag >>> 16) & 0xff, (tag >>> 24) & 0xff);

/** one section to write into a container */
export interface ContainerSectionInput {
	/** packed FourCC from {@link fourcc} */
	tag: number;
	/** raw payload bytes */
	data: Uint8Array;
	/** whether readers that don't know this tag must reject the container (default `false`) */
	required?: boolean;
	/** element count for array sections (default 0) */
	count?: number;
	/** byte stride per element for fixed-stride array sections (default 0) */
	stride?: number;
}

/** options for {@link encodeContainer} */
export interface EncodeContainerOptions {
	/** packed FourCC container magic */
	magic: number;
	/** container major version */
	majorVersion: number;
	/** container-wide bitflags (default 0) */
	flags?: number;
	/** sections in directory order; tags must be unique */
	sections: readonly ContainerSectionInput[];
}

/** one decoded section from a container */
export interface ContainerSection {
	tag: number;
	flags: number;
	offset: number;
	byteLength: number;
	count: number;
	stride: number;
	/** view into the container's buffer */
	data: Uint8Array;
}

/** a decoded container */
export interface DecodedContainer {
	magic: number;
	majorVersion: number;
	flags: number;
	/** recognized sections by packed FourCC tag */
	sections: ReadonlyMap<number, ContainerSection>;
}

/** options for {@link decodeContainer} */
export interface DecodeContainerOptions {
	/** expected packed FourCC container magic */
	magic: number;
	/** expected container major version */
	majorVersion: number;
	/** set of packed FourCC tags the caller understands */
	knownTags: ReadonlySet<number>;
	/** human-readable label for error messages */
	label: string;
}

/**
 * encodes a FourCC TLV binary container with 16-byte-aligned section payloads
 *
 * @param options magic, version, flags and sections
 * @returns encoded container bytes
 * @throws {RangeError} on duplicate section tags or out-of-range counts/lengths
 */
export const encodeContainer = (options: EncodeContainerOptions): Uint8Array => {
	const { magic, majorVersion, flags = 0, sections } = options;
	const seen = new Set<number>();
	let size = align16(CONTAINER_HEADER_SIZE + sections.length * SECTION_ENTRY_SIZE);
	const offsets: number[] = [];
	for (const section of sections) {
		if (seen.has(section.tag)) {
			throw new RangeError(`duplicate section '${fourccName(section.tag)}'`);
		}
		seen.add(section.tag);
		offsets.push(size);
		size = align16(size + section.data.byteLength);
	}
	if (size > 0xff_ff_ff_ff) {
		throw new RangeError('container exceeds 4 GiB u32 offset limit');
	}

	const out = new Uint8Array(size);
	const view = viewOf(out);
	view.setUint32(0, magic, true);
	view.setUint16(4, majorVersion, true);
	view.setUint16(6, flags, true);
	view.setUint32(8, sections.length, true);
	view.setUint32(12, 0, true);

	for (const [i, section] of sections.entries()) {
		const at = CONTAINER_HEADER_SIZE + i * SECTION_ENTRY_SIZE;
		const sectionFlags = section.required ? SectionFlags.Required : 0;
		view.setUint32(at, section.tag, true);
		view.setUint32(at + 4, sectionFlags, true);
		view.setUint32(at + 8, offsets[i], true);
		view.setUint32(at + 12, section.data.byteLength, true);
		view.setUint32(at + 16, section.count ?? 0, true);
		view.setUint32(at + 20, section.stride ?? 0, true);
		out.set(section.data, offsets[i]);
	}
	return out;
};

/**
 * decodes a FourCC TLV binary container, skipping unknown optional sections and rejecting unknown required
 * sections
 *
 * @param data raw container bytes
 * @param options expected magic, version, known tags and label
 * @returns decoded header and recognized sections
 * @throws {PackageFormatError} on bad magic, version, bounds, duplicate tags or unknown required sections
 */
export const decodeContainer = (data: Uint8Array, options: DecodeContainerOptions): DecodedContainer => {
	const { magic, majorVersion, knownTags, label } = options;
	if (data.byteLength < CONTAINER_HEADER_SIZE) {
		throw new PackageFormatError(`${label} is too short for a container header`);
	}
	const view = viewOf(data);
	if (view.getUint32(0, true) !== magic) {
		throw new PackageFormatError(`not a ${label}`);
	}
	const version = view.getUint16(4, true);
	if (version !== majorVersion) {
		throw new PackageFormatError(`${label} major version ${version} isn't ${majorVersion}`);
	}
	const flags = view.getUint16(6, true);
	const sectionCount = view.getUint32(8, true);
	const dirEnd = CONTAINER_HEADER_SIZE + sectionCount * SECTION_ENTRY_SIZE;
	if (dirEnd > data.byteLength) {
		throw new PackageFormatError(`${label} section directory runs past its end`);
	}

	const sections = new Map<number, ContainerSection>();
	const seen = new Set<number>();
	for (let i = 0; i < sectionCount; i++) {
		const at = CONTAINER_HEADER_SIZE + i * SECTION_ENTRY_SIZE;
		const tag = view.getUint32(at, true);
		const sectionFlags = view.getUint32(at + 4, true);
		const offset = view.getUint32(at + 8, true);
		const byteLength = view.getUint32(at + 12, true);
		const count = view.getUint32(at + 16, true);
		const stride = view.getUint32(at + 20, true);
		if (seen.has(tag)) {
			throw new PackageFormatError(`${label} has duplicate section '${fourccName(tag)}'`);
		}
		seen.add(tag);
		if (offset < dirEnd || (offset & (CONTAINER_ALIGN - 1)) !== 0 || offset + byteLength > data.byteLength) {
			throw new PackageFormatError(`${label} section '${fourccName(tag)}' has invalid bounds`);
		}
		if (!knownTags.has(tag)) {
			if ((sectionFlags & SectionFlags.Required) !== 0) {
				throw new PackageFormatError(`${label} has unknown required section '${fourccName(tag)}'`);
			}
			continue;
		}
		sections.set(tag, {
			tag,
			flags: sectionFlags,
			offset,
			byteLength,
			count,
			stride,
			data: data.subarray(offset, offset + byteLength),
		});
	}
	return { magic, majorVersion, flags, sections };
};

/**
 * fetches a required section from a decoded container
 *
 * @param container decoded container
 * @param tag packed FourCC
 * @param label container label for error messages
 * @returns the section
 * @throws {PackageFormatError} if the section is absent
 */
export const requireSection = (container: DecodedContainer, tag: number, label: string): ContainerSection => {
	const section = container.sections.get(tag);
	if (section === undefined) {
		throw new PackageFormatError(`${label} is missing required section '${fourccName(tag)}'`);
	}
	return section;
};

/**
 * validates that a fixed-stride array section has at least `minStride` bytes per element and enough bytes for
 * `count * stride`
 *
 * @param section section to validate
 * @param minStride minimum element stride the reader expects
 * @param label section label for error messages
 * @throws {PackageFormatError} if `stride` is too small or `byteLength` is too short
 */
export const checkStride = (section: ContainerSection, minStride: number, label: string): void => {
	if (section.stride < minStride) {
		throw new PackageFormatError(`${label} stride ${section.stride} is smaller than ${minStride}`);
	}
	if (section.byteLength < section.count * section.stride) {
		throw new PackageFormatError(
			`${label} is ${section.byteLength} bytes, shorter than ${section.count} × ${section.stride}`,
		);
	}
};

/**
 * returns a `Float32Array` view over a section's bytes (zero-copy when 4-byte aligned, else copied)
 *
 * @param section section holding f32 values
 * @returns f32 view or copy
 * @throws {PackageFormatError} if `byteLength` isn't a multiple of 4
 */
export const sectionF32 = (section: ContainerSection): Float32Array => {
	const { data } = section;
	if ((data.byteLength & 3) !== 0) {
		throw new PackageFormatError(`section '${fourccName(section.tag)}' length isn't a multiple of 4`);
	}
	if ((data.byteOffset & 3) === 0) {
		return new Float32Array(data.buffer, data.byteOffset, data.byteLength / 4);
	}
	return new Float32Array(data.slice().buffer);
};

/**
 * returns a `Uint32Array` view over a section's bytes (zero-copy when 4-byte aligned, else copied)
 *
 * @param section section holding u32 values
 * @returns u32 view or copy
 * @throws {PackageFormatError} if `byteLength` isn't a multiple of 4
 */
export const sectionU32 = (section: ContainerSection): Uint32Array => {
	const { data } = section;
	if ((data.byteLength & 3) !== 0) {
		throw new PackageFormatError(`section '${fourccName(section.tag)}' length isn't a multiple of 4`);
	}
	if ((data.byteOffset & 3) === 0) {
		return new Uint32Array(data.buffer, data.byteOffset, data.byteLength / 4);
	}
	return new Uint32Array(data.slice().buffer);
};

/**
 * returns a `Uint16Array` view over a section's bytes (zero-copy when 2-byte aligned, else copied)
 *
 * @param section section holding u16 values
 * @returns u16 view or copy
 * @throws {PackageFormatError} if `byteLength` isn't a multiple of 2
 */
export const sectionU16 = (section: ContainerSection): Uint16Array => {
	const { data } = section;
	if ((data.byteLength & 1) !== 0) {
		throw new PackageFormatError(`section '${fourccName(section.tag)}' length isn't a multiple of 2`);
	}
	if ((data.byteOffset & 1) === 0) {
		return new Uint16Array(data.buffer, data.byteOffset, data.byteLength / 2);
	}
	return new Uint16Array(data.slice().buffer);
};

/**
 * encodes a sparse per-row section: ascending `u32 rows[count]`, padded to 16 bytes, followed by `count ×
 * stride` value bytes
 *
 * @param rows strictly ascending row indices
 * @param values packed value bytes (`rows.length * stride`)
 * @param stride byte size per row value
 * @returns encoded section payload
 * @throws {RangeError} if `values.byteLength !== rows.length * stride` or `rows` aren't ascending
 */
export const encodeSparseSection = (rows: Uint32Array, values: Uint8Array, stride: number): Uint8Array => {
	if (values.byteLength !== rows.length * stride) {
		throw new RangeError(`sparse section values length ${values.byteLength} != ${rows.length} × ${stride}`);
	}
	for (let i = 1; i < rows.length; i++) {
		if (rows[i] <= rows[i - 1]) {
			throw new RangeError('sparse section row indices must be strictly ascending');
		}
	}
	const valuesOffset = align16(rows.byteLength);
	const out = new Uint8Array(valuesOffset + values.byteLength);
	out.set(new Uint8Array(rows.buffer, rows.byteOffset, rows.byteLength), 0);
	out.set(values, valuesOffset);
	return out;
};

/**
 * decodes a sparse per-row section encoded by {@link encodeSparseSection}
 *
 * @param section container section (`count` = row count, `stride` = value stride)
 * @param minStride minimum expected value stride
 * @param rowCount total rows in the owning block (every sparse row index must be `< rowCount`)
 * @param label section label for error messages
 * @returns row indices, raw value bytes (at `section.stride` per row), and `stride`
 * @throws {PackageFormatError} on invalid stride, length, or non-ascending / out-of-range row indices
 */
export const decodeSparseSection = (
	section: ContainerSection,
	minStride: number,
	rowCount: number,
	label: string,
): { rows: Uint32Array; values: Uint8Array; stride: number } => {
	if (section.stride < minStride) {
		throw new PackageFormatError(`${label} stride ${section.stride} is smaller than ${minStride}`);
	}
	const rowsBytes = section.count * 4;
	const valuesOffset = align16(rowsBytes);
	const valuesBytes = section.count * section.stride;
	if (section.byteLength < valuesOffset + valuesBytes) {
		throw new PackageFormatError(`${label} is shorter than its sparse rows and values`);
	}
	const { data } = section;
	const rows =
		(data.byteOffset & 3) === 0
			? new Uint32Array(data.buffer, data.byteOffset, section.count)
			: new Uint32Array(data.slice(0, rowsBytes).buffer);
	for (let i = 0; i < rows.length; i++) {
		if (rows[i] >= rowCount || (i > 0 && rows[i] <= rows[i - 1])) {
			throw new PackageFormatError(`${label} rows must be strictly ascending and below ${rowCount}`);
		}
	}
	return {
		rows,
		values: data.subarray(valuesOffset, valuesOffset + valuesBytes),
		stride: section.stride,
	};
};
