/* oxlint-disable no-await-in-loop -- avoid a burst of requests while examining local instances */
import { DrawRole } from '@endfield-noclip/package-format/instances';
import { ContentKind } from '@endfield-noclip/package-format/tree';

import type { DecodePool } from '../package/decode-pool.ts';
import type { DecodedGeometry, DecodedInstances } from '../package/decode-protocol.ts';
import { CORE_ARCHIVE_INDEX, type ViewerPackage } from '../package/viewer-package.ts';
import { RowKind, ROW_WORDS } from '../render/instance-rows.ts';
import { LookFlags, materialLooks } from '../render/materials.ts';

import type { Vec3 } from './camera.ts';
import type { CameraPose } from './noclip-controls.ts';

// only resolved decodes are shared: cancelling one target must not poison later reads.
const decodedCache = new WeakMap<ViewerPackage, Map<number, DecodedInstances | DecodedGeometry>>();
const opaqueCache = new WeakMap<ViewerPackage, boolean[]>();
const size = (v: DecodedInstances | DecodedGeometry): number =>
	v.kind === 'instances'
		? v.rows.byteLength + v.cull.byteLength + v.runs.byteLength
		: v.positions.byteLength +
			v.indices.byteLength +
			(v.normals?.byteLength ?? 0) +
			(v.tangents?.byteLength ?? 0) +
			(v.colors?.byteLength ?? 0) +
			v.uvs.reduce((n, b) => n + (b?.byteLength ?? 0), 0);
const remember = (pkg: ViewerPackage, blob: number, value: DecodedInstances | DecodedGeometry): void => {
	const cache = decodedCache.get(pkg) ?? new Map<number, DecodedInstances | DecodedGeometry>();
	const previous = cache.get(blob);
	cache.delete(blob);
	cache.set(blob, value);
	if (previous === value) {
		return;
	}

	let bytes = [...cache.values()].reduce((n, v) => n + size(v), 0);
	for (const [id, v] of cache) {
		if (bytes <= 64 * 1024 * 1024) {
			break;
		}
		cache.delete(id);
		bytes -= size(v);
	}
	decodedCache.set(pkg, cache);
};

type Triangle = [Vec3, Vec3, Vec3];
const cross = (a: Vec3, b: Vec3): Vec3 => [
	a[1] * b[2] - a[2] * b[1],
	a[2] * b[0] - a[0] * b[2],
	a[0] * b[1] - a[1] * b[0],
];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: readonly number[]): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

// two-sided segment tests also catch walls whose back face the renderer culls.
const blocked = (start: Vec3, end: Vec3, triangles: readonly Triangle[]): boolean => {
	const direction = sub(end, start);
	const length = Math.hypot(...direction);
	for (const [a, b, c] of triangles) {
		const e1 = sub(b, a),
			e2 = sub(c, a),
			h = cross(direction, e2),
			det = dot(e1, h);
		if (Math.abs(det) < 1e-9) {
			continue;
		}
		const s = sub(start, a),
			u = dot(s, h) / det;
		if (u < 0 || u > 1) {
			continue;
		}
		const q = cross(s, e1),
			v = dot(direction, q) / det,
			t = dot(e2, q) / det;
		if (v >= 0 && u + v <= 1 && t > 0.25 / length && t < 1) {
			return true;
		}
	}
	return false;
};

// The extra context rays share one spatial index per point; they must not each
// scan all nearby detail triangles during a whole-map bake.
type Occluders = { min: Vec3; max: Vec3; triangles?: readonly Triangle[]; children?: Occluders[] };
const indexTriangles = (triangles: readonly Triangle[]): Occluders => {
	const min: Vec3 = [Infinity, Infinity, Infinity],
		max: Vec3 = [-Infinity, -Infinity, -Infinity];
	for (const triangle of triangles) {
		for (const vertex of triangle) {
			for (let axis = 0; axis < 3; axis++) {
				min[axis] = Math.min(min[axis], vertex[axis]);
				max[axis] = Math.max(max[axis], vertex[axis]);
			}
		}
	}
	if (triangles.length <= 16) {
		return { min, max, triangles };
	}
	let axis = 0;
	for (let i = 1; i < 3; i++) {
		if (max[i] - min[i] > max[axis] - min[axis]) {
			axis = i;
		}
	}
	const ordered = triangles.toSorted(
		(a, b) => a[0][axis] + a[1][axis] + a[2][axis] - b[0][axis] - b[1][axis] - b[2][axis],
	);
	const middle = Math.floor(ordered.length / 2);
	return {
		min,
		max,
		children: [indexTriangles(ordered.slice(0, middle)), indexTriangles(ordered.slice(middle))],
	};
};
const intersects = (start: Vec3, end: Vec3, node: Occluders): boolean => {
	let near = 0,
		far = 1;
	for (let axis = 0; axis < 3; axis++) {
		const direction = end[axis] - start[axis];
		if (Math.abs(direction) < 1e-10) {
			if (start[axis] < node.min[axis] || start[axis] > node.max[axis]) {
				return false;
			}
		} else {
			const a = (node.min[axis] - start[axis]) / direction;
			const b = (node.max[axis] - start[axis]) / direction;
			near = Math.max(near, Math.min(a, b));
			far = Math.min(far, Math.max(a, b));
			if (near > far) {
				return false;
			}
		}
	}
	return node.triangles
		? blocked(start, end, node.triangles)
		: (node.children ?? []).some((child) => intersects(start, end, child));
};

/**
 * @param target authored point, in Unity coordinates
 * @param triangles nearby visible opaque scenery
 * @param ground terrain height, null where unknown or absent
 * @returns a clear view with nearby context, or the distance-preserving fallback
 */
export const pointPose = (
	target: Vec3,
	triangles: readonly Triangle[],
	ground: (x: number, z: number) => number | null,
): CameraPose & { clear: boolean } => {
	const occluders = indexTriangles(triangles);
	const sampled = ground(target[0], target[2]);
	// Underground points are framed within their cave, not lifted onto the terrain above it.
	const underground = sampled !== null && sampled > target[1] + 3;
	const surface = underground ? null : sampled;
	const focus: Vec3 = [target[0], Math.max(target[1], surface ?? target[1]) + 0.6, target[2]];
	for (const back of [10]) {
		for (const slope of [0.35, 0.15, 0.6, 1, 0.05, 0]) {
			let best: (CameraPose & { clear: boolean }) | null = null;
			let bestScore = Infinity;
			for (let heading = 0; heading < 16; heading++) {
				const yaw = (heading * Math.PI) / 8;
				const position: Vec3 = [
					target[0] - Math.sin(yaw) * back,
					focus[1] + back * slope,
					target[2] - Math.cos(yaw) * back,
				];
				// a small bundle tests the lens clearance as well as the central sight line.
				const eyes: Vec3[] = [
					position,
					[position[0] + 0.35, position[1], position[2]],
					[position[0] - 0.35, position[1], position[2]],
					[position[0], position[1] + 0.35, position[2]],
					[position[0], position[1] - 0.35, position[2]],
				];
				if (eyes.some((eye) => intersects(focus, eye, occluders))) {
					continue;
				}
				let below = false;
				const steps = Math.ceil(Math.hypot(back, back * slope) / 0.15);
				for (let step = 1; step <= steps; step++) {
					const t = step / steps,
						x = target[0] + (position[0] - target[0]) * t,
						z = target[2] + (position[2] - target[2]) * t;
					const y = underground ? null : ground(x, z);
					// points may sit directly on the ground; grow the clearance away from the target.
					if (y !== null && focus[1] + (position[1] - focus[1]) * t < y + 0.1 * Math.min(1, back * t)) {
						below = true;
						break;
					}
				}
				if (!below) {
					// A clear centre ray alone can leave half the image filled by a nearby wall.
					// Sample a fixed inspection frustum, independent of the user's saved lens.
					const pitch = -Math.atan2(position[1] - target[1], back);
					const forward: Vec3 = [
						Math.sin(yaw) * Math.cos(pitch),
						Math.sin(pitch),
						Math.cos(yaw) * Math.cos(pitch),
					];
					const right: Vec3 = [Math.cos(yaw), 0, -Math.sin(yaw)];
					const up = cross(forward, right);
					let score = 0;
					for (const x of [-0.8, -0.4, 0, 0.4, 0.8]) {
						for (const y of [-0.4, 0, 0.4]) {
							const component = (axis: number) =>
								position[axis] + 5 * (forward[axis] + right[axis] * x + up[axis] * y);
							const end: Vec3 = [component(0), component(1), component(2)];
							if (intersects(position, end, occluders)) {
								score++;
							}
						}
					}
					// Prefer oblique views only as a tie-breaker; visibility always wins.
					score += 0.01 * Math.abs(Math.cos(2 * yaw));
					if (score < bestScore - 1e-8) {
						bestScore = score;
						best = { position, yaw, pitch, clear: true };
					}
				}
			}
			if (best) {
				return best;
			}
		}
	}
	// Preserve a usable inspection distance even when the authored point is buried in solid geometry.
	return {
		position: [target[0], target[1] + 6, target[2] - 10],
		yaw: 0,
		pitch: -Math.atan2(6, 10),
		clear: false,
	};
};

/**
 * @param pkg opened scene package
 * @param pool existing decode workers
 * @param target authored point
 * @param shown visibility groups under the selected progression
 * @param signal cancels stale point requests
 * @returns opaque detail triangles near the point, independent of what happens to be on screen
 */
export const pointTriangles = async (
	pkg: ViewerPackage,
	pool: Pick<DecodePool, 'run'>,
	target: Vec3,
	shown: readonly boolean[],
	signal: AbortSignal,
): Promise<Triangle[]> => {
	const radius = 16;
	let opaque = opaqueCache.get(pkg);
	if (!opaque) {
		opaque = materialLooks(pkg.materials).map(
			(look) =>
				look.drawn &&
				!look.unsupported &&
				!look.transparent &&
				!look.relight &&
				look.screen === null &&
				(look.flags & LookFlags.Effect) === 0,
		);
		opaqueCache.set(pkg, opaque);
	}
	const near = (center: readonly number[], extent: readonly number[]): boolean =>
		center.every((v, i) => Math.abs(v - target[i]) <= radius + extent[i]);
	const read = async (blob: number): Promise<ArrayBuffer> => {
		signal.throwIfAborted();
		if (pkg.blobs[blob].archive === CORE_ARCHIVE_INDEX) {
			return pkg.readCoreBlob(blob);
		}
		const r = pkg.blobRange(blob);
		const bytes = await pkg.source.readRange(
			r.path,
			{ offset: r.start, length: r.length, fileSize: r.archiveSize },
			signal,
		);
		return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
	};
	const refs = [...pkg.manifest.global, ...pkg.tree.refs].filter(
		(ref) => ref.kind === ContentKind.Detail || ref.kind === ContentKind.Conditional,
	);
	// the core holds node bounds, so unrelated tiles need no instance reads.
	const nearby = new Set<number>();
	for (const node of pkg.tree.nodes) {
		const b = node.bounds;
		if (
			near(
				b.min.map((v, i) => (v + b.max[i]) / 2),
				b.min.map((v, i) => (b.max[i] - v) / 2),
			)
		) {
			for (let i = node.refFirst; i < node.refFirst + node.refCount; i++) {
				nearby.add(pkg.tree.refs[i].blob);
			}
		}
	}
	for (const ref of pkg.manifest.global) {
		nearby.add(ref.blob);
	}
	const blocks = new Map<number, Promise<DecodedInstances>>(),
		meshes = new Map<number, Promise<DecodedGeometry>>();
	const triangles: Triangle[] = [];
	for (const ref of refs) {
		if (!shown[ref.group] || !nearby.has(ref.blob)) {
			continue;
		}
		let pending = blocks.get(ref.blob);
		if (!pending) {
			const cached = decodedCache.get(pkg)?.get(ref.blob);
			pending =
				cached?.kind === 'instances'
					? Promise.resolve(cached)
					: read(ref.blob).then((data) =>
							pool.run({
								kind: 'instances',
								data,
								codec: pkg.blobs[ref.blob].codec,
								rawLength: pkg.blobs[ref.blob].rawLength,
								rowKinds: RowKind.Detail,
							}),
						);
			blocks.set(ref.blob, pending);
		}
		const block = await pending;
		remember(pkg, ref.blob, block);
		const rows = new Float32Array(block.rows.buffer);
		for (let run = 0; run < block.runs.length; run += 3) {
			const chain = pkg.chains[block.runs[run]],
				first = Math.max(ref.first, block.runs[run + 1]),
				end = Math.min(ref.first + ref.count, block.runs[run + 1] + block.runs[run + 2]);
			for (let row = first; row < end; row++) {
				signal.throwIfAborted();
				const at = row * ROW_WORDS;
				const center = block.origin.map((v, i) => v + rows[at + 12 + i]);
				if (!near(center, [rows[at + 16], rows[at + 17], rows[at + 18]])) {
					continue;
				}
				const extents = [rows[at + 16], rows[at + 17], rows[at + 18]];
				// Small geometry containing the target can be the collectible itself, not an occluder.
				if (
					extents.every((e) => e <= 1.5) &&
					center.every((v, i) => Math.abs(v - target[i]) <= extents[i] + 0.05)
				) {
					continue;
				}
				for (const draw of chain.draws) {
					if (draw.role !== DrawRole.Lit || draw.lod !== 0 || draw.particles !== null) {
						continue;
					}
					const entry = pkg.geometries.entries[draw.geometry];
					if (entry?.status !== 'ready' || !opaque[draw.material]) {
						continue;
					}
					let mesh = meshes.get(entry.blob);
					if (!mesh) {
						const cached = decodedCache.get(pkg)?.get(entry.blob);
						mesh =
							cached?.kind === 'geometry'
								? Promise.resolve(cached)
								: read(entry.blob).then((data) =>
										pool.run({
											kind: 'geometry',
											data,
											codec: pkg.blobs[entry.blob].codec,
											rawLength: pkg.blobs[entry.blob].rawLength,
										}),
									);
						meshes.set(entry.blob, mesh);
					}
					const geometry = await mesh;
					remember(pkg, entry.blob, geometry);
					const vertices = new Uint16Array(geometry.positions),
						indices =
							geometry.indexSize === 2
								? new Uint16Array(geometry.indices)
								: new Uint32Array(geometry.indices);
					const submesh = geometry.submeshes[draw.submesh];
					if (!submesh) {
						continue;
					}
					const vertex = (index: number): Vec3 => {
						const local = geometry.positionOffset.map(
							(v, i) => v + (vertices[index * 4 + i] / 65535) * geometry.positionScale[i],
						);
						return [
							block.origin[0] + dot([rows[at], rows[at + 1], rows[at + 2]], local) + rows[at + 3],
							block.origin[1] + dot([rows[at + 4], rows[at + 5], rows[at + 6]], local) + rows[at + 7],
							block.origin[2] + dot([rows[at + 8], rows[at + 9], rows[at + 10]], local) + rows[at + 11],
						];
					};
					for (let i = submesh.firstIndex; i < submesh.firstIndex + submesh.indexCount; i += 3) {
						const tri: Triangle = [
							vertex(indices[i] + submesh.baseVertex),
							vertex(indices[i + 1] + submesh.baseVertex),
							vertex(indices[i + 2] + submesh.baseVertex),
						];
						if (
							[0, 1, 2].every(
								(axis) =>
									Math.min(...tri.map((v) => v[axis])) <= target[axis] + radius &&
									Math.max(...tri.map((v) => v[axis])) >= target[axis] - radius,
							)
						) {
							triangles.push(tri);
						}
					}
				}
			}
		}
	}
	signal.throwIfAborted();
	return triangles;
};
