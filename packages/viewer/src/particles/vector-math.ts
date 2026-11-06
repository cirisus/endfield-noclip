import type { Vec3 } from '@endfield-noclip/package-format/values';

// the `…Into` forms write their result into `out` and return it, so the per-particle hot path needn't
// allocate. generic vector, matrix and quaternion helpers are in `math/`

/**
 * @param velocity a mesh particle's world velocity
 * @returns the right, up and forward axes the game turns a velocity-aligned mesh particle into: forward along
 *   the velocity (the world's +z when still), right level (the world's +x when moving straight up or down)
 */
export const velocityBasis = (velocity: ArrayLike<number>): [Vec3, Vec3, Vec3] =>
	velocityBasisInto(
		[
			[0, 0, 0],
			[0, 0, 0],
			[0, 0, 0],
		],
		velocity,
	);

/** writes {@link velocityBasis} into `out` @returns `out` */
export const velocityBasisInto = (
	out: [Vec3, Vec3, Vec3],
	velocity: ArrayLike<number>,
): [Vec3, Vec3, Vec3] => {
	const [right, up, forward] = out;
	const length = Math.hypot(velocity[0], velocity[1], velocity[2]);
	if (length > 1e-15) {
		const vx = velocity[0],
			vy = velocity[1],
			vz = velocity[2];
		forward[0] = vx / length;
		forward[1] = vy / length;
		forward[2] = vz / length;
	} else {
		forward[0] = 0;
		forward[1] = 0;
		forward[2] = 1;
	}
	const level = Math.hypot(forward[2], forward[0]);
	if (level > 1e-15) {
		right[0] = forward[2] / level;
		right[1] = 0;
		right[2] = -forward[0] / level;
	} else {
		right[0] = 1;
		right[1] = 0;
		right[2] = 0;
	}
	up[0] = forward[1] * right[2] - forward[2] * right[1];
	up[1] = forward[2] * right[0] - forward[0] * right[2];
	up[2] = forward[0] * right[1] - forward[1] * right[0];
	return out;
};

/** writes a uniformly random unit vector from two random values into `out` @returns `out` */
export const unitVectorInto = (out: Vec3, a: number, b: number): Vec3 => {
	const z = 2 * a - 1;
	const r = Math.sqrt(Math.max(0, 1 - z * z));
	const phi = 2 * Math.PI * b;
	out[0] = r * Math.cos(phi);
	out[1] = r * Math.sin(phi);
	out[2] = z;
	return out;
};
