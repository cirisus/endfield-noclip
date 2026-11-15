import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { TypeTreeObject } from '@endfield-noclip/formats/unity/type-tree';
import { CurveMode, ParticleShapeKind } from '@endfield-noclip/package-format/particles';

import { readSplineMover } from './spline-movers.ts';

const constant = (value: number, min = 0, mode = 0): TypeTreeObject => ({
	m_Mode: mode,
	m_CurveMultiplier: 0,
	m_CurveMin: { m_Curve: [], m_PreInfinity: 2, m_PostInfinity: 2, m_RotationOrder: 4 },
	m_CurveMax: { m_Curve: [], m_PreInfinity: 2, m_PostInfinity: 2, m_RotationOrder: 4 },
	m_ConstantMin: min,
	m_ConstantMax: value,
});

const v = (x: number, y: number, z: number): TypeTreeObject => ({ x, y, z });

/** the shape of Dijiang's descending cargo (`down_b_s01` in the central shaft's logistics effect) */
const mover = (desc: TypeTreeObject = {}): TypeTreeObject => ({
	m_Enabled: 1,
	desc: {
		hasNoise: 0,
		hasRotation: 0,
		has3dRotation: 0,
		has3dStartRotation: 1,
		hasAlphaControl: 1,
		transparentAlpha: 0,
		simulateSpeed: 1.4,
		emissionRateOverTime: 0.2,
		emissionType: 0,
		aabb: { m_Center: v(0, 0, 0), m_Extent: v(0, 0, 0) },
		lodGroups: [{ m_FileID: 3, m_PathID: 1316586920986994794n }],
		startLifeTime: constant(5),
		startSize: constant(0.9),
		startRotationX: constant(180),
		startRotationY: constant(0, 0, 3),
		startRotationZ: constant(0),
		sizeOverLifeTime: constant(1),
		velocityOverLifeTime: constant(1),
		...desc,
	},
	knotData: [
		{ p0: v(0, 40, 0), p1: v(0, 40, 0), p2: v(0, -14, 0), p3: v(0, -20, 0), length: 60 },
		{ p0: v(0, -20, 0), p1: v(0, -26, 0), p2: v(0, -14, 0), p3: v(0, -20, 0), length: 0.001 },
	],
	fixedPostion: 1,
});

describe('readSplineMover', () => {
	it('clamps the start lifetime to the whole spline at the speed', () => {
		const read = readSplineMover(mover());
		assert.ok('info' in read);
		const { info } = read;
		assert.equal(info.startLifetime.mode, CurveMode.Constant);
		assert.ok(Math.abs(info.startLifetime.scalar - 60.001) < 1e-9);
		assert.equal(info.simulationSpeed, 1.4);
		assert.equal(info.maxParticles, 13);
		assert.equal(info.shape?.kind, ParticleShapeKind.Box);
		assert.equal(info.motion.kind === 'spline' && info.motion.segments.length, 2);
		assert.equal(info.startRotation[0].scalar, Math.PI);
		assert.deepEqual(read.groups, [{ fileId: 3, pathId: 1316586920986994794n }]);
	});
	it('scales a fractional start lifetime by the spline', () => {
		const read = readSplineMover(mover({ startLifeTime: constant(0.7) }));
		assert.ok('info' in read);
		assert.ok(Math.abs(read.info.startLifetime.scalar - 0.7 * 60.001) < 1e-9);
	});
	it('spins objects by the rates in degrees, about x and y only with 3D rotation', () => {
		// the rates of Sword Vault Dale's floating stones (`line` in `p_fxmap_map02_lv006_slow_middlestone_01`)
		const rates = { rotationOverLifeTime: constant(10, 0, 3), rotationXOverLifeTime: constant(10, 0, 3) };
		const flat = readSplineMover(
			mover({ hasRotation: 1, ...rates, rotationYOverLifeTime: constant(10, 0, 3) }),
		);
		assert.ok('info' in flat);
		assert.deepEqual(
			flat.info.rotationOverLifetime?.map((curve) => curve.scalar),
			[0, 0, (10 * Math.PI) / 180],
		);
		const spun = readSplineMover(
			mover({ hasRotation: 1, has3dRotation: 1, ...rates, rotationYOverLifeTime: constant(5, -5, 3) }),
		);
		assert.ok('info' in spun);
		assert.deepEqual(spun.info.rotationOverLifetime?.[1], {
			mode: CurveMode.TwoConstants,
			scalar: (5 * Math.PI) / 180,
			min: (-5 * Math.PI) / 180,
		});
		const still = readSplineMover(mover({ has3dRotation: 1, ...rates }));
		assert.ok('info' in still);
		assert.equal(still.info.rotationOverLifetime, null);
	});
	it('times a random speed by its faster constant', () => {
		// Sword Vault Dale's small stones (`line (2)` in `p_fxmap_map02_lv006_slow_smallstone_01`)
		const read = readSplineMover(mover({ velocityOverLifeTime: constant(1.5, 1, CurveMode.TwoConstants) }));
		assert.ok('info' in read);
		assert.ok(Math.abs(read.info.startLifetime.scalar - 60.001 / 1.5) < 1e-9);
		assert.equal(read.info.motion.kind === 'spline' && read.info.motion.speed.mode, CurveMode.TwoConstants);
	});
	it('names what it cannot play', () => {
		assert.deepEqual(readSplineMover(mover({ hasNoise: 1 })), { reason: 'spline noise' });
	});
	it('plays movers that fade, opaque', () => {
		assert.ok('info' in readSplineMover(mover({ transparentAlpha: 1 })));
	});
});
