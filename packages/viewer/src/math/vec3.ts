import type { Vec3 } from '@endfield-noclip/package-format/values';

// the `…Into` forms write their result into `out` and return it, so hot paths needn't allocate. each reads
// all of its inputs before writing, so `out` may be one of them

/**
 * @param v a vector; components past the third (a colour's alpha) are ignored
 * @param s the factor
 * @returns the first three components times `s`
 */
export const scale = (v: Readonly<[number, number, number, ...number[]]>, s: number): Vec3 => [
	v[0] * s,
	v[1] * s,
	v[2] * s,
];

/**
 * @param f a component's value by its index
 * @returns the vector of `f` over the three components
 */
export const vec3From = (f: (i: 0 | 1 | 2) => number): Vec3 => [f(0), f(1), f(2)];

/**
 * @param a a vector; components past the third are ignored
 * @param b a vector; components past the third are ignored
 * @returns the dot product of their first three components
 */
export const dot = (a: ArrayLike<number>, b: ArrayLike<number>): number =>
	a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * @param a the left operand
 * @param b the right operand
 * @returns `a × b`
 */
export const cross = (a: Vec3, b: Vec3): Vec3 => [
	a[1] * b[2] - a[2] * b[1],
	a[2] * b[0] - a[0] * b[2],
	a[0] * b[1] - a[1] * b[0],
];

/**
 * @param v a vector
 * @returns `v` scaled to unit length; a zero vector stays zero
 */
export const normalize = ([x, y, z]: Vec3): Vec3 => {
	const length = Math.hypot(x, y, z) || 1;
	return [x / length, y / length, z / length];
};

/**
 * @param v a vector
 * @returns `v` scaled to unit length, or +z when it has none
 */
export const normalizeOrZ = (v: Vec3): Vec3 => normalizeOrZInto([0, 0, 0], v[0], v[1], v[2]);

/** writes {@link normalizeOrZ} of `(x, y, z)` into `out` @returns `out` */
export const normalizeOrZInto = (out: Vec3, x: number, y: number, z: number): Vec3 => {
	const length = Math.hypot(x, y, z);
	if (length > 1e-12) {
		out[0] = x / length;
		out[1] = y / length;
		out[2] = z / length;
	} else {
		out[0] = 0;
		out[1] = 0;
		out[2] = 1;
	}
	return out;
};
