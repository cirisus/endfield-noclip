import {
	ParticleMeshPlacement,
	ParticleMeshSpawn,
	type ParticleShapeMeshInfo,
} from '@endfield-noclip/package-format/particles';
import type { Vec3 } from '@endfield-noclip/package-format/values';

import { normalizeOrZInto } from '../math/vec3.ts';

/** a mesh shape with each primitive's running total of area (a line's length), for picking by it */
export interface PreparedMeshShape {
	info: ParticleShapeMeshInfo;
	/** primitive `i`'s total is the sum of the areas of primitives 0…i */
	running: Float64Array;
}

/**
 * @param info the mesh
 * @returns it, ready for {@link meshShapePoint}
 */
export const prepareMeshShape = (info: ParticleShapeMeshInfo): PreparedMeshShape => {
	const { positions: p, primitives, corners } = info;
	const count = Math.floor(primitives.length / corners);
	const running = new Float64Array(count);
	let total = 0;
	for (let i = 0; i < count; i++) {
		const a = primitives[i * corners] * 3;
		const b = primitives[i * corners + 1] * 3;
		const ab = [p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]];
		if (corners === 2) {
			total += Math.hypot(ab[0], ab[1], ab[2]);
		} else {
			const c = primitives[i * corners + 2] * 3;
			const ac = [p[c] - p[a], p[c + 1] - p[a + 1], p[c + 2] - p[a + 2]];
			total +=
				0.5 *
				Math.hypot(
					ab[1] * ac[2] - ab[2] * ac[1],
					ab[2] * ac[0] - ab[0] * ac[2],
					ab[0] * ac[1] - ab[1] * ac[0],
				);
		}
		running[i] = total;
	}
	return { info, running };
};

/** @returns the first primitive whose running total passes `target` */
const primitiveAt = (running: Float64Array, target: number): number => {
	let low = 0;
	let high = running.length - 1;
	while (low < high) {
		const mid = (low + high) >> 1;
		if (running[mid] > target) {
			high = mid;
		} else {
			low = mid + 1;
		}
	}
	return low;
};

const clamp = (x: number): number => Math.min(Math.max(x, 0), 1);

/** a point's vertices and their weights, written by `meshShapePoint` */
const corner = { vertices: [0, 0, 0], weights: [0, 0, 0] };

/**
 * writes where a particle starts on a mesh shape and which way it leaves, in the mesh's frame, picked as
 * {@link ParticleShapeMeshInfo} describes
 *
 * @param shape the prepared mesh
 * @param randoms three of the particle's random values, 0–1
 * @param ordinal the particle's emission number, for the vertex spawn modes that step through the vertices;
 *   `null` when it isn't known, which picks at random
 * @param position receives the start position
 * @param direction receives the unit start direction: the point's normal, or +z without normals
 * @param tint receives the colour, 0–1 rgba, the start colour is multiplied by: the point's vertex colour, or
 *   white
 */
export const meshShapePoint = (
	shape: PreparedMeshShape,
	randoms: readonly [number, number, number],
	ordinal: number | null,
	position: Vec3,
	direction: Vec3,
	tint: [number, number, number, number],
): void => {
	const { info, running } = shape;
	const { corners, primitives } = info;
	const { vertices, weights } = corner;
	const count = running.length;
	const total = count === 0 ? 0 : running[count - 1];
	const [r0, r1, r2] = randoms;
	// the third corner of a line repeats its second, so its weight adds to the second's
	const third = (i: number) => primitives[i * corners + corners - 1];
	switch (info.placement) {
		case ParticleMeshPlacement.Vertex: {
			const vertexCount = Math.floor(info.positions.length / 3);
			let vertex: number;
			if (info.spawn !== ParticleMeshSpawn.Random && ordinal !== null) {
				// the engine indexes the vertex buffer directly here, whatever the submeshes
				if (info.spawn === ParticleMeshSpawn.Loop) {
					vertex = ordinal % vertexCount;
				} else {
					const m = ordinal % (2 * vertexCount);
					vertex = m < vertexCount ? m : 2 * vertexCount - 1 - m;
				}
			} else {
				// a primitive evenly, then one of its corners, so shared vertices come up more often
				const primitive = Math.min(Math.floor(r0 * count), count - 1);
				vertex = primitives[primitive * corners + Math.min(Math.floor(r1 * corners), corners - 1)];
			}
			vertices[0] = vertex;
			vertices[1] = vertex;
			vertices[2] = vertex;
			weights[0] = 1;
			weights[1] = 0;
			weights[2] = 0;
			break;
		}
		case ParticleMeshPlacement.Edge: {
			let u = r0;
			if (info.spread > 0) {
				u = Math.floor(u / info.spread) * info.spread;
			}
			const target = u * total;
			const primitive = primitiveAt(running, target);
			const before = primitive === 0 ? 0 : running[primitive - 1];
			const area = running[primitive] - before;
			const f = area > 0 ? Math.min(Math.max((target - before) / area, 0), 1) : 0;
			vertices[0] = primitives[primitive * corners];
			vertices[1] = primitives[primitive * corners + 1];
			vertices[2] = third(primitive);
			if (corners === 2) {
				weights[0] = 1 - f;
				weights[1] = f;
				weights[2] = 0;
			} else {
				// along the outline by parameter, each side a third whatever its length
				const s = 3 * f;
				weights[0] = clamp(1 - s) + clamp(s - 2);
				weights[1] = clamp(s) - clamp(s - 1);
				weights[2] = clamp(s - 1) - clamp(s - 2);
			}
			break;
		}
		case ParticleMeshPlacement.Triangle: {
			const primitive = primitiveAt(running, r0 * total);
			let a = r1;
			let b = r2;
			// folded back into the triangle, uniform over it
			if (a + b > 1) {
				a = 1 - a;
				b = 1 - b;
			}
			vertices[0] = primitives[primitive * corners];
			vertices[1] = primitives[primitive * corners + 1];
			vertices[2] = third(primitive);
			weights[0] = a;
			weights[1] = b;
			weights[2] = 1 - a - b;
			break;
		}
	}
	const { positions, normals, colors } = info;
	// a mesh without normals reads (0, 0, 1)
	let nx = 0;
	let ny = 0;
	let nz = normals === null ? 1 : 0;
	position[0] = 0;
	position[1] = 0;
	position[2] = 0;
	tint[0] = colors === null ? 1 : 0;
	tint[1] = tint[0];
	tint[2] = tint[0];
	tint[3] = tint[0];
	for (let k = 0; k < 3; k++) {
		const w = weights[k];
		const v = vertices[k];
		position[0] += positions[v * 3] * w;
		position[1] += positions[v * 3 + 1] * w;
		position[2] += positions[v * 3 + 2] * w;
		if (normals !== null) {
			nx += normals[v * 3] * w;
			ny += normals[v * 3 + 1] * w;
			nz += normals[v * 3 + 2] * w;
		}
		if (colors !== null) {
			for (let c = 0; c < 4; c++) {
				tint[c] += (colors[v * 4 + c] / 255) * w;
			}
		}
	}
	// the offset runs along the normal before it's normalized
	position[0] += nx * info.normalOffset;
	position[1] += ny * info.normalOffset;
	position[2] += nz * info.normalOffset;
	normalizeOrZInto(direction, nx, ny, nz);
};
