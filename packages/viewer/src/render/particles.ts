import { evaluateCurve, evaluateGradient } from '@endfield-noclip/package-format/curves';
import {
	CurveMode,
	GradientMode,
	GRAVITY,
	type MinMaxCurveInfo,
	type MinMaxGradientInfo,
	ParticleAlignment,
	type ParticleDragInfo,
	type ParticleVelocityInfo,
	ParticleRenderMode,
	ParticleShapeKind,
	type ParticleSpeedLimitInfo,
	type ParticleSplineInfo,
	type ParticleSystemInfo,
	type ParticlesTable,
	type ParticleTextureSheetInfo,
	SheetRow,
} from '@endfield-noclip/package-format/particles';

import type { RangeAllocation } from '../gfx/range-allocator.ts';
import type { Vec3 } from '../scene/camera.ts';
import type { ResidentInstances } from '../streaming/stream-manager.ts';

import { linearRgb } from './color.ts';
import { ROW_COLORED, ROW_WORDS, RowBillboard, RowKind, packRowColor, rowInfo } from './instance-rows.ts';

/**
 * floats per particle in {@link ParticleSimulation.evaluate}'s output: position, rotation (xyzw), size, the
 * texture sheet's tile (0 without a sheet), colour (linear rgb, alpha), then velocity (m/s), all in the
 * emitter's frame
 */
export const PARTICLE_FLOATS = 18;

/** where each value starts in a particle's {@link PARTICLE_FLOATS} */
const At = {
	position: 0,
	rotation: 3,
	size: 7,
	tile: 10,
	color: 11,
	velocity: 15,
} as const;

/** the most particles one emitter shows */
const MAX_PARTICLES = 1024;

// #region randomness

/** @returns a well-mixed 32-bit hash of two 32-bit values (a PCG-style permutation) */
const hash2 = (a: number, b: number): number => {
	let h = Math.imul(a ^ 0x9e37_79b9, 0x85eb_ca6b) ^ Math.imul(b + 0x7f4a_7c15, 0xc2b2_ae35);
	h = Math.imul(h ^ (h >>> 16), 0x7feb_352d);
	h = Math.imul(h ^ (h >>> 15), 0x846c_a68b);
	return (h ^ (h >>> 16)) >>> 0;
};

/** @returns a value in [0, 1) for one particle and one of its random channels */
const random = (seed: number, particle: number, channel: number): number =>
	hash2(hash2(seed, particle), channel) / 4_294_967_296;

/** the random channels a particle draws from */
const Channel = {
	Lifetime: 0,
	Speed: 1,
	Size: 2,
	RotationX: 3,
	RotationY: 4,
	RotationZ: 5,
	Gravity: 6,
	Mesh: 7,
	Shape0: 8,
	Shape1: 9,
	Shape2: 10,
	Direction0: 11,
	Direction1: 12,
	Position0: 13,
	Position1: 14,
	Position2: 15,
	VelocityX: 16,
	VelocityY: 17,
	VelocityZ: 18,
	OrbitalX: 19,
	OrbitalY: 20,
	OrbitalZ: 21,
	Radial: 22,
	SpeedModifier: 23,
	SpinX: 24,
	SpinY: 25,
	SpinZ: 26,
	SizeOverLifetime: 27,
	Burst: 28,
	SheetRow: 29,
	StartFrame: 30,
	FrameOverTime: 31,
	Color: 32,
	ColorOverLifetime: 33,
	Drag: 34,
	SpeedLimit: 35,
	SplineSpeed: 36,
	StartDelay: 37,
} as const;

/**
 * @param seed text to hash
 * @returns a 32-bit FNV-1a hash
 */
export const hashText = (seed: string): number => {
	let h = 0x811c_9dc5;
	for (let i = 0; i < seed.length; i++) {
		h = Math.imul(h ^ seed.charCodeAt(i), 0x0100_0193);
	}
	return h >>> 0;
};

// #endregion

// #region evaluation

/**
 * @param curve a MinMaxCurve
 * @param time where curves are read, 0–1
 * @param r the random value choosing between the two ends, 0–1
 * @returns its value
 */
export const evaluateMinMax = (curve: MinMaxCurveInfo, time: number, r: number): number => {
	switch (curve.mode) {
		case CurveMode.Constant: {
			return curve.scalar;
		}
		case CurveMode.Curve: {
			return curve.curve === null ? curve.scalar : curve.scalar * evaluateCurve(curve.curve, time);
		}
		case CurveMode.TwoCurves: {
			const high = curve.curve === null ? 1 : evaluateCurve(curve.curve, time);
			const low = curve.minCurve === null ? high : evaluateCurve(curve.minCurve, time);
			return curve.scalar * (low + (high - low) * r);
		}
		case CurveMode.TwoConstants: {
			return curve.min + (curve.scalar - curve.min) * r;
		}
	}
};

/**
 * @param gradient a MinMaxGradient
 * @param time where gradients are read, 0–1
 * @param r the random value choosing between the two ends, or along a random colour's gradient, 0–1
 * @returns its colour and alpha, as authored
 */
export const evaluateMinMaxGradient = (
	gradient: MinMaxGradientInfo,
	time: number,
	r: number,
): [number, number, number, number] => {
	const between = (a: readonly number[], b: readonly number[]): [number, number, number, number] => [
		a[0] + (b[0] - a[0]) * r,
		a[1] + (b[1] - a[1]) * r,
		a[2] + (b[2] - a[2]) * r,
		a[3] + (b[3] - a[3]) * r,
	];
	const max = gradient.maxGradient;
	switch (gradient.mode) {
		case GradientMode.Color: {
			return [...gradient.max];
		}
		case GradientMode.Gradient: {
			return max === null ? [...gradient.max] : evaluateGradient(max, time);
		}
		case GradientMode.TwoColors: {
			return between(gradient.min, gradient.max);
		}
		case GradientMode.TwoGradients: {
			const high = max === null ? gradient.max : evaluateGradient(max, time);
			const low = gradient.minGradient === null ? high : evaluateGradient(gradient.minGradient, time);
			return between(low, high);
		}
		case GradientMode.RandomColor: {
			return max === null ? [...gradient.max] : evaluateGradient(max, r);
		}
	}
};

/** the drag's deceleration per unit of speed (or speed squared), for a particle of a size */
const dragRate = (drag: ParticleDragInfo, size: number, r: number): number =>
	Math.max(evaluateMinMax(drag.amount, 0, r), 0) * (drag.bySize ? Math.PI * (size / 2) ** 2 : 1);

/**
 * a start velocity slowed by drag alone
 *
 * @returns how far it has carried the particle by `age` (m), and its speed then (m/s)
 */
export const dragged = (
	drag: ParticleDragInfo,
	speed: number,
	size: number,
	age: number,
	r: number,
): [number, number] => {
	const k = dragRate(drag, size, r);
	if (k <= 0) {
		return [speed * age, speed];
	}
	if (drag.byVelocity) {
		// dv/dt = −k v²
		const sign = Math.sign(speed);
		const v = Math.abs(speed);
		return [(sign * Math.log1p(k * v * age)) / k, (sign * v) / (1 + k * v * age)];
	}
	// dv/dt = −k v
	const decay = Math.exp(-k * age);
	return [(speed * (1 - decay)) / k, speed * decay];
};

/**
 * a fall from rest under gravity and drag, which the particle approaches its terminal speed in
 *
 * @param gravity the acceleration down the world's y, m/s² (negative rises)
 * @returns how far it has fallen by `age` (m), and its speed then (m/s)
 */
export const draggedFall = (
	drag: ParticleDragInfo,
	gravity: number,
	size: number,
	age: number,
	r: number,
): [number, number] => {
	const k = dragRate(drag, size, r);
	if (k <= 0 || gravity === 0) {
		return [0.5 * gravity * age * age, gravity * age];
	}
	const sign = Math.sign(gravity);
	const g = Math.abs(gravity);
	if (drag.byVelocity) {
		const terminal = Math.sqrt(g / k);
		const x = (g * age) / terminal;
		// ln(cosh(x)), kept finite for large x
		const logCosh = x + Math.log1p(Math.exp(-2 * x)) - Math.LN2;
		return [(sign * terminal * terminal * logCosh) / g, sign * terminal * Math.tanh(x)];
	}
	const decay = Math.exp(-k * age);
	return [(sign * g * (age - (1 - decay) / k)) / k, (sign * g * (1 - decay)) / k];
};

/** what a freely moving particle's path starts from, in the emitter's frame */
interface PathStart {
	id: number;
	start: Vec3;
	direction: Vec3;
	/** m/s along {@link direction} */
	speed: number;
	/** the velocity module's speed modifier, 1 when it's a curve ({@link modifierAt}) */
	modifier: number;
	/**
	 * a speed modifier curve at an age, s, which `speed` leaves out; `null` when it's constant. the packer
	 * leaves such systems without a speed limit or drag
	 */
	modifierAt: ((age: number) => number) | null;
	/** m/s² along {@link down} */
	gravity: number;
	/** seconds */
	age: number;
	life: number;
	down: Vec3;
	worldToLocal: (direction: Vec3) => Vec3;
}

/** steps per second {@link limitedPath} takes: the 30 fps Unity's speed limit is stated against */
const LIMIT_STEP_RATE = 30;
/** the most steps {@link limitedPath} takes; longer ages take longer steps */
const LIMIT_MAX_STEPS = 600;

/** where a stepped particle had got to: its age, its own velocity and how far it had moved */
export interface LimitedState {
	age: number;
	own: Vec3;
	offset: Vec3;
}

/**
 * a particle's path under a speed limit, stepped from its birth or from an earlier state of the same path:
 * each step adds gravity to the particle's own velocity, pulls the whole speed (its own velocity plus the
 * extra velocity) towards the limit, taking the excess from its own velocity, then moves it by the whole
 * velocity
 *
 * @param path the limit (and its random value), the particle's start velocity, its acceleration, the extra
 *   velocity at an age and a distance moved from the start, its age and lifetime, in seconds, and the state
 *   to continue from (one at or before `age`, else the birth)
 * @returns how far it has moved by `age`, its velocity then, and the state to continue from later
 */
export const limitedPath = (path: {
	limit: ParticleSpeedLimitInfo;
	r: number;
	start: Vec3;
	acceleration: Vec3;
	extra: (age: number, moved: Vec3) => Vec3;
	age: number;
	life: number;
	from?: LimitedState;
}): { offset: Vec3; velocity: Vec3; state: LimitedState } => {
	const { limit, r, acceleration, extra, age, life } = path;
	const from =
		path.from !== undefined && path.from.age <= age
			? path.from
			: { age: 0, own: path.start, offset: [0, 0, 0] as Vec3 };
	const span = age - from.age;
	const steps = span > 0 ? Math.min(Math.ceil(span * LIMIT_STEP_RATE), LIMIT_MAX_STEPS) : 0;
	const h = steps > 0 ? span / steps : 0;
	const pull = 1 - (1 - limit.dampen) ** (h * LIMIT_STEP_RATE);
	const own: Vec3 = [...from.own];
	const offset: Vec3 = [...from.offset];
	for (let i = 1; i <= steps; i++) {
		const t = from.age + i * h;
		const added = extra(t, offset);
		const whole: Vec3 = [0, 0, 0];
		for (let axis = 0; axis < 3; axis++) {
			own[axis] += acceleration[axis] * h;
			whole[axis] = own[axis] + added[axis];
		}
		const speed = Math.hypot(...whole);
		const cap = evaluateMinMax(limit.limit, life > 0 ? t / life : 0, r);
		if (speed > cap) {
			const scale = (speed + (cap - speed) * pull) / speed;
			for (let axis = 0; axis < 3; axis++) {
				whole[axis] *= scale;
				own[axis] = whole[axis] - added[axis];
			}
		}
		for (let axis = 0; axis < 3; axis++) {
			offset[axis] += whole[axis] * h;
		}
	}
	const added = extra(age, offset);
	return {
		offset,
		velocity: [own[0] + added[0], own[1] + added[1], own[2] + added[2]],
		state: { age, own: [...own], offset: [...offset] },
	};
};

/** sample pairs {@link integrateAge} takes */
const TRAVEL_STEPS = 8;

/**
 * @param f a rate at an age, s
 * @param age the age to integrate it up to, s
 * @returns its integral from birth to `age` (Simpson's rule)
 */
export const integrateAge = (f: (age: number) => number, age: number): number => {
	const n = TRAVEL_STEPS * 2;
	const h = age / n;
	let sum = f(0) + f(age);
	for (let i = 1; i < n; i++) {
		sum += f(i * h) * (i % 2 === 1 ? 4 : 2);
	}
	return (sum * h) / 3;
};

/**
 * @param curve a velocity, m/s, read at the particle's age over its lifetime
 * @param age the particle's age, s
 * @param life its lifetime, s
 * @param r its random value for the velocity
 * @param scale a factor on the velocity at an age, s, such as a speed modifier curve; none when omitted
 * @returns how far the velocity has carried it, m
 */
export const travelled = (
	curve: MinMaxCurveInfo,
	age: number,
	life: number,
	r: number,
	scale?: (age: number) => number,
): number => {
	if (scale === undefined && (curve.mode === CurveMode.Constant || curve.mode === CurveMode.TwoConstants)) {
		return evaluateMinMax(curve, 0, r) * age;
	}
	return integrateAge(
		(a) => evaluateMinMax(curve, life > 0 ? Math.min(a / life, 1) : 0, r) * (scale?.(a) ?? 1),
		age,
	);
};

/**
 * a point along a particle path, as the game finds it: the segment the distance falls in, at the Bézier
 * parameter its share of that segment's length
 *
 * @param spline the path
 * @param distance m along it
 * @returns the point and the derivative per metre of distance, or `null` past the path's end
 */
export const splinePoint = (
	spline: ParticleSplineInfo,
	distance: number,
): { position: Vec3; tangent: Vec3 } | null => {
	let start = 0;
	for (const segment of spline.segments) {
		if (distance < start + segment.length) {
			const u = Math.max(distance - start, 0) / segment.length;
			const [p0, p1, p2, p3] = segment.points;
			const v = 1 - u;
			const b = [v * v * v, 3 * u * v * v, 3 * u * u * v, u * u * u];
			const d = [-3 * v * v, 3 * v * v - 6 * u * v, 6 * u * v - 3 * u * u, 3 * u * u];
			const position: Vec3 = [0, 0, 0];
			const tangent: Vec3 = [0, 0, 0];
			for (let axis = 0; axis < 3; axis++) {
				position[axis] = b[0] * p0[axis] + b[1] * p1[axis] + b[2] * p2[axis] + b[3] * p3[axis];
				tangent[axis] =
					(d[0] * p0[axis] + d[1] * p1[axis] + d[2] * p2[axis] + d[3] * p3[axis]) / segment.length;
			}
			return { position, tangent };
		}
		start += segment.length;
	}
	return null;
};

/**
 * @param lived a ring-buffered particle's age over its lifetime, which can pass 1
 * @param loopRange the span of the lifetime it replays once it reaches the span's end, or `null` to hold it
 *   at the end of its lifetime
 * @returns the age over its lifetime it shows
 */
export const ringBufferAge = (lived: number, loopRange: readonly [number, number] | null): number => {
	if (loopRange === null) {
		return Math.min(lived, 1);
	}
	const [start, end] = loopRange;
	if (lived <= end) {
		return lived;
	}
	const span = end - start;
	return span > 0 ? start + ((lived - end) % span) : end;
};

/**
 * the tile of a texture sheet a particle shows
 *
 * @param sheet the system's texture sheet
 * @param lived the particle's age over its lifetime, 0–1
 * @param age its age, s
 * @param loop the emission's place in its loop, where the start frame is read
 * @param randomOf the particle's random value for a channel
 * @param mesh the index of the particle's mesh
 * @returns the tile, counted from the sheet's top-left along its rows
 */
export const sheetTile = (
	sheet: ParticleTextureSheetInfo,
	lived: number,
	age: number,
	loop: number,
	randomOf: (channel: number) => number,
	mesh: number,
): number => {
	const [columns, rows] = sheet.tiles;
	const frames = sheet.row === null ? columns * rows : columns;
	let frame = evaluateMinMax(sheet.startFrame, loop, randomOf(Channel.StartFrame));
	if (sheet.frameOverTime === null) {
		frame += (age * sheet.fps) / frames;
	} else {
		// a particle held at the end of its lifetime keeps the last cycle's end
		const t = lived * sheet.cycles;
		const phase = lived >= 1 ? 1 : t - Math.floor(t);
		frame += evaluateMinMax(sheet.frameOverTime, phase, randomOf(Channel.FrameOverTime));
	}
	const index = Math.min(Math.floor((frame - Math.floor(frame)) * frames), frames - 1);
	switch (sheet.row) {
		case null: {
			return index;
		}
		case SheetRow.Random: {
			return Math.floor(randomOf(Channel.SheetRow) * rows) * columns + index;
		}
		case SheetRow.MeshIndex: {
			return Math.min(mesh, rows - 1) * columns + index;
		}
		default: {
			return sheet.row * columns + index;
		}
	}
};

/** @returns the largest value a MinMaxCurve can take, keys bounding its curves */
const upperBound = (curve: MinMaxCurveInfo): number => {
	switch (curve.mode) {
		case CurveMode.Constant: {
			return curve.scalar;
		}
		case CurveMode.TwoConstants: {
			return Math.max(curve.scalar, curve.min);
		}
		default: {
			let most = -Infinity;
			for (const key of [...(curve.curve?.keys ?? []), ...(curve.minCurve?.keys ?? [])]) {
				most = Math.max(most, key.value * curve.scalar);
			}
			return Number.isFinite(most) ? most : 0;
		}
	}
};

/** @returns a constant or random-between-two-constants rate's mean */
const meanOf = (curve: MinMaxCurveInfo): number =>
	curve.mode === CurveMode.TwoConstants ? (curve.min + curve.scalar) / 2 : curve.scalar;

/** @returns the xyzw quaternion of Unity Euler angles in radians (Z, then X, then Y) */
const eulerQuaternion = (x: number, y: number, z: number): [number, number, number, number] => {
	const cx = Math.cos(x / 2),
		cy = Math.cos(y / 2),
		cz = Math.cos(z / 2);
	const sx = Math.sin(x / 2),
		sy = Math.sin(y / 2),
		sz = Math.sin(z / 2);
	return [
		cy * sx * cz + sy * cx * sz,
		sy * cx * cz - cy * sx * sz,
		cy * cx * sz - sy * sx * cz,
		cy * cx * cz + sy * sx * sz,
	];
};

/** @returns `v` rotated by the xyzw quaternion `q` */
const rotate = (q: ArrayLike<number>, v: ArrayLike<number>): Vec3 => {
	const x = q[0],
		y = q[1],
		z = q[2],
		w = q[3];
	// t = 2 · cross(q.xyz, v); v' = v + w · t + cross(q.xyz, t)
	const tx = 2 * (y * v[2] - z * v[1]);
	const ty = 2 * (z * v[0] - x * v[2]);
	const tz = 2 * (x * v[1] - y * v[0]);
	return [
		v[0] + w * tx + (y * tz - z * ty),
		v[1] + w * ty + (z * tx - x * tz),
		v[2] + w * tz + (x * ty - y * tx),
	];
};

/** @returns `v` rotated about the unit axis of `omega` by its length (radians) */
const rotateBy = (omega: Vec3, v: Vec3): Vec3 => {
	const angle = Math.hypot(omega[0], omega[1], omega[2]);
	if (angle < 1e-9) {
		return v;
	}
	const s = Math.sin(angle / 2) / angle;
	return rotate([omega[0] * s, omega[1] * s, omega[2] * s, Math.cos(angle / 2)], v);
};

/**
 * @param to a direction, any length
 * @returns the xyzw quaternion turning +z onto it the shortest way: none for a zero vector, half a turn about
 *   x for −z
 */
export const turnFromZ = (to: ArrayLike<number>): [number, number, number, number] => {
	const length = Math.hypot(to[0], to[1], to[2]);
	if (length < 1e-12) {
		return [0, 0, 0, 1];
	}
	const z = to[2] / length;
	if (z < -1 + 1e-9) {
		return [1, 0, 0, 0];
	}
	// half the angle via the halfway vector: q = (z × v, 1 + z · v), normalized
	const x = -to[1] / length;
	const y = to[0] / length;
	const w = 1 + z;
	const n = Math.hypot(x, y, w);
	return [x / n, y / n, 0, w / n];
};

const normalize = (v: Vec3): Vec3 => {
	const length = Math.hypot(v[0], v[1], v[2]);
	return length > 1e-12 ? [v[0] / length, v[1] / length, v[2] / length] : [0, 0, 1];
};

/** a uniformly random unit vector from two random values */
const unitVector = (a: number, b: number): Vec3 => {
	const z = 2 * a - 1;
	const r = Math.sqrt(Math.max(0, 1 - z * z));
	const phi = 2 * Math.PI * b;
	return [r * Math.cos(phi), r * Math.sin(phi), z];
};

/** one emission: when (system time) and which particle */
interface Emission {
	time: number;
	id: number;
}

interface AdmittedEmission extends Emission {
	/** s */
	life: number;
}

/**
 * a system's particles over time, for one emitter
 *
 * @see ParticleField for the emitter's frame
 */
export class ParticleSimulation {
	readonly info: ParticleSystemInfo;
	readonly #seed: number;
	/** seconds before the first emission, drawn once per emitter as the game draws it once per play */
	readonly #startDelay: number;
	/** the longest a particle lives, s */
	readonly #longest: number;
	/** how far back emissions can still be alive, s: their lifetime, or until enough newer ones replace them */
	readonly #lookback: number;
	/** particles per second */
	readonly #rate: number;
	readonly #meshTotal: number;
	readonly #shapeRotation: [number, number, number, number];
	readonly #emissions: Emission[] = [];
	/** whether the cap can turn emissions away, so that which particles live depends on what came before */
	readonly #capped: boolean;
	/** the emissions the cap let in that may still be alive, oldest first */
	#admitted: AdmittedEmission[] = [];
	/** the system time {@link #admitted} has been played to */
	#admittedUntil = -Infinity;
	/**
	 * where each speed-limited particle drawn last frame had stepped to, so the next frame steps on from there
	 * rather than from its birth
	 */
	#limited = new Map<number, LimitedState>();
	/** the speed-limited particles placed during the current {@link evaluate} */
	#limitedNow = new Map<number, LimitedState>();

	/**
	 * @param info the system
	 * @param seed the emitter's random seed; emitters drawing other meshes of the same renderer share it
	 */
	constructor(info: ParticleSystemInfo, seed: number) {
		this.info = info;
		this.#seed = seed;
		this.#startDelay = Math.max(evaluateMinMax(info.startDelay, 0, random(seed, 0, Channel.StartDelay)), 0);
		this.#longest = Math.max(upperBound(info.startLifetime), 0);
		this.#rate = Math.max(meanOf(info.rate), 0);
		this.#lookback = this.#longest;
		if (info.ringBuffer !== null) {
			// the newest `maxParticles` emissions stay; look back far enough to find that many
			const burstsPerLoop = info.bursts.reduce(
				(sum, burst) => sum + Math.max(upperBound(burst.count), 0) * burst.cycles * burst.probability,
				0,
			);
			const perSecond = this.#rate + burstsPerLoop / info.duration;
			const kept = Math.min(info.maxParticles, MAX_PARTICLES) + 1;
			if (!info.looping) {
				this.#lookback = Infinity;
			} else if (perSecond > 0) {
				this.#lookback = Math.max(this.#longest, kept / perSecond + info.duration);
			}
		}
		this.#capped = info.ringBuffer === null && info.emissionBound > info.maxParticles;
		this.#meshTotal = info.meshWeights.reduce((sum, weight) => sum + weight, 0);
		const rotation = info.shape?.rotation ?? [0, 0, 0];
		this.#shapeRotation = eulerQuaternion(
			(rotation[0] * Math.PI) / 180,
			(rotation[1] * Math.PI) / 180,
			(rotation[2] * Math.PI) / 180,
		);
	}

	/** seconds a looping system needs to look as if it had always played */
	get settleTime(): number {
		return this.#startDelay + this.#lookback + this.info.duration;
	}

	/** the most particles alive at once: the cap, or less when one lifetime of emission holds fewer */
	get liveBound(): number {
		const { maxParticles, ringBuffer } = this.info;
		if (ringBuffer !== null) {
			return maxParticles;
		}
		return Math.min(maxParticles, this.info.emissionBound);
	}

	/**
	 * the live particles that draw this entry's mesh at a system time, newest last.
	 *
	 * @param time seconds of system time (the viewer's time times the simulation speed)
	 * @param down world down in the emitter's frame, unit length per metre of world (gravity's direction)
	 * @param worldToLocal turns a world direction into the emitter's frame (for world-space velocities)
	 * @param out {@link PARTICLE_FLOATS} floats per particle: position in the emitter's frame, rotation, size,
	 *   texture sheet tile
	 * @returns how many particles were written (at most `out.length / PARTICLE_FLOATS`)
	 */
	evaluate(time: number, down: Vec3, worldToLocal: (direction: Vec3) => Vec3, out: Float32Array): number {
		const emissions = this.#capped ? this.#admit(time) : this.#emitted(time - this.#lookback, time);
		this.#limitedNow.clear();
		const capacity = Math.floor(out.length / PARTICLE_FLOATS);
		const ringBuffer = this.info.ringBuffer;
		let count = 0;
		// with a ring buffer the newest particles win when there are more than the system allows
		let alive = 0;
		for (let i = emissions.length - 1; i >= 0 && alive < this.info.maxParticles && count < capacity; i--) {
			const { time: born, id } = emissions[i];
			let age = time - born;
			const life = this.#lifetime(emissions[i]);
			if (age < 0 || (ringBuffer === null && age >= life)) {
				continue;
			}
			if (ringBuffer !== null && life > 0) {
				age = life * ringBufferAge(age / life, ringBuffer.loop ? ringBuffer.loopRange : null);
			}
			// a particle that runs off its path's end is gone
			if (this.#splineAt(id, age, life) === null) {
				continue;
			}
			alive++;
			if (this.#drawsMesh(id)) {
				this.#place(id, born, age, down, worldToLocal, out, count * PARTICLE_FLOATS);
				count++;
			}
		}
		// keep only the particles still drawn
		[this.#limited, this.#limitedNow] = [this.#limitedNow, this.#limited];
		return count;
	}

	/**
	 * @returns where a particle is along the system's path and how it moves there, in the path's frame:
	 *   `undefined` without a path, `null` once it has run off the end
	 */
	#splineAt(id: number, age: number, life: number): { position: Vec3; moving: Vec3 } | null | undefined {
		const spline = this.info.motion;
		if (spline.kind !== 'spline') {
			return undefined;
		}
		const r = random(this.#seed, id, Channel.SplineSpeed);
		const point = splinePoint(spline, travelled(spline.speed, age, life, r));
		if (point === null) {
			return null;
		}
		const speed = evaluateMinMax(spline.speed, life > 0 ? Math.min(age / life, 1) : 0, r);
		const t = point.tangent;
		return { position: point.position, moving: [t[0] * speed, t[1] * speed, t[2] * speed] };
	}

	/** @returns how long an emission's particle lives, s */
	#lifetime({ time, id }: Emission): number {
		return evaluateMinMax(
			this.info.startLifetime,
			this.#loopFraction(time),
			random(this.#seed, id, Channel.Lifetime),
		);
	}

	/**
	 * plays the cap forward to `time`: an emission is let in only while fewer than the cap are alive, as the
	 * game skips emissions once the system is full. the result depends on every earlier emission, so it's kept
	 * between calls and played from where it stopped.
	 *
	 * @returns the admitted emissions that may still be alive, oldest first
	 */
	#admit(time: number): AdmittedEmission[] {
		const { maxParticles } = this.info;
		const startDelay = this.#startDelay;
		// further back than a few lifetimes the history barely shows, so a long jump or a step back starts
		// afresh from an empty system there
		const horizon = 4 * this.#longest + this.info.duration;
		let after = this.#admittedUntil;
		if (time < after || time - after > horizon) {
			this.#admitted = [];
			after = Math.max(startDelay, time - horizon) - 1e-9;
		}
		// the stream's emissions per window are capped, so play in steps that hold them all
		const step = Math.max(
			this.#rate > 0 ? Math.min(this.#longest, MAX_PARTICLES / this.#rate) : this.#longest,
			1e-3,
		);
		let admitted = this.#admitted;
		while (after < time) {
			const to = Math.min(time, after + step);
			for (const emission of this.#emitted(after, to)) {
				if (emission.time <= after) {
					continue;
				}
				let alive = 0;
				for (const other of admitted) {
					if (other.time + other.life > emission.time) {
						alive++;
					}
				}
				if (alive < maxParticles) {
					admitted.push({ ...emission, life: this.#lifetime(emission) });
				}
			}
			admitted = admitted.filter((emission) => emission.time + emission.life > to);
			after = to;
		}
		this.#admitted = admitted;
		this.#admittedUntil = time;
		return admitted;
	}

	/** the emissions in a window of system time whose particles could be alive at its end */
	#emitted(start: number, time: number): Emission[] {
		const emissions = this.#emissions;
		emissions.length = 0;
		const { duration, looping, bursts } = this.info;
		const startDelay = this.#startDelay;
		const from = Math.max(start, startDelay);
		const end = looping ? time : Math.min(time, startDelay + duration);
		if (end < from) {
			return emissions;
		}
		// bursts first, then the rate's steady stream, each with ids of their own
		for (const [b, burst] of bursts.entries()) {
			const firstLoop = looping
				? Math.max(0, Math.floor((from - startDelay - burst.time) / duration) - 1)
				: 0;
			const lastLoop = looping ? Math.floor((end - startDelay) / duration) : 0;
			for (let loop = firstLoop; loop <= lastLoop; loop++) {
				for (let cycle = 0; cycle < burst.cycles; cycle++) {
					const offset = burst.time + cycle * burst.interval;
					const at = startDelay + loop * duration + offset;
					if (offset > duration || at < from || at > end) {
						continue;
					}
					const event = hash2(hash2(b, loop), cycle);
					if (random(this.#seed, event, Channel.Burst) >= burst.probability) {
						continue;
					}
					const count = Math.round(
						evaluateMinMax(burst.count, offset / duration, random(this.#seed, event, 0)),
					);
					for (let j = 0; j < Math.min(count, MAX_PARTICLES); j++) {
						emissions.push({ time: at, id: hash2(event, j) | 1 });
					}
				}
			}
		}
		emissions.sort((a, b) => a.time - b.time);
		if (this.#rate > 0) {
			const first = Math.max(0, Math.ceil((from - startDelay) * this.#rate));
			const last = Math.floor((end - startDelay) * this.#rate);
			for (let k = Math.max(first, last - MAX_PARTICLES); k <= last; k++) {
				// even ids for the stream, odd for bursts
				emissions.push({ time: startDelay + k / this.#rate, id: (k * 2) >>> 0 });
			}
		}
		emissions.sort((a, b) => a.time - b.time);
		return emissions;
	}

	/** @returns the emission time's place within its loop, 0–1, where start values read their curves */
	#loopFraction(born: number): number {
		const t = (born - this.#startDelay) / this.info.duration;
		return this.info.looping ? t - Math.floor(t) : Math.min(Math.max(t, 0), 1);
	}

	/** whether a particle picked this entry's mesh */
	#drawsMesh(id: number): boolean {
		const weights = this.info.meshWeights;
		if (weights.length <= 1) {
			return true;
		}
		let pick = random(this.#seed, id, Channel.Mesh) * this.#meshTotal;
		for (const [i, weight] of weights.entries()) {
			pick -= weight;
			if (pick < 0) {
				return i === this.info.mesh;
			}
		}
		return weights.length - 1 === this.info.mesh;
	}

	/** where a particle starts and which way it leaves, in the emitter's frame */
	#start(id: number): { position: Vec3; direction: Vec3 } {
		const shape = this.info.shape;
		if (shape === null) {
			return { position: [0, 0, 0], direction: [0, 0, 1] };
		}
		const r0 = random(this.#seed, id, Channel.Shape0);
		const r1 = random(this.#seed, id, Channel.Shape1);
		const r2 = random(this.#seed, id, Channel.Shape2);
		const inner = 1 - Math.min(Math.max(shape.radiusThickness, 0), 1);
		let position: Vec3;
		let direction: Vec3;
		switch (shape.kind) {
			case ParticleShapeKind.Sphere:
			case ParticleShapeKind.Hemisphere: {
				direction = unitVector(r0, r1);
				if (shape.kind === ParticleShapeKind.Hemisphere) {
					direction[2] = Math.abs(direction[2]);
				}
				// uniform in the shell's volume
				const radius = shape.radius * Math.cbrt(inner ** 3 + (1 - inner ** 3) * r2);
				position = [direction[0] * radius, direction[1] * radius, direction[2] * radius];
				break;
			}
			case ParticleShapeKind.Cone:
			case ParticleShapeKind.ConeVolume:
			case ParticleShapeKind.Circle: {
				const phi = (r0 * shape.arc * Math.PI) / 180;
				// uniform in the ring's area
				const rho = Math.sqrt(inner * inner + (1 - inner * inner) * r1);
				const c = Math.cos(phi);
				const s = Math.sin(phi);
				position = [rho * shape.radius * c, rho * shape.radius * s, 0];
				if (shape.kind === ParticleShapeKind.Circle) {
					direction = [c, s, 0];
					break;
				}
				// towards the matching point on the cone's far end
				const spread = rho * Math.tan((shape.angle * Math.PI) / 180);
				direction = normalize([spread * c, spread * s, 1]);
				if (shape.kind === ParticleShapeKind.ConeVolume) {
					const along = (shape.length * r2) / direction[2];
					position = [
						position[0] + direction[0] * along,
						position[1] + direction[1] * along,
						position[2] + direction[2] * along,
					];
				}
				break;
			}
			case ParticleShapeKind.Box: {
				position = [r0 - 0.5, r1 - 0.5, r2 - 0.5];
				direction = [0, 0, 1];
				break;
			}
			case ParticleShapeKind.Donut: {
				// a point of the circle, then one of the tube's cross-section around it, uniform in its area
				const phi = (r0 * shape.arc * Math.PI) / 180;
				const theta = 2 * Math.PI * r1;
				const rho = shape.donutRadius * Math.sqrt(inner * inner + (1 - inner * inner) * r2);
				const out: Vec3 = [Math.cos(phi), Math.sin(phi), 0];
				direction = [out[0] * Math.cos(theta), out[1] * Math.cos(theta), Math.sin(theta)];
				position = [
					out[0] * shape.radius + direction[0] * rho,
					out[1] * shape.radius + direction[1] * rho,
					direction[2] * rho,
				];
				break;
			}
		}
		position = rotate(this.#shapeRotation, [
			position[0] * shape.scale[0],
			position[1] * shape.scale[1],
			position[2] * shape.scale[2],
		]);
		position = [
			position[0] + shape.position[0],
			position[1] + shape.position[1],
			position[2] + shape.position[2],
		];
		direction = normalize(
			rotate(this.#shapeRotation, [
				direction[0] * shape.scale[0],
				direction[1] * shape.scale[1],
				direction[2] * shape.scale[2],
			]),
		);
		if (shape.randomDirection > 0) {
			const away = unitVector(
				random(this.#seed, id, Channel.Direction0),
				random(this.#seed, id, Channel.Direction1),
			);
			const a = shape.randomDirection;
			direction = normalize([
				direction[0] + (away[0] - direction[0]) * a,
				direction[1] + (away[1] - direction[1]) * a,
				direction[2] + (away[2] - direction[2]) * a,
			]);
		}
		if (shape.sphericalDirection > 0) {
			const out = normalize([
				position[0] - shape.position[0],
				position[1] - shape.position[1],
				position[2] - shape.position[2],
			]);
			const a = shape.sphericalDirection;
			direction = normalize([
				direction[0] + (out[0] - direction[0]) * a,
				direction[1] + (out[1] - direction[1]) * a,
				direction[2] + (out[2] - direction[2]) * a,
			]);
		}
		if (shape.randomPosition > 0) {
			const a = shape.randomPosition * 2;
			position = [
				position[0] + (random(this.#seed, id, Channel.Position0) - 0.5) * a,
				position[1] + (random(this.#seed, id, Channel.Position1) - 0.5) * a,
				position[2] + (random(this.#seed, id, Channel.Position2) - 0.5) * a,
			];
		}
		return { position, direction };
	}

	/** where an unlimited particle is at an age and how it moves then, in closed form */
	#freePath(
		drag: ParticleDragInfo | null,
		velocity: ParticleVelocityInfo | null,
		motion: PathStart & { startSize: number[] },
	): { position: Vec3; moving: Vec3 } {
		const seed = this.#seed;
		const {
			id,
			start,
			direction,
			speed,
			modifier,
			modifierAt,
			gravity,
			startSize,
			age,
			life,
			down,
			worldToLocal,
		} = motion;
		const lived = life > 0 ? age / life : 0;
		// the game moves a particle by its whole velocity times the speed modifier: `scaledAge` is the modifier's
		// integral over the age, which a constant velocity moves by, and `scaleNow` its value now
		const scaledAge = modifierAt === null ? age : integrateAge(modifierAt, age);
		const scaleNow = modifierAt === null ? 1 : modifierAt(age);
		const [launch, launchSpeed] =
			drag === null
				? [speed * scaledAge, speed * scaleNow]
				: dragged(drag, speed, Math.max(...startSize), age, random(seed, id, Channel.Drag));
		const [fall, fallSpeed] =
			drag === null
				? [0.5 * gravity * age * age, gravity * age]
				: draggedFall(drag, gravity, Math.max(...startSize), age, random(seed, id, Channel.Drag));
		let position: Vec3 = [
			start[0] + direction[0] * launch + down[0] * fall,
			start[1] + direction[1] * launch + down[1] * fall,
			start[2] + direction[2] * launch + down[2] * fall,
		];
		let moving: Vec3 = [
			direction[0] * launchSpeed + down[0] * fallSpeed,
			direction[1] * launchSpeed + down[1] * fallSpeed,
			direction[2] * launchSpeed + down[2] * fallSpeed,
		];
		if (velocity !== null) {
			const channels = [Channel.VelocityX, Channel.VelocityY, Channel.VelocityZ];
			let linear: Vec3 = [0, 0, 0];
			let linearNow: Vec3 = [0, 0, 0];
			for (let axis = 0; axis < 3; axis++) {
				const r = random(seed, id, channels[axis]);
				linear[axis] = travelled(velocity.linear[axis], age, life, r, modifierAt ?? undefined);
				linearNow[axis] = evaluateMinMax(velocity.linear[axis], lived, r) * scaleNow;
			}
			if (velocity.linearInWorld) {
				linear = worldToLocal(linear);
				linearNow = worldToLocal(linearNow);
			}
			const offset = velocity.orbitalOffset;
			const radialRate = evaluateMinMax(velocity.radial, 0, random(seed, id, Channel.Radial)) * modifier;
			const radialSpeed = radialRate * scaleNow;
			const radial = radialRate * scaledAge;
			const outward = normalize([start[0] - offset[0], start[1] - offset[1], start[2] - offset[2]]);
			position = [
				position[0] + linear[0] * modifier + outward[0] * radial,
				position[1] + linear[1] * modifier + outward[1] * radial,
				position[2] + linear[2] * modifier + outward[2] * radial,
			];
			moving = [
				moving[0] + linearNow[0] * modifier + outward[0] * radialSpeed,
				moving[1] + linearNow[1] * modifier + outward[1] * radialSpeed,
				moving[2] + linearNow[2] * modifier + outward[2] * radialSpeed,
			];
			// the orbit turns the particle about the offset at a constant rate; applied to the whole path, which is
			// exact when the other motion runs along the orbit's axis (the crater rocks rise along theirs)
			const turn: Vec3 = [
				evaluateMinMax(velocity.orbital[0], 0, random(seed, id, Channel.OrbitalX)) * modifier * scaledAge,
				evaluateMinMax(velocity.orbital[1], 0, random(seed, id, Channel.OrbitalY)) * modifier * scaledAge,
				evaluateMinMax(velocity.orbital[2], 0, random(seed, id, Channel.OrbitalZ)) * modifier * scaledAge,
			];
			const turned = rotateBy(turn, [
				position[0] - offset[0],
				position[1] - offset[1],
				position[2] - offset[2],
			]);
			position = [turned[0] + offset[0], turned[1] + offset[1], turned[2] + offset[2]];
		}
		return { position, moving };
	}

	/**
	 * where a particle under a speed limit is at an age and how it moves then, stepped ({@link limitedPath}).
	 * the velocity module's linear, orbital and radial terms are the extra velocity the limit includes; the
	 * orbit moves the particle along its circle's tangent at its current place. the packer leaves such systems
	 * without drag
	 */
	#limitedPath(
		limit: ParticleSpeedLimitInfo,
		velocity: ParticleVelocityInfo | null,
		motion: PathStart,
	): { position: Vec3; moving: Vec3 } {
		const seed = this.#seed;
		const { id, start, direction, speed, modifier, gravity, age, life, down, worldToLocal } = motion;
		const linearChannels = [Channel.VelocityX, Channel.VelocityY, Channel.VelocityZ];
		const linearRandoms = linearChannels.map((channel) => random(seed, id, channel));
		const orbitChannels = [Channel.OrbitalX, Channel.OrbitalY, Channel.OrbitalZ];
		const spin: Vec3 = [0, 0, 0];
		let radial = 0;
		if (velocity !== null) {
			for (let axis = 0; axis < 3; axis++) {
				spin[axis] =
					evaluateMinMax(velocity.orbital[axis], 0, random(seed, id, orbitChannels[axis])) * modifier;
			}
			radial = evaluateMinMax(velocity.radial, 0, random(seed, id, Channel.Radial)) * modifier;
		}
		const extra = (t: number, moved: Vec3): Vec3 => {
			if (velocity === null) {
				return [0, 0, 0];
			}
			const lived = life > 0 ? t / life : 0;
			let linear: Vec3 = [0, 0, 0];
			for (let axis = 0; axis < 3; axis++) {
				linear[axis] = evaluateMinMax(velocity.linear[axis], lived, linearRandoms[axis]) * modifier;
			}
			if (velocity.linearInWorld) {
				linear = worldToLocal(linear);
			}
			const centre = velocity.orbitalOffset;
			const from: Vec3 = [
				start[0] + moved[0] - centre[0],
				start[1] + moved[1] - centre[1],
				start[2] + moved[2] - centre[2],
			];
			const outward = normalize(from);
			// ω × r, the orbit's velocity at the particle's place
			return [
				linear[0] + spin[1] * from[2] - spin[2] * from[1] + outward[0] * radial,
				linear[1] + spin[2] * from[0] - spin[0] * from[2] + outward[1] * radial,
				linear[2] + spin[0] * from[1] - spin[1] * from[0] + outward[2] * radial,
			];
		};
		const {
			offset,
			velocity: moving,
			state,
		} = limitedPath({
			limit,
			r: random(seed, id, Channel.SpeedLimit),
			start: [direction[0] * speed, direction[1] * speed, direction[2] * speed],
			acceleration: [down[0] * gravity, down[1] * gravity, down[2] * gravity],
			extra,
			age,
			life,
			from: this.#limited.get(id),
		});
		this.#limitedNow.set(id, state);
		return { position: [start[0] + offset[0], start[1] + offset[1], start[2] + offset[2]], moving };
	}

	/** writes one live particle */
	#place(
		id: number,
		born: number,
		age: number,
		down: Vec3,
		worldToLocal: (direction: Vec3) => Vec3,
		out: Float32Array,
		at: number,
	): void {
		const info = this.info;
		const seed = this.#seed;
		const u = this.#loopFraction(born);
		const life = evaluateMinMax(info.startLifetime, u, random(seed, id, Channel.Lifetime));
		const { position: start, direction } = this.#start(id);
		const lived = life > 0 ? age / life : 0;
		const sizeRandom = random(seed, id, Channel.Size);
		const growth = random(seed, id, Channel.SizeOverLifetime);
		const startSize = info.startSize.map((curve) => evaluateMinMax(curve, u, sizeRandom));
		let path: { position: Vec3; moving: Vec3 };
		const motion = info.motion;
		if (motion.kind === 'spline') {
			// a path's particles start at their place in the shape, offset from it
			const along = this.#splineAt(id, age, life) ?? { position: [0, 0, 0], moving: [0, 0, 0] };
			path = {
				position: [start[0] + along.position[0], start[1] + along.position[1], start[2] + along.position[2]],
				moving: along.moving,
			};
		} else {
			const { velocity, clamp } = motion;
			let modifier = 1;
			let modifierAt: ((age: number) => number) | null = null;
			if (velocity !== null) {
				const curve = velocity.speedModifier;
				const r = random(seed, id, Channel.SpeedModifier);
				if (curve.mode === CurveMode.Constant || curve.mode === CurveMode.TwoConstants) {
					modifier = evaluateMinMax(curve, 0, r);
				} else {
					// the game reads it each step at the particle's age over its lifetime, as linear velocities
					modifierAt = (a) => evaluateMinMax(curve, life > 0 ? Math.min(a / life, 1) : 0, r);
				}
			}
			const begin: PathStart = {
				id,
				start,
				direction,
				speed: evaluateMinMax(motion.startSpeed, u, random(seed, id, Channel.Speed)) * modifier,
				modifier,
				modifierAt,
				// gravity, which Unity always pulls down the world's y
				gravity: GRAVITY * evaluateMinMax(motion.gravityModifier, u, random(seed, id, Channel.Gravity)),
				age,
				life,
				down,
				worldToLocal,
			};
			path =
				clamp?.kind === 'limit'
					? this.#limitedPath(clamp, velocity, begin)
					: this.#freePath(clamp, velocity, { ...begin, startSize });
		}
		const { position, moving } = path;

		const size = startSize.map((value, axis) => {
			const over = info.sizeOverLifetime;
			return value * (over === null ? 1 : evaluateMinMax(over[axis], lived, growth));
		});

		const angles = info.startRotation.map((curve, axis) =>
			evaluateMinMax(curve, u, random(seed, id, Channel.RotationX + axis)),
		);
		const spin = info.rotationOverLifetime;
		if (spin !== null) {
			for (let axis = 0; axis < 3; axis++) {
				angles[axis] += travelled(spin[axis], age, life, random(seed, id, Channel.SpinX + axis));
			}
		}
		const rotation = eulerQuaternion(angles[0], angles[1], angles[2]);
		let color = evaluateMinMaxGradient(info.startColor, u, random(seed, id, Channel.Color));
		if (info.colorOverLifetime !== null) {
			const over = evaluateMinMaxGradient(
				info.colorOverLifetime,
				Math.min(lived, 1),
				random(seed, id, Channel.ColorOverLifetime),
			);
			color = [color[0] * over[0], color[1] * over[1], color[2] * over[2], color[3] * over[3]];
		}
		out.set(position, at + At.position);
		out.set(rotation, at + At.rotation);
		out.set(size, at + At.size);
		out[at + At.tile] =
			info.textureSheet === null
				? 0
				: sheetTile(info.textureSheet, lived, age, u, (channel) => random(seed, id, channel), info.mesh);
		out.set(linearRgb(color), at + At.color);
		out[at + At.color + 3] = color[3];
		out.set(moving, at + At.velocity);
	}
}

// #endregion

// #region rows

/** the camera inputs particle rows depend on */
export interface ParticleView {
	/** seconds of the viewer's clock */
	time: number;
	/** the camera's position (Unity world, f64), which stretched particles turn their width by */
	eye: Vec3;
	/** the viewport's width per metre of view depth, which quads' on-screen size limits are fractions of */
	widthPerDepth: number;
	/** the camera's right, up and forward axes (Unity frame), which view-aligned particles turn with */
	right: Vec3;
	up: Vec3;
	forward: Vec3;
}

/**
 * turns a vector in a row's frame as `row_basis` (frame.wgsl) turns the row's axes for its billboard kind
 *
 * @param billboard the row's billboard kind
 * @param view the camera's axes
 * @param v the vector in the row's frame
 * @returns it in the world's
 */
export const turnedByBillboard = (
	billboard: RowBillboard,
	view: ParticleView,
	v: readonly number[],
): Vec3 => {
	let basis: readonly Vec3[];
	switch (billboard) {
		case RowBillboard.Facing: {
			basis = [view.right, view.up, view.forward];
			break;
		}
		case RowBillboard.Upright: {
			// level and defined even looking straight down; Unity's forward is right × up
			const right = normalize([view.right[0], 0, view.right[2]]);
			basis = [right, [0, 1, 0], [-right[2], 0, right[0]]];
			break;
		}
		default: {
			return [v[0], v[1], v[2]];
		}
	}
	const row = (r: number) => basis[0][r] * v[0] + basis[1][r] * v[1] + basis[2][r] * v[2];
	return [row(0), row(1), row(2)];
};

/**
 * holds a quad's larger side between its on-screen limits, as the engine does before building quads
 *
 * @param sizes the quad's sizes along its x, y and z, m
 * @param limits the smallest and largest it may be, as fractions of the viewport's width at its depth
 * @param view the camera
 * @param at the particle's world position
 * @returns the sizes scaled together to fit, or zero behind the camera
 */
export const screenLimited = (
	sizes: readonly number[],
	limits: { min: number; max: number },
	view: ParticleView,
	at: Vec3,
): number[] => {
	const f = view.forward;
	const depth = (at[0] - view.eye[0]) * f[0] + (at[1] - view.eye[1]) * f[1] + (at[2] - view.eye[2]) * f[2];
	const half = 0.5 * Math.max(sizes[0], sizes[1]);
	if (depth <= 0 || half <= 0) {
		return [0, 0, 0];
	}
	const width = view.widthPerDepth * depth;
	const held = Math.min(Math.max(half, 0.5 * limits.min * width), 0.5 * limits.max * width);
	const ratio = held / half;
	return [sizes[0] * ratio, sizes[1] * ratio, sizes[2]];
};

/** one emitter's particles: its rows in the instance buffer and its clock */
interface Emitter {
	simulation: ParticleSimulation;
	rows: RangeAllocation;
	/** the viewer time the emitter was first drawn, which non-looping systems start from */
	start: number;
	/** the frame its rows were last written */
	frame: number;
	/** global indices of the rows holding live particles */
	live: number[];
}

/** what {@link ParticleField} needs of the instance buffer */
export interface ParticleRowStore {
	allocateRows(count: number): RangeAllocation | null;
	freeRows(alloc: RangeAllocation): void;
	writeRows(start: number, rows: Uint32Array<ArrayBuffer>, count: number): void;
}

/**
 * the particles of every drawn emitter, as instance rows. an emitter is an instance row whose draw names a
 * particle system: its transform is the system's frame, and its particles' rows use its block's origin
 */
export class ParticleField {
	readonly #systems: readonly ParticleSystemInfo[];
	/** each system's seed salt, the same for entries differing only in their mesh */
	readonly #salts: number[];
	readonly #store: ParticleRowStore;
	readonly #emitters = new Map<ResidentInstances, Map<number, Emitter>>();
	readonly #scratch = new Float32Array(MAX_PARTICLES * PARTICLE_FLOATS);
	readonly #rows = new Uint32Array(MAX_PARTICLES * ROW_WORDS);
	readonly #rowsF32 = new Float32Array(this.#rows.buffer);

	/**
	 * @param table the package's particle systems
	 * @param store the instance buffer the rows go to
	 */
	constructor(table: ParticlesTable, store: ParticleRowStore) {
		this.#systems = table.systems;
		this.#salts = table.systems.map((system) => hashText(JSON.stringify({ ...system, mesh: 0 })));
		this.#store = store;
	}

	/**
	 * writes an emitter's live particles for this frame, once per frame however many draws ask.
	 *
	 * @param instances the emitter's block
	 * @param row the emitter's row in the block
	 * @param system the particles-table entry its draw names
	 * @param frame the frame number
	 * @param view the clock and camera
	 * @returns the global row indices of its live particles (valid until the next frame)
	 */
	rows(
		instances: ResidentInstances,
		row: number,
		system: number,
		frame: number,
		view: ParticleView,
	): readonly number[] {
		const emitters = this.#emitters.getOrInsertComputed(instances, () => new Map());
		// one emitter per row and system: a renderer's meshes are separate rows
		const key = row * this.#systems.length + system;
		let emitter = emitters.get(key);
		if (emitter === undefined) {
			const info = this.#systems[system];
			if (info === undefined) {
				return [];
			}
			const f32 = instances.rowsF32;
			const at = row * ROW_WORDS;
			// emitters of one renderer's meshes share their place, so they share their particles' random values
			const seed = hash2(
				hash2(this.#salts[system], hashText(`${f32[at + 3]},${f32[at + 7]},${f32[at + 11]}`)),
				0,
			);
			const simulation = new ParticleSimulation(info, seed);
			const rows = this.#store.allocateRows(Math.max(Math.min(simulation.liveBound, MAX_PARTICLES), 1));
			if (rows === null) {
				return [];
			}
			emitter = {
				simulation,
				rows,
				start: view.time,
				frame: -1,
				live: [],
			};
			emitters.set(key, emitter);
		}
		if (emitter.frame !== frame) {
			emitter.frame = frame;
			this.#write(instances, row, emitter, view);
		}
		return emitter.live;
	}

	/** forgets a released block's emitters and frees their rows */
	release(instances: ResidentInstances): void {
		const emitters = this.#emitters.get(instances);
		if (emitters === undefined) {
			return;
		}
		for (const emitter of emitters.values()) {
			this.#store.freeRows(emitter.rows);
		}
		this.#emitters.delete(instances);
	}

	#write(instances: ResidentInstances, row: number, emitter: Emitter, view: ParticleView): void {
		const simulation = emitter.simulation;
		const info = simulation.info;
		const f32 = instances.rowsF32;
		const at = row * ROW_WORDS;
		// the emitter's rows3x4 matrix, translation relative to the block origin
		const m = f32.subarray(at, at + 12);
		const columns: Vec3[] = [
			[m[0], m[4], m[8]],
			[m[1], m[5], m[9]],
			[m[2], m[6], m[10]],
		];
		const scales = columns.map((column) => Math.hypot(column[0], column[1], column[2]));
		// the inverse of a rotation times a scale: project onto each column, divided by its squared length
		const along = (i: number, d: Vec3): number =>
			(columns[i][0] * d[0] + columns[i][1] * d[1] + columns[i][2] * d[2]) /
			Math.max(scales[i] * scales[i], 1e-12);
		const local = (direction: Vec3): Vec3 => [along(0, direction), along(1, direction), along(2, direction)];
		const elapsed = (view.time - emitter.start) * info.simulationSpeed;
		const time = info.looping ? elapsed + simulation.settleTime : elapsed;
		const scratch = this.#scratch;
		const count = simulation.evaluate(
			time,
			local([0, -1, 0]),
			local,
			scratch.subarray(0, Math.min(emitter.rows.count, MAX_PARTICLES) * PARTICLE_FLOATS),
		);
		const out = this.#rowsF32;
		const words = this.#rows;
		const block = instances.blockSlot;
		const sheet = info.textureSheet;
		// the transform's scale always moves the particles, and sizes them unless the system says otherwise
		const sizing = info.sizedByScale ? scales : [1, 1, 1];
		const toWorld = (v: ArrayLike<number>): Vec3 => [
			m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
			m[4] * v[0] + m[5] * v[1] + m[6] * v[2],
			m[8] * v[0] + m[9] * v[1] + m[10] * v[2],
		];
		// the frame quads turn in, by render mode: the camera's or its heading's (which `row_basis` turns them in
		// on the GPU, as billboard chains are), or lying flat facing up. billboards take their render alignment:
		// the camera's (View), the world's axes or the emitter's
		let frame: Vec3[] | null = null;
		let billboard: RowBillboard = RowBillboard.None;
		switch (info.renderMode) {
			case ParticleRenderMode.Billboard: {
				switch (info.alignment) {
					case ParticleAlignment.View: {
						billboard = RowBillboard.Facing;
						break;
					}
					case ParticleAlignment.World: {
						break;
					}
					case ParticleAlignment.Local:
					case ParticleAlignment.Velocity: {
						frame = columns.map(normalize);
						break;
					}
				}
				break;
			}
			case ParticleRenderMode.Vertical: {
				billboard = RowBillboard.Upright;
				break;
			}
			case ParticleRenderMode.Mesh: {
				if (info.alignment === ParticleAlignment.View) {
					billboard = RowBillboard.Facing;
				}
				break;
			}
			case ParticleRenderMode.Horizontal: {
				frame = [
					[1, 0, 0],
					[0, 0, 1],
					[0, -1, 0],
				];
				break;
			}
		}
		emitter.live.length = 0;
		for (let i = 0; i < count; i++) {
			const base = i * PARTICLE_FLOATS;
			const p = scratch.subarray(base + At.position, base + At.position + 3);
			const q = scratch.subarray(base + At.rotation, base + At.rotation + 4);
			const s = scratch.subarray(base + At.size, base + At.size + 3);
			const offset = toWorld(p);
			const center: Vec3 = [offset[0] + m[3], offset[1] + m[7], offset[2] + m[11]];
			// the rotation's axes, then the frame they turn in: the emitter's (local, or turned onto the velocity),
			// the world's, or the camera's
			let axes: Vec3[] = [rotate(q, [1, 0, 0]), rotate(q, [0, 1, 0]), rotate(q, [0, 0, 1])];
			if (info.alignment === ParticleAlignment.Velocity) {
				const onto = turnFromZ(scratch.subarray(base + At.velocity, base + At.velocity + 3));
				axes = axes.map((axis) => rotate(onto, axis));
			}
			let sizes = [s[0] * sizing[0], s[1] * sizing[1], s[2] * sizing[2]];
			// a stretched quad's length comes from its size before the on-screen limits
			const lengthSize = sizes[1];
			if (info.screenSize !== null) {
				sizes = screenLimited(sizes, info.screenSize, view, [
					instances.origin[0] + center[0],
					instances.origin[1] + center[1],
					instances.origin[2] + center[2],
				]);
			}
			const turn = (basis: readonly Vec3[]) => {
				axes = axes.map((axis) => [
					basis[0][0] * axis[0] + basis[1][0] * axis[1] + basis[2][0] * axis[2],
					basis[0][1] * axis[0] + basis[1][1] * axis[1] + basis[2][1] * axis[2],
					basis[0][2] * axis[0] + basis[1][2] * axis[1] + basis[2][2] * axis[2],
				]);
			};
			if (info.renderMode === ParticleRenderMode.Stretched) {
				// a streak from the particle back along its velocity, lengthened by the length scale and the speed.
				// its width runs across the velocity as seen from the camera's position, flattened onto the view
				// plane, so turning the camera in place leaves it be
				const velocity = toWorld(scratch.subarray(base + At.velocity, base + At.velocity + 3));
				const speed = Math.hypot(...velocity);
				const streak: Vec3 =
					speed > 1e-6 ? [velocity[0] / speed, velocity[1] / speed, velocity[2] / speed] : view.up;
				const f = view.forward;
				const sight: Vec3 = [
					instances.origin[0] + center[0] - view.eye[0],
					instances.origin[1] + center[1] - view.eye[1],
					instances.origin[2] + center[2] - view.eye[2],
				];
				const across: Vec3 = [
					streak[1] * sight[2] - streak[2] * sight[1],
					streak[2] * sight[0] - streak[0] * sight[2],
					streak[0] * sight[1] - streak[1] * sight[0],
				];
				const ahead = across[0] * f[0] + across[1] * f[1] + across[2] * f[2];
				const flat: Vec3 = [across[0] - f[0] * ahead, across[1] - f[1] * ahead, across[2] - f[2] * ahead];
				const right: Vec3 = Math.hypot(...flat) > 1e-9 ? normalize(flat) : view.right;
				// the face's own normal, which the effect shaders' Fresnel fades by, turned so the quad's -z normal
				// faces the camera
				let face = normalize([
					right[1] * streak[2] - right[2] * streak[1],
					right[2] * streak[0] - right[0] * streak[2],
					right[0] * streak[1] - right[1] * streak[0],
				]);
				if (face[0] * sight[0] + face[1] * sight[1] + face[2] * sight[2] < 0) {
					face = [-face[0], -face[1], -face[2]];
				}
				axes = [right, streak, face];
				const stretch = info.stretch ?? { lengthScale: 1, velocityScale: 0 };
				const length = lengthSize * stretch.lengthScale + speed * stretch.velocityScale;
				sizes = [sizes[0], length, sizes[2]];
				// the unit quad is centred, and the particle sits at the streak's head
				for (let r = 0; r < 3; r++) {
					center[r] -= streak[r] * length * 0.5;
				}
			} else if (info.renderMode !== ParticleRenderMode.Mesh) {
				if (frame !== null) {
					turn(frame);
				}
			} else {
				switch (info.alignment) {
					case ParticleAlignment.Local:
					case ParticleAlignment.Velocity: {
						axes = axes.map(toWorld);
						sizes = info.sizedByScale
							? [s[0], s[1], s[2]]
							: [s[0] / scales[0], s[1] / scales[1], s[2] / scales[2]];
						break;
					}
					case ParticleAlignment.View: {
						// the GPU turns it with the camera
						break;
					}
					case ParticleAlignment.World: {
						break;
					}
				}
			}
			if (info.pivot.some((value) => value !== 0)) {
				// the pivot moves the mesh in its turned and sized frame, the one it's drawn in: for camera-facing
				// rows that frame is turned on the GPU, so turn the offset with it here
				const inFrame = [0, 1, 2].map((r) =>
					axes.reduce((sum, axis, k) => sum + axis[r] * sizes[k] * info.pivot[k], 0),
				);
				const shift = turnedByBillboard(billboard, view, inFrame);
				for (let r = 0; r < 3; r++) {
					center[r] += shift[r];
				}
			}
			const o = i * ROW_WORDS;
			for (let r = 0; r < 3; r++) {
				out[o + r * 4] = axes[0][r] * sizes[0];
				out[o + r * 4 + 1] = axes[1][r] * sizes[1];
				out[o + r * 4 + 2] = axes[2][r] * sizes[2];
				out[o + r * 4 + 3] = center[r];
			}
			const extent = Math.max(sizes[0], sizes[1], sizes[2]);
			out.set(center, o + 12);
			words[o + 15] = block;
			out[o + 16] = extent;
			out[o + 17] = extent;
			out[o + 18] = extent;
			let rowWord =
				sheet === null
					? RowKind.Detail
					: rowInfo(RowKind.Detail, sheet.tiles, scratch[base + At.tile], sheet.uvChannels);
			const color = scratch.subarray(base + At.color, base + At.color + 4);
			if (color.some((channel) => channel !== 1)) {
				words[o + 18] = packRowColor(color);
				rowWord = (rowWord | ROW_COLORED) >>> 0;
			}
			words[o + 19] = (rowWord | (billboard << 30)) >>> 0;
			emitter.live.push(emitter.rows.start + i);
		}
		if (count > 0) {
			this.#store.writeRows(emitter.rows.start, words, count);
		}
	}
}

// #endregion
