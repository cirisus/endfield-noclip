import { BinaryReader, FormatError } from '../binary/binary-reader.ts';

import type { CollisionMesh } from './collision-mesh.ts';

// layout reference: NVIDIA PhysX ConvexMeshBuilder::save / ConvexHullBuilder::save /
// BigConvexDataBuilder::save (BSD-3-Clause).
// https://github.com/NVIDIAGameWorks/PhysX/tree/4.1/physx/source/physxcooking/src/convex

/**
 * @param bytes Unity m_BakedConvexCollisionMesh bytes
 * @returns a triangulated local convex hull; triangles face outward and have no original-triangle remap
 * @throws {FormatError} for unsupported cooks, malformed hulls or incomplete payloads
 */
export const readConvexMesh = (bytes: Uint8Array): CollisionMesh => {
	const r = new BinaryReader(bytes, { littleEndian: true });
	if (
		r.utf8(3) !== 'NXS' ||
		r.u8() !== 1 ||
		r.utf8(4) !== 'CVXM' ||
		r.u32() !== 13 ||
		r.u32() !== 0 ||
		r.utf8(3) !== 'ICE' ||
		r.u8() !== 1 ||
		r.utf8(4) !== 'CLHL' ||
		r.u32() !== 9
	) {
		throw new FormatError('unsupported cooked convex mesh');
	}
	const vertexCount = r.u32(),
		edgeCount = r.u32(),
		polygonCount = r.u32(),
		indexCount = r.u32();
	if (
		vertexCount < 4 ||
		vertexCount > 255 ||
		polygonCount < 4 ||
		polygonCount > 255 ||
		edgeCount > 32767 ||
		vertexCount - edgeCount + polygonCount !== 2 ||
		indexCount !== edgeCount * 2
	) {
		throw new FormatError('invalid or unsupported convex hull counts');
	}
	const scalar = () => {
		const n = r.f32();
		if (!Number.isFinite(n)) {
			throw new FormatError('nonfinite convex hull value');
		}
		return n;
	};
	const vector = (): [number, number, number] => [scalar(), scalar(), scalar()];
	const vertices = Array.from({ length: vertexCount }, vector);
	const polygons = Array.from({ length: polygonCount }, () => {
		const normal = vector(),
			distance = scalar(),
			offset = r.u16(),
			count = r.u8(),
			minIndex = r.u8();
		if (
			count < 3 ||
			offset + count > indexCount ||
			minIndex >= vertexCount ||
			Math.abs(Math.hypot(...normal) - 1) > 1e-4
		) {
			throw new FormatError('invalid convex polygon');
		}
		return { normal, distance, offset, count };
	});
	const indices = r.bytesView(indexCount);
	if (indices.some((i) => i >= vertexCount)) {
		throw new FormatError('invalid convex vertex index');
	}
	const adjacent = r.bytesView(edgeCount * 2 + vertexCount * 3);
	if (adjacent.some((i) => i >= polygonCount)) {
		throw new FormatError('invalid convex face index');
	}
	scalar(); // reserved geometry epsilon
	const bounds = { min: vector(), max: vector() };
	if (
		bounds.min.some((v, i) => v > bounds.max[i]) ||
		vertices.some((v) => v.some((x, i) => x < bounds.min[i] - 1e-4 || x > bounds.max[i] + 1e-4))
	) {
		throw new FormatError('invalid convex bounds');
	}
	for (let i = 0; i < 13; i++) {
		scalar();
	} // mass, inertia and centre of mass
	let supportAdjacency: { counts: number[]; vertices: Uint8Array } | null = null;
	const supportFlag = scalar();
	if (supportFlag === 1) {
		// Large hulls optionally carry Gauss-map hill-climbing seeds and vertex
		// adjacency. They accelerate support queries without changing hull geometry.
		const header = (tag: string, version: number) => {
			if (r.utf8(3) !== 'ICE' || r.u8() !== 1 || r.utf8(4) !== tag || r.u32() !== version) {
				throw new FormatError('unsupported convex support-map header');
			}
		};
		header('SUPM', 0);
		header('GAUS', 0);
		const subdivision = r.u32(),
			sampleCount = r.u32();
		if (subdivision < 2 || sampleCount > 65535 || sampleCount !== 6 * subdivision * subdivision) {
			throw new FormatError('invalid convex support-map sample count');
		}
		if (r.bytesView(sampleCount * 2).some((index) => index >= vertexCount)) {
			throw new FormatError('invalid convex support-map vertex index');
		}
		header('VALE', 2);
		const supportVertices = r.u32(),
			adjacencyCount = r.u32(),
			maximumValency = r.u32();
		if (supportVertices !== vertexCount || adjacencyCount !== edgeCount * 2 || maximumValency > 65535) {
			throw new FormatError('invalid convex support-map adjacency counts');
		}
		const counts = Array.from({ length: vertexCount }, () => (maximumValency <= 255 ? r.u8() : r.u16()));
		if (
			counts.some((count) => count < 1 || count >= vertexCount) ||
			Math.max(...counts) !== maximumValency ||
			counts.reduce((sum, count) => sum + count, 0) !== adjacencyCount
		) {
			throw new FormatError('invalid convex support-map valencies');
		}
		const adjacentVertices = r.bytesView(adjacencyCount);
		if (adjacentVertices.some((index) => index >= vertexCount)) {
			throw new FormatError('invalid convex support-map adjacent vertex');
		}
		supportAdjacency = { counts, vertices: adjacentVertices };
	} else if (supportFlag !== -1) {
		throw new FormatError('unsupported convex support map');
	}
	for (let i = 0; i < 4; i++) {
		if (scalar() < 0) {
			throw new FormatError('invalid convex internal bounds');
		}
	}
	if (r.remaining !== 0) {
		throw new FormatError('trailing convex mesh data');
	}
	const triangles: CollisionMesh['triangles'] = [];
	// Cooked faces can retain slightly noncoplanar vertices after polygon merging.
	// Use the size-scaled tolerance from PhysX checkHullPolygons, while also bounding
	// the face's own vertices rather than assuming an exact supporting plane.
	const tolerance = Math.max(
		0.02,
		0.02 * [0, 1, 2].reduce((sum, axis) => sum + Math.max(...vertices.map((v) => Math.abs(v[axis]))), 0),
	);
	const edges = new Map<string, number>();
	for (const p of polygons) {
		const face = Array.from(indices.subarray(p.offset, p.offset + p.count));
		if (
			new Set(face).size !== face.length ||
			vertices.some((v) => v.reduce((n, x, i) => n + x * p.normal[i], p.distance) > tolerance) ||
			face.some((i) => Math.abs(vertices[i].reduce((n, x, j) => n + x * p.normal[j], p.distance)) > tolerance)
		) {
			throw new FormatError('invalid convex supporting plane');
		}
		for (let i = 1; i < face.length - 1; i++) {
			const a = vertices[face[0]],
				b = vertices[face[i]],
				c = vertices[face[i + 1]];
			const u = b.map((v, j) => v - a[j]),
				v = c.map((x, j) => x - a[j]);
			const dot =
				(u[1] * v[2] - u[2] * v[1]) * p.normal[0] +
				(u[2] * v[0] - u[0] * v[2]) * p.normal[1] +
				(u[0] * v[1] - u[1] * v[0]) * p.normal[2];
			if (dot <= 0) {
				throw new FormatError('invalid convex face winding');
			}
			triangles.push([face[0], face[i], face[i + 1]]);
		}
		for (let i = 0; i < face.length; i++) {
			const key = `${face[i]}/${face[(i + 1) % face.length]}`;
			edges.set(key, (edges.get(key) ?? 0) + 1);
		}
	}
	if (
		edges.size !== indexCount ||
		[...edges].some(([key, count]) => count !== 1 || edges.get(key.split('/').toReversed().join('/')) !== 1)
	) {
		throw new FormatError('convex hull is not closed');
	}
	if (supportAdjacency) {
		let offset = 0;
		for (const [vertex, count] of supportAdjacency.counts.entries()) {
			const neighbours = supportAdjacency.vertices.subarray(offset, offset + count);
			if (
				new Set(neighbours).size !== count ||
				neighbours.some((index) => !edges.has(`${vertex}/${index}`))
			) {
				throw new FormatError('convex support-map adjacency does not match hull edges');
			}
			offset += count;
		}
	}
	return { vertices, triangles, bounds, faceRemap: null, materials: null };
};
