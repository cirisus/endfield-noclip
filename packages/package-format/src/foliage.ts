/**
 * compact foliage cluster block (`.fol`, `EFFL` TLV container, {@link BlobKind.Foliage}): keeps dense
 * grass/bush/tree grids out of `.inst` by quantizing per-instance transforms inside each cluster AABB (24 B
 * per instance vs 72 B+ in `.inst`)
 *
 * @module
 */

import { viewOf } from './binary.ts';
import {
	checkStride,
	decodeContainer,
	encodeContainer,
	fourcc,
	requireSection,
	type ContainerSectionInput,
} from './container.ts';
import { PackageFormatError } from './errors.ts';
import type { Vec3 } from './values.ts';

/** one foliage cluster sharing a single chain and AABB */
export interface FoliageCluster {
	/** local index into {@link FoliageBlock.palette} (or global chain id once resolved) */
	chain: number;
	firstInstance: number;
	instanceCount: number;
	/** cluster AABB centre relative to {@link FoliageBlock.origin} */
	center: Vec3;
	/** cluster AABB half-extents */
	halfExtents: Vec3;
	/** half-size of the foliage renderer for screen-size/sparsity culling */
	rendererHalfSize: number;
}

/**
 * packed foliage instances (24 bytes each):
 *
 * - `posQ`: `u16×3` (`unorm16` within cluster `[center - halfExtents, center + halfExtents]`)
 * - `rotScaleQ`: `u16×3` (quantized orientation + uniform scale)
 * - `sparsity`: `f32`
 * - `param0`: `u8×4` (`unorm8x4` shader custom param 0)
 * - `param1`: `u8×4` (`unorm8x4` shader custom param 1)
 */
export interface FoliageBlock {
	origin: Vec3;
	/** optional per-block canonical chain hash palette (`PLTT`) */
	palette?: BigUint64Array;
	clusters: FoliageCluster[];
	/** `instanceCount × 24` raw instance bytes */
	instances: Uint8Array;
}

/** byte size of one packed foliage instance record */
export const FOLIAGE_INSTANCE_BYTES = 24;

const MAGIC = fourcc('EFFL');
const MAJOR_VERSION = 2;

const TAG_HEAD = fourcc('HEAD');
const TAG_PLTT = fourcc('PLTT');
const TAG_CLST = fourcc('CLST');
const TAG_INST = fourcc('INST');
const KNOWN_TAGS = new Set([TAG_HEAD, TAG_PLTT, TAG_CLST, TAG_INST]);

const HEAD_SIZE = 20;
const CLST_SIZE = 40;

/**
 * encodes a {@link FoliageBlock} into an `EFFL` TLV container
 *
 * @param block foliage clusters and packed instances
 * @returns encoded bytes (before outer zstd)
 * @throws {RangeError} if instance byte length is not a multiple of {@link FOLIAGE_INSTANCE_BYTES} or a
 *   cluster slice runs past `instances`
 */
export const encodeFoliageBlock = (block: FoliageBlock): Uint8Array => {
	if (block.instances.byteLength % FOLIAGE_INSTANCE_BYTES !== 0) {
		throw new RangeError('foliage instances byte length is not a multiple of 24');
	}
	const instanceCount = block.instances.byteLength / FOLIAGE_INSTANCE_BYTES;
	const head = new Uint8Array(HEAD_SIZE);
	const hv = viewOf(head);
	hv.setFloat32(0, block.origin[0], true);
	hv.setFloat32(4, block.origin[1], true);
	hv.setFloat32(8, block.origin[2], true);
	hv.setUint32(12, block.clusters.length, true);
	hv.setUint32(16, instanceCount, true);

	const clst = new Uint8Array(block.clusters.length * CLST_SIZE);
	const cv = viewOf(clst);
	for (const [i, c] of block.clusters.entries()) {
		if (c.firstInstance + c.instanceCount > instanceCount) {
			throw new RangeError(`foliage cluster ${i} runs past instances`);
		}
		const at = i * CLST_SIZE;
		cv.setUint32(at, c.chain, true);
		cv.setUint32(at + 4, c.firstInstance, true);
		cv.setUint32(at + 8, c.instanceCount, true);
		cv.setFloat32(at + 12, c.center[0], true);
		cv.setFloat32(at + 16, c.center[1], true);
		cv.setFloat32(at + 20, c.center[2], true);
		cv.setFloat32(at + 24, c.halfExtents[0], true);
		cv.setFloat32(at + 28, c.halfExtents[1], true);
		cv.setFloat32(at + 32, c.halfExtents[2], true);
		cv.setFloat32(at + 36, c.rendererHalfSize, true);
	}

	const sections: ContainerSectionInput[] = [
		{ tag: TAG_HEAD, required: true, data: head, count: 1, stride: HEAD_SIZE },
		...(block.palette !== undefined && block.palette.length > 0
			? [
					{
						tag: TAG_PLTT,
						required: false,
						data: new Uint8Array(block.palette.buffer, block.palette.byteOffset, block.palette.byteLength),
						count: block.palette.length,
						stride: 8,
					},
				]
			: []),
		{ tag: TAG_CLST, required: true, data: clst, count: block.clusters.length, stride: CLST_SIZE },
		{
			tag: TAG_INST,
			required: true,
			data: block.instances,
			count: instanceCount,
			stride: FOLIAGE_INSTANCE_BYTES,
		},
	];
	return encodeContainer({ magic: MAGIC, majorVersion: MAJOR_VERSION, sections });
};

/**
 * decodes an `EFFL` foliage cluster block
 *
 * @param data `.fol` bytes
 * @param chainIndex optional map from 64-bit chain content hash → global chain index; when given and a `PLTT`
 *   section is present, remaps each cluster's `chain` to global chain IDs
 * @returns decoded foliage block
 * @throws {PackageFormatError} on malformed headers, lengths, or missing palette hashes
 */
export const decodeFoliageBlock = (
	data: Uint8Array,
	chainIndex?: ReadonlyMap<bigint, number>,
): FoliageBlock => {
	const container = decodeContainer(data, {
		magic: MAGIC,
		majorVersion: MAJOR_VERSION,
		knownTags: KNOWN_TAGS,
		label: 'foliage block',
	});
	const head = requireSection(container, TAG_HEAD, 'foliage block');
	if (head.byteLength < HEAD_SIZE) {
		throw new PackageFormatError('foliage block HEAD is too short');
	}
	const hv = viewOf(head.data);
	const origin: Vec3 = [hv.getFloat32(0, true), hv.getFloat32(4, true), hv.getFloat32(8, true)];
	const clusterCount = hv.getUint32(12, true);
	const instanceCount = hv.getUint32(16, true);

	const clstSec = requireSection(container, TAG_CLST, 'foliage block');
	const instSec = requireSection(container, TAG_INST, 'foliage block');
	checkStride(clstSec, CLST_SIZE, 'CLST');
	checkStride(instSec, FOLIAGE_INSTANCE_BYTES, 'INST');
	if (clstSec.count !== clusterCount || instSec.count !== instanceCount) {
		throw new PackageFormatError('foliage block section counts disagree with HEAD');
	}

	let palette: BigUint64Array | undefined;
	let remap: Uint32Array | null = null;
	const plttSec = container.sections.get(TAG_PLTT);
	if (plttSec !== undefined) {
		checkStride(plttSec, 8, 'PLTT');
		const rawPalette =
			(plttSec.data.byteOffset & 7) === 0
				? new BigUint64Array(plttSec.data.buffer, plttSec.data.byteOffset, plttSec.count)
				: new BigUint64Array(plttSec.data.slice(0, plttSec.count * 8).buffer);
		if (chainIndex !== undefined) {
			remap = new Uint32Array(rawPalette.length);
			for (let i = 0; i < rawPalette.length; i++) {
				const globalId = chainIndex.get(rawPalette[i]);
				if (globalId === undefined) {
					throw new PackageFormatError(`foliage block PLTT hash 0x${rawPalette[i].toString(16)} not found`);
				}
				remap[i] = globalId;
			}
		} else {
			palette = rawPalette;
		}
	}

	const cv = viewOf(clstSec.data);
	const clusters: FoliageCluster[] = [];
	for (let i = 0; i < clstSec.count; i++) {
		const at = i * clstSec.stride;
		const rawChain = cv.getUint32(at, true);
		let chain = rawChain;
		if (remap !== null) {
			if (rawChain >= remap.length) {
				throw new PackageFormatError(`foliage cluster ${i} chain ${rawChain} past PLTT`);
			}
			chain = remap[rawChain];
		}
		const firstInstance = cv.getUint32(at + 4, true);
		const count = cv.getUint32(at + 8, true);
		if (firstInstance + count > instanceCount) {
			throw new PackageFormatError(`foliage cluster ${i} runs past INST`);
		}
		clusters.push({
			chain,
			firstInstance,
			instanceCount: count,
			center: [cv.getFloat32(at + 12, true), cv.getFloat32(at + 16, true), cv.getFloat32(at + 20, true)],
			halfExtents: [cv.getFloat32(at + 24, true), cv.getFloat32(at + 28, true), cv.getFloat32(at + 32, true)],
			rendererHalfSize: cv.getFloat32(at + 36, true),
		});
	}

	return {
		origin,
		...(palette !== undefined ? { palette } : {}),
		clusters,
		instances: instSec.data.subarray(0, instanceCount * FOLIAGE_INSTANCE_BYTES),
	};
};
