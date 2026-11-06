import { BinaryReader, FormatError } from '../binary/binary-reader.ts';

/** decoded Unity version-16 navigation tile; coordinates are local to its NavMeshData */
export interface NavTile {
	x: number;
	z: number;
	vertices: [number, number, number][];
	polygons: { vertices: number[]; neighbours: number[]; flags: number; area: number; type: number }[];
}

/**
 * @param bytes m_MeshData from a Unity NavMeshData tile
 * @returns polygon topology; external neighbour flags remain encoded, never guessed as links
 * @throws {FormatError} for unsupported versions, sizes or invalid topology
 */
export const readNavTile = (bytes: Uint8Array): NavTile => {
	const r = new BinaryReader(bytes, { littleEndian: true });
	if (r.u32() !== 0x444e4156 || r.u32() !== 16) {
		throw new FormatError('unsupported navigation tile');
	}
	const x = r.i32(),
		z = r.i32();
	r.u32();
	const counts = Array.from({ length: 6 }, () => r.u32());
	const [polygons, vertices, details, detailVertices, detailTriangles, bounds] = counts;
	const expected =
		72 +
		vertices * 12 +
		polygons * 32 +
		details * 12 +
		detailVertices * 12 +
		detailTriangles * 8 +
		bounds * 16;
	if (expected !== bytes.length || vertices > 65535 || details !== polygons) {
		throw new FormatError('invalid navigation tile size');
	}
	for (let i = 0; i < 7; i++) {
		if (!Number.isFinite(r.f32())) {
			throw new FormatError('invalid navigation tile bounds');
		}
	}
	const points: NavTile['vertices'] = Array.from({ length: vertices }, () => [r.f32(), r.f32(), r.f32()]);
	if (points.some((p) => !p.every(Number.isFinite))) {
		throw new FormatError('invalid navigation vertex');
	}
	const faces: NavTile['polygons'] = [];
	for (let i = 0; i < polygons; i++) {
		const indices = Array.from({ length: 6 }, () => r.u16());
		const neighbours = Array.from({ length: 6 }, () => r.u16());
		const flags = r.u32(),
			count = r.u8(),
			area = r.u8(),
			type = r.u16();
		if (
			count < 3 ||
			count > 6 ||
			indices.slice(0, count).some((v) => v >= vertices) ||
			neighbours.slice(0, count).some((n) => !(n & 0x8000) && n > polygons)
		) {
			throw new FormatError(
				`invalid navigation polygon ${i}: count=${count} indices=${indices.join(',')} neighbours=${neighbours.join(',')} total=${polygons}/${vertices}`,
			);
		}
		faces.push({
			vertices: indices.slice(0, count),
			neighbours: neighbours.slice(0, count),
			flags,
			area,
			type,
		});
	}
	return { x, z, vertices: points, polygons: faces };
};
