import { sampleRoute } from '@oem/ganglia';

import type { Vec3 } from '../../../viewer/src/scene/camera.ts';
import type { CameraPose } from '../../../viewer/src/scene/noclip-controls.ts';
import { pointBlocked, pointFrameFits, type Triangle } from '../../../viewer/src/scene/point-view.ts';

/**
 * @param points verified arrival route in Unity coordinates, ending at the target
 * @returns candidate camera headings looking back from beyond the target; empty for degenerate routes
 */
export const arrivalHeadings = (points: readonly (readonly number[])[]): number[] => {
	if (points.length < 2 || points.some((p) => p.length !== 3 || !p.every(Number.isFinite))) {
		return [];
	}
	const target = points.at(-1)!;
	let before = target,
		remaining = 24;
	for (let i = points.length - 2; i >= 0; i--) {
		const a = points[i],
			b = points[i + 1];
		const length = Math.hypot(...a.map((v, axis) => v - b[axis]));
		if (length >= remaining && length > 0) {
			before = b.map((v, axis) => v + ((a[axis] - v) * remaining) / length);
			break;
		}
		before = a;
		remaining -= length;
	}
	const dx = target[0] - before[0],
		dz = target[2] - before[2];
	if (Math.hypot(dx, dz) < 0.1) {
		return [];
	}
	const back = Math.atan2(-dx, -dz);
	return [-45, -30, 30, 45].map((angle) => back + (angle * Math.PI) / 180);
};

/**
 * @param points source-bound ground route ending at the target
 * @returns oblique candidates and a visibility tie-breaker for the final approach
 */
export const arrivalFraming = (points: readonly Vec3[]) => {
	const reversed = points.toReversed();
	const samples = [2, 4, 8, 12, 18, 24].map((meters) => sampleRoute(reversed, meters));
	return {
		headings: arrivalHeadings(points),
		score: (pose: CameraPose, triangles: readonly Triangle[]): number => {
			let visible = 0;
			for (const sample of samples) {
				const focus: Vec3 = [sample[0], sample[1] + 0.6, sample[2]];
				if (pointFrameFits(pose, focus, focus) && !pointBlocked(pose.position, sample, triangles)) {
					visible++;
				}
			}
			return 1 - visible / samples.length;
		},
	};
};
