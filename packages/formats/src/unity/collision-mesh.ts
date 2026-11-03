import { BinaryReader, FormatError } from '../binary/binary-reader.ts';

// cooked triangle layout: NVIDIA PhysX, TriangleMeshBuilder::save and GuMeshData.h (BSD-3-Clause).
// https://github.com/NVIDIAGameWorks/PhysX/tree/4.1/physx/source/physxcooking/src/mesh
// this decoder reads geometry, not the acceleration structure's runtime pointers.

/** collision-only mesh in local coordinates; triangle order is the cooked order */
export interface CollisionMesh {
	vertices: [number, number, number][];
	triangles: [number, number, number][];
	/** original triangle indices, when the cook retained a remap */
	faceRemap: number[] | null;
	/** optional material indices, in cooked triangle order */
	materials: number[] | null;
	bounds: { min: [number, number, number]; max: [number, number, number] };
}

/**
 * @param bytes Unity m_BakedTriangleCollisionMesh bytes
 * @returns decoded local collision geometry, with no claim about scene placement or player collision masks
 * @throws {FormatError} for unsupported cooking formats, truncated data or invalid geometry
 */
export const readCollisionMesh = (bytes: Uint8Array): CollisionMesh => {
	const r = new BinaryReader(bytes, { littleEndian: true });
	if (r.utf8(3) !== 'NXS' || r.u8() !== 1 || r.utf8(4) !== 'MESH' || r.u32() !== 15 || r.u32() !== 1) {
		throw new FormatError('unsupported cooked collision mesh');
	}
	const flags = r.u32();
	if ((flags & ~31) !== 0 || (flags & 12) === 12) {
		throw new FormatError('unsupported collision mesh flags');
	}
	const vertexCount = r.u32(),
		triangleCount = r.u32();
	const width = flags & 4 ? 1 : flags & 8 ? 2 : 4;
	if (!vertexCount || !triangleCount || vertexCount * 12 + triangleCount * 3 * width > r.remaining) {
		throw new FormatError('invalid collision mesh counts');
	}
	const scalar = () => {
		const value = r.f32();
		if (!Number.isFinite(value)) {
			throw new FormatError('nonfinite collision mesh value');
		}
		return value;
	};
	const vector = (): [number, number, number] => [scalar(), scalar(), scalar()];
	const index = (size: number) => (size === 1 ? r.u8() : size === 2 ? r.u16() : r.u32());
	const vertices = Array.from({ length: vertexCount }, vector);
	const triangles = Array.from({ length: triangleCount }, (): [number, number, number] => {
		const face: [number, number, number] = [index(width), index(width), index(width)];
		if (face.some((i) => i >= vertexCount)) {
			throw new FormatError('invalid collision triangle index');
		}
		return face;
	});
	const materials = flags & 1 ? Array.from({ length: triangleCount }, () => r.u16()) : null;
	let faceRemap: number[] | null = null;
	if (flags & 2) {
		const max = r.u32(),
			remapWidth = max <= 255 ? 1 : max <= 65535 ? 2 : 4;
		faceRemap = Array.from({ length: triangleCount }, () => {
			const value = index(remapWidth);
			if (value > max) {
				throw new FormatError('invalid collision face remap');
			}
			return value;
		});
	}
	if (flags & 16) {
		r.skip(triangleCount * 12);
	}
	if (r.utf8(4) !== 'BV4 ' || r.u32() !== 3) {
		throw new FormatError('unsupported collision acceleration structure');
	}
	for (let i = 0; i < 4; i++) {
		scalar();
	}
	r.u32(); // tree root descriptor
	for (let i = 0; i < 6; i++) {
		scalar();
	}
	if (r.u32() !== 1) {
		throw new FormatError('unsupported nonquantized collision tree');
	}
	r.skip(r.u32() * 16);
	if (scalar() < 0) {
		throw new FormatError('negative collision epsilon');
	}
	const bounds = { min: vector(), max: vector() };
	if (
		bounds.min.some((v, i) => v > bounds.max[i]) ||
		vertices.some((v) => v.some((x, i) => x < bounds.min[i] - 1e-4 || x > bounds.max[i] + 1e-4))
	) {
		throw new FormatError('invalid collision mesh bounds');
	}
	const extra = r.u32();
	if (extra !== 0 && extra !== triangleCount) {
		throw new FormatError('invalid collision edge flag count');
	}
	r.skip(extra);
	if (r.remaining !== 0) {
		throw new FormatError('trailing collision mesh data');
	}
	return { vertices, triangles, faceRemap, materials, bounds };
};
