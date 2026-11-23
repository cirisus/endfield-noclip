/**
 * unified spatial volume shapes (`global`, `sphere`, `box`, `prism`, `cylinder`) shared by environment
 * volumes, triggers, stream areas, proximity reaches, light culling boxes, local fog volumes, reflection
 * probes, and named places
 *
 * @module
 */

import type { Mat3, Rect, Vec3 } from './values.ts';

/** a spatial volume in Unity's world frame */
export type VolumeShape =
	| { kind: 'global' }
	| { kind: 'sphere'; center: Vec3; radius: number }
	| {
			kind: 'box';
			center: Vec3;
			/** world-to-box-local 3×3 rotation (rows are the box's unit axes) */
			toBox: Mat3;
			halfExtents: Vec3;
	  }
	| {
			kind: 'prism';
			/** XZ polygon vertices */
			polygon: [x: number, z: number][];
			minY: number;
			maxY: number;
	  }
	| {
			kind: 'cylinder';
			center: Vec3;
			radius: number;
			halfHeight: number;
	  };

/**
 * tests whether `(x, z)` lies inside a 2D XZ polygon (even-odd rule)
 *
 * @param polygon XZ vertices
 * @param x world x
 * @param z world z
 * @returns whether the point is inside
 */
export const pointInPolygon = (
	polygon: readonly (readonly [number, number])[],
	x: number,
	z: number,
): boolean => {
	let inside = false;
	for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
		const [xi, zi] = polygon[i];
		const [xj, zj] = polygon[j];
		if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) {
			inside = !inside;
		}
	}
	return inside;
};

/**
 * distance from `(x, z)` to the nearest edge of a 2D polygon when inside it, or 0 outside
 *
 * @param polygon XZ vertices
 * @param x world x
 * @param z world z
 * @returns inward distance in metres, or 0 outside
 */
export const distanceInPolygon = (
	polygon: readonly (readonly [number, number])[],
	x: number,
	z: number,
): number => {
	let inside = false;
	let nearest = Infinity;
	for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
		const [xi, zi] = polygon[i];
		const [xj, zj] = polygon[j];
		if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) {
			inside = !inside;
		}
		const ex = xi - xj;
		const ez = zi - zj;
		const t = Math.max(0, Math.min(1, ((x - xj) * ex + (z - zj) * ez) / (ex * ex + ez * ez || 1)));
		nearest = Math.min(nearest, Math.hypot(x - (xj + t * ex), z - (zj + t * ez)));
	}
	return inside ? nearest : 0;
};

/**
 * inward distance from a point to a volume's boundary (metres): `Infinity` for `global`, positive inside, `<=
 * 0` outside
 *
 * @param shape volume shape
 * @param point world position
 * @returns inward distance in metres
 */
export const distanceInsideShape = (shape: VolumeShape, [x, y, z]: Readonly<Vec3>): number => {
	switch (shape.kind) {
		case 'global': {
			return Infinity;
		}
		case 'sphere': {
			return shape.radius - Math.hypot(x - shape.center[0], y - shape.center[1], z - shape.center[2]);
		}
		case 'box': {
			const { center, toBox: m, halfExtents } = shape;
			const dx = x - center[0];
			const dy = y - center[1];
			const dz = z - center[2];
			let inside = Infinity;
			for (let axis = 0; axis < 3; axis++) {
				const local = m[axis * 3] * dx + m[axis * 3 + 1] * dy + m[axis * 3 + 2] * dz;
				inside = Math.min(inside, halfExtents[axis] - Math.abs(local));
			}
			return inside;
		}
		case 'prism': {
			if (y < shape.minY || y > shape.maxY) {
				return 0;
			}
			return Math.min(distanceInPolygon(shape.polygon, x, z), y - shape.minY, shape.maxY - y);
		}
		case 'cylinder': {
			const radial = shape.radius - Math.hypot(x - shape.center[0], z - shape.center[2]);
			const vertical = shape.halfHeight - Math.abs(y - shape.center[1]);
			return Math.min(radial, vertical);
		}
	}
};

/**
 * tests whether a world point lies inside a volume
 *
 * @param shape volume shape
 * @param point world position
 * @returns whether the point is inside
 */
export const pointInVolume = (shape: VolumeShape, point: Readonly<Vec3>): boolean =>
	distanceInsideShape(shape, point) > 0;

/**
 * tests whether a volume's XZ footprint may intersect `rect`
 *
 * @param shape volume shape
 * @param rect world XZ rectangle
 * @returns whether the footprint overlaps `rect` (conservative for rotated boxes)
 */
export const shapeReachesRect = (shape: VolumeShape, rect: Rect): boolean => {
	switch (shape.kind) {
		case 'global': {
			return true;
		}
		case 'sphere':
		case 'cylinder': {
			const [x, , z] = shape.center;
			const { radius } = shape;
			return (
				x + radius >= rect.minX &&
				x - radius <= rect.maxX &&
				z + radius >= rect.minZ &&
				z - radius <= rect.maxZ
			);
		}
		case 'box': {
			const radius = Math.hypot(...shape.halfExtents);
			const [x, , z] = shape.center;
			return (
				x + radius >= rect.minX &&
				x - radius <= rect.maxX &&
				z + radius >= rect.minZ &&
				z - radius <= rect.maxZ
			);
		}
		case 'prism': {
			let minX = Infinity;
			let maxX = -Infinity;
			let minZ = Infinity;
			let maxZ = -Infinity;
			for (const [x, z] of shape.polygon) {
				minX = Math.min(minX, x);
				maxX = Math.max(maxX, x);
				minZ = Math.min(minZ, z);
				maxZ = Math.max(maxZ, z);
			}
			return maxX >= rect.minX && minX <= rect.maxX && maxZ >= rect.minZ && minZ <= rect.maxZ;
		}
	}
};
