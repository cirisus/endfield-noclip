import assert from 'node:assert/strict';
import { it } from 'node:test';

import { pointPose } from '../../../viewer/src/scene/point-view.ts';

import { arrivalHeadings } from './arrival-view.ts';
it('frames an east-to-west arrival from beyond the target, obliquely looking east', () => {
	const headings = arrivalHeadings([
		[30, 0, 0],
		[0.01, 0, 0],
		[0, 0, 0],
	]);
	const pose = pointPose([0, 0, 0], [], () => null, { context: false, headings });
	assert.equal(headings.length, 4);
	assert.ok(pose.position[0] < 0);
	assert.ok(Math.abs(pose.position[2]) > 4);
	assert.deepEqual(
		arrivalHeadings([
			[0, 0, 0],
			[0, 8, 0],
		]),
		[],
	);
});

it('keeps view preference relative to the route when the scene rotates', async () => {
	const { arrivalFraming } = await import('./arrival-view.ts');
	const first = arrivalFraming([
		[30, 0, 0],
		[0, 0, 0],
	]);
	const rotated = arrivalFraming([
		[0, 0, -30],
		[0, 0, 0],
	]);
	const a = pointPose([0, 0, 0], [], () => null, {
		context: false,
		headings: first.headings,
		score: (pose) => first.score(pose, []),
	});
	const b = pointPose([0, 0, 0], [], () => null, {
		context: false,
		headings: rotated.headings,
		score: (pose) => rotated.score(pose, []),
	});
	assert.ok(Math.abs(a.position[0] - b.position[2] * -1) < 1e-8);
	assert.ok(Math.abs(a.position[2] - b.position[0]) < 1e-8);
});
