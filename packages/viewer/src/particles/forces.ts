import {
	type MinMaxCurveInfo,
	type ParticleForceFieldInfo,
	PARTICLE_STEP_RATE,
} from '@endfield-noclip/package-format/particles';
import type { Vec3 } from '@endfield-noclip/package-format/values';

import { times3Into } from '../math/mat3.ts';

import { evaluateMinMax } from './curves.ts';

/** a force field ready to step: its matrices as 3×3 rows plus a translation */
export interface PreparedField {
	info: ParticleForceFieldInfo;
	/** the emitter's frame to the field's: `p_field = toField · p + toFieldOffset` */
	toField: number[];
	toFieldOffset: Vec3;
	/** the field's vectors in the emitter's frame (the inverse of {@link toField}) */
	fromField: number[];
}

/**
 * @param info a force field
 * @returns it with its matrices as rows, from its column-major `fromEmitter`
 */
export const prepareField = (info: ParticleForceFieldInfo): PreparedField => {
	const m = info.fromEmitter;
	// row r, column c of a column-major 4×4 is m[c * 4 + r]
	const a = [m[0], m[4], m[8], m[1], m[5], m[9], m[2], m[6], m[10]];
	const cofactor = [
		a[4] * a[8] - a[5] * a[7],
		a[2] * a[7] - a[1] * a[8],
		a[1] * a[5] - a[2] * a[4],
		a[5] * a[6] - a[3] * a[8],
		a[0] * a[8] - a[2] * a[6],
		a[2] * a[3] - a[0] * a[5],
		a[3] * a[7] - a[4] * a[6],
		a[1] * a[6] - a[0] * a[7],
		a[0] * a[4] - a[1] * a[3],
	];
	const det = a[0] * cofactor[0] + a[1] * cofactor[3] + a[2] * cofactor[6];
	const inverse = Math.abs(det) > 1e-20 ? cofactor.map((value) => value / det) : [1, 0, 0, 0, 1, 0, 0, 0, 1];
	return { info, toField: a, toFieldOffset: [m[12], m[13], m[14]], fromField: inverse };
};

/** one particle's random values for the force fields, the same for every field as in the game */
export interface ForceRandoms {
	multiplier: number;
	tiltX: number;
	tiltZ: number;
	direction: [number, number, number];
	gravity: number;
	spin: number;
	attraction: number;
	drag: number;
}

/**
 * changes a particle's own velocity by the force fields for one step, as the game's sphere fields do ({@link
 * ParticleForceFieldInfo})
 *
 * @param forces the system's forces, their fields prepared
 * @param position the particle's place in the emitter's frame, before the step
 * @param own its own velocity, changed in place
 * @param lived its age over its lifetime, 0–1, where the multiplier is read
 * @param size its size, which drag can scale by
 * @param r its random values
 * @param dt the step, s
 */
export const applyForces = (
	forces: { multiplier: MinMaxCurveInfo; fields: readonly PreparedField[] },
	position: Readonly<Vec3>,
	own: Vec3,
	lived: number,
	size: number,
	r: ForceRandoms,
	dt: number,
): void => {
	const m = evaluateMinMax(forces.multiplier, lived, r.multiplier);
	const { p, push, n, turn, q, back, tangent } = scratch;
	for (const field of forces.fields) {
		const { info, toField, toFieldOffset, fromField } = field;
		times3Into(p, toField, position[0], position[1], position[2]);
		for (let axis = 0; axis < 3; axis++) {
			p[axis] = p[axis] + toFieldOffset[axis];
		}
		const d = Math.hypot(p[0], p[1], p[2]);
		const { startRange: start, endRange: end } = info;
		if (d < start || d > end) {
			continue;
		}
		const tf = end > start ? Math.max((d - start) / (end - start), 0) : 0;
		const direction = info.direction;
		if (direction[0].scalar !== 0 || direction[1].scalar !== 0 || direction[2].scalar !== 0) {
			times3Into(
				push,
				fromField,
				evaluateMinMax(direction[0], tf, r.direction[0]),
				evaluateMinMax(direction[1], tf, r.direction[1]),
				evaluateMinMax(direction[2], tf, r.direction[2]),
			);
			for (let axis = 0; axis < 3; axis++) {
				own[axis] += push[axis] * m * dt;
			}
		}
		if (info.gravity.scalar !== 0) {
			times3Into(n, fromField, p[0], p[1], p[2]);
			unitOrZero(n);
			const sign = d < start + info.gravityFocus * (end - start) ? -1 : 1;
			const pull = -evaluateMinMax(info.gravity, tf, r.gravity) * m * dt * PARTICLE_STEP_RATE * sign;
			for (let axis = 0; axis < 3; axis++) {
				own[axis] += n[axis] * pull;
			}
		}
		if (info.rotationSpeed.scalar !== 0 && info.rotationAttraction.scalar !== 0) {
			const speed = evaluateMinMax(info.rotationSpeed, tf, r.spin) * m;
			const attraction = evaluateMinMax(info.rotationAttraction, tf, r.attraction) * m;
			// the swirl's axis, the field's +y, tilted by a fixed random turn about x then z per particle
			const ax = (r.tiltX - 0.5) * 2 * Math.PI * info.rotationRandomness[0];
			const az = (r.tiltZ - 0.5) * 2 * Math.PI * info.rotationRandomness[1];
			const tilt = Math.abs(ax) > 1e-6 || Math.abs(az) > 1e-6;
			const cx = Math.cos(ax),
				sx = Math.sin(ax),
				cz = Math.cos(az),
				sz = Math.sin(az);
			if (tilt) {
				setTilt(turn, cx, sx, cz, sz);
			} else {
				setIdentity(turn);
			}
			times3Into(q, turn, p[0], p[1], p[2]);
			// ŷ × q, turned back by the tilt's transpose
			const c0 = q[2],
				c1 = 0,
				c2 = -q[0];
			back[0] = turn[0] * c0 + turn[3] * c1 + turn[6] * c2;
			back[1] = turn[1] * c0 + turn[4] * c1 + turn[7] * c2;
			back[2] = turn[2] * c0 + turn[5] * c1 + turn[8] * c2;
			times3Into(tangent, fromField, back[0], back[1], back[2]);
			unitOrZero(tangent);
			const k = attraction * dt * PARTICLE_STEP_RATE;
			for (let axis = 0; axis < 3; axis++) {
				own[axis] += (tangent[axis] * speed - own[axis]) * k;
			}
		}
		if (info.drag.scalar !== 0) {
			const amount = evaluateMinMax(info.drag, tf, r.drag);
			const s = Math.hypot(own[0], own[1], own[2]);
			const k =
				(info.dragBySize ? Math.PI * (size / 2) ** 2 : 1) * amount * (info.dragByVelocity ? s * s : 1);
			const kept = s > 1e-15 ? Math.max(0, s - k * m * dt) / s : 0;
			for (let axis = 0; axis < 3; axis++) {
				own[axis] *= kept;
			}
		}
	}
};

// applyForces runs for every field on every step of every stepped particle, so it works in these
const vec3 = (): Vec3 => [0, 0, 0];
const scratch = {
	p: vec3(),
	push: vec3(),
	n: vec3(),
	/** the swirl's tilt, as 3×3 rows */
	turn: [1, 0, 0, 0, 1, 0, 0, 0, 1],
	q: vec3(),
	back: vec3(),
	tangent: vec3(),
};

/** scales `v` to unit length in place, or zeroes it when it has almost none */
const unitOrZero = (v: Vec3): void => {
	const length = Math.hypot(v[0], v[1], v[2]);
	for (let axis = 0; axis < 3; axis++) {
		v[axis] = length > 1e-15 ? v[axis] / length : 0;
	}
};

/** sets `out` to Rx(ax) · Rz(az) as 3×3 rows, from the angles' cosines and sines */
const setTilt = (out: number[], cx: number, sx: number, cz: number, sz: number): void => {
	out[0] = cz;
	out[1] = -sz;
	out[2] = 0;
	out[3] = cx * sz;
	out[4] = cx * cz;
	out[5] = -sx;
	out[6] = sx * sz;
	out[7] = sx * cz;
	out[8] = cx;
};

/** sets `out` to the identity as 3×3 rows */
const setIdentity = (out: number[]): void => {
	for (let i = 0; i < 9; i++) {
		out[i] = i % 4 === 0 ? 1 : 0;
	}
};
