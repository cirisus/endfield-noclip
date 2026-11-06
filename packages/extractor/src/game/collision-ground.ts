import type { EcsCollider } from '@endfield-noclip/formats/endfield/ecs-collider';
import type { CollisionMesh } from '@endfield-noclip/formats/unity/collision-mesh';
import { multiplyMatrices, transformPoint, trsMatrix } from '@endfield-noclip/formats/unity/transform';
import { isObject } from '@endfield-noclip/formats/unity/values';

type Vec3 = [number, number, number];
type Source = { buildGuid: string; contentHash: string };
type Selection = { sceneState: number; area: number; layerMask: number };
/** source collision geometry; missing cooks retain bounds without claiming decoded triangles */
export type MeshGeometry = CollisionMesh & { approximation?: 'missing-cook-bounds' };
type Actor = {
	id: number;
	component: number;
	file: string;
	collider: EcsCollider;
	assets: string[];
	shapeGeometry: (string | null)[];
	complexGeometry: string | null;
	terrainGeometry: string | null;
};
/** decoded collision-inputs export; geometry has collider scale baked only for terrain */
export interface CollisionInputs {
	version: 1;
	source: Source;
	scene: string;
	cell: 'global' | { x: number; z: number };
	selection: Selection;
	coverage: { complete: boolean; remaining: string[]; [key: string]: unknown };
	actors: Actor[];
	excludedActors: unknown[];
	geometries: Record<string, MeshGeometry>;
}

/** triangle range with optional source walkability classification */
export interface CollisionRecord {
	walkable?: boolean;
	first: number;
	count: number;
}

type ShapeRecord = CollisionRecord & {
	id: number;
	component: number;
	index: number | null;
	kind: 'box' | 'mesh' | 'terrain' | 'sphere' | 'capsule';
	approximation?: 'circumscribed-sphere' | 'capsule-axis-envelope' | 'missing-cook-bounds';
	bounds: { min: Vec3; max: Vec3 };
	layer: number;
};

/**
 * @param geometry collisionGeometry output or collision triangles with optional classified ranges
 * @returns copied indices with non-walkable upward faces reversed, preserving double-sided body collision
 * @throws for malformed triangle packing or classified ranges outside the geometry
 */
export const walkableCollisionIndices = (geometry: {
	positions: ArrayLike<number>;
	indices: ArrayLike<number>;
	records?: readonly CollisionRecord[];
}): number[] => {
	if (geometry.positions.length % 3 || geometry.indices.length % 3) {
		throw new Error('invalid collision triangle packing');
	}
	const indices = Array.from(geometry.indices);
	for (const record of geometry.records ?? []) {
		if (
			!Number.isInteger(record.first) ||
			!Number.isInteger(record.count) ||
			record.first < 0 ||
			record.count < 0 ||
			record.first + record.count > indices.length / 3
		) {
			throw new Error('invalid collision triangle range');
		}
		if (record.walkable !== false) {
			continue;
		}
		for (let triangle = record.first; triangle < record.first + record.count; triangle++) {
			const at = triangle * 3;
			const a = indices[at] * 3,
				b = indices[at + 1] * 3,
				c = indices[at + 2] * 3;
			const upward =
				(geometry.positions[b + 2] - geometry.positions[a + 2]) *
					(geometry.positions[c] - geometry.positions[a]) -
				(geometry.positions[b] - geometry.positions[a]) *
					(geometry.positions[c + 2] - geometry.positions[a + 2]);
			if (upward > 0) {
				[indices[at + 1], indices[at + 2]] = [indices[at + 2], indices[at + 1]];
			}
		}
	}
	return indices;
};

// Fresh decoder values and their JSON cache must compare under the same numeric
// semantics. In particular, JSON serializes negative zero as zero and omits undefined fields.
const sameData = (a: unknown, b: unknown): boolean => {
	if (a === b) {
		return true;
	}
	if (Array.isArray(a) || Array.isArray(b)) {
		return (
			Array.isArray(a) &&
			Array.isArray(b) &&
			a.length === b.length &&
			a.every((value, index) => sameData(value, b[index]))
		);
	}
	if (!isObject(a) || !isObject(b)) {
		return false;
	}
	const keys = Object.keys(a).filter((key) => a[key] !== undefined);
	return (
		keys.length === Object.keys(b).filter((key) => b[key] !== undefined).length &&
		keys.every((key) => Object.hasOwn(b, key) && sameData(a[key], b[key]))
	);
};

const finiteVector = (value: readonly number[], length: number) =>
	Array.isArray(value) && value.length === length && value.every(Number.isFinite);
const pose = (value: { position: Vec3; rotation: [number, number, number, number] }) => {
	if (
		!finiteVector(value.position, 3) ||
		!finiteVector(value.rotation, 4) ||
		Math.abs(Math.hypot(...value.rotation) - 1) > 1e-3
	) {
		throw new Error('invalid collision pose');
	}
};
const box = ([x, y, z]: Vec3): Pick<CollisionMesh, 'vertices' | 'triangles'> => {
	if (![x, y, z].every((value) => Number.isFinite(value) && value >= 0)) {
		throw new Error('invalid collision box dimensions');
	}
	return {
		vertices: [
			[-x, -y, -z],
			[x, -y, -z],
			[x, y, -z],
			[-x, y, -z],
			[-x, -y, z],
			[x, -y, z],
			[x, y, z],
			[-x, y, z],
		],
		triangles: [
			[0, 2, 1],
			[0, 3, 2],
			[4, 5, 6],
			[4, 6, 7],
			[0, 1, 5],
			[0, 5, 4],
			[3, 7, 6],
			[3, 6, 2],
			[0, 4, 7],
			[0, 7, 3],
			[1, 2, 6],
			[1, 6, 5],
		],
	};
};

const radialSegments = 24,
	latitudeBands = 24;
const sphereRing = (band: number, segment: number) =>
	1 + (band - 1) * radialSegments + (segment % radialSegments);
const sphereTemplate = () => {
	const vertices: Vec3[] = [[0, -1, 0]];
	for (let band = 1; band < latitudeBands; band++) {
		const latitude = -Math.PI / 2 + (band * Math.PI) / latitudeBands;
		for (let segment = 0; segment < radialSegments; segment++) {
			const longitude = (segment * Math.PI * 2) / radialSegments;
			vertices.push([
				Math.cos(latitude) * Math.cos(longitude),
				Math.sin(latitude),
				Math.cos(latitude) * Math.sin(longitude),
			]);
		}
	}
	const top = vertices.length;
	vertices.push([0, 1, 0]);
	const triangles: [number, number, number][] = [];
	for (let segment = 0; segment < radialSegments; segment++) {
		triangles.push([0, sphereRing(1, segment), sphereRing(1, segment + 1)]);
		for (let band = 1; band + 1 < latitudeBands; band++) {
			const a = sphereRing(band, segment),
				b = sphereRing(band, segment + 1),
				c = sphereRing(band + 1, segment),
				d = sphereRing(band + 1, segment + 1);
			triangles.push([a, c, d], [a, d, b]);
		}
		triangles.push([sphereRing(latitudeBands - 1, segment), top, sphereRing(latitudeBands - 1, segment + 1)]);
	}
	let minimumPlaneDistance = Infinity;
	for (const triangle of triangles) {
		const [a, b, c] = triangle.map((index) => vertices[index]);
		const u = b.map((value, axis) => value - a[axis]),
			v = c.map((value, axis) => value - a[axis]);
		const normal = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
		const signedDistance =
			normal.reduce((sum, value, axis) => sum + value * a[axis], 0) / Math.hypot(...normal);
		if (signedDistance < 0) {
			[triangle[1], triangle[2]] = [triangle[2], triangle[1]];
		}
		minimumPlaneDistance = Math.min(minimumPlaneDistance, Math.abs(signedDistance));
	}
	return { vertices, triangles, minimumPlaneDistance };
};
const unitSphere = sphereTemplate();
const enclosingSphere = (radius: number) => {
	if (!Number.isFinite(radius) || radius <= 0) {
		throw new Error('invalid round collision radius');
	}
	// UV sphere facets form a closed convex polyhedron. Scaling its minimum facet
	// distance to the source radius encloses the entire sphere, including facet interiors.
	const outerRadius = (radius / unitSphere.minimumPlaneDistance) * (1 + 1e-6);
	return {
		vertices: unitSphere.vertices.map((point): Vec3 => [
			point[0] * outerRadius,
			point[1] * outerRadius,
			point[2] * outerRadius,
		]),
		triangles: unitSphere.triangles,
		outerRadius,
	};
};

type ApproximationDetails =
	| {
			reason: string;
			kind: 'circumscribed-sphere' | 'capsule-axis-envelope';
			sourceRadius: number;
			envelopeRadius: number;
			outerRadius: number;
			radialSegments: number;
			latitudeBands: number;
			padding: number;
	  }
	| {
			kind: 'missing-cook-bounds';
			reason: string;
			geometry: string;
			padding: number;
	  };
type Approximation = ApproximationDetails & {
	id: number;
	component: number;
	index: number;
	bounds: { min: Vec3; max: Vec3 };
};
type Unresolved = {
	id: number;
	component: number;
	geometry: string | null;
} & (
	| {
			kind: 'complex';
			collider: NonNullable<EcsCollider['complex']>;
	  }
	| {
			kind: 'missing-cook-bounds';
			index: number;
			bounds: { min: Vec3; max: Vec3 };
	  }
);

// world-space rounding allowance for the source's float32 bounds and composed transforms.
const approximationPadding = 0.001;

/**
 * converts selected collision exports to world geometry. actor and local shape poses are applied once.
 * regular mesh scale is authored; terrain scale is already baked into its decoded vertices. sphere facets
 * circumscribe the exact sphere. capsules use an explicitly recorded axis-independent envelope because the
 * serialized axis and length convention remain unresolved. empty cooks retain their source bounds. all
 * approximations are non-walkable and retain unknown exclusion volumes, with explicit overblocking limits.
 * render transforms are never used. complex meshes and source-coverage gaps remain unresolved for the
 * caller.
 *
 * @param inputs decoded cell/global collision exports for one scene, build and selection
 * @param options optional verified player walkable-layer mask; absent classification stays unknown
 * @returns world-space collision triangles, shape records, unknown exclusion volumes and unresolved coverage
 * @throws for mismatched inputs, conflicting duplicate placements or malformed geometry
 */
export const collisionGeometry = (
	inputs: readonly CollisionInputs[],
	options: { walkableLayers?: number } = {},
) => {
	if (!inputs.length) {
		throw new Error('collision inputs are empty');
	}
	if (
		options.walkableLayers !== undefined &&
		(!Number.isInteger(options.walkableLayers) ||
			options.walkableLayers < 0 ||
			options.walkableLayers > 0xffffffff)
	) {
		throw new Error('invalid walkable collision layer mask');
	}
	const first = inputs[0];
	const actors = new Map<string, Actor>();
	const geometries = new Map<string, MeshGeometry>();
	const remaining = new Set<string>();
	let duplicates = 0;
	for (const input of inputs) {
		if (
			input.version !== 1 ||
			!input.source?.buildGuid ||
			!input.source.contentHash ||
			!input.scene ||
			!sameData(input.source, first.source) ||
			input.scene !== first.scene ||
			!sameData(input.selection, first.selection)
		) {
			throw new Error('collision inputs must share a scene, build and selection');
		}
		const { sceneState, area, layerMask } = input.selection;
		if (
			![sceneState, area, layerMask].every(Number.isInteger) ||
			sceneState < 0 ||
			area < 0 ||
			layerMask < 0 ||
			layerMask > 0xffffffff ||
			!Array.isArray(input.actors) ||
			!Array.isArray(input.coverage?.remaining) ||
			!input.geometries
		) {
			throw new Error('invalid collision input selection or coverage');
		}
		for (const reason of input.coverage.remaining) {
			remaining.add(reason);
		}
		for (const [key, mesh] of Object.entries(input.geometries)) {
			const previous = geometries.get(key);
			if (previous && !sameData(previous, mesh)) {
				throw new Error(`conflicting collision geometry ${key}`);
			}
			geometries.set(key, mesh);
		}
		for (const actor of input.actors) {
			if (
				!Number.isInteger(actor.id) ||
				actor.id < 0 ||
				!Number.isInteger(actor.component) ||
				actor.component < 0
			) {
				throw new Error('invalid collision actor identity');
			}
			const key = `${actor.id}/${actor.component}`;
			const previous = actors.get(key);
			if (previous) {
				// Streamed cell copies have different file provenance but must place exactly the same collider.
				const { file: _previousFile, ...previousData } = previous;
				const { file: _file, ...data } = actor;
				if (!sameData(previousData, data)) {
					throw new Error(`conflicting collision actor ${key}`);
				}
				duplicates++;
			} else {
				actors.set(key, actor);
			}
		}
	}
	const positions: number[] = [],
		indices: number[] = [],
		records: ShapeRecord[] = [];
	const approximations: Approximation[] = [];
	const unresolved: Unresolved[] = [];
	const exclusions: { id: string; min: Vec3; max: Vec3; state: 'unknown'; reason: string }[] = [];
	const append = (
		mesh: Pick<CollisionMesh, 'vertices' | 'triangles'>,
		matrix: Float32Array,
		flipped: boolean,
		record: Omit<ShapeRecord, 'first' | 'count' | 'bounds'>,
	) => {
		if (
			!mesh ||
			!Array.isArray(mesh.vertices) ||
			!Array.isArray(mesh.triangles) ||
			!mesh.vertices.length ||
			(!mesh.triangles.length && record.kind !== 'terrain')
		) {
			throw new Error('missing or empty collision geometry');
		}
		const base = positions.length / 3,
			firstTriangle = indices.length / 3;
		const min: Vec3 = [Infinity, Infinity, Infinity],
			max: Vec3 = [-Infinity, -Infinity, -Infinity];
		for (const vertex of mesh.vertices) {
			if (!finiteVector(vertex, 3)) {
				throw new Error('invalid collision mesh vertex');
			}
			const point = transformPoint(matrix, vertex);
			if (!point.every(Number.isFinite)) {
				throw new Error('nonfinite world collision vertex');
			}
			for (let axis = 0; axis < 3; axis++) {
				min[axis] = Math.min(min[axis], point[axis]);
				max[axis] = Math.max(max[axis], point[axis]);
			}
			positions.push(...point);
		}
		for (const triangle of mesh.triangles) {
			if (
				triangle.length !== 3 ||
				triangle.some((index) => !Number.isInteger(index) || index < 0 || index >= mesh.vertices.length)
			) {
				throw new Error('invalid collision mesh triangle');
			}
			indices.push(base + triangle[0], base + triangle[flipped ? 2 : 1], base + triangle[flipped ? 1 : 2]);
		}
		const bounds = { min, max };
		records.push({ ...record, first: firstTriangle, count: mesh.triangles.length, bounds });
		return bounds;
	};
	for (const actor of actors.values()) {
		const collider = actor.collider;
		if (
			!Number.isInteger(collider.layer) ||
			collider.layer < 0 ||
			collider.layer > 31 ||
			((first.selection.layerMask >>> collider.layer) & 1) === 0
		) {
			throw new Error(`collision actor ${actor.id} does not match the selected layer mask`);
		}
		pose(collider);
		const walkable =
			options.walkableLayers === undefined
				? undefined
				: ((options.walkableLayers >>> collider.layer) & 1) !== 0;
		const matrix = trsMatrix(collider.position, collider.rotation, [1, 1, 1]);
		if (actor.shapeGeometry.length !== collider.shapes.length) {
			throw new Error(`incomplete shape geometry bindings for collision actor ${actor.id}`);
		}
		for (const [index, shape] of collider.shapes.entries()) {
			if (!shape.enabled || shape.trigger) {
				continue;
			}
			pose(shape);
			let mesh: Pick<CollisionMesh, 'vertices' | 'triangles'>;
			let scale: Vec3 = [1, 1, 1];
			let approximation: ApproximationDetails | undefined;
			switch (shape.kind) {
				case 'box': {
					mesh = box(shape.halfExtents);
					break;
				}
				case 'sphere':
				case 'capsule': {
					if (!Number.isFinite(shape.radius) || shape.radius <= 0) {
						throw new Error('invalid round collision radius');
					}
					let envelopeRadius = shape.radius;
					if (shape.kind === 'capsule') {
						if (!Number.isFinite(shape.cylinderLength) || shape.cylinderLength < 0) {
							throw new Error('invalid capsule cylinder length');
						}
						// The serialized axis and half/full-length policy are unresolved. An
						// axis-independent r + L envelope covers either length convention.
						envelopeRadius += shape.cylinderLength;
					}
					const sphere = enclosingSphere(envelopeRadius);
					mesh = sphere;
					approximation = {
						kind: shape.kind === 'capsule' ? 'capsule-axis-envelope' : 'circumscribed-sphere',
						sourceRadius: shape.radius,
						envelopeRadius,
						outerRadius: sphere.outerRadius,
						radialSegments,
						latitudeBands,
						padding: approximationPadding,
						reason:
							shape.kind === 'capsule'
								? 'axis-independent conservative envelope; capsule axis and length convention unresolved; may substantially overblock'
								: 'closed convex sphere tessellation circumscribed around the source radius; unknown AABB occupancy enclosure may overblock',
					};
					break;
				}
				case 'mesh': {
					const key = actor.shapeGeometry[index];
					const geometry = key && geometries.get(key);
					if (!geometry) {
						throw new Error(`missing mesh geometry for collision actor ${actor.id}, shape ${index}`);
					}
					mesh = geometry;
					if (geometry.approximation === 'missing-cook-bounds') {
						const { min, max } = geometry.bounds;
						if (
							!finiteVector(min, 3) ||
							!finiteVector(max, 3) ||
							min.some((value, axis) => value > max[axis]) ||
							geometry.vertices.length ||
							geometry.triangles.length
						) {
							throw new Error('invalid missing-cook collision bounds');
						}
						const center: Vec3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
						const enclosure = box([(max[0] - min[0]) / 2, (max[1] - min[1]) / 2, (max[2] - min[2]) / 2]);
						mesh = {
							vertices: enclosure.vertices.map((vertex): Vec3 => [
								vertex[0] + center[0],
								vertex[1] + center[1],
								vertex[2] + center[2],
							]),
							triangles: enclosure.triangles,
						};
						approximation = {
							kind: 'missing-cook-bounds',
							geometry: key,
							padding: approximationPadding,
							reason:
								'empty cooked collision payload; source bounds retained as an unknown non-walkable enclosure; may substantially overblock',
						};
					}
					scale = shape.scale;
					if (!finiteVector(scale, 3) || scale.some((value) => value === 0)) {
						throw new Error('invalid collision mesh scale');
					}
					break;
				}
			}
			const bounds = append(
				mesh,
				multiplyMatrices(matrix, trsMatrix(shape.position, shape.rotation, scale)),
				scale[0] * scale[1] * scale[2] < 0,
				{
					id: actor.id,
					component: actor.component,
					index,
					kind: shape.kind,
					layer: collider.layer,
					walkable: approximation ? false : walkable,
					approximation: approximation?.kind,
				},
			);
			if (approximation) {
				approximations.push({ id: actor.id, component: actor.component, index, ...approximation, bounds });
				if (approximation.kind === 'missing-cook-bounds') {
					unresolved.push({
						id: actor.id,
						component: actor.component,
						index,
						kind: approximation.kind,
						geometry: approximation.geometry,
						bounds,
					});
				}
				// closed triangle shells cannot reject a capsule starting wholly inside.
				// the unknown volume blocks both traversal and initial/goal occupancy.
				exclusions.push({
					id: `${approximation.kind}/${actor.id}/${actor.component}/${index}`,
					min: [
						bounds.min[0] - approximationPadding,
						bounds.min[1] - approximationPadding,
						bounds.min[2] - approximationPadding,
					],
					max: [
						bounds.max[0] + approximationPadding,
						bounds.max[1] + approximationPadding,
						bounds.max[2] + approximationPadding,
					],
					state: 'unknown',
					reason: approximation.reason,
				});
			}
		}
		if (collider.terrain?.enabled) {
			const geometry = actor.terrainGeometry && geometries.get(actor.terrainGeometry);
			if (!geometry) {
				throw new Error(`missing terrain geometry for collision actor ${actor.id}`);
			}
			append(geometry, matrix, false, {
				id: actor.id,
				component: actor.component,
				index: null,
				kind: 'terrain',
				layer: collider.layer,
				walkable,
			});
		}
		if (collider.complex) {
			unresolved.push({
				id: actor.id,
				component: actor.component,
				kind: 'complex',
				geometry: actor.complexGeometry,
				collider: structuredClone(collider.complex),
			});
		}
	}
	return {
		source: { ...first.source },
		scene: first.scene,
		selection: { ...first.selection },
		positions,
		indices,
		records,
		exclusions,
		coverage: {
			complete: false,
			inputs: inputs.map((input) => ({
				cell: structuredClone(input.cell),
				coverage: structuredClone(input.coverage),
			})),
			remaining: [...remaining],
			approximations,
			walkableLayers: options.walkableLayers,
			unresolved,
			actors: actors.size,
			duplicates,
		},
	};
};
