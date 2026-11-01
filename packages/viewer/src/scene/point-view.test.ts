import assert from 'node:assert/strict';
import { it } from 'node:test';

import { pointPose } from './point-view.ts';

it('keeps the wide view in open space and turns around an opaque wall', () => {
	const target: [number, number, number] = [0, 0, 0];
	const open = pointPose(target, [], () => null);
	assert.equal(open.yaw, 0);
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
it('shortens the view in a low room rather than placing the camera through its ceiling', () => {
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
	assert.ok(Math.hypot(pose.position[0], pose.position[2]) < 10);
});
it('rejects terrain along the sight line, not only beneath the camera', () => {
	const pose = pointPose([0, 0, 0], [], (_x, z) => (z < -0.5 && z > -1 ? 8 : 0));
	assert.notEqual(pose.yaw, 0);
});
it('uses a close fallback when no sampled view can clear the terrain', () => {
	assert.deepEqual(pointPose([0, 0, 0], [], () => 100).position, [0, 0.6, -0.6]);
});
