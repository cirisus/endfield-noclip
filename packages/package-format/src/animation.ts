/**
 * unified binary motion / animation blob (`.anim`, `EFAN` TLV container): covers skeletal skinning, rigid
 * transform paths, analytic spins, water-volume floats, VAT clips, and typed material parameter tracks
 *
 * @module
 */

import { checkedEnum, enumGuard, viewOf } from './binary.ts';
import {
	decodeContainer,
	encodeContainer,
	fourcc,
	requireSection,
	sectionF32,
	type ContainerSectionInput,
} from './container.ts';
import { PackageFormatError } from './errors.ts';
import type { Bounds, Vec3 } from './values.ts';

/** kind of animation stored in an `.anim` blob */
export const AnimationKind = {
	Skin: 0,
	Transform: 1,
	Spin: 2,
	WaterFloat: 3,
	Vat: 4,
	Material: 5,
} as const;

export type AnimationKind = (typeof AnimationKind)[keyof typeof AnimationKind];

/** animation blob flag bits */
export const AnimationFlags = {
	/** wrap time modulo `duration` */
	Loop: 1 << 0,
	/** transform/motion operates in world space rather than local space */
	WorldSpace: 1 << 1,
	/** step between frames without linear interpolation */
	Stepped: 1 << 2,
	/** for `Transform`: frames store `f32×3` translation offsets instead of `f32×12` `rows3x4` */
	TranslationOnly: 1 << 3,
} as const;

/** typed material parameter targets for `Material` animation tracks (replaces JSONPath strings) */
export const MaterialParamId = {
	BaseColorTint: 0,
	EmissiveColor: 1,
	EmissiveIntensity: 2,
	AlphaClip: 3,
	Dissolve: 4,
	Opacity: 5,
	UvOffset0: 6,
	UvOffset1: 7,
	UvScale0: 8,
	UvScale1: 9,
	Roughness: 10,
	Metallic: 11,
	CustomFloat0: 12,
	CustomFloat1: 13,
	CustomVec0: 14,
	CustomVec1: 15,
} as const;

export type MaterialParamId = (typeof MaterialParamId)[keyof typeof MaterialParamId];

/** shared header fields on every {@link AnimationBlob} */
export interface AnimationBase {
	/** {@link AnimationFlags} */
	flags: number;
	/** clip duration in seconds (0 for analytic `Spin` / `WaterFloat`) */
	duration: number;
	/** sampled frames per second (0 for analytic) */
	frameRate: number;
	/** frame count (0 for analytic) */
	frameCount: number;
}

/** skeletal animation clip, decoupled from `.mesh` so one bind-pose mesh shares clips across placements */
export interface SkinAnimationBlob extends AnimationBase {
	kind: typeof AnimationKind.Skin;
	boneCount: number;
	/** local bounds enclosing all skinned frames */
	bounds: Bounds;
	/** `frameCount × boneCount` `rows3x4` matrices (12 f32 each), frame-major */
	matrices: Float32Array;
}

/** sampled rigid transform clip (unifies `RowPath`, rigid looping clips, and `ParticleEmitterMotion`) */
export interface TransformAnimationBlob extends AnimationBase {
	kind: typeof AnimationKind.Transform;
	/**
	 * `frameCount × 3` translation offsets when {@link AnimationFlags.TranslationOnly} is set, else `frameCount
	 * × 12` `rows3x4` matrices
	 */
	frames: Float32Array;
}

/** analytic rotation about a pivot and unit axis */
export interface SpinAnimationBlob extends AnimationBase {
	kind: typeof AnimationKind.Spin;
	pivot: Vec3;
	axis: Vec3;
	/** radians per second */
	speed: number;
}

/** vertical float tracking a water volume's fill height */
export interface WaterFloatAnimationBlob extends AnimationBase {
	kind: typeof AnimationKind.WaterFloat;
	/** index into `WaterTable.volumes` */
	waterVolume: number;
	/** vertical offset from surface, metres */
	offset: number;
	/** smoothing lag in seconds (0 = rigid) */
	lag: number;
}

/** vertex animation texture clip referencing GPU textures directly (no skeletal matrix expansion) */
export interface VatAnimationBlob extends AnimationBase {
	kind: typeof AnimationKind.Vat;
	/** texture table index for position VAT */
	posTexture: number;
	/** texture table index for normal VAT, or `0xffffffff` if none */
	normalTexture: number;
	/** position decode bounds */
	posMin: Vec3;
	posMax: Vec3;
}

/** one animated material parameter track */
export interface MaterialAnimationTrack {
	paramId: MaterialParamId;
	/** 1–4 float components per frame */
	components: number;
	/** bit 0 = stepped (hold frame) */
	flags: number;
	/** `frameCount × components` floats */
	samples: Float32Array;
}

/** material property animation clip */
export interface MaterialAnimationBlob extends AnimationBase {
	kind: typeof AnimationKind.Material;
	tracks: MaterialAnimationTrack[];
}

/** decoded `.anim` blob */
export type AnimationBlob =
	| SkinAnimationBlob
	| TransformAnimationBlob
	| SpinAnimationBlob
	| WaterFloatAnimationBlob
	| VatAnimationBlob
	| MaterialAnimationBlob;

const MAGIC = fourcc('EFAN');
const MAJOR_VERSION = 2;

const TAG_HEAD = fourcc('HEAD');
const TAG_SKIN = fourcc('SKIN');
const TAG_TRNS = fourcc('TRNS');
const TAG_SPIN = fourcc('SPIN');
const TAG_FLOT = fourcc('FLOT');
const TAG_VATC = fourcc('VATC');
const TAG_MATR = fourcc('MATR');
const TAG_MSMP = fourcc('MSMP');

const KNOWN_TAGS = new Set([TAG_HEAD, TAG_SKIN, TAG_TRNS, TAG_SPIN, TAG_FLOT, TAG_VATC, TAG_MATR, TAG_MSMP]);

const HEAD_SIZE = 20;
const SKIN_HEADER_SIZE = 28;
const SPIN_SIZE = 28;
const FLOT_SIZE = 12;
const VATC_SIZE = 40;
const MATR_TRACK_SIZE = 8;

const isAnimationKind = enumGuard(AnimationKind);
const isMaterialParamId = enumGuard(MaterialParamId);

/**
 * encodes an {@link AnimationBlob} into an `EFAN` TLV container
 *
 * @param clip animation clip to encode
 * @returns encoded `.anim` bytes
 * @throws {RangeError} if counts disagree with array lengths
 */
export const encodeAnimationBlob = (clip: AnimationBlob): Uint8Array => {
	const head = new Uint8Array(HEAD_SIZE);
	const hv = viewOf(head);
	hv.setUint8(0, clip.kind);
	hv.setUint8(1, clip.flags);
	hv.setFloat32(4, clip.duration, true);
	hv.setFloat32(8, clip.frameRate, true);
	hv.setUint32(12, clip.frameCount, true);

	const sections: ContainerSectionInput[] = [{ tag: TAG_HEAD, required: true, data: head }];

	switch (clip.kind) {
		case AnimationKind.Skin: {
			if (clip.matrices.length !== clip.frameCount * clip.boneCount * 12) {
				throw new RangeError('skin animation matrices length disagrees with frameCount × boneCount × 12');
			}
			const buf = new Uint8Array(SKIN_HEADER_SIZE + clip.matrices.byteLength);
			const v = viewOf(buf);
			v.setUint16(0, clip.boneCount, true);
			for (let i = 0; i < 3; i++) {
				v.setFloat32(4 + i * 4, clip.bounds.min[i], true);
				v.setFloat32(16 + i * 4, clip.bounds.max[i], true);
			}
			buf.set(
				new Uint8Array(clip.matrices.buffer, clip.matrices.byteOffset, clip.matrices.byteLength),
				SKIN_HEADER_SIZE,
			);
			sections.push({ tag: TAG_SKIN, required: true, data: buf, count: clip.frameCount });
			break;
		}
		case AnimationKind.Transform: {
			const strideFloats = (clip.flags & AnimationFlags.TranslationOnly) !== 0 ? 3 : 12;
			if (clip.frames.length !== clip.frameCount * strideFloats) {
				throw new RangeError('transform animation frames length disagrees with frameCount');
			}
			sections.push({
				tag: TAG_TRNS,
				required: true,
				data: new Uint8Array(clip.frames.buffer, clip.frames.byteOffset, clip.frames.byteLength),
				count: clip.frameCount,
				stride: strideFloats * 4,
			});
			break;
		}
		case AnimationKind.Spin: {
			const buf = new Uint8Array(SPIN_SIZE);
			const v = viewOf(buf);
			for (let i = 0; i < 3; i++) {
				v.setFloat32(i * 4, clip.pivot[i], true);
				v.setFloat32(12 + i * 4, clip.axis[i], true);
			}
			v.setFloat32(24, clip.speed, true);
			sections.push({ tag: TAG_SPIN, required: true, data: buf });
			break;
		}
		case AnimationKind.WaterFloat: {
			const buf = new Uint8Array(FLOT_SIZE);
			const v = viewOf(buf);
			v.setUint32(0, clip.waterVolume, true);
			v.setFloat32(4, clip.offset, true);
			v.setFloat32(8, clip.lag, true);
			sections.push({ tag: TAG_FLOT, required: true, data: buf });
			break;
		}
		case AnimationKind.Vat: {
			const buf = new Uint8Array(VATC_SIZE);
			const v = viewOf(buf);
			v.setUint32(0, clip.posTexture, true);
			v.setUint32(4, clip.normalTexture, true);
			for (let i = 0; i < 3; i++) {
				v.setFloat32(8 + i * 4, clip.posMin[i], true);
				v.setFloat32(20 + i * 4, clip.posMax[i], true);
			}
			v.setFloat32(32, clip.frameRate, true);
			v.setUint32(36, clip.frameCount, true);
			sections.push({ tag: TAG_VATC, required: true, data: buf });
			break;
		}
		case AnimationKind.Material: {
			let totalFloats = 0;
			for (const track of clip.tracks) {
				if (track.samples.length !== clip.frameCount * track.components) {
					throw new RangeError('material track samples length disagrees with frameCount × components');
				}
				totalFloats += track.samples.length;
			}
			const headers = new Uint8Array(clip.tracks.length * MATR_TRACK_SIZE);
			const hv2 = viewOf(headers);
			const samples = new Float32Array(totalFloats);
			let cursor = 0;
			for (const [i, track] of clip.tracks.entries()) {
				const at = i * MATR_TRACK_SIZE;
				hv2.setUint16(at, track.paramId, true);
				hv2.setUint8(at + 2, track.components);
				hv2.setUint8(at + 3, track.flags);
				hv2.setUint32(at + 4, cursor, true);
				samples.set(track.samples, cursor);
				cursor += track.samples.length;
			}
			sections.push(
				{ tag: TAG_MATR, required: true, data: headers, count: clip.tracks.length, stride: MATR_TRACK_SIZE },
				{
					tag: TAG_MSMP,
					required: true,
					data: new Uint8Array(samples.buffer),
					count: totalFloats,
					stride: 4,
				},
			);
			break;
		}
	}

	return encodeContainer({ magic: MAGIC, majorVersion: MAJOR_VERSION, sections });
};

/**
 * decodes an `EFAN` TLV animation blob
 *
 * @param data `.anim` bytes
 * @returns decoded animation clip
 * @throws {PackageFormatError} on invalid container, kind, or payload sizes
 */
export const decodeAnimationBlob = (data: Uint8Array): AnimationBlob => {
	const container = decodeContainer(data, {
		magic: MAGIC,
		majorVersion: MAJOR_VERSION,
		knownTags: KNOWN_TAGS,
		label: 'animation blob',
	});
	const head = requireSection(container, TAG_HEAD, 'animation blob');
	if (head.byteLength < HEAD_SIZE) {
		throw new PackageFormatError('animation HEAD section is too short');
	}
	const hv = viewOf(head.data);
	const kind = checkedEnum(isAnimationKind, hv.getUint8(0), 'animation kind');
	const base: AnimationBase = {
		flags: hv.getUint8(1),
		duration: hv.getFloat32(4, true),
		frameRate: hv.getFloat32(8, true),
		frameCount: hv.getUint32(12, true),
	};

	switch (kind) {
		case AnimationKind.Skin: {
			const sec = requireSection(container, TAG_SKIN, 'animation blob');
			if (sec.byteLength < SKIN_HEADER_SIZE) {
				throw new PackageFormatError('animation SKIN section is too short');
			}
			const v = viewOf(sec.data);
			const boneCount = v.getUint16(0, true);
			const f = (o: number): number => v.getFloat32(o, true);
			const expectedFloats = base.frameCount * boneCount * 12;
			if (sec.byteLength < SKIN_HEADER_SIZE + expectedFloats * 4) {
				throw new PackageFormatError('animation SKIN matrices truncated');
			}
			const raw = sec.data.subarray(SKIN_HEADER_SIZE, SKIN_HEADER_SIZE + expectedFloats * 4);
			const matrices =
				(raw.byteOffset & 3) === 0
					? new Float32Array(raw.buffer, raw.byteOffset, expectedFloats)
					: new Float32Array(raw.slice().buffer);
			return {
				...base,
				kind,
				boneCount,
				bounds: { min: [f(4), f(8), f(12)], max: [f(16), f(20), f(24)] },
				matrices,
			};
		}
		case AnimationKind.Transform: {
			const sec = requireSection(container, TAG_TRNS, 'animation blob');
			const strideFloats = (base.flags & AnimationFlags.TranslationOnly) !== 0 ? 3 : 12;
			const frames = sectionF32(sec);
			if (frames.length < base.frameCount * strideFloats) {
				throw new PackageFormatError('animation TRNS frames truncated');
			}
			return { ...base, kind, frames: frames.subarray(0, base.frameCount * strideFloats) };
		}
		case AnimationKind.Spin: {
			const sec = requireSection(container, TAG_SPIN, 'animation blob');
			if (sec.byteLength < SPIN_SIZE) {
				throw new PackageFormatError('animation SPIN section is too short');
			}
			const v = viewOf(sec.data);
			const f = (o: number): number => v.getFloat32(o, true);
			return { ...base, kind, pivot: [f(0), f(4), f(8)], axis: [f(12), f(16), f(20)], speed: f(24) };
		}
		case AnimationKind.WaterFloat: {
			const sec = requireSection(container, TAG_FLOT, 'animation blob');
			if (sec.byteLength < FLOT_SIZE) {
				throw new PackageFormatError('animation FLOT section is too short');
			}
			const v = viewOf(sec.data);
			return {
				...base,
				kind,
				waterVolume: v.getUint32(0, true),
				offset: v.getFloat32(4, true),
				lag: v.getFloat32(8, true),
			};
		}
		case AnimationKind.Vat: {
			const sec = requireSection(container, TAG_VATC, 'animation blob');
			if (sec.byteLength < VATC_SIZE) {
				throw new PackageFormatError('animation VATC section is too short');
			}
			const v = viewOf(sec.data);
			const f = (o: number): number => v.getFloat32(o, true);
			return {
				...base,
				kind,
				posTexture: v.getUint32(0, true),
				normalTexture: v.getUint32(4, true),
				posMin: [f(8), f(12), f(16)],
				posMax: [f(20), f(24), f(28)],
			};
		}
		case AnimationKind.Material: {
			const sec = requireSection(container, TAG_MATR, 'animation blob');
			const smps = sectionF32(requireSection(container, TAG_MSMP, 'animation blob'));
			const stride = sec.stride || MATR_TRACK_SIZE;
			if (stride < MATR_TRACK_SIZE || sec.byteLength < sec.count * stride) {
				throw new PackageFormatError('animation MATR section is malformed');
			}
			const v = viewOf(sec.data);
			const tracks: MaterialAnimationTrack[] = [];
			for (let i = 0; i < sec.count; i++) {
				const at = i * stride;
				const paramId = checkedEnum(isMaterialParamId, v.getUint16(at, true), 'material param id');
				const components = v.getUint8(at + 2);
				const flags = v.getUint8(at + 3);
				const firstFloat = v.getUint32(at + 4, true);
				const length = base.frameCount * components;
				if (firstFloat + length > smps.length) {
					throw new PackageFormatError(`material track ${i} samples run past MSMP`);
				}
				tracks.push({ paramId, components, flags, samples: smps.subarray(firstFloat, firstFloat + length) });
			}
			return { ...base, kind, tracks };
		}
	}
};

/**
 * evaluates a {@link TransformAnimationBlob} at `time` (seconds) into `out` (length 3 for `TranslationOnly`,
 * else 12)
 *
 * @param clip transform animation clip
 * @param time time in seconds
 * @param out destination float buffer
 * @returns `out`
 */
export const sampleTransformClip = <T extends Float32Array | number[]>(
	clip: TransformAnimationBlob,
	time: number,
	out: T,
): T => {
	const count = clip.frameCount;
	const stride = (clip.flags & AnimationFlags.TranslationOnly) !== 0 ? 3 : 12;
	const raw = time * clip.frameRate;
	const at =
		(clip.flags & AnimationFlags.Loop) !== 0
			? ((raw % count) + count) % count
			: Math.max(0, Math.min(count - 1, raw));
	const frame = Math.min(Math.floor(at), count - 1);
	const blend = (clip.flags & AnimationFlags.Stepped) !== 0 ? 0 : at - frame;
	const next =
		(clip.flags & AnimationFlags.Loop) !== 0 ? (frame + 1) % count : Math.min(frame + 1, count - 1);
	const a = frame * stride;
	const b = next * stride;
	for (let i = 0; i < stride; i++) {
		out[i] = clip.frames[a + i] + (clip.frames[b + i] - clip.frames[a + i]) * blend;
	}
	return out;
};
