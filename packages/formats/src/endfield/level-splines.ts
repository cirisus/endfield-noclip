import { FormatError } from '../binary/binary-reader.ts';
import { multiplyQuaternions, unityEulerQuaternion } from '../unity/transform.ts';

import type { MemoryPackValue } from './memory-pack.ts';

/** a Unity Splines `BezierKnot`: tangents are in the knot's own frame */
export interface SplineKnot {
	position: [number, number, number];
	tangentIn: [number, number, number];
	tangentOut: [number, number, number];
	/** quaternion x, y, z, w */
	rotation: [number, number, number, number];
}

/** a spline LevelData places (`LevelSplineData`); knots are relative to its position and rotation */
export interface LevelSpline {
	id: number;
	position: [number, number, number];
	/** Unity Euler angles, degrees */
	rotation: [number, number, number];
	closed: boolean;
	knots: SplineKnot[];
}

type Fields = { [key: string]: MemoryPackValue };

const record = (value: MemoryPackValue | undefined, what: string): Fields => {
	if (value === null || value === undefined || typeof value !== 'object' || Array.isArray(value)) {
		throw new FormatError(`invalid spline ${what}`);
	}
	return value;
};

const number = (value: MemoryPackValue | undefined, what: string): number => {
	if (typeof value !== 'number') {
		throw new FormatError(`invalid spline ${what}`);
	}
	return value;
};

const vec3 = (value: MemoryPackValue | undefined, what: string): [number, number, number] => {
	if (Array.isArray(value)) {
		if (value.length !== 3) {
			throw new FormatError(`invalid spline ${what}`);
		}
		return [number(value[0], what), number(value[1], what), number(value[2], what)];
	}
	// Unity.Mathematics float3
	const { x, y, z } = record(value, what);
	return [number(x, what), number(y, what), number(z, what)];
};

/**
 * reads the splines of a LevelData the MemoryPack schema decoded whole (`LevelDataForMemoryPack`)
 *
 * @param levelData the decoded LevelData
 * @returns its splines
 * @throws {FormatError} if a spline is malformed
 */
export const readLevelSplines = (levelData: MemoryPackValue): LevelSpline[] => {
	const { splines } = record(levelData, 'level data');
	if (!Array.isArray(splines)) {
		return [];
	}
	return splines.map((value) => {
		const spline = record(value, 'entry');
		if (!Array.isArray(spline.knots)) {
			throw new FormatError('invalid spline knots');
		}
		return {
			id: number(spline.splineId, 'id'),
			position: vec3(spline.position, 'position'),
			rotation: vec3(spline.rotation, 'rotation'),
			closed: spline.closed === true,
			knots: spline.knots.map((knotValue) => {
				const knot = record(knotValue, 'knot');
				const { x, y, z, w } = record(record(knot.Rotation, 'knot rotation').value, 'knot rotation');
				return {
					position: vec3(knot.Position, 'knot position'),
					tangentIn: vec3(knot.TangentIn, 'knot tangent'),
					tangentOut: vec3(knot.TangentOut, 'knot tangent'),
					rotation: [
						number(x, 'knot rotation'),
						number(y, 'knot rotation'),
						number(z, 'knot rotation'),
						number(w, 'knot rotation'),
					],
				};
			}),
		};
	});
};

/** a cubic Bézier segment's control points, in world space */
export type BezierCurve = [p0: number[], p1: number[], p2: number[], p3: number[]];

const rotate = (q: readonly number[], v: readonly number[]): number[] => {
	const turned = multiplyQuaternions(multiplyQuaternions(q, [v[0], v[1], v[2], 0]), [
		-q[0],
		-q[1],
		-q[2],
		q[3],
	]);
	return [turned[0], turned[1], turned[2]];
};

/**
 * the spline's curves in world space, as Unity Splines builds them: knot i to knot i + 1, plus the last knot
 * back to the first when closed. a knot's tangents turn with its rotation; the spline's rotation and position
 * then place the whole
 *
 * @param spline the spline
 * @param closed whether to close it, which may differ from its own flag
 * @returns its curves
 */
export const splineCurves = (spline: LevelSpline, closed: boolean): BezierCurve[] => {
	const frame = unityEulerQuaternion(spline.rotation);
	const world = (local: readonly number[]): number[] => {
		const turned = rotate(frame, local);
		return [turned[0] + spline.position[0], turned[1] + spline.position[1], turned[2] + spline.position[2]];
	};
	const { knots } = spline;
	const count = closed ? knots.length : knots.length - 1;
	const curves: BezierCurve[] = [];
	for (let i = 0; i < count; i++) {
		const a = knots[i];
		const b = knots[(i + 1) % knots.length];
		const out = rotate(a.rotation, a.tangentOut);
		const into = rotate(b.rotation, b.tangentIn);
		curves.push([
			world(a.position),
			world([a.position[0] + out[0], a.position[1] + out[1], a.position[2] + out[2]]),
			world([b.position[0] + into[0], b.position[1] + into[1], b.position[2] + into[2]]),
			world(b.position),
		]);
	}
	return curves;
};

/**
 * @param curve a cubic Bézier segment
 * @param t its parameter, 0 to 1
 * @returns the point at `t`
 */
export const bezierPoint = (curve: BezierCurve, t: number): [number, number, number] => {
	const u = 1 - t;
	const a = u * u * u;
	const b = 3 * u * u * t;
	const c = 3 * u * t * t;
	const d = t * t * t;
	const [p0, p1, p2, p3] = curve;
	return [
		a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0],
		a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1],
		a * p0[2] + b * p1[2] + c * p2[2] + d * p3[2],
	];
};
