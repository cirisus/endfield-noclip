import type { Vec3 } from '@endfield-noclip/package-format/values';

// the `…Into` forms write their result into `out` and return it, so hot paths needn't allocate. each reads
// all of its inputs before writing, so `out` may be one of them

/** an xyzw quaternion */
export type Quat = [x: number, y: number, z: number, w: number];

/** @returns the xyzw quaternion of Unity Euler angles in radians (Z, then X, then Y) */
export const eulerQuaternion = (x: number, y: number, z: number): Quat =>
	eulerQuaternionInto([0, 0, 0, 1], x, y, z);

/** writes {@link eulerQuaternion} into `out` @returns `out` */
export const eulerQuaternionInto = (out: Quat, x: number, y: number, z: number): Quat => {
	const cx = Math.cos(x / 2),
		cy = Math.cos(y / 2),
		cz = Math.cos(z / 2);
	const sx = Math.sin(x / 2),
		sy = Math.sin(y / 2),
		sz = Math.sin(z / 2);
	out[0] = cy * sx * cz + sy * cx * sz;
	out[1] = sy * cx * cz - cy * sx * sz;
	out[2] = cy * cx * sz - sy * sx * cz;
	out[3] = cy * cx * cz + sy * sx * sz;
	return out;
};

/** writes `(vx, vy, vz)` rotated by the xyzw quaternion `q` into `out` @returns `out` */
export const rotateInto = (out: Vec3, q: ArrayLike<number>, vx: number, vy: number, vz: number): Vec3 => {
	const x = q[0],
		y = q[1],
		z = q[2],
		w = q[3];
	// t = 2 · cross(q.xyz, v); v' = v + w · t + cross(q.xyz, t)
	const tx = 2 * (y * vz - z * vy);
	const ty = 2 * (z * vx - x * vz);
	const tz = 2 * (x * vy - y * vx);
	out[0] = vx + w * tx + (y * tz - z * ty);
	out[1] = vy + w * ty + (z * tx - x * tz);
	out[2] = vz + w * tz + (x * ty - y * tx);
	return out;
};

const turn: Quat = [0, 0, 0, 1];

/** writes `v` rotated about the unit axis of `omega` by its length (radians) into `out` @returns `out` */
export const rotateByInto = (out: Vec3, omega: Vec3, v: Vec3): Vec3 => {
	const angle = Math.hypot(omega[0], omega[1], omega[2]);
	if (angle < 1e-9) {
		out[0] = v[0];
		out[1] = v[1];
		out[2] = v[2];
		return out;
	}
	const s = Math.sin(angle / 2) / angle;
	turn[0] = omega[0] * s;
	turn[1] = omega[1] * s;
	turn[2] = omega[2] * s;
	turn[3] = Math.cos(angle / 2);
	return rotateInto(out, turn, v[0], v[1], v[2]);
};

/**
 * @param to a direction, any length
 * @returns the xyzw quaternion turning +z onto it the shortest way: none for a zero vector, half a turn about
 *   x for −z
 */
export const turnFromZ = (to: ArrayLike<number>): Quat => turnFromZInto([0, 0, 0, 1], to);

/** writes {@link turnFromZ} into `out` @returns `out` */
export const turnFromZInto = (out: Quat, to: ArrayLike<number>): Quat => {
	const length = Math.hypot(to[0], to[1], to[2]);
	if (length < 1e-12) {
		return setQuat(out, 0, 0, 0, 1);
	}
	const z = to[2] / length;
	if (z < -1 + 1e-9) {
		return setQuat(out, 1, 0, 0, 0);
	}
	// half the angle via the halfway vector: q = (z × v, 1 + z · v), normalized
	const x = -to[1] / length;
	const y = to[0] / length;
	const w = 1 + z;
	const n = Math.hypot(x, y, w);
	return setQuat(out, x / n, y / n, 0, w / n);
};

const setQuat = (out: Quat, x: number, y: number, z: number, w: number): Quat => {
	out[0] = x;
	out[1] = y;
	out[2] = z;
	out[3] = w;
	return out;
};
