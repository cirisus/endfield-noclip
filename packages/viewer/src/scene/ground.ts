/**
 * height queries over the loaded package's coarse terrain and scenery bounds, for placing the camera.
 *
 * @module
 */

import {
	isTerrainHole,
	TERRAIN_PAGE_SAMPLES,
	type TerrainInfo,
	terrainHeight,
} from '@endfield-noclip/package-format/terrain';
import { tileAt, tileId } from '@endfield-noclip/package-format/tiles';
import type { TreeInfo } from '@endfield-noclip/package-format/tree';

import type { TileTree } from './tile-tree.ts';

/** where the tile grid lies, and which level holds the cells */
export type TreeFrame = Pick<TreeInfo, 'origin' | 'rootSize' | 'cellLevel'>;

/** what the queries read */
export interface GroundSource {
	manifest: { tree: TreeFrame; terrain: TerrainInfo | null };
	tree: Pick<TileTree, 'byId' | 'terrainLeafLevel' | 'terrainRootLevel'>;
	/**
	 * @param blob a height page's blob
	 * @returns its samples, `null` while they aren't resident on the CPU
	 */
	heights: (blob: number) => Uint16Array | null;
}

/**
 * @param ground the package
 * @param x world x
 * @param z world z
 * @returns the top of the scenery in the cell over the point, or -∞ where there's none
 */
export const sceneryTop = (ground: GroundSource, x: number, z: number): number => {
	const info = ground.manifest.tree;
	const cell = ground.tree.byId.get(tileId(tileAt(info, info.cellLevel, x, z)));
	return cell?.bounds.max[1] ?? -Infinity;
};

/**
 * @param ground the package
 * @param x world x
 * @param z world z
 * @returns terrain height from the finest resident page over the point, `null` off the terrain or over a
 *   hole, or `undefined` while no page covering the point is resident yet
 */
export const groundHeight = (ground: GroundSource, x: number, z: number): number | null | undefined => {
	const { manifest, tree } = ground;
	const terrain = manifest.terrain;
	if (terrain === null) {
		return null;
	}
	const info = manifest.tree;
	let covered = false;
	for (let level = tree.terrainLeafLevel; level >= tree.terrainRootLevel; level--) {
		const node = tree.byId.get(tileId(tileAt(info, level, x, z)));
		const blob = node?.terrain?.blob;
		covered ||= blob !== undefined;
		const samples = blob === undefined ? null : ground.heights(blob);
		if (node === undefined || samples === null) {
			continue;
		}
		const side = TERRAIN_PAGE_SAMPLES;
		const spacing = node.size / (side - 1);
		const fx = Math.min(side - 1, Math.max(0, (x - node.minX) / spacing));
		const fz = Math.min(side - 1, Math.max(0, (z - node.minZ) / spacing));
		const sample = samples[Math.round(fz) * side + Math.round(fx)];
		return isTerrainHole(sample) ? null : terrainHeight(terrain, sample);
	}
	return covered ? undefined : null;
};
