import { createBufferWithData } from '../../gfx/buffers.ts';
import type { DecodedGeometry } from '../../package/decode-protocol.ts';
import type { ResidentGeometry } from '../../streaming/resident.ts';

import type { SkinAnimator } from './skin-animation.ts';
import type { VertexBindings } from './vertex-bindings.ts';

/**
 * uploads a decoded geometry: its streams into one vertex buffer, its indices into another, and an animated
 * one's bind pose and frames
 *
 * @param device the device
 * @param owners `skins` uploads the animation, `bindings` grows its zeros to cover streams the geometry lacks
 * @param blob the geometry's blob, for labels
 * @param decoded vertex streams and indices
 * @returns the residency (geometry buffers aren't pooled; the memory budget bounds them)
 */
export const uploadGeometry = (
	device: GPUDevice,
	{ skins, bindings }: { skins: SkinAnimator; bindings: VertexBindings },
	blob: number,
	decoded: DecodedGeometry,
): ResidentGeometry => {
	const streams = [decoded.positions, decoded.normals, ...decoded.uvs, decoded.tangents, decoded.colors];
	const offsets: (number | null)[] = [];
	let size = 0;
	for (const stream of streams) {
		offsets.push(stream === null ? null : size);
		size += stream?.byteLength ?? 0;
	}
	const vertices = device.createBuffer({
		label: `geometry ${blob}`,
		size: Math.max(4, size),
		// an animation skins its frames into the buffer
		usage:
			GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST | (decoded.skin === null ? 0 : GPUBufferUsage.STORAGE),
	});
	streams.forEach((stream, i) => {
		const offset = offsets[i];
		if (stream !== null && offset !== null) {
			device.queue.writeBuffer(vertices, offset, stream);
		}
	});
	if (streams.includes(null)) {
		bindings.fitZeros(decoded.vertexCount);
	}
	const indices = createBufferWithData(device, {
		label: `geometry ${blob} indices`,
		usage: GPUBufferUsage.INDEX,
		data: decoded.indices,
	});
	const skin =
		decoded.skin === null
			? null
			: skins.create(`geometry ${blob}`, decoded.skin, {
					vertices,
					vertexCount: decoded.vertexCount,
					normalOffset: offsets[1],
					tangentOffset: offsets[4],
					positionOffset: decoded.positionOffset,
					positionScale: decoded.positionScale,
				});
	return {
		kind: 'geometry',
		bytes: vertices.size + indices.size + (skin?.bytes ?? 0),
		vertices,
		positionBytes: decoded.positions.byteLength,
		normalOffset: offsets[1],
		uv0Offset: offsets[2],
		// the game reads a UV set a mesh lacks as set 0
		uv1Offset: offsets[3] ?? offsets[2],
		uvFormat: decoded.uvFormat,
		uvTransforms: decoded.uvTransforms,
		tangentOffset: offsets[4],
		colorOffset: offsets[5],
		indices,
		indexFormat: decoded.indexSize === 4 ? 'uint32' : 'uint16',
		positionOffset: decoded.positionOffset,
		positionScale: decoded.positionScale,
		submeshes: decoded.submeshes,
		skin,
	};
};

/** @param resident a geometry from {@link uploadGeometry}; its buffers and its animation's are destroyed */
export const releaseGeometry = (resident: ResidentGeometry): void => {
	resident.vertices.destroy();
	resident.indices.destroy();
	for (const buffer of resident.skin?.buffers ?? []) {
		buffer.destroy();
	}
};
