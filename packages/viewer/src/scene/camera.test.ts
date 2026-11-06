import assert from 'node:assert/strict';
import { it } from 'node:test';

import type { Vec3 } from '@endfield-noclip/package-format/values';

import { Camera, boxInFrustum, sweepPlanes } from './camera.ts';

it('sweeps the frustum towards the sun, so a caster behind the camera reaches the view', () => {
	// looking along +z with the sun behind and above: light travels along +z and down
	const camera = new Camera();
	const planes = camera.frustumPlanes(1, []);
	const light: [number, number, number] = [0, -Math.SQRT1_2, Math.SQRT1_2];
	const swept = sweepPlanes(planes, light, 100);
	const inside = (p: readonly number[], set: typeof planes): boolean =>
		boxInFrustum(set, [p[0] - 1, p[1] - 1, p[2] - 1], [p[0] + 1, p[1] + 1, p[2] + 1], [0, 0, 0]);

	// a tower top 20 m behind and 20 m above shades the ground 20 m ahead
	assert.equal(inside([0, 20, -20], planes), false);
	assert.equal(inside([0, 20, -20], swept), true);
	// what lies away from the sun can't shade the view
	assert.equal(inside([0, 0, -50], swept), false);
	assert.equal(inside([0, -60, 10], swept), false);
	// the view itself stays inside
	assert.equal(inside([0, 0, 30], swept), true);
});

it('projects directions onto the screen where the view rays through them point', () => {
	const camera = new Camera();
	camera.yaw = 0.3;
	camera.pitch = -0.2;
	const aspect = 16 / 9;
	const near = (uv: readonly number[] | null, expected: readonly number[]): boolean =>
		uv !== null && Math.abs(uv[0] - expected[0]) < 1e-12 && Math.abs(uv[1] - expected[1]) < 1e-12;
	const forward = camera.forward();
	assert.ok(near(camera.projectDirection(forward, aspect), [0.5, 0.5]));
	assert.equal(camera.projectDirection([-forward[0], -forward[1], -forward[2]], aspect), null);
	// the view ray through the top-right corner lands on uv (1, 0)
	const { right, up } = camera.viewBasis(aspect);
	const ray: Vec3 = [
		forward[0] + right[0] + up[0],
		forward[1] + right[1] + up[1],
		forward[2] + right[2] + up[2],
	];
	const length = Math.hypot(...ray);
	const corner = camera.projectDirection([ray[0] / length, ray[1] / length, ray[2] / length], aspect);
	assert.ok(near(corner, [1, 0]));
});
