import {
	CurveMode,
	GradientMode,
	type MinMaxCurveInfo,
	ParticleAlignment,
	ParticleRenderMode,
	ParticleShapeKind,
	type ParticleFreeMotionInfo,
	type ParticleSplineInfo,
	type ParticleSystemInfo,
	type ParticleTextureSheetInfo,
} from '@endfield-noclip/package-format/particles';
// curves and systems the particle tests build on
import type { Vec3 } from '@endfield-noclip/package-format/values';

import { PARTICLE_FLOATS, ParticleSimulation } from './simulation.ts';

export const constant = (value: number): MinMaxCurveInfo => ({
	mode: CurveMode.Constant,
	scalar: value,
	min: 0,
	curve: null,
	minCurve: null,
});

export const between = (min: number, max: number): MinMaxCurveInfo => ({
	mode: CurveMode.TwoConstants,
	scalar: max,
	min,
	curve: null,
	minCurve: null,
});

export const line = (from: number, to: number): MinMaxCurveInfo => ({
	mode: CurveMode.Curve,
	scalar: 1,
	min: 0,
	curve: {
		keys: [
			{
				time: 0,
				value: from,
				inSlope: to - from,
				outSlope: to - from,
				weightedMode: 0,
				inWeight: 0,
				outWeight: 0,
			},
			{
				time: 1,
				value: to,
				inSlope: to - from,
				outSlope: to - from,
				weightedMode: 0,
				inWeight: 0,
				outWeight: 0,
			},
		],
		preWrapMode: 2,
		postWrapMode: 2,
	},
	minCurve: null,
});

const fields = (
	overrides: Partial<ParticleSystemInfo>,
): Omit<ParticleSystemInfo, 'emissionBound' | 'motion'> => ({
	renderMode: ParticleRenderMode.Mesh,
	stretch: null,
	screenSize: null,
	sizedByScale: true,
	duration: 5,
	looping: true,
	startDelay: constant(0),
	maxParticles: 150,
	simulationSpeed: 1,
	startLifetime: constant(80),
	startColor: {
		mode: GradientMode.Color,
		max: [1, 1, 1, 1],
		min: [1, 1, 1, 1],
		maxGradient: null,
		minGradient: null,
	},
	colorOverLifetime: null,
	startSize: [constant(4), constant(4), constant(4)],
	startRotation: [constant(0), constant(0), between(0, Math.PI * 2)],
	rate: constant(1),
	bursts: [],
	shape: {
		kind: ParticleShapeKind.Cone,
		radius: 65,
		radiusThickness: 0.5,
		donutRadius: 0,
		angle: 2,
		length: 5,
		arc: 360,
		position: [0, 0, 0],
		rotation: [0, 0, 0],
		scale: [1, 1, 1],
		randomDirection: 0,
		sphericalDirection: 0,
		randomPosition: 0,
		mesh: null,
	},
	sizeOverLifetime: null,
	rotationOverLifetime: null,
	alignment: ParticleAlignment.View,
	pivot: [0, 0, 0],
	meshWeights: [1],
	mesh: 0,
	ringBuffer: null,
	textureSheet: null,
	customData: null,
	...overrides,
});

/** an ordinary system's motion, of which a test may set any part */
type FreeMotion = Omit<ParticleFreeMotionInfo, 'kind'>;

/**
 * a system, its emission bound worked out from its constant rate, bursts and lifetime as the packer does.
 * free motion fields set its motion's, and a spline makes it a spline mover
 */
export const system = ({
	startSpeed = constant(0),
	gravityModifier = constant(-0.01),
	velocity = null,
	clamp = null,
	forces = null,
	spline,
	...overrides
}: Partial<ParticleSystemInfo & FreeMotion> & { spline?: ParticleSplineInfo } = {}): ParticleSystemInfo => {
	const info = {
		...fields(overrides),
		motion:
			overrides.motion ??
			spline ??
			({
				kind: 'free',
				startSpeed,
				gravityModifier,
				velocity,
				clamp,
				forces,
			} satisfies ParticleFreeMotionInfo),
	};
	const life = info.startLifetime.scalar;
	const perLoop = info.bursts.reduce((sum, burst) => sum + burst.count.scalar * burst.cycles, 0);
	const bound = Math.ceil(info.rate.scalar * life + perLoop * Math.ceil(life / info.duration - 1e-6));
	return { ...info, emissionBound: overrides.emissionBound ?? bound };
};

export const sheet = (overrides: Partial<ParticleTextureSheetInfo> = {}): ParticleTextureSheetInfo => ({
	tiles: [8, 8],
	row: null,
	frameOverTime: { ...line(0, 1), scalar: 0.9999 },
	fps: 30,
	startFrame: constant(0),
	cycles: 1,
	uvChannels: 3,
	...overrides,
});

/** the emitter's z is the world's up, as on the crater's rock emitters, so the cone's base lies flat */
export const DOWN: Vec3 = [0, 0, -1];
export const same = (direction: Vec3): Vec3 => direction;

/** @returns the live particles' positions, rotations and sizes */
export const run = (info: ParticleSystemInfo, time: number, seed = 7) => {
	const out = new Float32Array(1024 * PARTICLE_FLOATS);
	const count = new ParticleSimulation(info, seed).evaluate(time, DOWN, same, out);
	return Array.from({ length: count }, (_, i) => ({
		position: Array.from(out.subarray(i * PARTICLE_FLOATS, i * PARTICLE_FLOATS + 3)),
		rotation: Array.from(out.subarray(i * PARTICLE_FLOATS + 3, i * PARTICLE_FLOATS + 7)),
		size: Array.from(out.subarray(i * PARTICLE_FLOATS + 7, i * PARTICLE_FLOATS + 10)),
		tile: out[i * PARTICLE_FLOATS + 10],
	}));
};
