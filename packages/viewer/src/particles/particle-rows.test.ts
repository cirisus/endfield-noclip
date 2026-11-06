import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
	ParticleAlignment,
	ParticleRenderMode,
	type ParticleSystemInfo,
} from '@endfield-noclip/package-format/particles';
import type { Vec3 } from '@endfield-noclip/package-format/values';

import { ROW_WORDS, RowBillboard, RowWord } from '../content/instance-rows.ts';

import {
	type EmitterBlock,
	ParticleField,
	type ParticleRowStore,
	type ParticleView,
	screenLimited,
	turnedByBillboard,
} from './particle-rows.ts';
import { between, constant, line, system } from './test-systems.ts';

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
		const instances = { rowsF32, origin: [0, 0, 0], blockSlot: 0 } satisfies EmitterBlock;
		const field = new ParticleField({ systems: [info] }, store);
		assert.equal(field.rows(instances, 0, 0, 0, { time: 0, ...view }).length, 1);
		return rows;
	};
	/** @returns a written row's custom data, from its f16 words */
	const customOf = (row: Float32Array): number[] => [
		...new Float16Array(row.buffer, row.byteOffset + RowWord.custom * 4, 4),
	];
	const center = (info: ParticleSystemInfo, view: Omit<ParticleView, 'time'>): number[] => {
		const row = written(info, view);
		return [row[3], row[7], row[11]];
	};
	const eye: Vec3 = [0, 0, -10];

	it('lays a stretched particle back from its head, its width set by where the camera is, not how it turns', () => {
		// Suiming's drifting fog (`smoke` in p_fxmap_map02_lv007_windice01): legacy stretched quads
		const moving = (linear: Vec3, pivot: Vec3 = [0, 0, 0]) =>
			system({
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
				pivot,
				velocity: {
					linear: [constant(linear[0]), constant(linear[1]), constant(linear[2])],
					linearInWorld: false,
					orbital: [constant(0), constant(0), constant(0)],
					orbitalOffset: [0, 0, 0],
					radial: constant(0),
					speedModifier: constant(1),
				},
			});
		const fog = moving([0, 1, 0]);
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
		// moving along the line of sight it has no width, and the game draws nothing
		const view = {
			eye,
			widthPerDepth: 2,
			right: [1, 0, 0],
			up: [0, 1, 0],
			forward: [0, 0, 1],
		} satisfies Omit<ParticleView, 'time'>;
		const along = written(moving([0, 0, 1]), view);
		assert.ok(
			[0, 1, 2, 4, 5, 6, 8, 9, 10].every((i) => along[i] === 0),
			[...along.subarray(0, 12)].join(),
		);
		// its pivot moves the head along the velocity by its size, and the streak across by half its width
		const pivoted = written(moving([0, 1, 0], [1, 0.5, 0]), view);
		assert.ok(near(pivoted, [1, 0, 0, 0, 2, 0, 0, 0, 1, 0.5, -0.5, 0]), [...pivoted.subarray(0, 12)].join());
	});

	it('writes custom data read at the age over the lifetime, and none for systems without it', () => {
		// the anchors' black smoke: a random texture shift, and a dissolve rising over the particle's life
		const smoke = system({
			looping: false,
			startLifetime: constant(5),
			rate: constant(0),
			bursts: [{ time: 0, count: constant(1), cycles: 1, interval: 0.01, probability: 1 }],
			shape: null,
			customData: [between(0, 1), null, line(0.3, 1), constant(2)],
		});
		const view = {
			eye,
			widthPerDepth: 2,
			right: [1, 0, 0],
			up: [0, 1, 0],
			forward: [0, 0, 1],
		} satisfies Omit<ParticleView, 'time'>;
		const [x, y, z, w] = customOf(written(smoke, view));
		assert.ok(x >= 0 && x <= 1);
		assert.deepEqual([y, w], [0, 2]);
		// just born, to f16's precision
		assert.ok(Math.abs(z - 0.3) < 1e-3, String(z));
		assert.deepEqual(customOf(written({ ...smoke, customData: null }, view)), [0, 0, 0, 0]);
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

	it('frees the rows of emitters left undrawn, though their block stays resident', () => {
		const allocated = new Set<number>();
		let next = 0;
		const store: ParticleRowStore = {
			allocateRows: (count) => {
				allocated.add(next);
				const alloc = { start: next, count };
				next += count;
				return alloc;
			},
			freeRows: (alloc) => {
				allocated.delete(alloc.start);
			},
			writeRows: () => {},
		};
		const rowsF32 = new Float32Array(ROW_WORDS * 2);
		rowsF32.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]);
		rowsF32.set([1, 0, 0, 5, 0, 1, 0, 0, 0, 0, 1, 0], ROW_WORDS);
		// a pinned block, never released
		const block = { rowsF32, origin: [0, 0, 0], blockSlot: 0 } satisfies EmitterBlock;
		const field = new ParticleField({ systems: [system()] }, store);
		const view = {
			eye,
			widthPerDepth: 2,
			right: [1, 0, 0],
			up: [0, 1, 0],
			forward: [0, 0, 1],
		} satisfies Omit<ParticleView, 'time'>;
		field.rows(block, 0, 0, 1, { time: 0, ...view });
		field.rows(block, 1, 0, 1, { time: 0, ...view });
		assert.equal(allocated.size, 2);
		// only the first stays in view
		for (let frame = 2; frame <= 1300; frame++) {
			field.rows(block, 0, 0, frame, { time: frame / 60, ...view });
		}
		assert.equal(allocated.size, 1);
		// the other comes back with rows of its own
		assert.ok(field.rows(block, 1, 0, 1301, { time: 1301 / 60, ...view }).length > 0);
		assert.equal(allocated.size, 2);
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
		// behind the camera the game drops it only with a minimum; without one it keeps its whole size
		assert.deepEqual(screenLimited([3, 1, 1], { min: 0.1, max: 0.5 }, view, [0, 0, -4]), [0, 0, 1]);
		assert.deepEqual(screenLimited([3, 1, 1], { min: 0, max: 0.5 }, view, [0, 0, -4]), [3, 1, 1]);
	});
});
