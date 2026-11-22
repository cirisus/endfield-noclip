import type { Aabb } from './values.ts';

/**
 * @param position translation
 * @param quaternion normalized rotation, xyzw
 * @param scale axis scales
 * @returns a column-major TRS matrix
 */
export const trsMatrix = (
	position: readonly number[],
	quaternion: readonly number[],
	scale: readonly number[],
): Float32Array => {
	const [x, y, z, w] = quaternion;
	const [sx, sy, sz] = scale;
	return new Float32Array([
		(1 - 2 * (y * y + z * z)) * sx,
		2 * (x * y + z * w) * sx,
		2 * (x * z - y * w) * sx,
		0,
		2 * (x * y - z * w) * sy,
		(1 - 2 * (x * x + z * z)) * sy,
		2 * (y * z + x * w) * sy,
		0,
		2 * (x * z + y * w) * sz,
		2 * (y * z - x * w) * sz,
		(1 - 2 * (x * x + y * y)) * sz,
		0,
		position[0],
		position[1],
		position[2],
		1,
	]);
};

/**
 * @param angles Unity Euler angles in degrees, applied Z then X then Y
 * @returns the rotation as an xyzw quaternion
 */
export const unityEulerQuaternion = (angles: readonly number[]): [number, number, number, number] => {
	const [x, y, z] = angles.map((angle) => (angle * Math.PI) / 360);
	const cx = Math.cos(x),
		cy = Math.cos(y),
		cz = Math.cos(z);
	const sx = Math.sin(x),
		sy = Math.sin(y),
		sz = Math.sin(z);
	return [
		cy * sx * cz + sy * cx * sz,
		sy * cx * cz - cy * sx * sz,
		cy * cx * sz - sy * sx * cz,
		cy * cx * cz + sy * sx * sz,
	];
};

/**
 * @param quaternion normalized rotation, xyzw
 * @returns Unity Euler angles in degrees (Z then X then Y), the inverse of {@link unityEulerQuaternion}
 */
export const quaternionUnityEuler = (quaternion: readonly number[]): [number, number, number] => {
	const [x, y, z, w] = quaternion;
	const degrees = 180 / Math.PI;
	const sinX = Math.min(Math.max(2 * (w * x - y * z), -1), 1);
	return [
		Math.asin(sinX) * degrees,
		Math.atan2(2 * (x * z + w * y), 1 - 2 * (x * x + y * y)) * degrees,
		Math.atan2(2 * (x * y + w * z), 1 - 2 * (x * x + z * z)) * degrees,
	];
};

/**
 * @param a xyzw quaternion
 * @param b xyzw quaternion
 * @returns `a · b`, the rotation `b` followed by `a`
 */
export const multiplyQuaternions = (
	a: readonly number[],
	b: readonly number[],
): [number, number, number, number] => {
	const [ax, ay, az, aw] = a;
	const [bx, by, bz, bw] = b;
	return [
		aw * bx + ax * bw + ay * bz - az * by,
		aw * by - ax * bz + ay * bw + az * bx,
		aw * bz + ax * by - ay * bx + az * bw,
		aw * bw - ax * bx - ay * by - az * bz,
	];
};

/**
 * @param parent column-major parent matrix
 * @param local column-major local matrix
 * @returns their product; neither input is modified
 */
export const multiplyMatrices = (parent: Float32Array, local: Float32Array): Float32Array => {
	const result = new Float32Array(16);
	for (let c = 0; c < 4; c++) {
		const l0 = local[c * 4];
		const l1 = local[c * 4 + 1];
		const l2 = local[c * 4 + 2];
		const l3 = local[c * 4 + 3];
		for (let r = 0; r < 4; r++) {
			// each partial sum is rounded to float32, and the first starts from +0 (so a -0 product becomes +0), as
			// accumulating into a zeroed Float32Array would; packages keep these bits, so both are part of the output
			result[c * 4 + r] = fround(
				fround(fround(fround(parent[r] * l0 + 0) + parent[4 + r] * l1) + parent[8 + r] * l2) +
					parent[12 + r] * l3,
			);
		}
	}
	return result;
};

const fround = Math.fround;

/**
 * @param matrix affine column-major matrix
 * @param point a point
 * @returns the point transformed by the matrix
 */
export const transformPoint = (matrix: Float32Array, point: readonly number[]): [number, number, number] => {
	const out: [number, number, number] = [matrix[12], matrix[13], matrix[14]];
	for (let r = 0; r < 3; r++) {
		for (let c = 0; c < 3; c++) {
			out[r] += matrix[c * 4 + r] * point[c];
		}
	}
	return out;
};

const adj = new Float64Array(9);

/** writes the 3×3 linear part's adjugate (row-major) into `adj` and returns its determinant */
const linearAdjugate = (matrix: Float32Array): number => {
	const m00 = matrix[0],
		m01 = matrix[4],
		m02 = matrix[8];
	const m10 = matrix[1],
		m11 = matrix[5],
		m12 = matrix[9];
	const m20 = matrix[2],
		m21 = matrix[6],
		m22 = matrix[10];
	const a00 = m11 * m22 - m12 * m21;
	const a10 = m12 * m20 - m10 * m22;
	const a20 = m10 * m21 - m11 * m20;
	const det = m00 * a00 + m01 * a10 + m02 * a20;
	if (Math.abs(det) < 1e-12) {
		throw new RangeError('the matrix has no inverse');
	}
	adj[0] = a00;
	adj[1] = m02 * m21 - m01 * m22;
	adj[2] = m01 * m12 - m02 * m11;
	adj[3] = a10;
	adj[4] = m00 * m22 - m02 * m20;
	adj[5] = m02 * m10 - m00 * m12;
	adj[6] = a20;
	adj[7] = m01 * m20 - m00 * m21;
	adj[8] = m00 * m11 - m01 * m10;
	return det;
};

/**
 * @param matrix affine column-major matrix
 * @param point a point
 * @returns the point the matrix takes to `point`
 * @throws {RangeError} if the matrix's linear part is singular
 */
export const inverseTransformPoint = (
	matrix: Float32Array,
	point: readonly number[],
): [number, number, number] => {
	const det = linearAdjugate(matrix);
	const dx = point[0] - matrix[12];
	const dy = point[1] - matrix[13];
	const dz = point[2] - matrix[14];
	return [
		(adj[0] * dx + adj[1] * dy + adj[2] * dz) / det,
		(adj[3] * dx + adj[4] * dy + adj[5] * dz) / det,
		(adj[6] * dx + adj[7] * dy + adj[8] * dz) / det,
	];
};

/**
 * @param matrix affine column-major matrix
 * @returns its inverse
 * @throws {RangeError} if the matrix's linear part is singular
 */
export const inverseAffine = (matrix: Float32Array): Float32Array => {
	const det = linearAdjugate(matrix);
	const out = new Float32Array(16);
	out[0] = adj[0] / det;
	out[1] = adj[3] / det;
	out[2] = adj[6] / det;
	out[4] = adj[1] / det;
	out[5] = adj[4] / det;
	out[6] = adj[7] / det;
	out[8] = adj[2] / det;
	out[9] = adj[5] / det;
	out[10] = adj[8] / det;
	const tx = matrix[12];
	const ty = matrix[13];
	const tz = matrix[14];
	out[12] = -(adj[0] * tx + adj[1] * ty + adj[2] * tz) / det;
	out[13] = -(adj[3] * tx + adj[4] * ty + adj[5] * tz) / det;
	out[14] = -(adj[6] * tx + adj[7] * ty + adj[8] * tz) / det;
	out[15] = 1;
	return out;
};

/**
 * @param bounds local axis-aligned bounds
 * @param matrix affine column-major matrix
 * @returns enclosing world bounds, including rotated and nonuniformly scaled extents
 */
export const transformBounds = (bounds: Aabb, matrix: Float32Array): Aabb => {
	const center: [number, number, number] = [0, 0, 0];
	const extents: [number, number, number] = [0, 0, 0];
	for (let r = 0; r < 3; r++) {
		center[r] = matrix[12 + r];
		for (let c = 0; c < 3; c++) {
			center[r] += matrix[c * 4 + r] * bounds.center[c];
			extents[r] += Math.abs(matrix[c * 4 + r]) * bounds.extents[c];
		}
	}
	return { center, extents };
};
