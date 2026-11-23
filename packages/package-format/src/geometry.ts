import { align4, enumGuard, viewOf } from './binary.ts';
import {
	checkStride,
	decodeContainer,
	encodeContainer,
	fourcc,
	requireSection,
	type ContainerSectionInput,
} from './container.ts';
import type { UnconvertedEntry } from './entries.ts';
import { PackageFormatError } from './errors.ts';
import type { Bounds } from './values.ts';

/**
 * what a geometry stream holds. the numbering is Unity's shader channel order, so `TexCoord0 + n` is UV set
 * `n` (the {@link TextureSlot.uv} of a material slot)
 */
export const VertexAttribute = {
	/**
	 * `unorm16x4` dequantized (`position = offset + value.xyz · scale`) when animated or when the span is at
	 * most 4 m (keeping quantization step ≤ 0.06 mm so coplanar trim stays separated), else `float32x4` with
	 * identity transform. `w` is the vertex's sway weight when a swaying material draws the mesh, else 0. the
	 * mesh's own frame (Unity, left-handed)
	 */
	Position: 0,
	/**
	 * `snorm16x2`: an octahedral unit vector `(x, y)`, dequantized first when the stream is flagged. decode in
	 * the shader: `n = (x, y, 1 - |x| - |y|)`; where `n.z < 0`, `n.xy = (1 - |n.yx|) · sign(n.xy)` (sign of 0
	 * taken as +1); normalize
	 */
	Normal: 1,
	/**
	 * `snorm8x4`: `xy` is the tangent, octahedral like {@link VertexAttribute.Normal}; `z` is the bitangent sign
	 * (±1). `bitangent = cross(normal, tangent) · sign`, in the mesh's frame; like Unity, multiply by the sign
	 * of the object-to-world determinant for mirrored instances. MikkTSpace tangents over UV set
	 * {@link GeometryEntry.tangentUv} unless the source mesh had its own
	 */
	Tangent: 2,
	/** `unorm8x4`, or `float16x4` when the source has values outside `[0, 1]` */
	Color: 3,
	/**
	 * UV sets 0–7: `unorm16x2` dequantized like positions when that keeps the error below 2^-13 (a span of at
	 * most 16), else `float32x2`; `snorm8x4` or `unorm8x4` where the source stores 8-bit normalized values (the
	 * game's UV2/UV3 on foliage), and `float32x4` for sets of more than two components. UVs are the game's,
	 * unflipped: texture row 0 is `v = 0`, matching how texel data is stored
	 */
	TexCoord0: 4,
	TexCoord7: 11,
	/**
	 * `unorm16x4`: a skinned vertex's four bone weights, summing to 1, for the blob's
	 * {@link GeometryBlob.animation}
	 */
	BlendWeight: 12,
	/**
	 * `uint8x4`, or `uint16x4` for an animation of more than 256 bones: the bones those weights belong to,
	 * indexing the animation's bones
	 */
	BlendIndices: 13,
} as const;

/** a {@link VertexAttribute} value; UV sets fill the range `TexCoord0`…`TexCoord7` */
export type VertexAttribute = number;

/**
 * a geometry stream's element format, indexing {@link GEOMETRY_VERTEX_FORMATS}. every format is a whole
 * WebGPU vertex format, and each stream is its own vertex buffer (stride = the format's size)
 */
export const GeometryVertexFormat = {
	Unorm16x4: 0,
	Snorm16x2: 1,
	Snorm8x4: 2,
	Unorm8x4: 3,
	Float16x4: 4,
	Unorm16x2: 5,
	Float32x2: 6,
	Float32x4: 7,
	Uint8x4: 8,
	Uint16x4: 9,
} as const;

export type GeometryVertexFormat = (typeof GeometryVertexFormat)[keyof typeof GeometryVertexFormat];

/** WebGPU name and byte size of each {@link GeometryVertexFormat} */
export const GEOMETRY_VERTEX_FORMATS: Record<GeometryVertexFormat, { gpu: string; size: number }> = {
	[GeometryVertexFormat.Unorm16x4]: { gpu: 'unorm16x4', size: 8 },
	[GeometryVertexFormat.Snorm16x2]: { gpu: 'snorm16x2', size: 4 },
	[GeometryVertexFormat.Snorm8x4]: { gpu: 'snorm8x4', size: 4 },
	[GeometryVertexFormat.Unorm8x4]: { gpu: 'unorm8x4', size: 4 },
	[GeometryVertexFormat.Float16x4]: { gpu: 'float16x4', size: 8 },
	[GeometryVertexFormat.Unorm16x2]: { gpu: 'unorm16x2', size: 4 },
	[GeometryVertexFormat.Float32x2]: { gpu: 'float32x2', size: 8 },
	[GeometryVertexFormat.Float32x4]: { gpu: 'float32x4', size: 16 },
	[GeometryVertexFormat.Uint8x4]: { gpu: 'uint8x4', size: 4 },
	[GeometryVertexFormat.Uint16x4]: { gpu: 'uint16x4', size: 8 },
};

/** geometry blob flag bits */
export const GeometryFlags = {
	/** indices are u32; otherwise u16 */
	IndexU32: 1 << 0,
	/** the tangent stream was generated (MikkTSpace) rather than taken from the source mesh */
	GeneratedTangents: 1 << 1,
} as const;

/** geometry stream flag bits */
export const GeometryStreamFlags = {
	/**
	 * apply `offset + value · scale` per component (up to three) to the value as the GPU reads it (normalized
	 * formats already in [0, 1] or [-1, 1]); position, unorm16 UVs and the game's packed normals use it
	 */
	Dequantize: 1 << 0,
} as const;

/**
 * a geometry blob's container. payloads are meshopt-encoded (meshoptimizer ≥ 1.0 codec, version 1): decode
 * each stream with `MeshoptDecoder.decodeVertexBuffer(target, vertexCount, stride, data)` and the indices
 * with `decodeIndexBuffer(target, indexCount, indexSize, data)`. no meshopt filters are used, so the decoded
 * bytes are the GPU vertex buffers as they are
 */
export interface GeometryBlob {
	/** {@link GeometryFlags} */
	flags: number;
	vertexCount: number;
	/** total indices over all submeshes */
	indexCount: number;
	streams: GeometryStream[];
	/** ranges of the index buffer; indices are local to each submesh's vertex range */
	submeshes: GeometrySubmesh[];
	/**
	 * meshopt-encoded index buffer of `indexCount` u16 or u32 ({@link GeometryFlags.IndexU32}) triangle-list
	 * indices
	 */
	indices: Uint8Array;
	/** the skeletal animation the mesh plays, or `null` for a mesh that holds still */
	animation: SkinAnimation | null;
}

/**
 * a looping skeletal animation, sampled at the clip's frames. a geometry with one stores its positions,
 * normals and tangents in the mesh's bind space, with {@link VertexAttribute.BlendWeight} and
 * {@link VertexAttribute.BlendIndices} streams; at time `t` (seconds) its frame is `(t · frameRate) mod
 * frameCount`, linearly interpolated (the last frame blends into the first), and each vertex moves to `Σ
 * weight · matrix(bone) · bindPosition`
 */
export interface SkinAnimation {
	boneCount: number;
	frameCount: number;
	/** frames per second */
	frameRate: number;
	/** every frame's skinned positions lie in `offset + [0, 1]³ · scale`, a box to quantize them to */
	offset: [x: number, y: number, z: number];
	scale: [x: number, y: number, z: number];
	/**
	 * `frameCount × boneCount` matrices, frame-major, as rows3x4 (12 floats): from the mesh's bind space to the
	 * space the geometry is drawn in, bind pose included
	 */
	matrices: Float32Array;
}

/** one vertex buffer of a {@link GeometryBlob} */
export interface GeometryStream {
	/** {@link VertexAttribute} */
	attribute: VertexAttribute;
	format: GeometryVertexFormat;
	/** {@link GeometryStreamFlags} */
	flags: number;
	/** dequantization for {@link GeometryStreamFlags.Dequantize}: `offset + value · scale`, per component */
	offset: [x: number, y: number, z: number];
	scale: [x: number, y: number, z: number];
	/** meshopt-encoded `vertexCount × stride` bytes */
	data: Uint8Array;
}

/**
 * a submesh: what a {@link ChainDraw.submesh} draws. one `drawIndexed(indexCount, …, firstIndex, baseVertex)`;
 * the submesh's vertices are `[baseVertex, baseVertex + vertexCount)`, contiguous and owned by it alone, so
 * the indices fit u16 whenever every submesh has at most 65,536 vertices
 */
export interface GeometrySubmesh {
	firstIndex: number;
	indexCount: number;
	baseVertex: number;
	vertexCount: number;
	/** the submesh's local bounds, from the game */
	bounds: Bounds;
}

/** one mesh asset, an entry of the geometry table (`geometry-table`) */
export type GeometryEntry = UnconvertedEntry | ReadyGeometry;

/** a converted mesh */
export interface ReadyGeometry {
	status: 'ready';
	/** the {@link BlobKind.Geometry} blob */
	blob: number;
	/** local bounds of the vertices */
	bounds: Bounds;
	vertexCount: number;
	indexCount: number;
	submeshCount: number;
	/** bit `a` set when the blob has a stream for {@link VertexAttribute} `a` */
	attributes: number;
	/** the UV set tangents were generated from, or `null` without generated tangents */
	tangentUv: number | null;
	/** frames of the blob's {@link SkinAnimation}, `null` for a geometry that holds still */
	animationFrames: number | null;
}

const MAGIC = fourcc('EFGM');
const MAJOR_VERSION = 2;
const TAG_HEAD = fourcc('HEAD');
const TAG_STRM = fourcc('STRM');
const TAG_SUBM = fourcc('SUBM');
const TAG_VBUF = fourcc('VBUF');
const TAG_IBUF = fourcc('IBUF');
const TAG_ANIM = fourcc('ANIM');
const KNOWN_TAGS = new Set([TAG_HEAD, TAG_STRM, TAG_SUBM, TAG_VBUF, TAG_IBUF, TAG_ANIM]);

const HEAD_SIZE = 16;
const STREAM_SIZE = 36;
const SUBMESH_SIZE = 40;
const ANIMATION_HEADER_SIZE = 32;

const isGeometryVertexFormat = enumGuard(GeometryVertexFormat);

/**
 * encodes a geometry blob (`.mesh`) as an `EFGM` v2 TLV container
 *
 * @param blob the container; payloads are stored as given
 * @returns the encoded blob
 * @throws {RangeError} on more than 65,535 streams, submeshes, bones or frames, or animation matrices that
 *   don't match its counts
 */
export const encodeGeometryBlob = (blob: GeometryBlob): Uint8Array => {
	if (blob.streams.length > 0xff_ff || blob.submeshes.length > 0xff_ff) {
		throw new RangeError('geometry has more than 65,535 streams or submeshes');
	}
	const { animation } = blob;
	if (
		animation !== null &&
		(animation.boneCount > 0xff_ff ||
			animation.frameCount > 0xff_ff ||
			animation.matrices.length !== animation.boneCount * animation.frameCount * 12)
	) {
		throw new RangeError('geometry animation counts are out of range or disagree with its matrices');
	}

	const head = new Uint8Array(HEAD_SIZE);
	const hv = viewOf(head);
	hv.setUint16(0, blob.flags, true);
	hv.setUint32(4, blob.vertexCount, true);
	hv.setUint32(8, blob.indexCount, true);

	const vbufSize = blob.streams.reduce((sum, s) => sum + align4(s.data.byteLength), 0);
	const vbuf = new Uint8Array(vbufSize);
	const strmBuf = new Uint8Array(blob.streams.length * STREAM_SIZE);
	const sv = viewOf(strmBuf);
	let vAt = 0;
	for (const [i, stream] of blob.streams.entries()) {
		const at = i * STREAM_SIZE;
		sv.setUint8(at, stream.attribute);
		sv.setUint8(at + 1, stream.format);
		sv.setUint8(at + 2, stream.flags);
		sv.setUint32(at + 4, vAt, true);
		sv.setUint32(at + 8, stream.data.byteLength, true);
		for (let axis = 0; axis < 3; axis++) {
			sv.setFloat32(at + 12 + axis * 4, stream.offset[axis], true);
			sv.setFloat32(at + 24 + axis * 4, stream.scale[axis], true);
		}
		vbuf.set(stream.data, vAt);
		vAt += align4(stream.data.byteLength);
	}

	const submBuf = new Uint8Array(blob.submeshes.length * SUBMESH_SIZE);
	const mv = viewOf(submBuf);
	for (const [i, submesh] of blob.submeshes.entries()) {
		const at = i * SUBMESH_SIZE;
		mv.setUint32(at, submesh.firstIndex, true);
		mv.setUint32(at + 4, submesh.indexCount, true);
		mv.setUint32(at + 8, submesh.baseVertex, true);
		mv.setUint32(at + 12, submesh.vertexCount, true);
		for (let axis = 0; axis < 3; axis++) {
			mv.setFloat32(at + 16 + axis * 4, submesh.bounds.min[axis], true);
			mv.setFloat32(at + 28 + axis * 4, submesh.bounds.max[axis], true);
		}
	}

	const sections: ContainerSectionInput[] = [
		{ tag: TAG_HEAD, required: true, data: head },
		{ tag: TAG_STRM, required: true, data: strmBuf, count: blob.streams.length, stride: STREAM_SIZE },
		{ tag: TAG_SUBM, required: true, data: submBuf, count: blob.submeshes.length, stride: SUBMESH_SIZE },
		{ tag: TAG_VBUF, required: true, data: vbuf },
		{ tag: TAG_IBUF, required: true, data: blob.indices },
	];

	if (animation !== null) {
		const animBuf = new Uint8Array(ANIMATION_HEADER_SIZE + animation.matrices.byteLength);
		const av = viewOf(animBuf);
		av.setUint16(0, animation.boneCount, true);
		av.setUint16(2, animation.frameCount, true);
		av.setFloat32(4, animation.frameRate, true);
		for (let axis = 0; axis < 3; axis++) {
			av.setFloat32(8 + axis * 4, animation.offset[axis], true);
			av.setFloat32(20 + axis * 4, animation.scale[axis], true);
		}
		animBuf.set(
			new Uint8Array(animation.matrices.buffer, animation.matrices.byteOffset, animation.matrices.byteLength),
			ANIMATION_HEADER_SIZE,
		);
		sections.push({ tag: TAG_ANIM, required: false, data: animBuf });
	}

	return encodeContainer({ magic: MAGIC, majorVersion: MAJOR_VERSION, sections });
};

/**
 * decodes a geometry blob (`.mesh`, `EFGM` v2 TLV container)
 *
 * @param data a geometry blob
 * @returns its container; payloads are views into `data`
 * @throws {PackageFormatError} on a bad header, an unknown vertex format or a length mismatch
 */
export const decodeGeometryBlob = (data: Uint8Array): GeometryBlob => {
	const container = decodeContainer(data, {
		magic: MAGIC,
		majorVersion: MAJOR_VERSION,
		knownTags: KNOWN_TAGS,
		label: 'geometry blob',
	});
	const head = requireSection(container, TAG_HEAD, 'geometry blob');
	if (head.byteLength < HEAD_SIZE) {
		throw new PackageFormatError('geometry blob HEAD is too short');
	}
	const hv = viewOf(head.data);
	const flags = hv.getUint16(0, true);
	const vertexCount = hv.getUint32(4, true);
	const indexCount = hv.getUint32(8, true);

	const strmSec = requireSection(container, TAG_STRM, 'geometry blob');
	const submSec = requireSection(container, TAG_SUBM, 'geometry blob');
	const vbufSec = requireSection(container, TAG_VBUF, 'geometry blob');
	const ibufSec = requireSection(container, TAG_IBUF, 'geometry blob');
	checkStride(strmSec, STREAM_SIZE, 'STRM');
	checkStride(submSec, SUBMESH_SIZE, 'SUBM');

	const sv = viewOf(strmSec.data);
	const streams: GeometryStream[] = [];
	for (let s = 0; s < strmSec.count; s++) {
		const at = s * strmSec.stride;
		const format = sv.getUint8(at + 1);
		if (!isGeometryVertexFormat(format)) {
			throw new PackageFormatError(`geometry stream ${s} has unknown vertex format ${format}`);
		}
		const offset = sv.getUint32(at + 4, true);
		const length = sv.getUint32(at + 8, true);
		if (offset + length > vbufSec.byteLength) {
			throw new PackageFormatError(`geometry stream ${s} runs past VBUF`);
		}
		const f = (o: number): number => sv.getFloat32(at + o, true);
		streams.push({
			attribute: sv.getUint8(at),
			format,
			flags: sv.getUint8(at + 2),
			offset: [f(12), f(16), f(20)],
			scale: [f(24), f(28), f(32)],
			data: vbufSec.data.subarray(offset, offset + length),
		});
	}

	const mv = viewOf(submSec.data);
	const submeshes: GeometrySubmesh[] = [];
	for (let s = 0; s < submSec.count; s++) {
		const at = s * submSec.stride;
		const f = (o: number): number => mv.getFloat32(at + o, true);
		submeshes.push({
			firstIndex: mv.getUint32(at, true),
			indexCount: mv.getUint32(at + 4, true),
			baseVertex: mv.getUint32(at + 8, true),
			vertexCount: mv.getUint32(at + 12, true),
			bounds: { min: [f(16), f(20), f(24)], max: [f(28), f(32), f(36)] },
		});
	}

	let animation: SkinAnimation | null = null;
	const animSec = container.sections.get(TAG_ANIM);
	if (animSec !== undefined) {
		if (animSec.byteLength < ANIMATION_HEADER_SIZE) {
			throw new PackageFormatError('geometry ANIM section is too short');
		}
		const av = viewOf(animSec.data);
		const boneCount = av.getUint16(0, true);
		const frameCount = av.getUint16(2, true);
		const count = boneCount * frameCount * 12;
		if (animSec.byteLength !== ANIMATION_HEADER_SIZE + count * 4) {
			throw new PackageFormatError('geometry animation length disagrees with its counts');
		}
		const f = (o: number): number => av.getFloat32(o, true);
		const raw = animSec.data.subarray(ANIMATION_HEADER_SIZE, animSec.byteLength);
		const matrices =
			(raw.byteOffset & 3) === 0
				? new Float32Array(raw.buffer, raw.byteOffset, count)
				: new Float32Array(raw.slice().buffer);
		animation = {
			boneCount,
			frameCount,
			frameRate: f(4),
			offset: [f(8), f(12), f(16)],
			scale: [f(20), f(24), f(28)],
			matrices,
		};
	}

	return {
		flags,
		vertexCount,
		indexCount,
		streams,
		submeshes,
		indices: ibufSec.data,
		animation,
	};
};
