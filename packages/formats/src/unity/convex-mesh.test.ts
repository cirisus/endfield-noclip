import assert from 'node:assert/strict';
import { test } from 'node:test';

import { readConvexMesh } from './convex-mesh.ts';

const fixture = (shape?: {
	vertices?: number[][];
	faces?: number[][];
	planes?: number[][];
	supportMap?: boolean;
}) => {
	const bytes: number[] = [];
	const raw = (s: string) => bytes.push(...new TextEncoder().encode(s));
	const u32 = (n: number) => {
		const b = new Uint8Array(4);
		new DataView(b.buffer).setUint32(0, n, true);
		bytes.push(...b);
	};
	const f32 = (n: number) => {
		const b = new Uint8Array(4);
		new DataView(b.buffer).setFloat32(0, n, true);
		bytes.push(...b);
	};
	raw('NXS');
	bytes.push(1);
	raw('CVXM');
	u32(13);
	u32(0);
	raw('ICE');
	bytes.push(1);
	raw('CLHL');
	u32(9);
	const norm = 1 / Math.sqrt(3);
	const vertices = shape?.vertices ?? [
		[0, 0, 0],
		[1, 0, 0],
		[0, 1, 0],
		[0, 0, 1],
	];
	const faces = shape?.faces ?? [
		[0, 2, 1],
		[0, 1, 3],
		[0, 3, 2],
		[1, 2, 3],
	];
	const planes = shape?.planes ?? [
		[0, 0, -1, 0],
		[0, -1, 0, 0],
		[-1, 0, 0, 0],
		[norm, norm, norm, -norm],
	];
	const indexCount = faces.reduce((count, face) => count + face.length, 0);
	[vertices.length, indexCount / 2, faces.length, indexCount].forEach(u32);
	vertices.flat().forEach(f32);
	const polygonOffset = bytes.length;
	let offset = 0;
	planes.forEach((p, i) => {
		p.forEach(f32);
		bytes.push(offset & 255, offset >>> 8, faces[i].length, 0);
		offset += faces[i].length;
	});
	const indexOffset = bytes.length;
	bytes.push(...faces.flat());
	const edges = new Map<string, number[]>();
	for (const [index, face] of faces.entries()) {
		for (let i = 0; i < face.length; i++) {
			const a = face[i],
				b = face[(i + 1) % face.length],
				key = `${Math.min(a, b)}/${Math.max(a, b)}`;
			edges.set(key, [...(edges.get(key) ?? []), index]);
		}
	}
	bytes.push(...[...edges.values()].flat());
	vertices.forEach((_, index) => {
		bytes.push(...faces.flatMap((face, i) => (face.includes(index) ? [i] : [])).slice(0, 3));
	});
	f32(0);
	[0, 1, 2].map((axis) => Math.min(...vertices.map((v) => v[axis]))).forEach(f32);
	[0, 1, 2].map((axis) => Math.max(...vertices.map((v) => v[axis]))).forEach(f32);
	Array<number>(13).fill(1).forEach(f32);
	const supportOffset = bytes.length;
	if (shape?.supportMap) {
		f32(1);
		for (const [tag, version] of [
			['SUPM', 0],
			['GAUS', 0],
		] as const) {
			raw('ICE');
			bytes.push(1);
			raw(tag);
			u32(version);
		}
		u32(2);
		u32(24);
		bytes.push(...Array<number>(48).fill(0));
		raw('ICE');
		bytes.push(1);
		raw('VALE');
		u32(2);
		u32(vertices.length);
		u32(indexCount);
		const neighbours = vertices.map((_, vertex) => {
			const adjacent = new Set<number>();
			for (const face of faces) {
				const index = face.indexOf(vertex);
				if (index < 0) {
					continue;
				}
				adjacent.add(face[(index + 1) % face.length]);
				adjacent.add(face[(index + face.length - 1) % face.length]);
			}
			return Array.from(adjacent);
		});
		u32(Math.max(...neighbours.map((list) => list.length)));
		bytes.push(...neighbours.map((list) => list.length), ...neighbours.flat());
	} else {
		f32(-1);
	}
	[0.1, 0.1, 0.1, 0.1].forEach(f32);
	return { bytes: Uint8Array.from(bytes), indexOffset, polygonOffset, supportOffset };
};

test('preserves a closed outward tetrahedron without inventing original triangle indices', () => {
	const hull = readConvexMesh(fixture().bytes);
	assert.deepEqual(hull.triangles, [
		[0, 2, 1],
		[0, 1, 3],
		[0, 3, 2],
		[1, 2, 3],
	]);
	assert.equal(hull.faceRemap, null);
	assert.deepEqual(hull.bounds, { min: [0, 0, 0], max: [1, 1, 1] });
});

test('rejects unsupported, open, inverted, nonfinite and truncated hull data', () => {
	const { bytes, indexOffset } = fixture();
	for (const offset of [3, 8, 24, indexOffset]) {
		const invalid = bytes.slice();
		invalid[offset] = 255;
		assert.throws(() => readConvexMesh(invalid));
	}
	const inverted = bytes.slice();
	inverted[indexOffset + 1] = 1;
	inverted[indexOffset + 2] = 2;
	assert.throws(() => readConvexMesh(inverted), /winding/);
	const open = bytes.slice();
	open.set(open.subarray(92, 108), 152);
	open.set(open.subarray(indexOffset, indexOffset + 3), indexOffset + 9);
	assert.throws(() => readConvexMesh(open), /not closed/);
	const nonfinite = bytes.slice();
	new DataView(nonfinite.buffer).setFloat32(44, NaN, true);
	assert.throws(() => readConvexMesh(nonfinite), /nonfinite/);
	assert.throws(() => readConvexMesh(bytes.subarray(0, bytes.length - 1)), /exceeds/);
	assert.throws(() => readConvexMesh(Uint8Array.from([...bytes, 0])), /trailing/);
});

test('preserves mildly noncoplanar cooked polygon vertices while rejecting a corrupt plane', () => {
	const { bytes, polygonOffset } = fixture({
		vertices: [
			[0, 0, 0],
			[1, 0, 0],
			[1, 1, 0],
			[0, 1, 0],
			[0, 0, 1],
			[1, 0, 1],
			[1, 1.002, 1],
			[0, 1, 1],
		],
		faces: [
			[0, 3, 2, 1],
			[0, 1, 5, 4],
			[0, 4, 7, 3],
			[1, 2, 6, 5],
			[3, 7, 6, 2],
			[4, 5, 6, 7],
		],
		planes: [
			[0, 0, -1, 0],
			[0, -1, 0, 0],
			[-1, 0, 0, 0],
			[1, 0, 0, -1],
			[0, 1, 0, -1],
			[0, 0, 1, -1],
		],
	});
	const hull = readConvexMesh(bytes);
	assert.equal(hull.vertices.length, 8);
	assert.equal(hull.triangles.length, 12);
	assert.equal(hull.vertices[6][1], Math.fround(1.002));
	assert.deepEqual(hull.triangles.slice(8, 10), [
		[3, 7, 6],
		[3, 6, 2],
	]);
	const corrupt = bytes.slice();
	new DataView(corrupt.buffer).setFloat32(polygonOffset + 4 * 20 + 12, -0.5, true);
	assert.throws(() => readConvexMesh(corrupt), /supporting plane/);
});

test('decodes optional Gauss support maps without changing the closed hull geometry', () => {
	const { bytes } = fixture({ supportMap: true });
	assert.deepEqual(readConvexMesh(bytes), readConvexMesh(fixture().bytes));
});

test('rejects malformed optional support-map headers, sample indices, counts and adjacency', () => {
	const { bytes, supportOffset } = fixture({ supportMap: true });
	for (const [offset, value] of [
		[supportOffset + 4, 0],
		[supportOffset + 4 + 24 + 8, 255],
		[supportOffset + 4 + 24 + 4, 25],
		[supportOffset + 4 + 24 + 8 + 48 + 12, 5],
		[supportOffset + 4 + 24 + 8 + 48 + 12 + 8 + 4, 0],
		[supportOffset + 4 + 24 + 8 + 48 + 12 + 8 + 4 + 4, 255],
	]) {
		const invalid = bytes.slice();
		invalid[offset] = value;
		assert.throws(() => readConvexMesh(invalid), /support/);
	}
	const selfAdjacent = bytes.slice();
	selfAdjacent[supportOffset + 4 + 24 + 8 + 48 + 12 + 8 + 4 + 4] = 0;
	assert.throws(() => readConvexMesh(selfAdjacent), /adjacency/);
	assert.throws(() => readConvexMesh(bytes.subarray(0, bytes.length - 20)), /exceeds/);
});
