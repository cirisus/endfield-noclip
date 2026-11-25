/**
 * expands a decoded `.fol` {@link FoliageBlock} into the viewer's GPU {@link InstanceRows} layout so foliage
 * clusters stream, GPU-cull, and draw through the same instanced mesh pipeline as `.inst` blocks.
 *
 * @module
 */

import {
	FOLIAGE_INSTANCE_BYTES,
	type FoliageBlock,
	unpackFoliageInstance,
} from '@endfield-noclip/package-format/foliage';
import { RowFlags } from '@endfield-noclip/package-format/instances';

import { CULL_FLOATS, type InstanceRows, ROW_WORDS, RowKind, RowWord } from './instance-rows.ts';

const ROW_WHITE = 0xffff_ffff;
const f32Bits = new Float32Array(1);
const u32Bits = new Uint32Array(f32Bits.buffer);

/**
 * unpacks a decoded {@link FoliageBlock}'s clusters into {@link InstanceRows} and pre-baked {@link RowFlags}
 *
 * @param block decoded foliage cluster block (with global chain indices)
 * @returns GPU-ready instance rows and per-row handedness flags for `buildRowBounds`
 */
export const buildFoliageRows = (block: FoliageBlock): { built: InstanceRows; rowFlags: Uint8Array } => {
	let count = 0;
	let nonEmpty = 0;
	for (const cluster of block.clusters) {
		if (cluster.instanceCount > 0) {
			count += cluster.instanceCount;
			nonEmpty++;
		}
	}
	const rows = new Uint32Array(count * ROW_WORDS);
	const f32 = new Float32Array(rows.buffer);
	const cull = new Float32Array(count * CULL_FLOATS);
	const rowFlags = new Uint8Array(count);
	const foliageClusters = new Uint32Array(nonEmpty * 3);
	const runs: number[] = [];

	let outRow = 0;
	let clusterOut = 0;
	for (const cluster of block.clusters) {
		if (cluster.instanceCount === 0) {
			continue;
		}
		f32Bits[0] = cluster.sparsity ?? 1;
		foliageClusters[clusterOut] = outRow;
		foliageClusters[clusterOut + 1] = cluster.instanceCount;
		foliageClusters[clusterOut + 2] = u32Bits[0];
		clusterOut += 3;
		// coalesce consecutive clusters sharing a chain into one run
		if (runs.length >= 3 && runs[runs.length - 3] === cluster.chain) {
			runs[runs.length - 1] += cluster.instanceCount;
		} else {
			runs.push(cluster.chain, outRow, cluster.instanceCount);
		}
		const [cx, cy, cz] = cluster.center;
		const [ex, ey, ez] = cluster.halfExtents;
		const radius = Math.sqrt(ex * ex + ey * ey + ez * ez);
		const maxExtent = Math.max(ex, ey, ez);

		for (let k = 0; k < cluster.instanceCount; k++) {
			const at = outRow * ROW_WORDS;
			const mirrored = unpackFoliageInstance(
				block.instances,
				(cluster.firstInstance + k) * FOLIAGE_INSTANCE_BYTES,
				cluster.center,
				cluster.halfExtents,
				f32,
				at,
			);
			if (mirrored) {
				rowFlags[outRow] = RowFlags.Mirrored;
			}
			f32[at + 12] = cx;
			f32[at + 13] = cy;
			f32[at + 14] = cz;
			f32[at + 16] = ex;
			f32[at + 17] = ey;
			f32[at + 18] = ez;
			rows[at + RowWord.info] = RowKind.Detail;
			rows[at + RowWord.color] = ROW_WHITE;
			cull[outRow * CULL_FLOATS] = radius;
			cull[outRow * CULL_FLOATS + 1] = maxExtent;
			outRow++;
		}
	}

	return {
		built: {
			count,
			origin: block.origin,
			rows,
			cull,
			runs: new Uint32Array(runs),
			placements: new Float32Array(0),
			spins: null,
			floaters: null,
			rides: null,
			cloths: null,
			foliageClusters,
		},
		rowFlags,
	};
};
