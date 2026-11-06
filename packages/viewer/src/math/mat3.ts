import type { Vec3 } from '@endfield-noclip/package-format/values';

// the `…Into` forms write their result into `out` and return it, so hot paths needn't allocate. each reads
// all of its inputs before writing, so `out` may be one of them

/** writes the 3×3 rows `a` (9 floats, row-major) times `(x, y, z)` into `out` @returns `out` */
export const times3Into = (out: Vec3, a: ArrayLike<number>, x: number, y: number, z: number): Vec3 => {
	out[0] = a[0] * x + a[1] * y + a[2] * z;
	out[1] = a[3] * x + a[4] * y + a[5] * z;
	out[2] = a[6] * x + a[7] * y + a[8] * z;
	return out;
};

/** @returns the matrix whose columns are `columns`, times `v` */
export const times3Columns = (columns: readonly Vec3[], v: ArrayLike<number>): Vec3 =>
	times3ColumnsInto([0, 0, 0], columns, v[0], v[1], v[2]);

/** writes the matrix whose columns are `columns`, times `(x, y, z)`, into `out` @returns `out` */
export const times3ColumnsInto = (
	out: Vec3,
	columns: readonly Vec3[],
	x: number,
	y: number,
	z: number,
): Vec3 => {
	const [a, b, c] = columns;
	out[0] = a[0] * x + b[0] * y + c[0] * z;
	out[1] = a[1] * x + b[1] * y + c[1] * z;
	out[2] = a[2] * x + b[2] * y + c[2] * z;
	return out;
};
