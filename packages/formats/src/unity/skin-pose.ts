import { FormatError } from '../binary/binary-reader.ts';

import type { DecodedMesh } from './mesh.ts';
import type { Aabb } from './values.ts';

/**
 * bakes linear blend skinning into a new static mesh, preserving the input arrays
 *
 * @param mesh decoded mesh with vertex weights and bone indices
 * @param pose bone-to-output transforms multiplied by their mesh bind poses
 * @returns geometry in the pose's output space, with updated normals, tangents and bounds
 * @throws {FormatError} for missing influences, invalid bone references or singular transforms
 */
export const bakeSkinPose = (mesh: DecodedMesh, pose: readonly Float32Array[]): DecodedMesh => {
	const weights = mesh.skin?.weights;
	const indices = mesh.skin?.indices;
	if (!weights || !indices || weights.dimension !== indices.dimension) {
		throw new FormatError(`mesh ${mesh.name} has no matching skin influences`);
	}
	const positions = new Float32Array(mesh.positions.length);
	const normals = mesh.normals?.slice() ?? null;
	const tangents = mesh.tangents ? { ...mesh.tangents, data: mesh.tangents.data.slice() } : null;
	const min = [Infinity, Infinity, Infinity],
		max = [-Infinity, -Infinity, -Infinity];
	const matrix = new Float64Array(16);
	for (let v = 0; v < mesh.vertexCount; v++) {
		matrix.fill(0);
		let total = 0;
		for (let k = 0; k < weights.dimension; k++) {
			const weight = weights.data[v * weights.dimension + k];
			if (weight === 0) {
				continue;
			}
			const index = indices.data[v * indices.dimension + k];
			const bone = pose[index];
			if (!Number.isFinite(weight) || weight < 0 || !Number.isInteger(index) || !bone || bone.length !== 16) {
				throw new FormatError(`mesh ${mesh.name} has an invalid skin influence`);
			}
			for (let i = 0; i < 16; i++) {
				matrix[i] += bone[i] * weight;
			}
			total += weight;
		}
		if (total <= 0) {
			throw new FormatError(`mesh ${mesh.name} has an unweighted vertex`);
		}
		for (let i = 0; i < 16; i++) {
			matrix[i] /= total;
		}
		for (let axis = 0; axis < 3; axis++) {
			let value = matrix[12 + axis];
			for (let c = 0; c < 3; c++) {
				value += matrix[c * 4 + axis] * mesh.positions[v * 3 + c];
			}
			positions[v * 3 + axis] = value;
			min[axis] = Math.min(min[axis], value);
			max[axis] = Math.max(max[axis], value);
		}
		const a = matrix[0],
			b = matrix[4],
			c = matrix[8];
		const d = matrix[1],
			e = matrix[5],
			f = matrix[9];
		const g = matrix[2],
			h = matrix[6],
			i = matrix[10];
		const c00 = e * i - f * h;
		const c01 = f * g - d * i;
		const c02 = d * h - e * g;
		const c10 = c * h - b * i;
		const c11 = a * i - c * g;
		const c12 = b * g - a * h;
		const c20 = b * f - c * e;
		const c21 = c * d - a * f;
		const c22 = a * e - b * d;
		const determinant = a * c00 + b * c01 + c * c02;
		if (Math.abs(determinant) < 1e-12) {
			throw new FormatError(`mesh ${mesh.name} has a singular skin pose`);
		}
		// normals take the inverse transpose (cofactor ÷ determinant); tangents take the matrix itself, and a
		// mirroring pose flips the bitangent sign
		if (normals && mesh.normals) {
			const offset = v * 3;
			const nx = mesh.normals[offset];
			const ny = mesh.normals[offset + 1];
			const nz = mesh.normals[offset + 2];
			const ox = (c00 * nx + c01 * ny + c02 * nz) / determinant;
			const oy = (c10 * nx + c11 * ny + c12 * nz) / determinant;
			const oz = (c20 * nx + c21 * ny + c22 * nz) / determinant;
			const length = Math.hypot(ox, oy, oz);
			if (length === 0) {
				normals[offset] = 0;
				normals[offset + 1] = 0;
				normals[offset + 2] = 0;
			} else {
				normals[offset] = ox / length;
				normals[offset + 1] = oy / length;
				normals[offset + 2] = oz / length;
			}
		}
		if (tangents && mesh.tangents && tangents.dimension >= 4) {
			const offset = v * tangents.dimension;
			const tx = mesh.tangents.data[offset];
			const ty = mesh.tangents.data[offset + 1];
			const tz = mesh.tangents.data[offset + 2];
			const ox = a * tx + b * ty + c * tz;
			const oy = d * tx + e * ty + f * tz;
			const oz = g * tx + h * ty + i * tz;
			const length = Math.hypot(ox, oy, oz);
			if (length === 0) {
				tangents.data[offset] = 0;
				tangents.data[offset + 1] = 0;
				tangents.data[offset + 2] = 0;
			} else {
				tangents.data[offset] = ox / length;
				tangents.data[offset + 1] = oy / length;
				tangents.data[offset + 2] = oz / length;
			}
			tangents.data[offset + 3] *= Math.sign(determinant);
		}
	}
	const bounds: Aabb = {
		center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2],
		extents: [(max[0] - min[0]) / 2, (max[1] - min[1]) / 2, (max[2] - min[2]) / 2],
	};
	return {
		...mesh,
		positions,
		normals,
		// the source words describe the unposed normals
		packedNormals: null,
		tangents,
		bounds,
		submeshes: mesh.submeshes.map((submesh) => ({ ...submesh, bounds })),
		skin: null,
	};
};
