import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Gradient } from '@endfield-noclip/package-format/curves';
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
	SheetRow,
} from '@endfield-noclip/package-format/particles';

import type { Vec3 } from '../scene/camera.ts';
import type { ResidentInstances } from '../streaming/stream-manager.ts';

import { ROW_WORDS, RowBillboard, RowKind, packRowColor, rowInfo } from './instance-rows.ts';
import {
	PARTICLE_FLOATS,
	ParticleField,
	type ParticleRowStore,
	ParticleSimulation,
	type ParticleView,
	dragged,
	draggedFall,
	evaluateMinMax,
	evaluateMinMaxGradient,
	limitedPath,
	ringBufferAge,
	sheetTile,
	splinePoint,
	travelled,
	turnedByBillboard,
	screenLimited,
	turnFromZ,
} from './particles.ts';

const constant = (value: number): MinMaxCurveInfo => ({
	mode: CurveMode.Constant,
	scalar: value,
	min: 0,
	curve: null,
	minCurve: null,
});

const between = (min: number, max: number): MinMaxCurveInfo => ({
	mode: CurveMode.TwoConstants,
	scalar: max,
	min,
	curve: null,
	minCurve: null,
});

const line = (from: number, to: number): MinMaxCurveInfo => ({
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
	},
	sizeOverLifetime: null,
	rotationOverLifetime: null,
	alignment: ParticleAlignment.View,
	pivot: [0, 0, 0],
	meshWeights: [1],
	mesh: 0,
	ringBuffer: null,
	textureSheet: null,
	...overrides,
});

/** an ordinary system's motion, of which a test may set any part */
type FreeMotion = Omit<ParticleFreeMotionInfo, 'kind'>;

/**
 * a system, its emission bound worked out from its constant rate, bursts and lifetime as the packer does.
 * free motion fields set its motion's, and a spline makes it a spline mover
 */
const system = ({
	startSpeed = constant(0),
	gravityModifier = constant(-0.01),
	velocity = null,
	clamp = null,
	spline,
	...overrides
}: Partial<ParticleSystemInfo & FreeMotion> & { spline?: ParticleSplineInfo } = {}): ParticleSystemInfo => {
	const info = {
		...fields(overrides),
		motion:
			overrides.motion ??
			spline ??
			({ kind: 'free', startSpeed, gravityModifier, velocity, clamp } satisfies ParticleFreeMotionInfo),
	};
	const life = info.startLifetime.scalar;
	const perLoop = info.bursts.reduce((sum, burst) => sum + burst.count.scalar * burst.cycles, 0);
	const bound = Math.ceil(info.rate.scalar * life + perLoop * Math.ceil(life / info.duration - 1e-6));
	return { ...info, emissionBound: overrides.emissionBound ?? bound };
};

const sheet = (overrides: Partial<ParticleTextureSheetInfo> = {}): ParticleTextureSheetInfo => ({
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
const DOWN: Vec3 = [0, 0, -1];
const same = (direction: Vec3): Vec3 => direction;

/** @returns the live particles' positions, rotations and sizes */
const run = (info: ParticleSystemInfo, time: number, seed = 7) => {
	const out = new Float32Array(1024 * PARTICLE_FLOATS);
	const count = new ParticleSimulation(info, seed).evaluate(time, DOWN, same, out);
	return Array.from({ length: count }, (_, i) => ({
		position: Array.from(out.subarray(i * PARTICLE_FLOATS, i * PARTICLE_FLOATS + 3)),
		rotation: Array.from(out.subarray(i * PARTICLE_FLOATS + 3, i * PARTICLE_FLOATS + 7)),
		size: Array.from(out.subarray(i * PARTICLE_FLOATS + 7, i * PARTICLE_FLOATS + 10)),
		tile: out[i * PARTICLE_FLOATS + 10],
	}));
};

describe('spline paths', () => {
	// Dijiang's central shaft lifts its cargo 70 m up a straight segment whose handles sit on its ends
	const lift: ParticleSplineInfo = {
		kind: 'spline',
		segments: [
			{
				points: [
					[0, -20, 0],
					[0, -20, 0],
					[0, 50, 0],
					[0, 50, 0],
				] as [Vec3, Vec3, Vec3, Vec3],
				length: 70,
			},
		],
		speed: constant(1),
	};
	it('places a distance at its share of the segment as a Bézier parameter, so the lift eases in and out', () => {
		assert.deepEqual(splinePoint(lift, 35)?.position, [0, 15, 0]);
		// smoothstep(0.25) of the way up
		assert.ok(Math.abs((splinePoint(lift, 17.5)?.position[1] ?? 0) - (-20 + 70 * 0.15625)) < 1e-9);
		assert.equal(splinePoint(lift, 70.5), null);
	});
	it('moves particles by the speed along the path, from their box offset', () => {
		const info = system({
			startLifetime: constant(49),
			rate: constant(0.5),
			maxParticles: 26,
			shape: { ...system().shape!, kind: ParticleShapeKind.Box, position: [2, 0, 0], scale: [0, 0, 0] },
			startRotation: [constant(0), constant(0), constant(0)],
			spline: lift,
		});
		const particles = run(info, 1000);
		assert.ok(particles.length > 20);
		for (const { position } of particles) {
			assert.equal(position[0], 2);
			// 49 m of 70 at most
			assert.ok(position[1] >= -20 && position[1] <= -20 + 70 * (3 * 0.7 ** 2 - 2 * 0.7 ** 3) + 1e-4);
		}
	});
	it('drops particles that run off the end within their lifetime', () => {
		const info = system({ startLifetime: constant(200), rate: constant(1), maxParticles: 201, spline: lift });
		assert.ok(run(info, 1000).length <= 71);
	});
});

describe('min-max gradients', () => {
	const fade: Gradient = {
		colorKeys: [
			{ time: 0, color: [1, 1, 1] },
			{ time: 1, color: [0.5, 0.5, 0.5] },
		],
		alphaKeys: [
			{ time: 0, alpha: 0 },
			{ time: 0.4, alpha: 1 },
		],
		fixed: false,
	};
	it('pick between two colours or gradients by the random value', () => {
		const two = {
			mode: GradientMode.TwoColors,
			max: [1, 1, 1, 0.45] as [number, number, number, number],
			min: [1, 1, 1, 0.2] as [number, number, number, number],
			maxGradient: null,
			minGradient: null,
		};
		assert.ok(Math.abs(evaluateMinMaxGradient(two, 0, 0.5)[3] - 0.325) < 1e-9);
		const gradients = { ...two, mode: GradientMode.TwoGradients, maxGradient: fade, minGradient: fade };
		assert.deepEqual(evaluateMinMaxGradient(gradients, 0.2, 0.3), [0.9, 0.9, 0.9, 0.5]);
	});
});

describe('motion', () => {
	it('integrates a velocity curve over the age', () => {
		// 0 → 2 m/s over a 1 s life covers 1 m
		assert.ok(Math.abs(travelled(line(0, 2), 1, 1, 0) - 1) < 1e-6);
		assert.equal(travelled(constant(3), 2, 10, 0), 6);
	});
	it('slows a launch and caps a fall at the terminal speed under quadratic drag', () => {
		const drag = { kind: 'drag', amount: constant(1), bySize: false, byVelocity: true } as const;
		const [distance, speed] = dragged(drag, 4, 1, 1, 0);
		assert.ok(Math.abs(distance - Math.log1p(4)) < 1e-9);
		assert.ok(Math.abs(speed - 4 / 5) < 1e-9);
		// terminal speed √(g / k) = √9.81
		const [, falling] = draggedFall(drag, 9.81, 1, 100, 0);
		assert.ok(Math.abs(falling - Math.sqrt(9.81)) < 1e-6);
	});
	// the challenge start point's rising stones: 1 m/s up from velocity over lifetime, limited to 0.1 m/s with
	// a dampen of 0.1
	const stones = {
		limit: { kind: 'limit' as const, limit: constant(0.1), dampen: 0.1 },
		r: 0,
		start: [0, 0, 0] as Vec3,
		acceleration: [0, 0, 0] as Vec3,
		extra: (): Vec3 => [0, 1, 0],
		life: 3,
	};
	it('pulls the whole speed, extra velocity included, down to the limit', () => {
		const { velocity } = limitedPath({ ...stones, age: 3 });
		// 90 steps at 0.1 of the excess each leave 0.9^90 of it
		assert.ok(Math.abs(velocity[1] - (0.1 + 0.9 * 0.9 ** 90)) < 1e-9);
		const { offset } = limitedPath({ ...stones, age: 0.5 });
		assert.ok(offset[1] > 0.05 && offset[1] < 0.5);
	});
	it('gives the same path whatever the age it is read at', () => {
		const once = limitedPath({ ...stones, age: 2 }).offset[1];
		const again = limitedPath({ ...stones, age: 2 }).offset[1];
		assert.equal(once, again);
	});
	it('steps on from an earlier state to where stepping from birth gets', () => {
		const fresh = limitedPath({ ...stones, age: 2 });
		let state = limitedPath({ ...stones, age: 0.5 }).state;
		for (let age = 0.5 + 1 / 60; age <= 2 + 1e-9; age += 1 / 60) {
			state = limitedPath({ ...stones, age, from: state }).state;
		}
		// frame-sized steps rather than 1/30 s ones differ by a little
		assert.ok(Math.abs(state.offset[1] - fresh.offset[1]) < 5e-3);
		// a state past the age is ignored, so a path read earlier starts again from birth
		const back = limitedPath({ ...stones, age: 0.5, from: fresh.state });
		assert.equal(back.offset[1], limitedPath({ ...stones, age: 0.5 }).offset[1]);
	});
	it('leaves a particle under the limit alone', () => {
		const { offset, velocity } = limitedPath({
			...stones,
			limit: { ...stones.limit, limit: constant(5) },
			age: 2,
		});
		assert.ok(Math.abs(offset[1] - 2) < 1e-9);
		assert.deepEqual(velocity, [0, 1, 0]);
	});
});

describe('ringBufferAge', () => {
	it('holds a particle at its end, or replays its loop range', () => {
		assert.equal(ringBufferAge(0.5, null), 0.5);
		assert.equal(ringBufferAge(3.2, null), 1);
		assert.equal(ringBufferAge(0.5, [0.2, 0.8]), 0.5);
		assert.ok(Math.abs(ringBufferAge(1.1, [0.2, 0.8]) - 0.5) < 1e-9);
		assert.ok(Math.abs(ringBufferAge(1.25, [0, 1]) - 0.25) < 1e-9);
	});
});

describe('sheetTile', () => {
	const r = () => 0.5;
	it('steps through the whole sheet over the lifetime, cycles times', () => {
		assert.equal(sheetTile(sheet(), 0, 0, 0, r, 0), 0);
		assert.equal(sheetTile(sheet(), 0.5, 0, 0, r, 0), 31);
		assert.equal(sheetTile(sheet(), 1, 0, 0, r, 0), 63);
		assert.equal(sheetTile(sheet({ cycles: 2 }), 0.75, 0, 0, r, 0), 31);
	});

	it('steps by frames per second, and along a single row', () => {
		// 30 fps through 64 frames: one second in, the 30th frame, wrapping after 64
		assert.equal(sheetTile(sheet({ frameOverTime: null }), 0, 1, 0, r, 0), 30);
		assert.equal(sheetTile(sheet({ frameOverTime: null }), 0, 3, 0, r, 0), 90 % 64);
		assert.equal(sheetTile(sheet({ row: 2 }), 0.5, 0, 0, r, 0), 2 * 8 + 3);
		assert.equal(sheetTile(sheet({ row: SheetRow.MeshIndex }), 0, 0, 0, r, 1), 8);
		assert.equal(sheetTile(sheet({ row: SheetRow.Random }), 0, 0, 0, r, 0), 4 * 8);
	});

	it('packs into the row info word next to the row kind', () => {
		const info = rowInfo(RowKind.Detail, [8, 4], 63, 1);
		assert.equal(info & 7, RowKind.Detail);
		assert.equal(((info >>> 4) & 63) + 1, 8);
		assert.equal(((info >>> 10) & 63) + 1, 4);
		assert.equal((info >>> 16) & 0xfff, 63);
		assert.equal(info >>> 28, 1);
		assert.equal(packRowColor([1, 0, 0.5, 0.25]), (64 << 24) | (128 << 16) | 255);
	});
});

describe('evaluateMinMax', () => {
	it('reads constants, curves and the random ends of either', () => {
		assert.equal(evaluateMinMax(constant(3), 0.5, 0.9), 3);
		assert.equal(evaluateMinMax(between(2, 4), 0.5, 0.25), 2.5);
		assert.equal(evaluateMinMax(line(1, 0), 0.25, 0), 0.75);
		const curves: MinMaxCurveInfo = {
			...line(1, 1),
			mode: CurveMode.TwoCurves,
			scalar: 2,
			minCurve: line(0, 0).curve,
		};
		assert.equal(evaluateMinMax(curves, 0.5, 0.5), 1);
	});
});

describe('ParticleSimulation', () => {
	it('keeps a settled looping system at its rate times its lifetime, rising under negative gravity', () => {
		const particles = run(system(), 1000);
		// one per second for 80 seconds
		assert.ok(particles.length >= 79 && particles.length <= 81);
		for (const { position } of particles) {
			// on the cone's base ring, between half the radius and the radius, then lifted along z
			const radius = Math.hypot(position[0], position[1]);
			assert.ok(radius >= 32.5 - 1e-3 && radius <= 65 + 1e-3);
			assert.ok(position[2] >= 0);
		}
		// the oldest has risen ½ · 9.81 · 0.01 · 80² m at most
		const highest = Math.max(...particles.map(({ position }) => position[2]));
		assert.ok(highest <= 0.5 * 9.81 * 0.01 * 80 * 80 + 1e-3);
		assert.ok(highest > 0.5 * 9.81 * 0.01 * 78 * 78);
	});

	it('gives the same particles for the same seed and time, and others for another seed', () => {
		assert.deepEqual(run(system(), 500), run(system(), 500));
		assert.notDeepEqual(run(system(), 500, 1), run(system(), 500, 2));
	});

	it('splits particles between the entries drawing each of a renderer mesh', () => {
		const all = run(system(), 1000).length;
		const first = run(system({ meshWeights: [1, 3], mesh: 0 }), 1000);
		const second = run(system({ meshWeights: [1, 3], mesh: 1 }), 1000);
		assert.equal(first.length + second.length, all);
		assert.ok(first.length < second.length);
	});

	it('plays a burst once when not looping, and shrinks particles by the size over lifetime', () => {
		const once = system({
			looping: false,
			duration: 2,
			rate: constant(0),
			startLifetime: constant(10),
			bursts: [{ time: 0, count: constant(30), cycles: 1, interval: 0.01, probability: 1 }],
			sizeOverLifetime: [line(1, 0), line(1, 0), line(1, 0)],
		});
		const early = run(once, 2.5);
		assert.equal(early.length, 30);
		// a quarter of the way through its life, the size is three quarters of the start size
		for (const { size } of early) {
			assert.ok(Math.abs(size[0] - 3) < 1e-3);
		}
		assert.equal(run(once, 10.5).length, 0);
	});

	it('keeps a ring-buffered particle past its lifetime until the next replaces it, flipping its sheet', () => {
		// the campfire flames: one particle per two-second loop, living two seconds, through an 8×8 sheet
		const flame = system({
			duration: 2,
			maxParticles: 1,
			rate: constant(0),
			startLifetime: constant(2),
			bursts: [{ time: 0, count: constant(1), cycles: 1, interval: 0.01, probability: 1 }],
			shape: null,
			gravityModifier: constant(0),
			ringBuffer: { loop: false, loopRange: [0, 1] },
			textureSheet: sheet(),
		});
		const tiles = [100.25, 101, 101.75].map((time) => {
			const particles = run(flame, time);
			assert.equal(particles.length, 1);
			return particles[0].tile;
		});
		// an eighth of the way through: 0.9999 · ⅛ · 64 frames, just short of the 8th
		assert.deepEqual(tiles, [7, 31, 55]);
		// a longer loop than the lifetime holds the last tile until the next emission
		const held = run({ ...flame, duration: 3 }, 3 * 40 + 2.5);
		assert.equal(held.length, 1);
		assert.equal(held[0].tile, 63);
		// without the ring buffer the particle is gone by then
		assert.equal(run({ ...flame, duration: 3, ringBuffer: null }, 3 * 40 + 2.5).length, 0);
	});

	it('caps the live particles at the system maximum', () => {
		assert.equal(run(system({ maxParticles: 20 }), 1000).length, 20);
	});

	it('skips emissions while the system is full, so a capped particle lives out its lifetime', () => {
		// the Very Large Rift's ripple walls: a burst every 0.1 s loop, one particle allowed, living 6 s
		const ripple = system({
			duration: 0.1,
			maxParticles: 1,
			rate: constant(0),
			startLifetime: constant(6),
			bursts: [{ time: 0, count: constant(1), cycles: 1, interval: 0.01, probability: 1 }],
			shape: null,
			gravityModifier: constant(0),
			sizeOverLifetime: [line(0, 1), line(0, 1), line(0, 1)],
		});
		const simulation = new ParticleSimulation(ripple, 7);
		const out = new Float32Array(PARTICLE_FLOATS);
		const sizes: number[] = [];
		for (let time = 30; time < 48; time += 0.25) {
			assert.equal(simulation.evaluate(time, DOWN, same, out), 1);
			sizes.push(out[7]);
		}
		// one ring grows for its 6 s before the next starts (at the first loop after), so the size drops two or
		// three times in 18 s, not every loop
		const drops = sizes.filter((size, i) => i > 0 && size < sizes[i - 1]).length;
		assert.ok(drops >= 2 && drops <= 3, `${drops} restarts`);
	});

	it('orbits particles about the emitter axis without changing their distance from it', () => {
		const still = run(system({ gravityModifier: constant(0) }), 1000);
		const orbiting = run(
			system({
				gravityModifier: constant(0),
				velocity: {
					linear: [constant(0), constant(0), constant(0)],
					linearInWorld: false,
					orbital: [constant(0), constant(0), constant(0.05)],
					orbitalOffset: [0, 0, 0],
					radial: constant(0),
					speedModifier: constant(1),
				},
			}),
			1000,
		);
		assert.equal(orbiting.length, still.length);
		let moved = 0;
		for (const [i, { position }] of orbiting.entries()) {
			const before = still[i].position;
			assert.ok(Math.abs(Math.hypot(position[0], position[1]) - Math.hypot(before[0], before[1])) < 1e-2);
			moved += Math.hypot(position[0] - before[0], position[1] - before[1]);
		}
		assert.ok(moved > 1);
	});

	it('starts donut particles inside its tube, the outer part its thickness allows', () => {
		const donut = run(
			system({
				gravityModifier: constant(0),
				looping: false,
				rate: constant(0),
				startLifetime: constant(10),
				bursts: [{ time: 0, count: constant(100), cycles: 1, interval: 0.01, probability: 1 }],
				shape: {
					...system().shape!,
					kind: ParticleShapeKind.Donut,
					radius: 1,
					donutRadius: 0.2,
					radiusThickness: 0.4,
				},
			}),
			0.5,
		);
		assert.equal(donut.length, 100);
		for (const { position } of donut) {
			// distance from the circle of radius 1 in the xy plane
			const tube = Math.hypot(Math.hypot(position[0], position[1]) - 1, position[2]);
			assert.ok(tube >= 0.2 * 0.6 - 1e-4 && tube <= 0.2 + 1e-4, `${tube}`);
		}
	});

	it('turns particles by the integral of a rotation curve over their age', () => {
		const spinning = run(
			system({
				gravityModifier: constant(0),
				looping: false,
				rate: constant(0),
				startLifetime: constant(1),
				startRotation: [constant(0), constant(0), constant(0)],
				bursts: [{ time: 0, count: constant(1), cycles: 1, interval: 0.01, probability: 1 }],
				// 0 rad/s at birth to 2 rad/s at death: 1 rad by the end, a quarter of that halfway
				rotationOverLifetime: [constant(0), constant(0), line(0, 2)],
			}),
			0.5,
		);
		assert.equal(spinning.length, 1);
		assert.ok(Math.abs(spinning[0].rotation[2] - Math.sin(0.25 / 2)) < 1e-4);
	});

	it('moves particles by their velocity times a speed modifier curve integrated over their age', () => {
		// the floating stones of Valley's Aberrants (`floatstone01`) rise at a constant speed that their speed
		// modifier ramps up over their lifetime
		const rising = (speedModifier: MinMaxCurveInfo) =>
			run(
				system({
					gravityModifier: constant(0),
					looping: false,
					rate: constant(0),
					startLifetime: constant(1),
					shape: null,
					bursts: [{ time: 0, count: constant(1), cycles: 1, interval: 0.01, probability: 1 }],
					velocity: {
						linear: [constant(0), constant(0), constant(1)],
						linearInWorld: false,
						orbital: [constant(0), constant(0), constant(0)],
						orbitalOffset: [0, 0, 0],
						radial: constant(0),
						speedModifier,
					},
				}),
				0.5,
			);
		// 0 at birth to 2 at death: ∫₀^½ 2a da = ¼ m by halfway
		const [ramped] = rising(line(0, 2));
		assert.ok(Math.abs(ramped.position[2] - 0.25) < 1e-6, `${ramped.position[2]}`);
		const [steady] = rising(constant(2));
		assert.ok(Math.abs(steady.position[2] - 1) < 1e-6, `${steady.position[2]}`);
	});
});

describe('ParticleField', () => {
	/** @returns the row the field writes for one particle of a system on an identity emitter at the origin */
	const written = (info: ParticleSystemInfo, view: Omit<ParticleView, 'time'>): Float32Array => {
		let rows = new Float32Array(0);
		const store: ParticleRowStore = {
			allocateRows: (count) => ({ start: 0, count }),
			freeRows: () => {},
			writeRows: (_start, words) => {
				rows = new Float32Array(words.buffer.slice(0, ROW_WORDS * 4));
			},
		};
		const rowsF32 = new Float32Array(ROW_WORDS);
		rowsF32.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]);
		// the field reads only the emitter row, the block's origin and its slot
		const instances = { rowsF32, origin: [0, 0, 0], blockSlot: 0 } as unknown as ResidentInstances;
		const field = new ParticleField({ systems: [info] }, store);
		assert.equal(field.rows(instances, 0, 0, 0, { time: 0, ...view }).length, 1);
		return rows;
	};
	const center = (info: ParticleSystemInfo, view: Omit<ParticleView, 'time'>): number[] => {
		const row = written(info, view);
		return [row[3], row[7], row[11]];
	};
	const eye: Vec3 = [0, 0, -10];

	it('lays a stretched particle back from its head, its width set by where the camera is, not how it turns', () => {
		// Suiming's drifting fog (`smoke` in p_fxmap_map02_lv007_windice01): legacy stretched quads
		const fog = system({
			renderMode: ParticleRenderMode.Stretched,
			stretch: { lengthScale: 2, velocityScale: 0 },
			screenSize: { min: 0, max: 2 },
			looping: false,
			startLifetime: constant(5),
			rate: constant(0),
			bursts: [{ time: 0, count: constant(1), cycles: 1, interval: 0.01, probability: 1 }],
			shape: null,
			startSize: [constant(1), constant(1), constant(1)],
			startRotation: [constant(0), constant(0), constant(0)],
			gravityModifier: constant(0),
			velocity: {
				linear: [constant(0), constant(1), constant(0)],
				linearInWorld: false,
				orbital: [constant(0), constant(0), constant(0)],
				orbitalOffset: [0, 0, 0],
				radial: constant(0),
				speedModifier: constant(1),
			},
		});
		const level = written(fog, {
			eye,
			widthPerDepth: 2,
			right: [1, 0, 0],
			up: [0, 1, 0],
			forward: [0, 0, 1],
		});
		// looking 30° down from the same place
		const pitched = written(fog, {
			eye,
			widthPerDepth: 2,
			right: [1, 0, 0],
			up: [0, Math.cos(Math.PI / 6), Math.sin(Math.PI / 6)],
			forward: [0, -Math.sin(Math.PI / 6), Math.cos(Math.PI / 6)],
		});
		const near = (a: Float32Array, b: number[]) =>
			b.every((value, i) => Math.abs(a[[0, 4, 8, 1, 5, 9, 2, 6, 10, 3, 7, 11][i]] - value) < 1e-5);
		// width along x, 2 m up the rise, its face's normal on the line of sight, the particle at the top end
		const expected = [1, 0, 0, 0, 2, 0, 0, 0, 1, 0, -1, 0];
		assert.ok(near(level, expected), [...level.subarray(0, 12)].join());
		assert.ok(near(pitched, expected), [...pitched.subarray(0, 12)].join());
	});

	it('offsets a view-aligned mesh by its pivot in the camera-turned frame it is drawn in', () => {
		// the blue talosite's shards: one mesh particle each, pivoted off centre, facing the camera
		const shard = system({
			looping: false,
			startLifetime: constant(5),
			rate: constant(0),
			bursts: [{ time: 0, count: constant(1), cycles: 1, interval: 0.01, probability: 1 }],
			shape: null,
			startSize: [constant(2), constant(2), constant(2)],
			startRotation: [constant(0), constant(0), constant(0)],
			gravityModifier: constant(0),
			pivot: [0, 0.5, 0],
		});
		const level = center(shard, {
			eye,
			widthPerDepth: 2,
			right: [1, 0, 0],
			up: [0, 1, 0],
			forward: [0, 0, 1],
		});
		assert.deepEqual(level, [0, 1, 0]);
		// looking straight down, the camera's up is the world's +z, so the offset goes there
		const down = center(shard, {
			eye,
			widthPerDepth: 2,
			right: [1, 0, 0],
			up: [0, 0, 1],
			forward: [0, -1, 0],
		});
		assert.deepEqual(down, [0, 0, 1]);
		// a world-aligned one keeps it in the world's frame
		const world = center(
			{ ...shard, alignment: ParticleAlignment.World },
			{
				eye,
				widthPerDepth: 2,
				right: [1, 0, 0],
				up: [0, 0, 1],
				forward: [0, -1, 0],
			},
		);
		assert.deepEqual(world, [0, 1, 0]);
	});
});

describe('turnedByBillboard', () => {
	it('turns as row_basis turns a billboard row', () => {
		const view = {
			time: 0,
			eye: [0, 0, 0],
			widthPerDepth: 2,
			right: [0, 0, -1],
			up: [0.6, 0.8, 0],
			forward: [0.8, -0.6, 0],
		} satisfies ParticleView;
		assert.deepEqual(turnedByBillboard(RowBillboard.None, view, [1, 2, 3]), [1, 2, 3]);
		assert.deepEqual(turnedByBillboard(RowBillboard.Facing, view, [1, 0, 0]), [0, 0, -1]);
		// kept upright: right stays level, up is the world's, forward is right × up
		assert.deepEqual(
			turnedByBillboard(RowBillboard.Upright, view, [0, 1, 1]).map((value) => value + 0),
			[1, 1, 0],
		);
	});
});

describe('screenLimited', () => {
	const view = {
		time: 0,
		eye: [0, 0, 0],
		widthPerDepth: 2,
		right: [1, 0, 0],
		up: [0, 1, 0],
		forward: [0, 0, 1],
	} satisfies ParticleView;

	it('holds the larger side to a fraction of the viewport width at the depth, scaling both', () => {
		// 4 m away the viewport is 8 m wide, so half of it is 4 m: a 10 × 5 m quad shrinks to 4 × 2 m
		assert.deepEqual(screenLimited([10, 5, 1], { min: 0, max: 0.5 }, view, [3, 0, 4]), [4, 2, 1]);
		// small ones grow to the minimum, those within the limits stay
		assert.deepEqual(screenLimited([0.5, 1, 1], { min: 0.25, max: 0.5 }, view, [0, 0, 4]), [1, 2, 1]);
		assert.deepEqual(screenLimited([3, 1, 1], { min: 0, max: 0.5 }, view, [0, 0, 4]), [3, 1, 1]);
		// behind the camera, nothing
		assert.deepEqual(screenLimited([3, 1, 1], { min: 0, max: 0.5 }, view, [0, 0, -4]), [0, 0, 0]);
	});
});

describe('turnFromZ', () => {
	const rotateZ = (q: number[]): number[] => {
		// +z rotated by q
		const [x, y, z, w] = q;
		return [2 * (x * z + w * y), 2 * (y * z - w * x), 1 - 2 * (x * x + y * y)];
	};

	it('turns +z onto a direction, and leaves it for a zero or +z vector', () => {
		for (const to of [
			[0, 1, 0],
			[1, 1, 1],
			[0.3, -2, -0.5],
			[0, 0, -4],
		]) {
			const length = Math.hypot(to[0], to[1], to[2]);
			const turned = rotateZ(turnFromZ(to));
			for (let axis = 0; axis < 3; axis++) {
				assert.ok(Math.abs(turned[axis] - to[axis] / length) < 1e-6, `${to.join()} → ${turned.join()}`);
			}
		}
		assert.deepEqual(turnFromZ([0, 0, 0]), [0, 0, 0, 1]);
		assert.deepEqual(
			turnFromZ([0, 0, 2]).map((value) => value + 0),
			[0, 0, 0, 1],
		);
	});
});
