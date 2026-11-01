import type { PackageManifest } from './manifest.ts';
import type { Catalog } from './oem.ts';
import type { Vec3 } from './values.ts';

/** Source-authored map volumes; coordinates remain in each package's Unity frame. */
export interface Volume {
	kind: 'box' | 'sphere' | 'polygon';
	position: Vec3;
	rotation: Vec3;
	size: Vec3;
	radius: number;
	points: [number, number][];
}

/** A route joins OEM subregions to an explicit scene/level, never an ID-prefix guess. */
export interface Route {
	scene: string;
	level: string;
	region: string;
	subregion: string;
	seamless: boolean;
	bounds: { min: Vec3; max: Vec3 } | null;
	volumes: { tier: number; priority: number; shapes: Volume[] }[];
}

/** Small immutable routing companion, bound to the exact package generations. */
export interface Navigation {
	version: 1;
	release: string;
	source: PackageManifest['source'];
	generations: Record<string, string>;
	routes: Route[];
}

const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object';
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const vec = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every(finite);
const volume = (v: unknown): boolean =>
	object(v) &&
	['box', 'sphere', 'polygon'].includes(String(v.kind)) &&
	vec(v.position) &&
	vec(v.rotation) &&
	vec(v.size) &&
	finite(v.radius) &&
	Array.isArray(v.points) &&
	v.points.every((p: unknown) => Array.isArray(p) && p.length === 2 && p.every(finite));

/** @param value decoded JSON @returns whether the navigation companion has valid geometry */
export const isNavigation = (value: unknown): value is Navigation =>
	object(value) &&
	value.version === 1 &&
	typeof value.release === 'string' &&
	object(value.source) &&
	typeof value.source.buildGuid === 'string' &&
	typeof value.source.contentHash === 'string' &&
	object(value.generations) &&
	Object.values(value.generations).every((v) => typeof v === 'string') &&
	Array.isArray(value.routes) &&
	value.routes.every(
		(r: unknown) =>
			object(r) &&
			['scene', 'level', 'region', 'subregion'].every((k) => typeof r[k] === 'string') &&
			typeof r.seamless === 'boolean' &&
			(r.bounds === null || (object(r.bounds) && vec(r.bounds.min) && vec(r.bounds.max))) &&
			Array.isArray(r.volumes) &&
			r.volumes.every(
				(v: unknown) =>
					object(v) &&
					Number.isInteger(v.tier) &&
					finite(v.priority) &&
					Array.isArray(v.shapes) &&
					v.shapes.every(volume),
			),
	);

/**
 * @param shape source-authored volume @param point Unity world position @returns whether it contains the
 *   point
 */
export const containsVolume = (shape: Volume, point: readonly number[]): boolean => {
	let [x, y, z] = point.map((v, i) => v - shape.position[i]);
	const [rx, ry, rz] = shape.rotation.map((v) => (v * Math.PI) / 180);
	// Undo Unity's ZXY Euler order, including tilted boxes and prisms.
	[x, z] = [x * Math.cos(ry) - z * Math.sin(ry), x * Math.sin(ry) + z * Math.cos(ry)];
	[y, z] = [y * Math.cos(rx) + z * Math.sin(rx), -y * Math.sin(rx) + z * Math.cos(rx)];
	[x, y] = [x * Math.cos(rz) + y * Math.sin(rz), -x * Math.sin(rz) + y * Math.cos(rz)];
	if (shape.kind === 'sphere') {
		return Math.hypot(x, y, z) <= shape.radius;
	}
	if (shape.kind === 'box') {
		return [x, y, z].every((v, i) => Math.abs(v) <= Math.abs(shape.size[i]) / 2);
	}
	if (Math.abs(y) > Math.abs(shape.size[1]) / 2) {
		return false;
	}
	let inside = false;
	for (let i = 0, j = shape.points.length - 1; i < shape.points.length; j = i++) {
		const [ax, az] = shape.points[j],
			[bx, bz] = shape.points[i];
		if (
			Math.abs((x - ax) * (bz - az) - (z - az) * (bx - ax)) < 1e-7 &&
			x >= Math.min(ax, bx) &&
			x <= Math.max(ax, bx) &&
			z >= Math.min(az, bz) &&
			z <= Math.max(az, bz)
		) {
			return true;
		}
		if (az > z !== bz > z && x < ((bx - ax) * (z - az)) / (bz - az) + ax) {
			inside = !inside;
		}
	}
	return inside;
};

/**
 * @param data navigation companion @param catalog release catalog @returns whether all source and generation
 *   bindings match
 */
export const matchesNavigation = (data: Navigation, catalog: Catalog): boolean =>
	data.release === catalog.release &&
	data.source.buildGuid === catalog.source.buildGuid &&
	data.source.contentHash === catalog.source.contentHash &&
	Object.keys(data.generations).length === Object.keys(catalog.packages).length &&
	Object.entries(catalog.packages).every(([scene, p]) => data.generations[scene] === p.generation) &&
	data.routes.every(
		(r) => Object.hasOwn(catalog.packages, r.scene) && Object.hasOwn(catalog.files, r.subregion),
	);
