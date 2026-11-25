import type { EnvironmentVolumeShape } from './environment.ts';
import type { Rect, Vec3 } from './values.ts';
import {
	distanceInPolygon,
	distanceInsideShape,
	pointInPolygon,
	shapeReachesRect,
	type VolumeShape,
} from './volumes.ts';

// where environment volumes apply and in what order they stack: shared by the extractor's base-environment
// vote and the viewer's blend at the camera, so both pick the same volume at the same point.

const toVolumeShape = (shape: EnvironmentVolumeShape): VolumeShape =>
	shape.kind === 'prism'
		? { kind: 'prism', polygon: shape.points, minY: shape.bottom, maxY: shape.top }
		: shape;

/**
 * shape order among equal priorities, by volume type (prism is `PolyArea`, 3). the game's order among equal
 * priorities isn't known; this is an assumption
 */
const SHAPE_ORDER: Record<EnvironmentVolumeShape['kind'], number> = {
	global: 0,
	box: 1,
	sphere: 2,
	prism: 3,
};

/**
 * orders two volumes as they stack: ascending priority, then shape kind (global, box, prism). volumes that
 * still tie keep their list order, and the later one stacks on top
 *
 * @param a a volume
 * @param b another volume
 * @returns negative when `a` stacks under `b`, positive when over, 0 on a tie
 */
export const compareVolumes = (
	a: { priority: number; shape: EnvironmentVolumeShape },
	b: { priority: number; shape: EnvironmentVolumeShape },
): number => a.priority - b.priority || SHAPE_ORDER[a.shape.kind] - SHAPE_ORDER[b.shape.kind];

/**
 * @param shape a volume's shape
 * @param point a world position
 * @returns how far inside the shape the point is (m), infinite for global volumes, or ≤ 0 outside
 */
export const distanceInsideVolume = (shape: EnvironmentVolumeShape, point: Readonly<Vec3>): number =>
	distanceInsideShape(toVolumeShape(shape), point);

/**
 * @param shape a volume's shape
 * @param x world x
 * @param z world z
 * @returns whether the shape holds the point at some height: a prism at any height, a box at its centre's
 */
export const volumeFootprintContains = (shape: EnvironmentVolumeShape, x: number, z: number): boolean => {
	switch (shape.kind) {
		case 'global': {
			return true;
		}
		case 'box': {
			return distanceInsideVolume(shape, [x, shape.center[1], z]) >= 0;
		}
		case 'sphere': {
			return Math.hypot(x - shape.center[0], z - shape.center[2]) <= shape.radius;
		}
		case 'prism': {
			return pointInPolygon(shape.points, x, z) && distanceInPolygon(shape.points, x, z) > 0;
		}
	}
};

/**
 * @param shape a volume's shape
 * @param rect a world x, z rectangle
 * @returns whether the volume's footprint may reach into the rectangle (boxes are bounded by their rotated
 *   extents' circle, so this can be true just outside a box's corners)
 */
export const volumeReaches = (shape: EnvironmentVolumeShape, rect: Rect): boolean =>
	shapeReachesRect(toVolumeShape(shape), rect);
