// a port of the transform-track decompression of the Animation Compression Library 2.1
// (https://github.com/nfrechette/acl), under its licence:
//
// MIT License
//
// Copyright (c) 2017 Nicholas Frechette & Animation Compression Library contributors
//
// Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
// documentation files (the "Software"), to deal in the Software without restriction, including without
// limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the
// Software, and to permit persons to whom the Software is furnished to do so, subject to the following
// conditions:
//
// The above copyright notice and this permission notice shall be included in all copies or substantial portions
// of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO
// THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF
// CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
// DEALINGS IN THE SOFTWARE.

import { FormatError } from '../binary/binary-reader.ts';

// layout: docs/game-data/animation.md#acl-compressed-clips

/** `buffer_tag32::compressed_tracks` */
const TAG = 0xac11_ac11;
/** `compressed_tracks_version16::v02_01_00` */
const VERSION = 10;
/** `track_type8::qvvf` */
const TRANSFORMS = 12;
/** `raw_buffer_header` (size, hash) */
const RAW_HEADER = 8;
/** `tracks_header`, after the raw header */
const TRACKS_HEADER = 24;
/** `transform_tracks_header`: 8 counts and 5 offsets */
const TRANSFORM_HEADER = 52;
/** a variable sub-track's per-segment format byte for full-precision samples (32 bits remapped to 31) */
const RAW_BITS = 31;

/** `rotation_format8` */
const QUAT_FULL = 0;
const QUAT_DROP_W_FULL = 2;
const QUAT_DROP_W_VARIABLE = 3;

/** floats per decoded track and sample: rotation xyzw, translation xyz, scale xyz */
export const ACL_TRANSFORM_STRIDE = 10;

/** every sample of an ACL buffer's transform tracks */
export interface AclTransforms {
	trackCount: number;
	sampleCount: number;
	/** samples per second */
	sampleRate: number;
	/**
	 * whether the clip wraps: its last sample interpolates into its first, so it lasts `sampleCount /
	 * sampleRate` rather than `(sampleCount − 1) / sampleRate`
	 */
	wraps: boolean;
	/** `values[(sample × trackCount + track) × ACL_TRANSFORM_STRIDE + k]` */
	values: Float32Array;
}

/** FNV-1a, 32 bits: ACL's `hash32` */
const fnv1a = (bytes: Uint8Array): number => {
	let hash = 0x811c_9dc5;
	for (const byte of bytes) {
		hash = Math.imul(hash ^ byte, 0x0100_0193) >>> 0;
	}
	return hash;
};

/** @returns `count` bits from `bit` on, most significant first (ACL's big-endian bit streams), as an unsigned */
const readBits = (bytes: Uint8Array, bit: number, count: number): number => {
	let value = 0;
	for (let i = 0; i < count; i++) {
		const at = bit + i;
		const byte = bytes[at >> 3];
		if (byte === undefined) {
			throw new FormatError('ACL animated data ends early');
		}
		value = value * 2 + ((byte >> (7 - (at & 7))) & 1);
	}
	return value;
};

// ACL normalizes and remaps in float32, a multiply and an add each rounded: near a unit quaternion's edge the
// rounding decides w, so the arithmetic follows it
const INV_U8 = Math.fround(1 / 255);
const INV_U16 = Math.fround(1 / 65_535);
const f32Mul = (a: number, b: number): number => Math.fround(a * b);
const f32MulAdd = (a: number, b: number, c: number): number => Math.fround(Math.fround(a * b) + c);

const alignTo = (offset: number, alignment: number): number => Math.ceil(offset / alignment) * alignment;

const floatBits = new DataView(new ArrayBuffer(4));
const bitsFloat = (bits: number): number => {
	floatBits.setUint32(0, bits);
	return floatBits.getFloat32(0);
};

/** the kinds of a transform's rotation, translation or scale in `packed_sub_track_types` */
const DEFAULT = 0;
const CONSTANT = 1;
const ANIMATED = 2;

/**
 * `quat_from_positive_w`: w from the unit length, its square taken as absolute. in float32 as ACL computes
 * it: near w = 0 the rounding decides w
 */
const positiveW = (x: number, y: number, z: number): number => {
	const f = Math.fround;
	const dot = f(f(f(f(x * x) + f(y * y)) + f(z * z)));
	return f(Math.sqrt(Math.abs(f(1 - dot))));
};

/**
 * decodes every sample of an ACL 2.1 `compressed_tracks` buffer of transform tracks
 *
 * @param bytes the buffer
 * @returns its tracks' values at each stored sample time; samples keyframe stripping removed are interpolated
 *   as ACL interpolates them (rotations by normalized lerp along the shorter arc, vectors linearly)
 * @throws {FormatError} on a malformed or mis-hashed buffer, another ACL version or track type, a database,
 *   non-trivial default values (they need the bind pose) or an unknown rotation format
 */
export const decodeAclTransforms = (bytes: Uint8Array): AclTransforms => {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (bytes.length < RAW_HEADER + TRACKS_HEADER + TRANSFORM_HEADER) {
		throw new FormatError('ACL buffer is too short');
	}
	const size = view.getUint32(0, true);
	if (size > bytes.length || size < RAW_HEADER + TRACKS_HEADER) {
		throw new FormatError(`ACL buffer of ${bytes.length} bytes says it has ${size}`);
	}
	if (fnv1a(bytes.subarray(RAW_HEADER, size)) !== view.getUint32(4, true)) {
		throw new FormatError('ACL buffer hash mismatch');
	}
	const u32 = (offset: number): number => view.getUint32(offset, true);
	const f32 = (offset: number): number => view.getFloat32(offset, true);

	// #region tracks header
	const h = RAW_HEADER;
	if (u32(h) !== TAG) {
		throw new FormatError(`not an ACL compressed_tracks buffer (tag 0x${u32(h).toString(16)})`);
	}
	const version = view.getUint16(h + 4, true);
	if (version !== VERSION) {
		throw new FormatError(`ACL version ${version} isn't supported`);
	}
	if (bytes[h + 6] !== 0) {
		throw new FormatError(`ACL algorithm ${bytes[h + 6]} isn't supported`);
	}
	if (bytes[h + 7] !== TRANSFORMS) {
		throw new FormatError(`ACL track type ${bytes[h + 7]} isn't transforms`);
	}
	const trackCount = u32(h + 8);
	const sampleCount = u32(h + 12);
	const sampleRate = f32(h + 16);
	const misc = u32(h + 20);
	const hasScale = (misc & 1) !== 0;
	const defaultScale = (misc >> 1) & 1;
	const scaleVariable = ((misc >> 2) & 1) === 1;
	const translationVariable = ((misc >> 3) & 1) === 1;
	const rotationFormat = (misc >> 4) & 15;
	const hasDatabase = (misc & (1 << 8)) !== 0;
	const trivialDefaults = (misc & (1 << 9)) !== 0;
	const stripped = (misc & (1 << 10)) !== 0;
	const wraps = (misc & (1 << 30)) !== 0;
	if (hasDatabase) {
		throw new FormatError('ACL buffers with a database aren’t supported');
	}
	if (!trivialDefaults && trackCount > 0) {
		throw new FormatError('ACL buffer has non-trivial default values');
	}
	if (
		rotationFormat !== QUAT_FULL &&
		rotationFormat !== QUAT_DROP_W_FULL &&
		rotationFormat !== QUAT_DROP_W_VARIABLE
	) {
		throw new FormatError(`ACL rotation format ${rotationFormat} isn't supported`);
	}
	const rotationVariable = rotationFormat === QUAT_DROP_W_VARIABLE;
	const rotationDropsW = rotationFormat !== QUAT_FULL;
	// #endregion

	const stride = ACL_TRANSFORM_STRIDE;
	const values = new Float32Array(trackCount * sampleCount * stride);
	if (trackCount === 0 || sampleCount === 0) {
		return { trackCount, sampleCount, sampleRate, wraps, values };
	}

	// #region transform header
	const t = h + TRACKS_HEADER;
	const segmentCount = u32(t);
	const variableSubTracks = u32(t + 4);
	const offset = (field: number): number => t + u32(t + field);
	const segmentHeaders = offset(36);
	const subTrackTypes = offset(40);
	const constantData = offset(44);
	const clipRangeData = offset(48);
	const segmentStarts: number[] = [0];
	for (let i = 1; i < segmentCount; i++) {
		segmentStarts.push(u32(t + TRANSFORM_HEADER + i * 4));
	}
	// #endregion

	// #region sub-track kinds
	const entries = Math.ceil(trackCount / 16);
	const kindOf = (type: number, track: number): number => {
		if (type === 2 && !hasScale) {
			return DEFAULT;
		}
		const word = u32(subTrackTypes + (type * entries + Math.floor(track / 16)) * 4);
		return (word >>> ((15 - (track % 16)) * 2)) & 3;
	};
	/** per sub-track type (rotation, translation, scale), its tracks of each kind in track order */
	const constant: number[][] = [[], [], []];
	const animated: number[][] = [[], [], []];
	/** bit `type` is set when track `t` has an animated sub-track of that type */
	const animatedMask = new Uint8Array(trackCount);
	for (let type = 0; type < 3; type++) {
		for (let track = 0; track < trackCount; track++) {
			const kind = kindOf(type, track);
			if (kind === CONSTANT) {
				constant[type].push(track);
			} else if (kind === ANIMATED) {
				animated[type].push(track);
				animatedMask[track] |= 1 << type;
			} else if (kind !== DEFAULT) {
				throw new FormatError(`ACL sub-track kind ${kind}`);
			}
		}
	}
	// #endregion

	/** one track's value at every sample, filled for constant and default sub-tracks */
	const fill = (track: number, k: number, value: ArrayLike<number>): void => {
		for (let sample = 0; sample < sampleCount; sample++) {
			values.set(value, (sample * trackCount + track) * stride + k);
		}
	};
	const setQuat = (at: number, x: number, y: number, z: number, w: number): void => {
		const length = Math.hypot(x, y, z, w) || 1;
		values[at] = x / length;
		values[at + 1] = y / length;
		values[at + 2] = z / length;
		values[at + 3] = w / length;
	};

	// #region defaults and constants
	for (let track = 0; track < trackCount; track++) {
		fill(track, 0, [0, 0, 0, 1]);
		fill(track, 4, [0, 0, 0]);
		fill(track, 7, [defaultScale, defaultScale, defaultScale]);
	}
	{
		let at = constantData;
		const rotations = constant[0];
		if (rotationDropsW) {
			// groups of four: xxxx, yyyy, zzzz (the last group as long as it is)
			const sample = new Float32Array(4);
			for (let group = 0; group < rotations.length; group += 4) {
				const count = Math.min(4, rotations.length - group);
				for (let i = 0; i < count; i++) {
					const x = f32(at + i * 4);
					const y = f32(at + (count + i) * 4);
					const z = f32(at + (count * 2 + i) * 4);
					const w = positiveW(x, y, z);
					const length = Math.hypot(x, y, z, w) || 1;
					sample[0] = x / length;
					sample[1] = y / length;
					sample[2] = z / length;
					sample[3] = w / length;
					fill(rotations[group + i], 0, sample);
				}
				at += count * 12;
			}
		} else {
			for (const track of rotations) {
				const [x, y, z, w] = [f32(at), f32(at + 4), f32(at + 8), f32(at + 12)];
				const length = Math.hypot(x, y, z, w) || 1;
				fill(track, 0, [x / length, y / length, z / length, w / length]);
				at += 16;
			}
		}
		for (const track of constant[1]) {
			fill(track, 4, [f32(at), f32(at + 4), f32(at + 8)]);
			at += 12;
		}
		for (const track of constant[2]) {
			fill(track, 7, [f32(at), f32(at + 4), f32(at + 8)]);
			at += 12;
		}
	}
	// #endregion

	// #region clip ranges
	/** per animated sub-track of each type, its clip range min and extent, or `null` without range reduction */
	const clipRanges: (Float32Array | null)[][] = [[], [], []];
	{
		let at = clipRangeData;
		const rotations = animated[0].length;
		for (let group = 0; group < rotations; group += 4) {
			const count = Math.min(4, rotations - group);
			for (let i = 0; i < count; i++) {
				clipRanges[0].push(
					rotationVariable ? Float32Array.from({ length: 6 }, (_, c) => f32(at + (c * count + i) * 4)) : null,
				);
			}
			if (rotationVariable) {
				at += count * 24;
			}
		}
		for (const [type, variable] of [
			[1, translationVariable],
			[2, scaleVariable],
		] as const) {
			for (let i = 0; i < animated[type].length; i++) {
				clipRanges[type].push(variable ? Float32Array.from({ length: 6 }, (_, c) => f32(at + c * 4)) : null);
				if (variable) {
					at += 24;
				}
			}
		}
	}
	// #endregion

	// #region segments
	const variable = [rotationVariable, translationVariable, scaleVariable];
	/** which samples were stored, to interpolate the rest */
	const storedSamples = new Uint8Array(sampleCount);
	const segmentHeaderSize = stripped ? 20 : 16;
	const multipleSegments = segmentCount > 1;
	for (let segment = 0; segment < segmentCount; segment++) {
		const header = segmentHeaders + segment * segmentHeaderSize;
		const poseBits = u32(header);
		const segmentData = t + u32(header + 12);
		const start = segmentStarts[segment];
		const end = segment + 1 < segmentCount ? segmentStarts[segment + 1] : sampleCount;
		const sampleIndices = stripped ? u32(header + 16) : 0xffff_ffff;

		// format bytes (rotations padded to groups of four), then segment ranges (2-aligned), then samples (4-aligned)
		// alignment is relative to the buffer's start, which ACL keeps 16-byte aligned
		const formats = segmentData;
		const ranges = alignTo(formats + variableSubTracks, 2);
		const animatedData = alignTo(ranges + (multipleSegments ? 6 * variableSubTracks : 0), 4);
		const data = bytes.subarray(animatedData);

		/** per animated sub-track of each type: its bit count and segment range bytes' offset */
		const layouts: { bits: number; range: number }[][] = [[], [], []];
		{
			let format = formats;
			let range = ranges;
			const rotations = animated[0].length;
			for (let group = 0; group < rotations; group += 4) {
				const count = Math.min(4, rotations - group);
				for (let i = 0; i < count; i++) {
					// SOA ranges: min x, y, z, extent x, y, z, four lanes each
					layouts[0].push({ bits: rotationVariable ? bytes[format + i] : -1, range: range + i });
				}
				if (rotationVariable) {
					format += 4;
					range += 24;
				}
			}
			for (const type of [1, 2]) {
				for (let i = 0; i < animated[type].length; i++) {
					layouts[type].push({ bits: variable[type] ? bytes[format] : -1, range });
					if (variable[type]) {
						format++;
						range += 6;
					}
				}
			}
		}

		let stored = 0;
		for (let sample = start; sample < end; sample++) {
			if (((sampleIndices >>> (31 - (sample - start))) & 1) === 0) {
				continue;
			}
			storedSamples[sample] = 1;
			let bit = stored * poseBits;
			stored++;
			for (let type = 0; type < 3; type++) {
				for (const [i, track] of animated[type].entries()) {
					const { bits, range } = layouts[type][i];
					const xyz = [0, 0, 0];
					let segmentRange = multipleSegments;
					let clipRange = clipRanges[type][i] !== null;
					if (bits === -1) {
						// full precision
						const components = type === 0 && !rotationDropsW ? 4 : 3;
						const raw = Array.from({ length: components }, (_, c) =>
							bitsFloat(readBits(data, bit + c * 32, 32)),
						);
						bit += components * 32;
						const at = (sample * trackCount + track) * stride;
						if (type === 0) {
							setQuat(
								at,
								raw[0],
								raw[1],
								raw[2],
								components === 4 ? raw[3] : positiveW(raw[0], raw[1], raw[2]),
							);
						} else {
							values.set(raw, at + (type === 1 ? 4 : 7));
						}
						continue;
					}
					if (bits === 0) {
						// constant in this segment: 16 bits a component, kept in the segment range bytes
						if (type === 0) {
							for (let c = 0; c < 3; c++) {
								xyz[c] = f32Mul((bytes[range + c * 8] << 8) | bytes[range + c * 8 + 4], INV_U16);
							}
						} else {
							for (let c = 0; c < 3; c++) {
								xyz[c] = f32Mul(view.getUint16(range + c * 2, true), INV_U16);
							}
						}
						segmentRange = false;
					} else if (bits === RAW_BITS) {
						for (let c = 0; c < 3; c++) {
							xyz[c] = bitsFloat(readBits(data, bit + c * 32, 32));
						}
						bit += 96;
						segmentRange = false;
						clipRange = false;
					} else {
						const inverse = Math.fround(1 / (2 ** bits - 1));
						for (let c = 0; c < 3; c++) {
							xyz[c] = f32Mul(readBits(data, bit + c * bits, bits), inverse);
						}
						bit += bits * 3;
					}
					if (segmentRange) {
						for (let c = 0; c < 3; c++) {
							const min = type === 0 ? bytes[range + c * 4] : bytes[range + c];
							const extent = type === 0 ? bytes[range + 12 + c * 4] : bytes[range + 3 + c];
							xyz[c] = f32MulAdd(xyz[c], f32Mul(extent, INV_U8), f32Mul(min, INV_U8));
						}
					}
					const clip = clipRanges[type][i];
					if (clipRange && clip !== null) {
						for (let c = 0; c < 3; c++) {
							xyz[c] = f32MulAdd(xyz[c], clip[3 + c], clip[c]);
						}
					}
					const at = (sample * trackCount + track) * stride;
					if (type === 0) {
						setQuat(at, xyz[0], xyz[1], xyz[2], positiveW(xyz[0], xyz[1], xyz[2]));
					} else {
						values.set(xyz, at + (type === 1 ? 4 : 7));
					}
				}
			}
		}
	}
	// #endregion

	// #region stripped samples
	if (stripped) {
		const animatedTracks: number[] = [];
		for (let track = 0; track < trackCount; track++) {
			if (animatedMask[track] !== 0) {
				animatedTracks.push(track);
			}
		}
		const kept: number[] = [];
		for (let sample = 0; sample < sampleCount; sample++) {
			if (storedSamples[sample] === 1) {
				kept.push(sample);
			}
		}
		if (kept.length === 0) {
			throw new FormatError('ACL buffer stores no samples');
		}
		let next = 0;
		for (let sample = 0; sample < sampleCount; sample++) {
			if (storedSamples[sample] === 1) {
				next++;
				continue;
			}
			const before = kept[next - 1] ?? kept[0];
			let after = kept[next];
			let span: number;
			if (after === undefined) {
				// past the last stored sample: a wrapping clip blends into its first, a clamped one holds
				after = wraps ? kept[0] : before;
				span = wraps ? sampleCount - before + after : 1;
			} else {
				span = after - before;
			}
			const alpha = after === before ? 0 : (sample - before) / span;
			for (const track of animatedTracks) {
				const a = (before * trackCount + track) * stride;
				const b = (after * trackCount + track) * stride;
				const at = (sample * trackCount + track) * stride;
				const mask = animatedMask[track];
				if ((mask & 1) !== 0) {
					// shorter arc: flip the end when the dot product is negative
					const ax = values[a],
						ay = values[a + 1],
						az = values[a + 2],
						aw = values[a + 3];
					const bx = values[b],
						by = values[b + 1],
						bz = values[b + 2],
						bw = values[b + 3];
					const sign = ax * bx + ay * by + az * bz + aw * bw < 0 ? -1 : 1;
					setQuat(
						at,
						ax + (bx * sign - ax) * alpha,
						ay + (by * sign - ay) * alpha,
						az + (bz * sign - az) * alpha,
						aw + (bw * sign - aw) * alpha,
					);
				}
				if ((mask & 2) !== 0) {
					values[at + 4] = values[a + 4] + (values[b + 4] - values[a + 4]) * alpha;
					values[at + 5] = values[a + 5] + (values[b + 5] - values[a + 5]) * alpha;
					values[at + 6] = values[a + 6] + (values[b + 6] - values[a + 6]) * alpha;
				}
				if ((mask & 4) !== 0) {
					values[at + 7] = values[a + 7] + (values[b + 7] - values[a + 7]) * alpha;
					values[at + 8] = values[a + 8] + (values[b + 8] - values[a + 8]) * alpha;
					values[at + 9] = values[a + 9] + (values[b + 9] - values[a + 9]) * alpha;
				}
			}
		}
	}
	// #endregion

	return { trackCount, sampleCount, sampleRate, wraps, values };
};
