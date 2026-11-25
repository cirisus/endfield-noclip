import type { ChunkLight } from '@endfield-noclip/formats/endfield/chunk-lights';
import type { ClothGroup } from '@endfield-noclip/formats/endfield/cloth-groups';
import { FoliageGridType } from '@endfield-noclip/formats/endfield/foliage-grids';
import type { RendererDraw, WaterDecal } from '@endfield-noclip/formats/endfield/init-chunk-data';
import { levelTagOf } from '@endfield-noclip/formats/endfield/level-partition';
import type { MonoObject } from '@endfield-noclip/formats/endfield/mono-objects';
import {
	type ChunkReflectionProbe,
	readReflectionProbe,
} from '@endfield-noclip/formats/endfield/reflection-probe';
import type { WaterGlobalBinding, WaterSurface } from '@endfield-noclip/formats/endfield/water';
import type { Aabb } from '@endfield-noclip/formats/unity/values';
import type { ChainDraw } from '@endfield-noclip/package-format/instances';
import { type TileKey, tileAt, tileId } from '@endfield-noclip/package-format/tiles';

import { compareStrings } from '../../compare.ts';
import { collectSceneVolumes, type SceneVolumes } from '../../game/environment.ts';
import type { Visibility } from '../../game/state/scene-control.ts';
import { collectSceneWater, type SceneWater } from '../../game/water/water-source.ts';
import type { ChunkFile, ChunkSource, WorldIndex } from '../../game/world/world-index.ts';
import { VfsGroup } from '../../hg/vfs.ts';
import { orderedPool } from '../../pool.ts';
import { type ChainPlacement, chunkEntityPlacement } from '../instances/chains.ts';
import type { CollectedRow } from '../instances/collector.ts';
import { HLOD_NAME, type HlodCandidates, hlodCandidates, pickHlodTile } from '../instances/hlod-cells.ts';
import { type InstanceInput, rowReach } from '../instances/instances.ts';
import type { SkippedEntityRow } from '../skipped-entities.ts';
import type { PackCache } from '../store/pack-cache.ts';

import { decalPlacement, type PackContent } from './pack-content.ts';

const STATIC_CHUNKS_ENTRY = new URL(import.meta.url);

type CachedDrawSpec =
	| { kind: 'renderer'; draw: RendererDraw }
	| { kind: 'decal'; material: bigint }
	| { kind: 'waterDecal'; mesh: bigint; material: bigint; placement: WaterDecal };

interface CachedChainSpec {
	draws: CachedDrawSpec[];
	placement: ChainPlacement | undefined;
}

type CachedPlacement =
	| {
			kind: 'hlod';
			tag: number;
			key: TileKey;
			tier: number;
			name: string;
			file: number;
			row: InstanceInput;
			visibility: Visibility | null;
	  }
	| {
			kind: 'global';
			tag: number;
			name: string;
			file: number;
			row: InstanceInput;
			visibility: Visibility | null;
	  }
	| {
			kind: 'detail';
			tag: number;
			key: TileKey;
			name: string;
			file: number;
			row: InstanceInput;
			visibility: Visibility | null;
	  }
	| {
			kind: 'conditional';
			tag: number;
			key: TileKey;
			name: string;
			file: number;
			row: InstanceInput;
			visibility: Visibility;
	  }
	| {
			kind: 'foliage';
			/** `true` for grass clusters packed as `.fol` blobs; `false` for tree rows in `.inst` */
			grass: boolean;
			tag: number;
			key: TileKey;
			name: string;
			file: number;
			entityId: number;
			chain: number;
			bounds: Aabb;
			rendererHalfSize: number;
			instances: Float32Array;
			visibility: Visibility | null;
			stateGated: boolean;
	  };

interface StaticChunksMemo {
	hlodNameMatches: number;
	chunkVolumes: SceneVolumes;
	sceneWater: SceneWater;
	clothGroups: ClothGroup[];
	counts: Record<string, number>;
	skipped: SkippedEntityRow[];
	seen: Uint32Array;
	lights: { light: ChunkLight; fileIndex: number }[];
	reflectionProbes: { probe: ChunkReflectionProbe; fileIndex: number }[];
	chains: CachedChainSpec[];
	placements: CachedPlacement[];
	sceneStates: number[];
	areas: number[];
}

// the scene's chunk files: static entities, foliage grids and local lights, filed as
// docs/extraction.md#how-the-packer-files-instances describes

/** reads ahead this many chunk files while decoding the current one */
const READ_AHEAD = 8;

const STATIC_COUNTS = [
	'read',
	'unique',
	'noRenderer',
	'decal',
	'decalSkipped',
	'noMatrix',
	'noBounds',
	'excluded',
	'packed',
	'clothSimulated',
	'foliageGrids',
	'foliageInstances',
];

/** an HLOD cluster entity waiting for its cell */
interface HlodCluster extends CollectedRow {
	tier: number;
	/** the tiles its named cell may be */
	candidates: HlodCandidates;
	/** a conditional set index for clusters of a stream area, else `null` */
	condition: number | null;
}

/** rows of one entity or foliage grid and where it was first met */
interface StaticRows {
	rows: InstanceInput[];
	/** when set, `rows` came from foliage clusters (grass clusters pack into `.fol`, trees into `.inst`) */
	foliageClusters?: {
		grass: boolean;
		chain: number;
		bounds: Aabb;
		rendererHalfSize: number;
		entityId: number;
		instances: Float32Array;
	}[];
	tag: number;
	name: string;
	/** chunk-file index */
	file: number;
	/** from a Global chunk file */
	global: boolean;
	/** an HLOD cluster's name match, or `null` for other renderers */
	hlod: RegExpExecArray | null;
}

/** what {@link collectStaticChunks} produces besides rows filed into {@link PackContent} */
export interface StaticChunkSummary {
	/** how many HLOD clusters' bounds centres lie in the tile they're filed under */
	hlodNameMatches: number;
	/** environment and post-processing volumes of the scene's default-area chunks */
	chunkVolumes: SceneVolumes;
	/** placed water surfaces and global config bindings of the scene's Global chunks */
	sceneWater: SceneWater;
	/** unique cloth simulation groups whose cloths are referenced by packed entities */
	clothGroups: ClothGroup[];
}

/** replays a cached {@link StaticChunksMemo} into an empty {@link PackContent} */
const replayStaticChunks = (content: PackContent, memo: StaticChunksMemo): StaticChunkSummary => {
	const { scene, collector, controls, seen } = content;
	controls.require({ sceneStates: memo.sceneStates, areas: memo.areas });
	for (const [key, value] of Object.entries(memo.counts)) {
		content.count(key, value);
	}
	content.skipped.merge(memo.skipped);
	for (const id of memo.seen) {
		seen.add(id);
	}
	for (const { light, fileIndex } of memo.lights) {
		content.lights.add(light, scene.files[fileIndex]);
	}
	for (const { probe, fileIndex } of memo.reflectionProbes) {
		content.reflectionProbes.add(probe, scene.files[fileIndex]);
	}
	for (const spec of memo.chains) {
		const draws = spec.draws.map((entry): ChainDraw => {
			switch (entry.kind) {
				case 'renderer': {
					return content.rendererDraw(entry.draw);
				}
				case 'decal': {
					return content.decalDraw(entry.material)!;
				}
				case 'waterDecal': {
					return content.waterDecalDraw(entry.mesh, entry.material, entry.placement);
				}
			}
		});
		content.chains.intern(draws, spec.placement);
	}
	for (const item of memo.placements) {
		switch (item.kind) {
			case 'hlod': {
				const condition = item.visibility === null ? null : controls.condition(item.visibility);
				collector.addHlod({
					tag: item.tag,
					row: item.row,
					name: item.name,
					file: item.file,
					tier: item.tier,
					key: item.key,
					condition,
				});
				content.uses.note(item.row.chain, item.key);
				collector.noteOwner(item.tag, rowReach(item.row));
				break;
			}
			case 'global': {
				const condition = item.visibility === null ? null : controls.condition(item.visibility);
				collector.addGlobal({ tag: item.tag, row: item.row, name: item.name, file: item.file, condition });
				content.uses.note(item.row.chain, null);
				collector.noteOwner(item.tag, rowReach(item.row));
				break;
			}
			case 'detail': {
				const condition = item.visibility === null ? null : controls.condition(item.visibility);
				collector.addDetail({
					tag: item.tag,
					row: item.row,
					name: item.name,
					file: item.file,
					key: item.key,
					condition,
				});
				content.uses.note(item.row.chain, item.key);
				collector.noteOwner(item.tag, rowReach(item.row));
				break;
			}
			case 'conditional': {
				collector.addConditional({
					tag: item.tag,
					row: item.row,
					name: item.name,
					file: item.file,
					key: item.key,
					visibility: item.visibility,
					reach: null,
				});
				content.uses.note(item.row.chain, item.key);
				collector.noteOwner(item.tag, rowReach(item.row));
				break;
			}
			case 'foliage': {
				if (item.grass) {
					collector.addFoliage({
						tag: item.tag,
						key: item.key,
						cluster: {
							chain: item.chain,
							bounds: item.bounds,
							rendererHalfSize: item.rendererHalfSize,
							instances: item.instances,
						},
						visibility: item.visibility,
						conditional: item.stateGated && item.visibility !== null,
					});
					content.uses.note(item.chain, item.key);
					collector.noteOwner(item.tag, item.bounds);
					break;
				}
				const condition = item.visibility === null ? null : controls.condition(item.visibility);
				const instanceCount = item.instances.length / 16;
				for (let i = 0; i < instanceCount; i++) {
					const row: InstanceInput = {
						chain: item.chain,
						matrix: item.instances.subarray(i * 16, i * 16 + 16),
						bounds: item.bounds,
						entityId: item.entityId,
					};
					if (item.stateGated && item.visibility !== null) {
						collector.addConditional({
							tag: item.tag,
							row,
							name: item.name,
							file: item.file,
							key: item.key,
							visibility: item.visibility,
							reach: null,
						});
					} else {
						collector.addDetail({
							tag: item.tag,
							row,
							name: item.name,
							file: item.file,
							key: item.key,
							condition,
						});
					}
					content.uses.note(item.chain, item.key);
				}
				collector.noteOwner(item.tag, item.bounds);
				break;
			}
		}
	}
	return {
		hlodNameMatches: memo.hlodNameMatches,
		chunkVolumes: memo.chunkVolumes,
		sceneWater: memo.sceneWater,
		clothGroups: memo.clothGroups,
	};
};

/**
 * reads every chunk file of the scene, in order, and files each entity, foliage instance and light, while
 * collecting chunk environment/post volumes and Global-chunk water in the same pass
 *
 * @param world the world index
 * @param content the pack's content; rows, lights, counts and skipped entities are added
 * @param cache optional pack cache for the scene's static chunk summary
 * @returns HLOD name-match tally, chunk environment volumes and Global-chunk water
 */
export const collectStaticChunks = async (
	world: WorldIndex,
	content: PackContent,
	cache: PackCache | null = null,
): Promise<StaticChunkSummary> => {
	const { scene, collector, controls, seen } = content;
	const { grid, subset } = scene;
	let memoKey: string | null = null;
	if (cache !== null) {
		const streamingHash = (await world.vfs.group(VfsGroup.Streaming)).catalogHash;
		memoKey = await cache.stepKey(STATIC_CHUNKS_ENTRY, {
			kind: 'staticChunks',
			scene: scene.id,
			subset: subset.info,
			streamingHash,
			hlod: scene.hlod,
			grid,
			hasDecalCube: content.decalCubeHash() ?? null,
		});
		const recalled = await cache.recallValue<StaticChunksMemo>(memoKey);
		if (recalled !== undefined) {
			scene.globalChunks.clear();
			return replayStaticChunks(content, recalled);
		}
	}
	// listed in the report even at zero
	for (const key of STATIC_COUNTS) {
		content.count(key, 0);
	}
	const record = memoKey !== null;
	const recordedLights: { light: ChunkLight; fileIndex: number }[] = [];
	const recordedProbes: { probe: ChunkReflectionProbe; fileIndex: number }[] = [];
	const recordedChains: CachedChainSpec[] = [];
	const recordedPlacements: CachedPlacement[] = [];
	const internChain = (specs: CachedDrawSpec[], draws: ChainDraw[], placement?: ChainPlacement): number => {
		const before = content.chains.chains.length;
		const id = content.chains.intern(draws, placement);
		if (record && content.chains.chains.length > before) {
			recordedChains.push({ draws: specs, placement });
		}
		return id;
	};
	// rows of scene-state and stream-area files, by entity or foliage grid id, with every file holding them;
	// added once all files are read
	const gatedRows = new Map<number, StaticRows & { sources: ChunkSource[] }>();
	let hlodNameMatches = 0;
	/** HLOD clusters whose name leaves more than one tile: clamped coordinates, or a misaligned tier */
	const unresolvedHlod: (HlodCluster & { visibility: Visibility | null })[] = [];
	/** bounds of always-loaded detail instances by `tileId/levelTag` */
	const detailBounds = new Map<string, Aabb[]>();
	const volumeFiles: { file: ChunkFile; objects: readonly MonoObject[] }[] = [];
	const waterFiles: {
		file: ChunkFile;
		surfaces: readonly WaterSurface[];
		globals: readonly WaterGlobalBinding[];
	}[] = [];
	const allClothGroups = new Map<number, ClothGroup>();
	const usedClothHashes = new Set<number>();

	const addHlod = (cluster: HlodCluster & { visibility: Visibility | null }, key: TileKey): void => {
		const [x, , z] = cluster.row.bounds.center;
		const at = tileAt(grid, key.level, x, z);
		if (at.x === key.x && at.z === key.z) {
			hlodNameMatches++;
		}
		collector.addHlod({ ...cluster, key });
		content.uses.note(cluster.row.chain, key);
		if (record) {
			recordedPlacements.push({
				kind: 'hlod',
				tag: cluster.tag,
				key,
				tier: cluster.tier,
				name: cluster.name,
				file: cluster.file,
				row: cluster.row,
				visibility: cluster.visibility,
			});
		}
	};

	/** sends a row to its destination: HLOD node, Global block, detail leaf or conditional leaf */
	const addRow = (
		{ row, tag, name, file, global, hlod }: Omit<StaticRows, 'rows'> & { row: InstanceInput },
		/** when it loads, `null` for always */
		visibility: Visibility | null,
		/** whether a scene state gates it, so no HLOD stands in for it */
		stateGated: boolean,
		/** false for foliage rows, which are recorded per cluster instead */
		recordRow = true,
	): void => {
		const entry = { tag, row, name, file };
		const condition = visibility === null ? null : controls.condition(visibility);
		if (hlod !== null && !stateGated) {
			const tier = Number(hlod[1]);
			const candidates = hlodCandidates({
				tree: grid,
				layout: scene.hlod,
				sample: { tier, x: Number(hlod[2]), z: Number(hlod[3]) },
				bounds: row.bounds,
			});
			const cluster = { ...entry, tier, candidates, condition, visibility };
			if (candidates.x[0] === candidates.x[1] && candidates.z[0] === candidates.z[1]) {
				addHlod(cluster, { level: candidates.level, x: candidates.x[0], z: candidates.z[0] });
			} else {
				// resolved once every detail instance is known
				unresolvedHlod.push(cluster);
			}
			return;
		}
		if (global) {
			collector.addGlobal({ ...entry, condition });
			content.uses.note(row.chain, null);
			if (record && recordRow) {
				recordedPlacements.push({ kind: 'global', tag, name, file, row, visibility });
			}
			return;
		}
		const key = tileAt(grid, grid.leafLevel, row.bounds.center[0], row.bounds.center[2]);
		if (stateGated && visibility !== null) {
			collector.addConditional({ ...entry, key, visibility, reach: null });
			if (record && recordRow) {
				recordedPlacements.push({ kind: 'conditional', tag, key, name, file, row, visibility });
			}
		} else {
			collector.addDetail({ ...entry, condition, key });
			detailBounds.getOrInsertComputed(`${tileId(key)}/${tag}`, () => []).push(row.bounds);
			if (record && recordRow) {
				recordedPlacements.push({ kind: 'detail', tag, key, name, file, row, visibility });
			}
		}
		content.uses.note(row.chain, key);
	};

	const emitRows = (rows: StaticRows, visibility: Visibility | null, stateGated: boolean): void => {
		if (rows.foliageClusters !== undefined) {
			for (const cluster of rows.foliageClusters) {
				const key = tileAt(grid, grid.leafLevel, cluster.bounds.center[0], cluster.bounds.center[2]);
				if (cluster.grass) {
					collector.addFoliage({
						tag: rows.tag,
						key,
						cluster: {
							chain: cluster.chain,
							bounds: cluster.bounds,
							rendererHalfSize: cluster.rendererHalfSize,
							instances: cluster.instances,
						},
						visibility,
						conditional: stateGated && visibility !== null,
					});
					if (!stateGated) {
						detailBounds.getOrInsertComputed(`${tileId(key)}/${rows.tag}`, () => []).push(cluster.bounds);
					}
					content.uses.note(cluster.chain, key);
				}
				if (record) {
					recordedPlacements.push({
						kind: 'foliage',
						grass: cluster.grass,
						tag: rows.tag,
						key,
						name: rows.name,
						file: rows.file,
						entityId: cluster.entityId,
						chain: cluster.chain,
						bounds: cluster.bounds,
						rendererHalfSize: cluster.rendererHalfSize,
						instances: cluster.instances,
						visibility,
						stateGated,
					});
				}
			}
			for (const row of rows.rows) {
				addRow({ ...rows, row }, visibility, stateGated, false);
			}
			return;
		}
		for (const row of rows.rows) {
			addRow({ ...rows, row }, visibility, stateGated, true);
		}
	};

	/** files rows met first in `file`, or holds them back when the file is gated */
	const place = (id: number, rows: StaticRows, file: ChunkSource): void => {
		if (file.sceneState !== 0 || file.area !== 0) {
			gatedRows.set(id, { ...rows, sources: [file] });
			return;
		}
		emitRows(rows, null, false);
	};

	// files are settled in order, for a deterministic dedupe
	await orderedPool(
		scene.files,
		READ_AHEAD + 1,
		async (file) => {
			const cached = scene.globalChunks.get(file.name);
			if (cached !== undefined) {
				scene.globalChunks.delete(file.name);
				return cached;
			}
			return world.readChunkContent(file, scene.partition);
		},
		(read, file, fileIndex) => {
			if (read instanceof Error) {
				throw read;
			}
			if (read.monoObjects.length > 0) {
				volumeFiles.push({ file, objects: read.monoObjects });
				for (const object of read.monoObjects) {
					const probe = readReflectionProbe(object);
					if (probe !== undefined && subset.includesPoint(levelTagOf(probe.id), probe.center)) {
						content.reflectionProbes.add(probe, file);
						if (record) {
							recordedProbes.push({ probe, fileIndex });
						}
					}
				}
			}
			if (read.waterSurfaces.length > 0 || read.waterGlobals.length > 0) {
				waterFiles.push({ file, surfaces: read.waterSurfaces, globals: read.waterGlobals });
			}
			for (const light of read.lights) {
				if (subset.includesPoint(light.levelTag, light.position)) {
					content.lights.add(light, file);
					if (record) {
						recordedLights.push({ light, fileIndex });
					}
				}
			}
			/** @returns whether the entity or grid was met before, adding the file to its sources if so */
			const repeat = (id: number): boolean => {
				if (!seen.has(id)) {
					seen.add(id);
					return false;
				}
				gatedRows.get(id)?.sources.push(file);
				return true;
			};
			for (const entity of read.entities) {
				content.count('read');
				if (repeat(entity.id)) {
					continue;
				}
				content.count('unique');
				const { renderer } = entity;
				/** decal / WaterDecal hashes to intern once the entity is known to pack */
				let decalSpec: CachedDrawSpec | null = null;
				if (entity.decal !== null) {
					const material = read.decalMaterials.get(entity.id);
					if (material === undefined || content.decalCubeHash() === undefined) {
						content.count('decalSkipped');
						content.skipped.add('static', decalSkipReason(material), entity);
						continue;
					}
					decalSpec = { kind: 'decal', material };
					content.count('decal');
				} else if (entity.waterDecal !== null) {
					const material = read.decalMaterials.get(entity.id);
					const mesh = read.waterDecalMeshes.get(entity.id);
					if (material === undefined || mesh === undefined) {
						content.count('waterDecalSkipped');
						content.skipped.add('static', 'water decal without its mesh or material', entity);
						continue;
					}
					decalSpec = { kind: 'waterDecal', mesh, material, placement: entity.waterDecal };
					content.count('waterDecal');
				} else if (renderer === null) {
					content.count('noRenderer');
					content.skipped.add('static', 'no renderer', entity);
					continue;
				}
				if (entity.matrix === null) {
					content.count('noMatrix');
					content.skipped.add('static', 'no matrix', entity);
					continue;
				}
				// without bounds a row can't be filed, culled or sized for LOD
				if (entity.bounds === null) {
					content.count('noBounds');
					content.skipped.add('static', 'no bounds', entity);
					continue;
				}
				if (!subset.includesPoint(entity.levelTag, entity.bounds.center)) {
					content.count('excluded');
					continue;
				}
				content.count('packed');
				if (entity.clothHash !== null) {
					content.count('clothSimulated');
					usedClothHashes.add(entity.clothHash);
				}
				let draws: ChainDraw[] = [];
				let drawSpecs: CachedDrawSpec[] = [];
				if (renderer !== null) {
					draws = renderer.draws.map((draw) => content.rendererDraw(draw));
					if (record) {
						drawSpecs = renderer.draws.map((draw) => ({ kind: 'renderer', draw }));
					}
				} else if (decalSpec !== null) {
					draws = [
						decalSpec.kind === 'decal'
							? content.decalDraw(decalSpec.material)!
							: content.waterDecalDraw(decalSpec.mesh, decalSpec.material, decalSpec.placement),
					];
					drawSpecs = [decalSpec];
				}
				const placement = chunkEntityPlacement({ ...entity, matrix: entity.matrix });
				const row: InstanceInput = {
					chain: internChain(drawSpecs, draws, placement),
					matrix: entity.matrix,
					bounds: entity.bounds,
					entityId: entity.id,
				};
				if (entity.decal !== null) {
					row.decalPlacement = decalPlacement(entity.decal);
				}
				if (entity.rotator !== null) {
					row.spin = entity.rotator;
				}
				if (entity.clothHash !== null) {
					row.clothHash = entity.clothHash;
				}
				place(
					entity.id,
					{
						rows: [row],
						tag: entity.levelTag,
						name: entity.name,
						file: fileIndex,
						global: file.cell === null,
						// an entity named as a cluster that nothing links to is never hidden: plain scenery
						hlod: read.hlodClusters.has(entity.id) ? HLOD_NAME.exec(entity.name) : null,
					},
					file,
				);
				collector.noteOwner(entity.levelTag, rowReach(row));
			}
			for (const group of read.clothGroups) {
				if (!allClothGroups.has(group.groupHash)) {
					allClothGroups.set(group.groupHash, group);
				}
			}
			for (const foliage of read.foliage) {
				if (repeat(foliage.id)) {
					continue;
				}
				content.count('foliageGrids');
				const isGrass = foliage.type === FoliageGridType.Grass;
				// grass clusters pack into compact `.fol` blobs; tree grids stay in `.inst`
				const rows: InstanceInput[] = [];
				const foliageClusters: NonNullable<StaticRows['foliageClusters']> = [];
				let instanceTotal = 0;
				for (const cluster of foliage.clusters) {
					if (!subset.includesPoint(foliage.levelTag, cluster.bounds.center)) {
						continue;
					}
					const draws = cluster.renderer.draws.map((draw) => content.rendererDraw(draw));
					const specs: CachedDrawSpec[] = record
						? cluster.renderer.draws.map((draw) => ({ kind: 'renderer', draw }))
						: [];
					const chain = internChain(specs, draws);
					instanceTotal += cluster.instanceCount;
					if (!isGrass) {
						for (let i = 0; i < cluster.instanceCount; i++) {
							const matrix = cluster.instances.subarray(i * 16, i * 16 + 16);
							rows.push({ chain, matrix, bounds: cluster.bounds, entityId: foliage.id });
						}
					}
					if ((isGrass || record) && cluster.instanceCount > 0) {
						foliageClusters.push({
							grass: isGrass,
							chain,
							bounds: cluster.bounds,
							rendererHalfSize: cluster.rendererHalfSize,
							entityId: foliage.id,
							instances: cluster.instances.subarray(0, cluster.instanceCount * 16),
						});
					}
					collector.noteOwner(foliage.levelTag, cluster.bounds);
				}
				content.count('foliageInstances', instanceTotal);
				place(
					foliage.id,
					{
						rows,
						foliageClusters: isGrass || record ? foliageClusters : undefined,
						tag: foliage.levelTag,
						name: foliage.name,
						file: fileIndex,
						global: false,
						hlod: null,
					},
					file,
				);
			}
		},
	);
	content.count('gatedRenderers', gatedRows.size);
	const requiredSceneStates = new Set<number>();
	const requiredAreas = new Set<number>();
	for (const { sources, ...rows } of gatedRows.values()) {
		const visibility = controls.sourceVisibility(sources);
		if (visibility !== null) {
			for (const { sceneState, area } of sources) {
				if (sceneState !== 0) {
					requiredSceneStates.add(sceneState - 1);
				}
				if (area !== 0) {
					requiredAreas.add(area);
				}
			}
		}
		// HLOD clusters stand in for the rows of their own area, so area-only content keeps HLOD refinement;
		// scene-state content has no HLODs and streams as conditional detail
		const stateGated = visibility !== null && sources.some((source) => source.sceneState !== 0);
		emitRows(rows, visibility, stateGated);
	}
	for (const cluster of unresolvedHlod) {
		const key = pickHlodTile({
			tree: grid,
			leafLevel: grid.leafLevel,
			candidates: cluster.candidates,
			bounds: cluster.row.bounds,
			detailAt: (leaf) => detailBounds.get(`${tileId(leaf)}/${cluster.tag}`) ?? [],
		});
		addHlod(cluster, key);
	}
	volumeFiles.sort(byFileName);
	waterFiles.sort(byFileName);
	const chunkVolumes = collectSceneVolumes(volumeFiles);
	const sceneWater = collectSceneWater(waterFiles);
	const clothGroups = [...allClothGroups.values()].filter((group) =>
		group.cloths.some((cloth) => usedClothHashes.has(cloth.hash)),
	);
	if (memoKey !== null && cache !== null) {
		await cache.rememberValue(memoKey, {
			hlodNameMatches,
			chunkVolumes,
			sceneWater,
			clothGroups,
			counts: { ...content.counts },
			skipped: content.skipped.rows(),
			seen: Uint32Array.from(seen),
			lights: recordedLights,
			reflectionProbes: recordedProbes,
			chains: recordedChains,
			placements: recordedPlacements,
			sceneStates: [...requiredSceneStates],
			areas: [...requiredAreas],
		} satisfies StaticChunksMemo);
	}
	return { hlodNameMatches, chunkVolumes, sceneWater, clothGroups };
};

const byFileName = (a: { file: ChunkFile }, b: { file: ChunkFile }): number =>
	compareStrings(a.file.name, b.file.name);

/** @returns why a rect decal makes no row: no material, or no decal cube in the install */
export const decalSkipReason = (material: bigint | null | undefined): string =>
	material == null ? 'rect decal without a material' : 'no decal cube mesh';
