import {
	conditionResults,
	groupsShown,
	resolveSceneValues,
} from '@endfield-noclip/package-format/conditions';
import type { PointView } from '@endfield-noclip/package-format/oem';
import type { StatesInfo } from '@endfield-noclip/package-format/states';

import type { DecodePool } from '../package/decode-pool.ts';
import type { ViewerPackage } from '../package/viewer-package.ts';

import type { Vec3 } from './camera.ts';
import { pointBlocked, pointEnclosure, pointFrameFits, pointPose, pointTriangles } from './point-view.ts';

/**
 * @param ground terrain sampler shared with ordinary point framing
 * @returns a view and optional authored obstruction states; unrelated controls are never switched
 */
export const pointPreview = async (
	pkg: ViewerPackage,
	pool: Pick<DecodePool, 'run'>,
	target: Vec3,
	states: StatesInfo,
	levelTag: number | null,
	picks: Readonly<Record<string, number>>,
	ground: (x: number, z: number) => number | null,
	signal: AbortSignal,
): Promise<Omit<PointView, 'key'>> => {
	const visibility = (values: Readonly<Record<string, number>>) =>
		groupsShown(states, levelTag, conditionResults(states, resolveSceneValues(states, values)));
	const original = visibility(picks);
	let triangles = await pointTriangles(pkg, pool, target, original, signal);
	const visible = (shown: readonly boolean[]) =>
		triangles.filter((triangle) => triangle.group !== undefined && shown[triangle.group]);
	let initialTriangles = visible(original);
	const initial = pointPose(target, initialTriangles, ground, { context: false });
	// Only controls attached to nearby visible geometry can obstruct this approach.
	// A clear interior view does not rule out a more useful entrance view.
	const localControls = new Set(
		[...new Set(initialTriangles.map((triangle) => triangle.group))].flatMap((group) => {
			if (group === undefined) {
				return [];
			}
			const condition = states.groups[group].condition;
			return condition === null
				? []
				: states.conditionalSets[condition].alternatives.flatMap((requirements) =>
						requirements.map((r) => r.control),
					);
		}),
	);
	const values = resolveSceneValues(states, picks);
	const candidates = states.controls.flatMap((control) => {
		if (
			!localControls.has(control.id) ||
			control.derived !== null ||
			(levelTag !== null && !control.levelTags.some((tag) => tag === 0 || tag === levelTag))
		) {
			return [];
		}
		const door = control.kind === 'door' || control.kind === 'destruction';
		const hide =
			control.kind === 'script' &&
			control.drivers.some(
				(driver) =>
					driver.value === 0 &&
					(driver.kind === 'switch' || (driver.kind === 'event' && driver.event === 'combat')),
			);
		if (!door && !hide) {
			return [];
		}
		const before = door ? 0 : 1,
			after = door ? 1 : 0;
		if (values[control.id] !== before || !control.values.some((value) => value.value === after)) {
			return [];
		}
		const shown = visibility({ ...picks, [control.id]: after });
		const removed = new Set(
			original.flatMap((wasShown, group) => (wasShown && !shown[group] ? [group] : [])),
		);
		return removed.size === 0
			? []
			: [{ control: control.id, label: control.name, before, after, shown, removed }];
	});
	if (candidates.length === 0 && initial.clear) {
		return initial;
	}
	// Initial clear views sit 10 m from the target. Their six-metre enclosure
	// probes are already covered by the 16 m geometry read; zero cannot improve.
	const enclosure =
		initial.clear && initial.position.every((v, axis) => Math.abs(v - target[axis]) + 6 <= 16)
			? pointEnclosure(initial.position, initialTriangles)
			: null;
	if (enclosure === 0) {
		return initial;
	}
	const union = original.map(
		(shown, group) => shown || candidates.some((candidate) => candidate.shown[group]),
	);
	triangles = await pointTriangles(pkg, pool, target, union, signal, { radius: 26 });
	initialTriangles = visible(original);
	const initialEnclosure =
		enclosure ?? (initial.clear ? pointEnclosure(initial.position, initialTriangles) : Infinity);
	for (const candidate of candidates) {
		const obstruction = initialTriangles.filter(
			(triangle) => triangle.group !== undefined && candidate.removed.has(triangle.group),
		);
		if (obstruction.length === 0) {
			continue;
		}
		const min: Vec3 = [Infinity, Infinity, Infinity],
			max: Vec3 = [-Infinity, -Infinity, -Infinity];
		for (const triangle of obstruction) {
			for (const vertex of triangle) {
				for (let axis = 0; axis < 3; axis++) {
					min[axis] = Math.min(min[axis], vertex[axis]);
					max[axis] = Math.max(max[axis], vertex[axis]);
				}
			}
		}

		const after = pointPose(target, visible(candidate.shown), ground, {
			context: false,
			distances: [10, 16, 22],
			accept: (pose) => pointFrameFits(pose, min, max) && pointBlocked(pose.position, target, obstruction),
		});
		// Require both an actual blocked ray before and a clear inspection bundle after.
		// Nearby doors or script groups alone are not evidence of an interaction link.
		if (
			after.clear &&
			(!initial.clear || pointEnclosure(after.position, initialTriangles) < initialEnclosure)
		) {
			return {
				...after,
				interactions: [
					{
						control: candidate.control,
						label: candidate.label,
						before: candidate.before,
						after: candidate.after,
					},
				],
			};
		}
	}
	return initial.clear ? initial : pointPose(target, initialTriangles, ground);
};
