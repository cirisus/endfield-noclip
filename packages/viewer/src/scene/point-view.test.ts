import assert from 'node:assert/strict';
import { it } from 'node:test';

import { pointPose } from './point-view.ts';

it('keeps the wide view in open space and turns around an opaque wall', () => {
	const target: [number, number, number] = [0, 0, 0];
	const open = pointPose(target, [], () => null);
	assert.equal(open.yaw, Math.PI / 4);
	const pose = pointPose(
		target,
		[
			[
				[-100, -100, -1],
				[100, -100, -1],
				[100, 100, -1],
			],
			[
				[-100, -100, -1],
				[100, 100, -1],
				[-100, 100, -1],
			],
		],
		() => null,
	);
	assert.ok(pose.position[2] > -0.7);
	assert.notEqual(pose.yaw, open.yaw);
	assert.equal(Math.hypot(pose.position[0], pose.position[2]), 10);
});
it('uses a flat angle beneath a low ceiling without collapsing the viewing distance', () => {
	const pose = pointPose(
		[0, 0, 0],
		[
			[
				[-100, 1, -100],
				[100, 1, -100],
				[100, 1, 100],
			],
			[
				[-100, 1, -100],
				[100, 1, 100],
				[-100, 1, 100],
			],
		],
		() => 0,
	);
	assert.ok(pose.position[1] < 1);
	assert.ok(Math.hypot(pose.position[0], pose.position[2]) >= 10);
	assert.equal(pose.clear, true);
});
it('rejects terrain along the sight line, not only beneath the camera', () => {
	const pose = pointPose([0, 0, 0], [], (_x, z) => (z < -0.5 && z > -1 ? 8 : 0));
	assert.notEqual(pose.yaw, 0);
});
it('raises the focus above local terrain and never collapses the camera onto the point', () => {
	const p = pointPose([0, 0, 0], [], () => 0.5);
	assert.ok(p.position[1] > 0.5);
	assert.ok(Math.hypot(p.position[0], p.position[2]) >= 10);
});

it('keeps underground targets beneath the terrain above their cave', () => {
	const p = pointPose([0, 0, 0], [], () => 100);
	assert.ok(p.position[1] < 10);
	assert.equal(p.clear, true);
});

it('keeps at least ten metres away when walls block every candidate', () => {
	const walls: [[number, number, number], [number, number, number], [number, number, number]][] = [];
	for (const axis of [0, 2]) {
		for (const side of [-1, 1]) {
			const a: [number, number, number] = [-1, -100, -1],
				b: [number, number, number] = [1, -100, 1],
				c: [number, number, number] = [1, 100, 1],
				d: [number, number, number] = [-1, 100, -1];
			a[axis] = side;
			b[axis] = side;
			c[axis] = side;
			d[axis] = side;
			walls.push([a, b, c], [a, c, d]);
		}
	}
	const view = pointPose([0, 0, 0], walls, () => 0);
	assert.equal(view.clear, false);
	assert.ok(Math.hypot(view.position[0], view.position[2]) >= 10);
});

// The centre sight line is clear alongside x = 0.8, but the old south view
// filled the right side with the wall. Keep the camera on the open side.
it('favours an oblique context view over a clear but wall-hugging centre ray', () => {
	const wall: [[number, number, number], [number, number, number], [number, number, number]][] = [
		[
			[0.8, -100, -100],
			[0.8, 100, -100],
			[0.8, 100, 100],
		],
		[
			[0.8, -100, -100],
			[0.8, 100, 100],
			[0.8, -100, 100],
		],
	];
	const pose = pointPose([0, 0, 0], wall, () => null);
	assert.equal(pose.clear, true);
	assert.ok(pose.position[0] < -5);
	assert.ok(Math.abs(pose.position[2]) > 5);
	assert.ok(Math.hypot(pose.position[0], pose.position[2]) >= 10 - 1e-9);
	// Exercise internal spatial partitions as well as the tiny leaf case.
	assert.deepEqual(
		pointPose([0, 0, 0], Array.from({ length: 20 }, () => wall).flat(), () => null),
		pose,
	);
});
