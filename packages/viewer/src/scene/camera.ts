/**
 * the viewer camera. its position is kept in Unity world coordinates in double precision; everything sent to
 * the GPU is relative to it (camera-relative rendering), so f32 stays precise anywhere in the world.
 *
 * the package keeps Unity's left-handed frame. building the view as rows (right, up, -forward) of Unity
 * vectors is the same as applying `scale(1, 1, -1)` at the root followed by a right-handed look-at, so the
 * image matches the game and Unity's clockwise front faces stay clockwise on screen.
 *
 * @module
 */

import type { Vec3 } from '@endfield-noclip/package-format/values';

import { dot } from '../math/vec3.ts';

/** a plane `n·p + d ≥ 0` (inside), with `p` relative to the camera */
export type Plane = [nx: number, ny: number, nz: number, d: number];

/** the side planes' NDC signs along x and y, in the order {@link Camera.frustumPlanes} writes them */
const FRUSTUM_SIDES = [
	[1, 0],
	[-1, 0],
	[0, 1],
	[0, -1],
] as const;

const setPlane = (out: Plane[], i: number, nx: number, ny: number, nz: number, d: number): void => {
	const plane = (out[i] ??= [0, 0, 0, 0]);
	plane[0] = nx;
	plane[1] = ny;
	plane[2] = nz;
	plane[3] = d;
};

/** position, orientation and lens */
export class Camera {
	/** Unity world position, f64 */
	position: Vec3 = [0, 0, 0];
	/** radians; 0 looks along +Z (north), positive turns right (towards +X) */
	yaw = 0;
	/** radians; positive looks up */
	pitch = 0;
	/** vertical field of view, radians */
	fovY = (60 * Math.PI) / 180;
	/** near plane distance (m); the far plane is at infinity */
	near = 0.25;

	/** @returns unit forward vector */
	forward(): Vec3 {
		const cp = Math.cos(this.pitch);
		return [Math.sin(this.yaw) * cp, Math.sin(this.pitch), Math.cos(this.yaw) * cp];
	}

	/** @returns unit right vector (horizontal) */
	right(): Vec3 {
		return [Math.cos(this.yaw), 0, -Math.sin(this.yaw)];
	}

	/** @returns unit up vector */
	up(): Vec3 {
		const sp = Math.sin(this.pitch);
		return [-Math.sin(this.yaw) * sp, Math.cos(this.pitch), -Math.cos(this.yaw) * sp];
	}

	/**
	 * the view's axes scaled to its half extents at unit depth, so a camera-relative view ray through NDC `(x,
	 * y)` is `forward + x · right + y · up`
	 *
	 * @param aspect width / height
	 * @returns forward (unit), right · aspect · tan(fovY / 2) and up · tan(fovY / 2)
	 */
	viewBasis(aspect: number): { forward: Vec3; right: Vec3; up: Vec3 } {
		const tanHalf = Math.tan(this.fovY / 2);
		const right = this.right();
		const up = this.up();
		return {
			forward: this.forward(),
			right: [right[0] * aspect * tanHalf, right[1] * aspect * tanHalf, right[2] * aspect * tanHalf],
			up: [up[0] * tanHalf, up[1] * tanHalf, up[2] * tanHalf],
		};
	}

	/**
	 * @param direction a unit direction, such as towards the sun
	 * @param aspect width / height
	 * @returns where the direction falls on screen (uv, 0 at the top-left; outside [0, 1] off screen), or
	 *   `null` when it points behind the camera
	 */
	projectDirection(direction: Vec3, aspect: number): [u: number, v: number] | null {
		const w = dot(this.forward(), direction);
		if (w <= 0) {
			return null;
		}
		const f = 1 / Math.tan(this.fovY / 2);
		const x = ((f / aspect) * dot(this.right(), direction)) / w;
		const y = (f * dot(this.up(), direction)) / w;
		return [x * 0.5 + 0.5, 0.5 - y * 0.5];
	}

	/**
	 * @param viewportHeight drawing buffer height, px
	 * @returns pixels per metre at 1 m distance: `viewportHeight / (2 tan(fovY / 2))`; screen-space error is
	 *   `geometricError · factor / distance`
	 */
	pixelFactor(viewportHeight: number): number {
		return viewportHeight / (2 * Math.tan(this.fovY / 2));
	}

	/**
	 * writes the camera-relative view-projection: reversed-Z, infinite far plane, WebGPU clip space.
	 *
	 * @param aspect width / height
	 * @param out 16 floats, column-major; overwritten
	 */
	writeViewProjection(aspect: number, out: Float32Array): void {
		const f = 1 / Math.tan(this.fovY / 2);
		const r = this.right();
		const u = this.up();
		const fw = this.forward();
		// clip = (f/a · r·d, f · u·d, near, fw·d): depth = near / distance along the view axis
		for (let j = 0; j < 3; j++) {
			out[j * 4] = (f / aspect) * r[j];
			out[j * 4 + 1] = f * u[j];
			out[j * 4 + 2] = 0;
			out[j * 4 + 3] = fw[j];
		}
		out[12] = 0;
		out[13] = 0;
		out[14] = this.near;
		out[15] = 0;
	}

	/**
	 * writes the left, right, bottom, top and near planes, camera-relative (no far plane), into `out`, reusing
	 * its planes.
	 *
	 * @param aspect width / height
	 * @param out the planes to overwrite; resized to 5
	 * @returns `out`
	 */
	frustumPlanes(aspect: number, out: Plane[]): Plane[] {
		const f = 1 / Math.tan(this.fovY / 2);
		const r = this.right();
		const u = this.up();
		const fw = this.forward();
		out.length = 5;
		for (const [i, [sx, sy]] of FRUSTUM_SIDES.entries()) {
			const nx = fw[0] + sx * (f / aspect) * r[0] + sy * f * u[0];
			const ny = fw[1] + sx * (f / aspect) * r[1] + sy * f * u[1];
			const nz = fw[2] + sx * (f / aspect) * r[2] + sy * f * u[2];
			const length = Math.hypot(nx, ny, nz);
			setPlane(out, i, nx / length, ny / length, nz / length, 0);
		}
		setPlane(out, 4, fw[0], fw[1], fw[2], -this.near);
		return out;
	}
}

/**
 * @param planes camera-relative planes
 * @param min box minimum, world
 * @param max box maximum, world
 * @param eye camera position, world
 * @returns whether the box is at least partly inside every plane
 */
export const boxInFrustum = (
	planes: readonly Plane[],
	min: readonly number[],
	max: readonly number[],
	eye: Vec3,
): boolean => {
	for (const [nx, ny, nz, d] of planes) {
		// the box corner furthest along the plane normal
		const px = (nx >= 0 ? max[0] : min[0]) - eye[0];
		const py = (ny >= 0 ? max[1] : min[1]) - eye[1];
		const pz = (nz >= 0 ? max[2] : min[2]) - eye[2];
		if (nx * px + ny * py + nz * pz + d < 0) {
			return false;
		}
	}
	return true;
};

/**
 * sweeps a frustum along a direction: a sphere passes the swept planes when moving it up to `distance` along
 * `direction` brings it inside every original plane. each plane is tested on its own, so like the plain
 * frustum test this keeps a few spheres it needn't. used for shadow casters, whose shadows travel along the
 * sunlight into the view.
 *
 * @param planes camera-relative planes
 * @param direction unit direction of the sweep
 * @param distance how far to sweep, m
 * @returns new planes, moved outwards on the side the sweep comes from
 */
export const sweepPlanes = (planes: readonly Plane[], direction: Vec3, distance: number): Plane[] =>
	planes.map(([nx, ny, nz, d]) => [
		nx,
		ny,
		nz,
		d + distance * Math.max(0, nx * direction[0] + ny * direction[1] + nz * direction[2]),
	]);

/**
 * @param min box minimum
 * @param max box maximum
 * @param p a point
 * @returns the distance from the point to the box (0 inside)
 */
export const distanceToBox = (min: readonly number[], max: readonly number[], p: Vec3): number => {
	const dx = Math.max(min[0] - p[0], 0, p[0] - max[0]);
	const dy = Math.max(min[1] - p[1], 0, p[1] - max[1]);
	const dz = Math.max(min[2] - p[2], 0, p[2] - max[2]);
	return Math.hypot(dx, dy, dz);
};
