import type { Vec3 } from '@oem/ganglia';

interface Boundary {
	id: string;
	side: number;
	climb: number;
	a: Vec3;
	b: Vec3;
}

const axisOf = (side: number) => (side === 0 || side === 4 ? 0 : 2);

/**
 * @param boundaries authored external tile boundaries in world metres
 * @param steps player upward/downward step limits
 * @returns directed transfers across opposite source portals, retaining height differences
 * @throws for malformed authored boundary metadata
 */
export const navigationPortals = (boundaries: Boundary[], steps: { up: number; down: number }) => {
	const buckets = new Map<string, Boundary[]>();
	const portals: { from: string; to: string; points: [Vec3, Vec3] }[] = [];
	const epsilon = 0.0001;
	for (const edge of boundaries) {
		const axis = axisOf(edge.side);
		if (
			![0, 2, 4, 6].includes(edge.side) ||
			!Number.isFinite(edge.climb) ||
			edge.climb < 0 ||
			[...edge.a, ...edge.b].some((value) => !Number.isFinite(value)) ||
			Math.abs(edge.a[axis] - edge.b[axis]) > epsilon
		) {
			throw new Error('invalid authored navigation boundary');
		}
		const key = `${axis}/${Math.round(edge.a[axis] * 1000)}`;
		const list = buckets.get(key) ?? [];
		list.push(edge);
		buckets.set(key, list);
	}
	const height = (edge: Boundary, coordinate: number, along: number) => {
		const t = (coordinate - edge.a[along]) / (edge.b[along] - edge.a[along]);
		return edge.a[1] + t * (edge.b[1] - edge.a[1]);
	};
	for (const edges of buckets.values()) {
		const axis = axisOf(edges[0].side),
			along = axis === 0 ? 2 : 0;
		const ordered = edges
			.filter((edge) => Math.abs(edge.a[along] - edge.b[along]) > epsilon)
			.toSorted((a, b) => Math.min(a.a[along], a.b[along]) - Math.min(b.a[along], b.b[along]));
		for (let i = 0; i < ordered.length; i++) {
			const a = ordered[i],
				aMax = Math.max(a.a[along], a.b[along]);
			for (let j = i + 1; j < ordered.length; j++) {
				const b = ordered[j],
					bMin = Math.min(b.a[along], b.b[along]);
				if (bMin >= aMax - epsilon) {
					break;
				}
				if (a.id === b.id || (a.side + 4) % 8 !== b.side || Math.abs(a.a[axis] - b.a[axis]) > epsilon) {
					continue;
				}
				const low = Math.max(Math.min(a.a[along], a.b[along]), bMin);
				const high = Math.min(aMax, Math.max(b.a[along], b.b[along]));
				if (high - low <= epsilon) {
					continue;
				}
				const coordinate = (low + high) / 2;
				const ay = height(a, coordinate, along),
					by = height(b, coordinate, along);
				const climb = Math.min(a.climb, b.climb);
				if (Math.abs(ay - by) > climb + epsilon) {
					continue;
				}
				// Multiple overlapping bake variants cannot authorize a unique transition.
				const owners = ordered.filter(
					(edge) =>
						Math.min(edge.a[along], edge.b[along]) < coordinate &&
						Math.max(edge.a[along], edge.b[along]) > coordinate &&
						Math.abs(height(edge, coordinate, along) - ay) <= climb + epsilon,
				);
				if (owners.length !== 2) {
					continue;
				}
				const pa: Vec3 = [0, ay, 0],
					pb: Vec3 = [0, by, 0];
				pa[axis] = a.a[axis];
				pb[axis] = b.a[axis];
				pa[along] = coordinate;
				pb[along] = coordinate;
				if (by - ay <= steps.up + epsilon && ay - by <= steps.down + epsilon) {
					portals.push({ from: a.id, to: b.id, points: [pa, pb] });
				}
				if (ay - by <= steps.up + epsilon && by - ay <= steps.down + epsilon) {
					portals.push({ from: b.id, to: a.id, points: [pb, pa] });
				}
			}
		}
	}
	return portals;
};
