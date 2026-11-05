import {
	type createGoalProjector,
	jumpDuration,
	surfaceGraph,
	type InteractionGoal,
	type JumpModel,
	type Surface,
	type Vec3,
} from '@oem/ganglia';
import { buildGroundSurfaces, type BuildOptions, type CollisionGeometry } from '@oem/ganglia/build';

type Options = {
	build: BuildOptions;
	project: ReturnType<typeof createGoalProjector>;
	goal: Vec3;
	interaction?: InteractionGoal;
	model: JumpModel;
};

/**
 * @param geometry complete selected collision, with non-walkable support faces already excluded
 * @param surfaces immutable coarse ground from the same collision and body profile
 * @param options matching build parameters, goal region and movement model
 * @returns finer support patches missing from the coarse mesh in the goal's local jump-access region
 * @throws when the bounded native refinement fails; returned patches still require physical action checks
 */
export const refineGoalGround = async (
	geometry: CollisionGeometry,
	surfaces: Surface[],
	{ build, project, goal, interaction, model }: Options,
) => {
	const duration = jumpDuration(goal[1], goal[1], { ...model, mode: 'jump' });
	if (!duration || !build.bounds) {
		return { surfaces: [], bounds: null };
	}
	// A goal region and one ordinary jump's horizontal reach cover its immediate
	// access supports. This is local resolution repair, not a limit on route hops.
	const reach = (interaction?.radius ?? 0) + duration * model.maxHorizontalSpeed + build.profile.radius;
	const bounds = {
		min: [Math.max(build.bounds.min[0], goal[0] - reach), Math.max(build.bounds.min[1], goal[2] - reach)] as [
			number,
			number,
		],
		max: [Math.min(build.bounds.max[0], goal[0] + reach), Math.min(build.bounds.max[1], goal[2] + reach)] as [
			number,
			number,
		],
	};
	if (bounds.min.some((value, axis) => value >= bounds.max[axis])) {
		return { surfaces: [], bounds };
	}
	const positions: number[] = [];
	for (let offset = 0; offset < geometry.indices.length; offset += 3) {
		const ids = [geometry.indices[offset], geometry.indices[offset + 1], geometry.indices[offset + 2]];
		if (
			!([0, 2] as const).every(
				(axis, index) =>
					Math.min(...ids.map((id) => geometry.positions[id * 3 + axis])) <= bounds.max[index] &&
					Math.max(...ids.map((id) => geometry.positions[id * 3 + axis])) >= bounds.min[index],
			)
		) {
			continue;
		}
		for (const id of ids) {
			positions.push(
				geometry.positions[id * 3],
				geometry.positions[id * 3 + 1],
				geometry.positions[id * 3 + 2],
			);
		}
	}
	if (!positions.length) {
		return { surfaces: [], bounds };
	}
	const fine = await buildGroundSurfaces(
		{ positions, indices: Array.from({ length: positions.length / 3 }, (_, index) => index) },
		{ ...build, bounds, cellSize: build.cellSize / 3 },
	);
	const graph = surfaceGraph(fine, { speed: 1 });
	const parents = new Map(fine.map((surface) => [surface.id, surface.id]));
	const root = (id: string): string => {
		let current = id;
		while (parents.get(current) !== current) {
			current = parents.get(current)!;
		}
		return current;
	};
	for (const edge of graph.edges) {
		parents.set(root(edge.from), root(edge.to));
	}
	const covered = new Set<string>();
	for (const surface of fine) {
		if (
			surface.vertices.some(
				(point) =>
					project(point, {
						maxVertical: build.cellHeight * 2,
						interaction: { radius: build.profile.radius },
					}).length,
			)
		) {
			covered.add(root(surface.id));
		}
	}
	const ids = new Set(surfaces.map((surface) => surface.id));
	const additions: Surface[] = [];
	let serial = 0;
	for (const surface of fine) {
		// Mixing overlapping detail meshes can invalidate ordinary portal ownership.
		// Keep only wholly missing support components; partial passage refinement
		// needs a stitched replacement mesh rather than isolated triangle fragments.
		if (covered.has(root(surface.id))) {
			continue;
		}
		let id: string;
		do {
			id = `refined/${serial++}`;
		} while (ids.has(id));
		ids.add(id);
		additions.push({ ...surface, id });
	}
	return { surfaces: additions, bounds };
};
