import { FormatError } from '../binary/binary-reader.ts';
import { TERRAIN_HEIGHT_HOLE } from '../hg/terrain.ts';
import type { CollisionMesh } from '../unity/collision-mesh.ts';

/**
 * @param bytes little-endian RG16 base-level samples from an ECS terrain collider's texture
 * @param options dimensions and collider scale, in local Unity coordinates
 * @returns upward triangles; a hole at any quad corner removes both triangles
 * @throws {FormatError} for inconsistent dimensions or unsupported scale
 */
export const readCollisionHeightfield = (
	bytes: Uint8Array,
	options: { width: number; height: number; scale: readonly [number, number, number] },
): CollisionMesh => {
	const { width, height, scale } = options;
	if (
		!Number.isSafeInteger(width) ||
		!Number.isSafeInteger(height) ||
		width < 2 ||
		height < 2 ||
		width * height * 2 !== bytes.length ||
		scale.length !== 3 ||
		scale.some((v) => !Number.isFinite(v) || v <= 0) ||
		scale[0] < 1e-8 ||
		scale[2] < 1e-8 ||
		scale[1] / 32766 < 1.5259021823865737e-9
	) {
		throw new FormatError('invalid collision heightfield');
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const vertices: CollisionMesh['vertices'] = [],
		triangles: CollisionMesh['triangles'] = [];
	const holes = new Uint8Array(width * height);
	let minY = Infinity,
		maxY = -Infinity;
	for (let z = 0; z < height; z++) {
		for (let x = 0; x < width; x++) {
			const i = z * width + x,
				sample = view.getUint16(i * 2, true);
			holes[i] = (sample & TERRAIN_HEIGHT_HOLE) !== 0 ? 1 : 0;
			// collision height normalization differs from the rendered terrain's /32768.
			const y = (sample & (TERRAIN_HEIGHT_HOLE - 1)) * (scale[1] / 32766);
			vertices.push([x * scale[0], y, z * scale[2]]);
			minY = Math.min(minY, y);
			maxY = Math.max(maxY, y);
		}
	}
	for (let z = 0; z < height - 1; z++) {
		for (let x = 0; x < width - 1; x++) {
			const a = z * width + x,
				b = a + 1,
				c = a + width,
				d = c + 1;
			if (holes[a] || holes[b] || holes[c] || holes[d]) {
				continue;
			}
			// alternating diagonals preserve the collision surface on nonplanar quads.
			if ((x + z) % 2 === 0) {
				triangles.push([a, c, d], [a, d, b]);
			} else {
				triangles.push([a, c, b], [b, c, d]);
			}
		}
	}
	return {
		vertices,
		triangles,
		faceRemap: null,
		materials: null,
		bounds: { min: [0, minY, 0], max: [(width - 1) * scale[0], maxY, (height - 1) * scale[2]] },
	};
};
