import { readFile } from 'node:fs/promises';
import { basename } from 'node:path/posix';
import { parseArgs } from 'node:util';

import { LightType, readChunkLights, type ChunkLight } from '@endfield-noclip/formats/endfield/chunk-lights';
import type { EnvironmentVolume } from '@endfield-noclip/formats/endfield/environment-volume';
import {
	parseInitChunk,
	StreamingLayer,
	type ChunkEntity,
} from '@endfield-noclip/formats/endfield/init-chunk-data';
import {
	cellKey,
	levelOfTag,
	voteLevelTags,
	type LevelPartition,
} from '@endfield-noclip/formats/endfield/level-partition';
import { CELL_SIZE } from '@endfield-noclip/formats/endfield/map-config';
import type { Aabb } from '@endfield-noclip/formats/unity/values';
import { ruleText } from '@endfield-noclip/package-format/conditions';
import { compareVolumes, distanceInsideVolume } from '@endfield-noclip/package-format/environment-volumes';

import { mapDefined } from '@mary-ext/array-fns';

import {
	DEFAULT_OUT,
	hashText,
	jsonReplacer,
	need as needArg,
	parseNumbers,
	parseOptionalInteger,
	separatePositionals,
} from '../cli-args.ts';
import { compareNatural, compareStrings } from '../compare.ts';
import { type Context, withContext } from '../context.ts';
import { errorText, ignoreMissing } from '../errors.ts';
import type { StructureModel } from '../game/dynamic/dynamic-structures.ts';
import {
	environmentBlend,
	environmentVolumeShape,
	loadLevelPhases,
	loadSceneVolumes,
	resolveLevelEnvironment,
	resolveLevelPost,
	scenePhaseLoader,
	type SceneEnvironmentVolume,
} from '../game/environment.ts';
import {
	boxDistance,
	describeAlternatives,
	parsePlacementKinds,
	PLACEMENT_KINDS,
	type PlacementKind,
} from '../game/placements.ts';
import { sourceVisibility } from '../game/state/chunk-sources.ts';
import { GameState } from '../game/state/game-state.ts';
import {
	defaultSceneStates,
	loadMapVariables,
	loadSceneStates,
	sceneStateControl,
} from '../game/state/scene-conditions.ts';
import { loadSceneryVariants } from '../game/state/scenery-variants.ts';
import { loadUpgradeLinks } from '../game/state/settlement-upgrades.ts';
import { stripMarkup } from '../game/state/story.ts';
import { readSceneWater } from '../game/water/water-source.ts';
import { readWaterVolumes } from '../game/water/water-volumes.ts';
import { loadDungeonUses, readOperatorNames } from '../game/world/dungeons.ts';
import { indexTerrain } from '../game/world/terrain-source.ts';
import { type ChunkFile, type IndexedEntity, pivotOf, type WorldIndex } from '../game/world/world-index.ts';
import { DEBUG_DIR, STAND_INS_FILE, type StandInReport } from '../pack/debug.ts';
import { type ScenePlacementSurvey, surveyPlacedVolumes, surveyPlacements } from '../pack/survey.ts';
import { mapPool } from '../pool.ts';

export const summary = 'browse scenes, levels, controls, environments, and everything placed near a point';

/** command usage, available without opening the install */
export const usage = `usage:
  scene list [--dungeons] [--category re] [--json]
                                           streaming scenes (with terrain/level counts), or dungeon entries
  scene levels <map> [--verify]            levels with tag, cells and names; --verify votes tags against cells
  scene find <scene> [--name re] [--near x,y,z --radius n] [--kind k,…] [--max-size n] [--no-hlod]
      [--scene-state n] [--area n] [--limit n] [--json]
                                           everything placed in a scene: static, dynamic, model, effect,
                                           facility, cabin, light, water, env (default all)
                                           --near: Unity coordinates, nearest then smallest first; annotates
                                           stand-ins from out/<scene>/debug/stand-ins.json
                                           --max-size drops bounds longer than n m; --no-hlod drops HLOD layers
  scene env <map|level> [--at x,y,z] [--json]
                                           base environment per level, or with --at the volume stack at a point
  scene controls <scene> [--json]          scene states, stream areas and progression controllers`;

const OPTIONS = {
	config: { type: 'string' },
	dungeons: { type: 'boolean', default: false },
	category: { type: 'string' },
	verify: { type: 'boolean', default: false },
	'scene-state': { type: 'string' },
	area: { type: 'string' },
	name: { type: 'string' },
	near: { type: 'string' },
	radius: { type: 'string' },
	kind: { type: 'string' },
	'max-size': { type: 'string' },
	'no-hlod': { type: 'boolean', default: false },
	at: { type: 'string' },
	limit: { type: 'string' },
	json: { type: 'boolean', default: false },
} as const;

export const run = async (args: string[]): Promise<void> => {
	const { values, positionals } = parseArgs({
		args: separatePositionals(args, OPTIONS),
		allowPositionals: true,
		options: OPTIONS,
	});
	const [sub, target] = positionals;

	await withContext(values.config, async (context) => {
		switch (sub) {
			case 'list': {
				if (values.dungeons) {
					await listDungeons(context, {
						category: values.category === undefined ? undefined : new RegExp(values.category, 'i'),
						json: values.json,
					});
				} else {
					await listScenes(context, values.json);
				}
				break;
			}
			case 'levels': {
				await listLevels(context.world, needArg(target, 'map', usage), values.verify);
				break;
			}
			case 'find': {
				const near = values.near === undefined ? undefined : parseNumbers(values.near, 3, '--near');
				const radius =
					values.radius === undefined ? undefined : parseNumbers(values.radius, 1, '--radius')[0];
				if ((near === undefined) !== (radius === undefined) || (radius !== undefined && radius < 0)) {
					throw new Error('use --near x,y,z with --radius n (nonnegative)');
				}
				await findPlacements(context, needArg(target, 'scene', usage), {
					pattern: values.name === undefined ? undefined : new RegExp(values.name, 'i'),
					near,
					radius,
					kinds: values.kind === undefined ? new Set(PLACEMENT_KINDS) : parsePlacementKinds(values.kind),
					maxSize:
						values['max-size'] === undefined
							? undefined
							: parseNumbers(values['max-size'], 1, '--max-size')[0],
					noHlod: values['no-hlod'],
					limit: searchLimit(values.limit),
					json: values.json,
					sceneState: parseOptionalInteger(values['scene-state'], '--scene-state'),
					area: parseOptionalInteger(values.area, '--area'),
				});
				break;
			}
			case 'env': {
				const at = values.at === undefined ? undefined : parseNumbers(values.at, 3, '--at');
				await showEnvironment(context, needArg(target, 'map or level', usage), at, values.json);
				break;
			}
			case 'controls': {
				await showControls(context, needArg(target, 'scene', usage), values.json);
				break;
			}
			default: {
				throw new Error(usage);
			}
		}
	});
};

const searchLimit = (text: string | undefined): number => {
	const limit = parseOptionalInteger(text, '--limit') ?? 100;
	if (limit < 1) {
		throw new Error('--limit must be a positive integer');
	}
	return limit;
};

const requirePartition = async (world: WorldIndex, mapId: string): Promise<LevelPartition> => {
	const partition = await world.partition(mapId);
	if (partition === undefined) {
		throw new Error(`${mapId} has no MapConfig, so it has no level partition`);
	}
	return partition;
};

const findLevel = async (world: WorldIndex, levelId: string) => {
	const mapId = (await world.levelConfigs()).get(levelId)?.mapId;
	if (!mapId) {
		throw new Error(`${levelId} has no LevelConfig`);
	}
	const partition = await requirePartition(world, mapId);
	const level = partition.levels.find((candidate) => candidate.id === levelId);
	if (level === undefined) {
		throw new Error(`${levelId} owns no cells of ${mapId}'s grid`);
	}
	return { partition, level };
};

// #region list & levels

const listScenes = async (context: Context, json: boolean): Promise<void> => {
	const { world, vfs } = context;
	const [names, files, scenes, terrain] = await Promise.all([
		world.names(),
		world.chunkFiles(),
		world.scenes(),
		indexTerrain(vfs),
	]);
	const partitions = await Promise.all(scenes.map((scene) => world.partition(scene)));
	const rows = scenes.map((scene, i) => {
		const chunks = files.filter((file) => file.scene === scene).length;
		const partition = partitions[i];
		const terrainTiles = terrain.get(scene)?.tiles.size ?? 0;
		return {
			scene,
			chunks,
			levels: partition?.levels.length ?? 0,
			grid: partition?.map.sideGridNum ?? null,
			terrainTiles,
			name: names.get(scene) ?? null,
		};
	});
	if (json) {
		console.log(JSON.stringify(rows, null, '\t'));
		return;
	}
	for (const row of rows) {
		const levels = row.grid === null ? '' : `${row.levels} levels, ${row.grid}² grid`;
		const tiles = row.terrainTiles === 0 ? '' : `${row.terrainTiles} terrain`;
		console.log(
			`${row.scene.padEnd(20)} ${String(row.chunks).padStart(6)} chunks  ${levels.padEnd(22)} ${tiles.padEnd(14)} ${row.name ?? ''}`,
		);
	}
};

const listDungeons = async (
	context: Context,
	options: { category: RegExp | undefined; json: boolean },
): Promise<void> => {
	const { vfs, world } = context;
	const [uses, levelNames, operators, text] = await Promise.all([
		loadDungeonUses(context),
		world.names(),
		world.englishText().then((english) => readOperatorNames(vfs, english)),
		world.text(),
	]);
	const missionName = (key: string | null): string | null => {
		const value = key === null ? undefined : text(key);
		return value === undefined ? null : stripMarkup(value);
	};
	const rows = uses
		.filter(({ dungeon }) => options.category === undefined || options.category.test(dungeon.category ?? ''))
		.map(({ dungeon, scene, charId, missions }) => ({
			id: dungeon.id,
			name: dungeon.name ?? (dungeon.levelId === null ? null : levelNames.get(dungeon.levelId)) ?? null,
			category: dungeon.category,
			level: dungeon.levelId,
			scene,
			charId,
			operator: charId === null ? null : (operators.get(charId) ?? null),
			missions: missions.map((mission) => ({ id: mission.id, name: missionName(mission.nameKey) })),
		}));
	rows.sort((a, b) => compareNatural(a.level ?? '', b.level ?? '') || compareStrings(a.id, b.id));
	if (options.json) {
		console.log(JSON.stringify(rows, null, '\t'));
		return;
	}
	console.log(
		'level                  scene                  category                dungeon                         operator          missions',
	);
	for (const row of rows) {
		let scene = row.scene ?? '-';
		if (row.level !== null && row.scene === row.level) {
			scene = '=';
		} else if (row.level !== null && row.scene === null) {
			scene = '(not shipped)';
		}
		const missions =
			row.missions
				.map((mission) => (mission.name ? `${mission.id} ${mission.name}` : mission.id))
				.join(', ') || '-';
		console.log(
			`${(row.level ?? '-').padEnd(22)} ${scene.padEnd(22)} ${(row.category ?? '-').padEnd(23)} ${row.id.padEnd(31)} ${(row.operator ?? '-').padEnd(17)} ${missions}`,
		);
	}
	const unreached = rows.filter((row) => row.missions.length === 0).length;
	console.error(
		`${rows.length} dungeon entries, ${unreached} named by no mission; scene '=' is the level's own`,
	);
};

const listLevels = async (world: WorldIndex, mapId: string, verify: boolean): Promise<void> => {
	const partition = await requirePartition(world, mapId);
	const names = await world.names();
	console.log('tag  level          idNum  cells  rect (x,z min → max)          init pos             name');
	for (const level of partition.levels) {
		const { config } = level;
		const rect = `${config.rectLeftBottom.join(',')} → ${config.rectRightTop.join(',')}`;
		const init = config.playerInitPos.map((v) => Math.round(v)).join(',');
		console.log(
			`${String(level.tag).padStart(3)}  ${level.id.padEnd(14)} ${String(level.idNum).padStart(5)}  ${String(level.cells.size).padStart(5)}  ${rect.padEnd(28)}  ${init.padEnd(19)}  ${names.get(level.id) ?? ''}`,
		);
	}
	const owned = partition.map.levelIds.filter((id) => id !== 0).length;
	console.log(`\n${owned} of ${partition.map.levelIds.length} grid cells owned by a level`);
	for (const issue of partition.issues) {
		console.log(`issue: ${issue.level}: ${issue.message}`);
	}
	if (partition.issues.length === 0) {
		console.log('MapConfig grid and LevelConfig levelGrids agree exactly');
	}
	if (verify) {
		const samples: { tag: number; x: number; z: number }[] = [];
		for await (const entity of world.sceneEntities(
			mapId,
			(file) => file.cell !== null && file.sceneState === 0,
		)) {
			if (entity.pivot !== null) {
				samples.push({ tag: entity.id >>> 27, x: entity.pivot.x, z: entity.pivot.z });
			}
		}
		console.log('\ntag  rule level      majority cell owner  share   entities');
		for (const vote of voteLevelTags(partition, samples)) {
			const flag = vote.rule === null || vote.rule === vote.majority ? '' : '  MISMATCH';
			console.log(
				`${String(vote.tag).padStart(3)}  ${(vote.rule ?? '-').padEnd(14)} ${(vote.majority ?? '-').padEnd(20)} ${(vote.share * 100).toFixed(1).padStart(5)}%  ${String(vote.count).padStart(8)}${flag}`,
			);
		}
	}
};

// #endregion

// #region find

interface FoundRow {
	kind: PlacementKind;
	name: string;
	position: [number, number, number] | null;
	distance: number | null;
	size: number | null;
	level: string | null;
	visibility: string;
	source: string;
	summary: string;
	standIns: string[];
	json: object;
}

interface FindOptions {
	pattern: RegExp | undefined;
	near: number[] | undefined;
	radius: number | undefined;
	kinds: Set<PlacementKind>;
	maxSize: number | undefined;
	noHlod: boolean;
	limit: number;
	json: boolean;
	sceneState: number | undefined;
	area: number | undefined;
}

interface FoundCandidate {
	bounds: Aabb | null;
	position: readonly number[] | null;
	/** optional override for distance/size (used for non-AABB environment volumes) */
	customMeasure?: () => { distance: number | null; size: number | null } | undefined;
	labels: () => readonly string[];
	row: (distance: number | null) => Omit<FoundRow, 'distance' | 'size'>;
}

interface AssetNames {
	pathOf: (hash: bigint) => string | undefined;
	assetPathOf: (hash: bigint) => string | undefined;
	bundleOf: (hash: bigint) => string | null;
}

interface FindLookups {
	partition: LevelPartition | undefined;
	names: AssetNames;
	standIns: StandInIndex;
	levelOf: (tag: number) => string | null;
}

class FoundRows {
	readonly #options: Pick<FindOptions, 'pattern' | 'near' | 'radius' | 'maxSize' | 'limit'>;
	readonly #rows: FoundRow[] = [];

	constructor(options: FindOptions) {
		this.#options = options;
	}

	get length(): number {
		return this.#rows.length;
	}

	get full(): boolean {
		return this.#options.near === undefined && this.#rows.length >= this.#options.limit;
	}

	accepts(candidate: FoundCandidate): boolean {
		const { pattern } = this.#options;
		const place = this.#measure(candidate);
		return (
			place !== undefined &&
			(pattern === undefined || candidate.labels().some((label) => pattern.test(label)))
		);
	}

	add(candidate: FoundCandidate): void {
		const { pattern } = this.#options;
		const place = this.#measure(candidate);
		if (
			place === undefined ||
			(pattern !== undefined && !candidate.labels().some((label) => pattern.test(label)))
		) {
			return;
		}
		this.#rows.push({ ...candidate.row(place.distance), ...place });
	}

	shown(): FoundRow[] {
		const rows =
			this.#options.near === undefined
				? this.#rows
				: this.#rows.toSorted(
						(a, b) => (a.distance ?? 0) - (b.distance ?? 0) || (a.size ?? 0) - (b.size ?? 0),
					);
		return rows.slice(0, this.#options.limit);
	}

	#measure(candidate: FoundCandidate): Pick<FoundRow, 'distance' | 'size'> | undefined {
		if (candidate.customMeasure !== undefined) {
			return candidate.customMeasure();
		}
		const { near, radius, maxSize } = this.#options;
		const { bounds, position } = candidate;
		const size = bounds === null ? null : 2 * Math.max(...bounds.extents);
		if (maxSize !== undefined && size !== null && size > maxSize) {
			return undefined;
		}
		if (near === undefined || radius === undefined) {
			return { distance: null, size };
		}
		let distance: number;
		if (bounds !== null) {
			distance = boxDistance(near, bounds);
		} else if (position !== null) {
			distance = Math.hypot(position[0] - near[0], position[1] - near[1], position[2] - near[2]);
		} else {
			return undefined;
		}
		return distance <= radius ? { distance, size } : undefined;
	}
}

const SURVEY_KINDS: readonly PlacementKind[] = ['dynamic', 'model', 'effect', 'facility', 'cabin'];
const HLOD_LAYERS = new Set<number>([StreamingLayer.HLOD0, StreamingLayer.HLOD1, StreamingLayer.HLOD2]);

const findPlacements = async (context: Context, scene: string, options: FindOptions): Promise<void> => {
	const { world } = context;
	if (!(await world.scenes()).includes(scene)) {
		throw new Error(`unknown streaming scene ${scene}`);
	}
	const { kinds, limit } = options;
	const needsSurvey = SURVEY_KINDS.some((k) => kinds.has(k));
	const [partition, pathOf, standIns, manifest] = await Promise.all([
		world.partition(scene),
		world.pathLookup(),
		loadStandIns(scene),
		needsSurvey ? world.manifest() : undefined,
	]);
	const nearLevels =
		options.near === undefined || partition === undefined
			? null
			: levelsNear(partition, options.near, options.radius);
	const scopedLevel = nearLevels !== null && nearLevels.length === 1 ? nearLevels[0].id : null;
	const surveyOptions = { includeEcs: kinds.has('dynamic') };
	const surveyPromise =
		needsSurvey && (options.near !== undefined || !kinds.has('static'))
			? surveyPlacements(context, scene, scopedLevel, surveyOptions).catch(errorText)
			: null;
	let loadedManifest = manifest;
	const names: AssetNames = {
		pathOf,
		assetPathOf: (hash) => {
			const asset = loadedManifest?.findAssets(hash)[0];
			return asset === undefined ? undefined : loadedManifest?.assetPath(asset);
		},
		bundleOf: (hash) => {
			const asset = loadedManifest?.findAssets(hash)[0];
			return asset === undefined ? null : (loadedManifest?.bundleName(asset.bundleIndex) ?? null);
		},
	};
	const lookups: FindLookups = {
		partition,
		names,
		standIns,
		levelOf: (tag) => (partition && levelOfTag(partition, tag)?.id) ?? (tag === 0 ? 'shared' : `tag ${tag}`),
	};
	const rows = new FoundRows(options);
	const scanAll = options.near !== undefined;
	const lightPromise = scanAll && kinds.has('light') ? lightCandidates(world, scene, options, lookups) : null;
	const waterPromise =
		scanAll && kinds.has('water') ? waterCandidates(context, scene, scopedLevel, options, lookups) : null;
	const envPromise = scanAll && kinds.has('env') ? envCandidates(context, scene, options, lookups) : null;

	if (kinds.has('static')) {
		for await (const candidate of staticCandidates(world, scene, options, lookups)) {
			if (loadedManifest === undefined && rows.accepts(candidate)) {
				loadedManifest = await world.manifest();
			}
			rows.add(candidate);
			if (rows.full) {
				break;
			}
		}
	}

	const survey =
		rows.full || !needsSurvey
			? null
			: await (surveyPromise ??
					surveyPlacements(context, scene, scopedLevel, surveyOptions).catch(errorText));
	if (typeof survey === 'string') {
		console.error(`${SURVEY_KINDS.filter((k) => kinds.has(k)).join(', ')}: not searched: ${survey}`);
	} else if (survey !== null) {
		for (const candidate of surveyCandidates(survey, kinds, lookups)) {
			rows.add(candidate);
			if (rows.full) {
				break;
			}
		}
	}

	if (!rows.full && kinds.has('light')) {
		for (const candidate of await (lightPromise ?? lightCandidates(world, scene, options, lookups))) {
			rows.add(candidate);
			if (rows.full) {
				break;
			}
		}
	}

	if (!rows.full && kinds.has('water')) {
		for (const candidate of await (waterPromise ??
			waterCandidates(context, scene, scopedLevel, options, lookups))) {
			rows.add(candidate);
			if (rows.full) {
				break;
			}
		}
	}

	if (!rows.full && kinds.has('env')) {
		for (const candidate of await (envPromise ?? envCandidates(context, scene, options, lookups))) {
			rows.add(candidate);
			if (rows.full) {
				break;
			}
		}
	}

	const shown = rows.shown();
	if (options.json) {
		console.log(
			JSON.stringify(
				shown.map((row) => row.json),
				jsonReplacer,
				'\t',
			),
		);
	} else {
		for (const row of shown) {
			console.log(foundLine(row));
		}
	}
	const counts = PLACEMENT_KINDS.flatMap((kind) => {
		const n = shown.filter((row) => row.kind === kind).length;
		return n === 0 ? [] : [`${n} ${kind}`];
	});
	console.error(
		`${shown.length} matches${counts.length === 0 ? '' : ` (${counts.join(', ')})`}${rows.length >= limit ? '; limit reached, raise --limit for more' : ''}${lookups.standIns.found ? '' : `; no out/${scene}/debug/stand-ins.json, so stand-ins aren't marked`}`,
	);
};

const drawLabels = (entity: ChunkEntity, { pathOf }: AssetNames): string[] =>
	entity.renderer?.draws.flatMap((draw) => [
		pathOf(draw.meshHash) ?? hashText(draw.meshHash),
		pathOf(draw.materialHash) ?? hashText(draw.materialHash),
	]) ?? [];

/** levels owning any cell within `reach` cells of `point` */
const levelsNear = (
	partition: LevelPartition,
	point: readonly number[],
	radius: number | undefined,
): LevelPartition['levels'] => {
	const cx = Math.floor(point[0] / CELL_SIZE);
	const cz = Math.floor(point[2] / CELL_SIZE);
	const reach = radius === undefined ? 1 : Math.ceil(radius / CELL_SIZE) + 1;
	const matched = new Set<LevelPartition['levels'][number]>();
	for (let dx = -reach; dx <= reach; dx++) {
		for (let dz = -reach; dz <= reach; dz++) {
			const key = cellKey(cx + dx, cz + dz);
			for (const level of partition.levels) {
				if (level.cells.has(key)) {
					matched.add(level);
				}
			}
		}
	}
	return [...matched];
};

const nearCellFilter = (
	near: readonly number[] | undefined,
	radius: number | undefined,
): ((file: ChunkFile) => boolean) | undefined => {
	if (near === undefined) {
		return undefined;
	}
	const cx = Math.floor(near[0] / CELL_SIZE);
	const cz = Math.floor(near[2] / CELL_SIZE);
	const reach = radius === undefined ? 1 : Math.ceil(radius / CELL_SIZE) + 1;
	return (file) =>
		file.cell === null || (Math.abs(file.cell.x - cx) <= reach && Math.abs(file.cell.z - cz) <= reach);
};

async function* staticCandidates(
	world: WorldIndex,
	scene: string,
	options: Pick<FindOptions, 'near' | 'radius' | 'sceneState' | 'area' | 'noHlod'>,
	lookups: FindLookups,
): AsyncGenerator<FoundCandidate> {
	const { names, standIns, partition } = lookups;
	const cellFilter = nearCellFilter(options.near, options.radius);
	for await (const { entity, decalMaterial } of world.sceneEntitiesWithDecals(
		scene,
		(file) =>
			(options.sceneState === undefined || file.sceneState === options.sceneState) &&
			(options.area === undefined || file.area === options.area) &&
			(cellFilter === undefined || cellFilter(file)),
	)) {
		if (options.noHlod && HLOD_LAYERS.has(entity.layer)) {
			continue;
		}
		const position = entity.pivot === null ? null : [entity.pivot.x, entity.pivot.y, entity.pivot.z];
		const decal = decalMaterial === null ? null : (names.pathOf(decalMaterial) ?? hashText(decalMaterial));
		yield {
			bounds: entity.bounds,
			position,
			labels: () => [entity.name, ...drawLabels(entity, names), ...(decal === null ? [] : [decal])],
			row: (distance) => {
				const visibility = describeAlternatives(sourceVisibility([entity.source])?.alternatives ?? [[]]);
				const reasons = standIns.atEntity(entity.name, position);
				return {
					kind: 'static',
					name: entity.name,
					position: position === null ? null : [position[0], position[1], position[2]],
					level: entity.membership.level?.id ?? entity.membership.bucket,
					visibility,
					source: basename(entity.source.name),
					summary: `${drawSummary(entity, names)}${decal === null ? '' : `  ${decal}`}  layer ${layerName(entity.layer)}`,
					standIns: reasons,
					json: {
						kind: 'static',
						...entityJson(entity, partition, names),
						...(decal === null ? {} : { decalMaterial: decal }),
						visibility,
						standIns: reasons,
						distance,
					},
				};
			},
		};
	}
}

const prefab = (kind: PlacementKind, model: StructureModel) => ({ kind, model });

function* surveyCandidates(
	survey: ScenePlacementSurvey,
	kinds: ReadonlySet<PlacementKind>,
	lookups: FindLookups,
): Generator<FoundCandidate> {
	const { dynamic, interactives, structureModels } = survey;
	const { names, standIns, levelOf } = lookups;
	if (kinds.has('dynamic')) {
		for (const { entity, visibility: gates } of dynamic.entities) {
			const pivot = pivotOf(entity);
			const position = pivot === null ? null : [pivot.x, pivot.y, pivot.z];
			yield {
				bounds: entity.bounds,
				position,
				labels: () => [entity.name, ...drawLabels(entity, names)],
				row: (distance) => {
					const visibility = describeAlternatives(gates.alternatives);
					const reasons = standIns.atEntity(entity.name, position);
					return {
						kind: 'dynamic',
						name: entity.name,
						position: position === null ? null : [position[0], position[1], position[2]],
						level: levelOf(entity.levelTag),
						visibility,
						source: `entity ${entity.id}`,
						summary: drawSummary(entity, names),
						standIns: reasons,
						json: {
							kind: 'dynamic',
							id: entity.id,
							levelTag: entity.levelTag,
							level: levelOf(entity.levelTag),
							name: entity.name,
							pivot,
							visibility,
							standIns: reasons,
							...chunkEntityJson(entity, names),
							distance,
						},
					};
				},
			};
		}
	}
	const prefabs = [
		...structureModels.map((model) => prefab(model.source.startsWith('effect:') ? 'effect' : 'model', model)),
		...interactives.facilityModels.map((model) => prefab('facility', model)),
		...interactives.cabinModels.map((model) => prefab('cabin', model)),
	];
	for (const { kind, model } of prefabs) {
		if (!kinds.has(kind)) {
			continue;
		}
		const { pathHash, position, rotation, scale } = model.model;
		let resolvedPath: string | undefined;
		const prefabPath = (): string => {
			resolvedPath ??= names.assetPathOf(pathHash) ?? names.pathOf(pathHash) ?? hashText(pathHash);
			return resolvedPath;
		};
		yield {
			bounds: null,
			position,
			labels: () => [prefabPath(), model.source],
			row: (distance) => {
				const path = prefabPath();
				const visibility = describeAlternatives(model.visibility.alternatives);
				const bundle = names.bundleOf(pathHash);
				const reasons = standIns.ofPrefab(path);
				return {
					kind,
					name: basename(path),
					position: [...position],
					level: levelOf(model.levelTag),
					visibility,
					source: model.source,
					summary: `${path}  ${bundle ?? '-'}`,
					standIns: reasons,
					json: {
						kind,
						path,
						bundle,
						level: levelOf(model.levelTag),
						position,
						rotation,
						scale,
						source: model.source,
						...(model.grid !== undefined && { grid: model.grid }),
						...(model.lodGrids !== undefined && { lodGrids: model.lodGrids }),
						visibility,
						alternatives: model.visibility.alternatives,
						standIns: reasons,
						distance,
					},
				};
			},
		};
	}
	if (kinds.has('facility')) {
		for (const standIn of interactives.standIns) {
			yield {
				bounds: null,
				position: standIn.position,
				labels: () => [standIn.template, standIn.source],
				row: (distance) => ({
					kind: 'facility',
					name: standIn.template,
					position: [...standIn.position],
					level: levelOf(standIn.levelTag),
					visibility: 'always',
					source: standIn.source,
					summary: `no model: ${standIn.reason}`,
					standIns: [standIn.reason],
					json: {
						kind: 'facility',
						...standIn,
						level: levelOf(standIn.levelTag),
						model: null,
						distance,
					},
				}),
			};
		}
	}
}

const LIGHT_TYPE_NAME: Record<number, string> = {
	[LightType.Spot]: 'spot',
	[LightType.Directional]: 'dir',
	[LightType.Point]: 'point',
};

const lightCandidates = async (
	world: WorldIndex,
	scene: string,
	options: Pick<FindOptions, 'near' | 'radius' | 'sceneState' | 'area'>,
	lookups: FindLookups,
): Promise<FoundCandidate[]> => {
	const cellFilter = nearCellFilter(options.near, options.radius);
	const files = (await world.chunkFiles()).filter(
		(file) =>
			file.scene === scene &&
			(options.sceneState === undefined || file.sceneState === options.sceneState) &&
			(options.area === undefined || file.area === options.area) &&
			(cellFilter === undefined || cellFilter(file)),
	);
	const perFile = await mapPool(files, 16, async (file) => {
		return { file, lights: readChunkLights(parseInitChunk(await world.readInitPayload(file))) };
	});
	const seen = new Map<number, { light: ChunkLight; file: (typeof files)[number] }>();
	for (const { file, lights } of perFile) {
		for (const light of lights) {
			if (!seen.has(light.id)) {
				seen.set(light.id, { light, file });
			}
		}
	}
	const out: FoundCandidate[] = [];
	for (const { light, file } of seen.values()) {
		const typeLabel = LIGHT_TYPE_NAME[light.type] ?? `type:${light.type}`;
		out.push({
			bounds: null,
			position: light.position,
			labels: () => [light.name, typeLabel, String(light.id)],
			row: (distance) => {
				const visibility = describeAlternatives(sourceVisibility([file])?.alternatives ?? [[]]);
				const color = light.color.map((c) => +c.toFixed(1)).join(',');
				const flags = [
					light.shadows !== null ? 'shadows' : '',
					light.shadowOnly ? 'shadow-only' : '',
					light.characterOnly ? 'char-only' : '',
				]
					.filter(Boolean)
					.join(' ');
				return {
					kind: 'light',
					name: light.name,
					position: [...light.position],
					level: lookups.levelOf(light.levelTag),
					visibility,
					source: basename(file.name),
					summary: `${typeLabel}  range=${light.range.toFixed(1)}  color=(${color})  int=${light.intensity.toFixed(1)}${flags ? `  [${flags}]` : ''}`,
					standIns: [],
					json: {
						kind: 'light',
						...light,
						level: lookups.levelOf(light.levelTag),
						visibility,
						source: basename(file.name),
						distance,
					},
				};
			},
		});
	}
	return out;
};

const waterCandidates = async (
	context: Context,
	scene: string,
	level: string | null,
	options: Pick<FindOptions, 'near' | 'radius'>,
	lookups: FindLookups,
): Promise<FoundCandidate[]> => {
	const { world } = context;
	const { names, partition } = lookups;
	const [{ surfaces }, { volumes }] = await Promise.all([
		readSceneWater(world, scene, nearCellFilter(options.near, options.radius), { includeGlobals: false }),
		readWaterVolumes(context, scene, level, partition).catch(() => ({ volumes: [], unsupported: [] })),
	]);
	const out: FoundCandidate[] = [];
	for (const surface of surfaces) {
		const m = surface.matrix;
		const pos: [number, number, number] = [m[12], m[13], m[14]];
		const configPath = names.pathOf(surface.configHash) ?? hashText(surface.configHash);
		const meshPath = names.pathOf(surface.meshHash) ?? hashText(surface.meshHash);
		out.push({
			bounds: surface.bounds,
			position: pos,
			labels: () => [surface.name, configPath, meshPath],
			row: (distance) => ({
				kind: 'water',
				name: surface.name,
				position: pos,
				level: lookups.levelOf(surface.levelTag),
				visibility: 'always',
				source: basename(surface.source.name),
				summary: `surface mask=${surface.renderTypeMask}  ${basename(meshPath)} / ${basename(configPath)}`,
				standIns: [],
				json: {
					kind: 'water',
					waterKind: 'surface',
					id: surface.id,
					name: surface.name,
					level: lookups.levelOf(surface.levelTag),
					position: pos,
					bounds: surface.bounds,
					renderTypeMask: surface.renderTypeMask,
					mesh: meshPath,
					config: configPath,
					distance,
				},
			}),
		});
	}
	for (const volume of volumes) {
		const xs = volume.points.map(([x]) => x);
		const zs = volume.points.map(([, z]) => z);
		const minX = Math.min(...xs);
		const maxX = Math.max(...xs);
		const minZ = Math.min(...zs);
		const maxZ = Math.max(...zs);
		const minY = volume.pivot[1];
		const maxY = volume.pivot[1] + Math.max(volume.heightMax, 0.1);
		const bounds: Aabb = {
			center: [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2],
			extents: [(maxX - minX) / 2, (maxY - minY) / 2, (maxZ - minZ) / 2],
		};
		const configPath =
			volume.configHash === null ? null : (names.pathOf(volume.configHash) ?? hashText(volume.configHash));
		out.push({
			bounds,
			position: volume.pivot,
			labels: () => [volume.id, volume.itemType, ...(configPath === null ? [] : [configPath])],
			row: (distance) => ({
				kind: 'water',
				name: `${volume.itemType} (${volume.id})`,
				position: [...volume.pivot],
				level: volume.levelId,
				visibility: 'always',
				source: `volume ${volume.id}`,
				summary: `volume depth=${volume.heightMax.toFixed(1)} fill=${volume.fraction.toFixed(2)} y=${(volume.pivot[1] + volume.heightMax * volume.fraction).toFixed(1)}${configPath ? `  ${basename(configPath)}` : ''}`,
				standIns: [],
				json: {
					kind: 'water',
					waterKind: 'volume',
					...volume,
					config: configPath,
					distance,
				},
			}),
		});
	}
	return out;
};

const envCandidates = async (
	context: Context,
	scene: string,
	options: Pick<FindOptions, 'near' | 'radius' | 'maxSize'>,
	lookups: FindLookups,
): Promise<FoundCandidate[]> => {
	const { world } = context;
	// with `--near`, envCandidates tests containment at `near` itself, so only covering cells + Global matter
	const chunkVolumes = await loadSceneVolumes(world, scene, nearCellFilter(options.near, undefined));
	const out: FoundCandidate[] = [];
	for (const entry of chunkVolumes.environment) {
		const { volume } = entry;
		const shape = environmentVolumeShape(volume);
		const phasePath =
			volume.envPhase === null
				? '(none)'
				: (lookups.names.pathOf(volume.envPhase) ?? hashText(volume.envPhase));
		const isGlobal = typeof shape !== 'string' && shape.kind === 'global';
		out.push({
			bounds: null,
			position: null,
			customMeasure: () => {
				if (options.maxSize !== undefined && isGlobal) {
					return undefined;
				}
				if (options.near === undefined || options.radius === undefined) {
					return { distance: null, size: isGlobal ? Infinity : null };
				}
				if (typeof shape === 'string') {
					return undefined;
				}
				const inside = distanceInsideVolume(shape, [options.near[0], options.near[1], options.near[2]]);
				if (inside <= 0) {
					return undefined;
				}
				return { distance: 0, size: isGlobal ? Infinity : null };
			},
			labels: () => [volume.name, phasePath],
			row: (distance) => ({
				kind: 'env',
				name: volume.name,
				position: null,
				level: lookups.levelOf(entry.tag),
				visibility:
					entry.sceneStates.length === 0
						? 'always'
						: entry.sceneStates.map((s) => `${sceneStateControl(s)}=1`).join(' | '),
				source: `priority ${volume.priority}`,
				summary: `type=${volume.volumeType}  phase=${basename(phasePath).replace(/\.asset$/, '')}`,
				standIns: [],
				json: {
					kind: 'env',
					name: volume.name,
					level: lookups.levelOf(entry.tag),
					priority: volume.priority,
					volumeType: volume.volumeType,
					blendMode: volume.blendMode,
					phase: phasePath,
					sceneStates: entry.sceneStates,
					distance,
				},
			}),
		});
	}
	return out;
};

interface StandInIndex {
	found: boolean;
	ofPrefab: (path: string) => string[];
	atEntity: (name: string, position: readonly number[] | null) => string[];
}

const loadStandIns = async (scene: string): Promise<StandInIndex> => {
	const text = await ignoreMissing(
		readFile(new URL(`${scene}/${DEBUG_DIR}/${STAND_INS_FILE}`, DEFAULT_OUT), 'utf8'),
		null,
	);
	if (text === null) {
		return { found: false, ofPrefab: () => [], atEntity: () => [] };
	}
	const reports: StandInReport[] = JSON.parse(text);
	const byPrefab = new Map<string, Set<string>>();
	const byName = new Map<string, { reason: string; position: number[] }[]>();
	for (const { path, name, reason, position } of reports) {
		if (position === null) {
			byPrefab.getOrInsertComputed(path, () => new Set()).add(`${name}: ${reason}`);
		} else {
			byName.getOrInsertComputed(name, () => []).push({ reason, position });
		}
	}
	return {
		found: true,
		ofPrefab: (path) => [...(byPrefab.get(path) ?? [])],
		atEntity: (name, position) =>
			position === null
				? []
				: (byName.get(name) ?? []).flatMap((report) =>
						Math.hypot(...report.position.map((v, i) => v - position[i])) <= 2 ? [report.reason] : [],
					),
	};
};

const foundLine = (row: FoundRow): string => {
	const distance = row.distance === null ? '' : `${row.distance.toFixed(1).padStart(6)} m  `;
	const size = row.size === null || !Number.isFinite(row.size) ? '' : `  ${row.size.toFixed(0)} m across`;
	const position = row.position === null ? '-' : row.position.map((v) => v.toFixed(1)).join(',');
	const standIn = row.standIns.length === 0 ? '' : `  STAND-IN: ${row.standIns.join('; ')}`;
	return `${distance}${row.kind.padEnd(8)} ${(row.level ?? '-').padEnd(12)} ${position.padEnd(24)} ${row.name}${size}  [${row.visibility}]  ${row.summary}  @ ${row.source}${standIn}`;
};

const drawSummary = (entity: ChunkEntity, { pathOf, bundleOf }: AssetNames): string => {
	const { renderer } = entity;
	if (renderer === null) {
		return `${entity.decal === null ? 'no renderer' : 'rect decal'} (components ${entity.components.join(' ')})`;
	}
	const first = renderer.draws[0];
	if (first === undefined) {
		return 'no draws';
	}
	const mesh = (pathOf(first.meshHash) ?? hashText(first.meshHash)).split('##').pop();
	const material = pathOf(first.materialHash) ?? hashText(first.materialHash);
	return `${renderer.draws.length} draws/${renderer.lodCount} lods  ${mesh}  ${material}  ${bundleOf(first.materialHash) ?? '-'}`;
};

// #endregion

// #region env & controls

const percent = (part: number, whole: number): string => `${((part / Math.max(1, whole)) * 100).toFixed(1)}%`;

const showEnvironment = async (
	context: Context,
	target: string,
	at: number[] | undefined,
	json: boolean,
): Promise<void> => {
	const { world } = context;
	let scene = await world.partition(target);
	let levels = scene?.levels ?? [];
	if (scene === undefined) {
		const found = await findLevel(world, target);
		scene = found.partition;
		levels = [found.level];
	}
	const singleLevel = levels.length === 1 && scene.levels.length > 1 ? levels[0] : null;
	const nearLevels = at !== undefined && singleLevel === null ? levelsNear(scene, at, undefined) : [];
	let levelTags: Set<number> | null = null;
	let surveyLevel: string | null = singleLevel?.id ?? null;
	if (singleLevel !== null) {
		levelTags = new Set([0, singleLevel.tag]);
	} else if (nearLevels.length > 0) {
		levelTags = new Set([0, ...nearLevels.map((level) => level.tag)]);
		if (nearLevels.length === 1) {
			surveyLevel = nearLevels[0].id;
		}
	}
	let chunkFilter: ((file: ChunkFile) => boolean) | undefined;
	if (at !== undefined) {
		chunkFilter = nearCellFilter(at, undefined);
	} else if (singleLevel !== null) {
		chunkFilter = (file) => file.cell === null || singleLevel.cells.has(cellKey(file.cell.x, file.cell.z));
	}
	const [survey, chunkVolumes, pathOf, names, resolver] = await Promise.all([
		surveyPlacements(context, scene.mapId, surveyLevel, { includeEcs: false }),
		loadSceneVolumes(world, scene.mapId, chunkFilter),
		world.pathLookup(),
		world.names(),
		context.resolver(),
	]);
	const placed = await surveyPlacedVolumes(
		context,
		levelTags === null
			? survey
			: { ...survey, placements: survey.placements.filter(({ levelTag }) => levelTags.has(levelTag)) },
	);
	const volumes = { ...chunkVolumes, environment: [...chunkVolumes.environment, ...placed] };
	const fromPrefabs = new Set(placed.map(({ volume }) => volume));
	const { sceneStates: states, game } = survey.scene;
	const enabled = defaultSceneStates(states, game);
	const assetName = (hash: bigint | null): string =>
		hash === null
			? '(none)'
			: (pathOf(hash)
					?.split('/')
					.pop()
					?.replace(/\.asset$/, '') ?? hashText(hash));
	const loadPhase = scenePhaseLoader(resolver, pathOf, volumes.environment);
	const phaseName = async (volume: EnvironmentVolume | null): Promise<string> => {
		if (volume === null || !fromPrefabs.has(volume)) {
			return assetName(volume?.envPhase ?? null);
		}
		const load = loadPhase(volume);
		return load === null
			? '(none)'
			: load.then(
					({ phase }) => phase.name,
					(error: unknown) => `(unreadable: ${errorText(error)})`,
				);
	};

	if (at !== undefined) {
		await showEnvironmentAt(
			volumes.environment,
			fromPrefabs,
			enabled,
			[at[0], at[1], at[2]],
			phaseName,
			json,
		);
		return;
	}

	console.log(
		`scene states (default: ${
			mapDefined(states, ({ index, name }) => (enabled.has(index) ? name : undefined)).join(', ') || 'none'
		})`,
	);
	for (const { index, name, condition } of states) {
		console.log(
			`  ${enabled.has(index) ? 'on ' : 'off'} ${sceneStateControl(index).padEnd(14)} ${name}: ${
				condition === null ? 'no condition: only set by name' : ruleText(game.describe(condition))
			}`,
		);
	}

	const choices = levels.map((level) => resolveLevelEnvironment(level, volumes, enabled));
	const phases = await Promise.all(choices.map((choice) => loadLevelPhases(choice, loadPhase)));
	const listed = choices.map((choice) => choice.shares.slice(0, 6));
	const listedPhases = await Promise.all(
		choices.map((choice, i) =>
			Promise.all([...listed[i].map(({ volume }) => phaseName(volume)), phaseName(choice.volume)]),
		),
	);
	for (const [i, level] of levels.entries()) {
		const choice = choices[i];
		console.log(`${level.id} (tag ${level.tag}) ${names.get(level.id) ?? ''}`);
		console.log(
			`  ${choice.samples} samples on a ${CELL_SIZE / 4} m grid over the level's cells; its volumes by coverage:`,
		);
		console.log('    covers   shown  priority type  volume → phase');
		for (const [j, { volume, covered, wins }] of listed[i].entries()) {
			const name = fromPrefabs.has(volume) ? `${volume.name} (prefab)` : volume.name;
			console.log(
				`    ${percent(covered, choice.samples).padStart(6)}  ${percent(wins, choice.samples).padStart(6)}  ${String(volume.priority).padStart(8)} ${String(volume.volumeType).padStart(4)}  ${name} → ${listedPhases[i][j]}`,
			);
		}
		if (choice.shares.length > 6) {
			console.log(`    … ${choice.shares.length - 6} more`);
		}
		console.log(`  base: ${listedPhases[i].at(-1)}`);
		const loaded = phases[i];
		if (loaded !== null) {
			const sources = Object.entries(loaded.composed).map(([name, { source }]) =>
				source === 'level' ? name.replace(/Config$/, '') : `${name.replace(/Config$/, '')} (${source})`,
			);
			console.log(`  sections: ${sources.join(', ')}`);
			console.log(
				`  scene global under it: ${choice.global?.name ?? '(none)'} → ${assetName(choice.global?.envPhase ?? null)}`,
			);
		}
		const post = resolveLevelPost(level, volumes, enabled);
		console.log(`  post: ${post === null ? '(none)' : `${post.name} → ${assetName(post.profile)}`}`);
	}
};

const showEnvironmentAt = async (
	entries: readonly SceneEnvironmentVolume[],
	fromPrefabs: ReadonlySet<EnvironmentVolume>,
	enabledStates: ReadonlySet<number>,
	point: [number, number, number],
	phaseName: (volume: EnvironmentVolume | null) => Promise<string>,
	json: boolean,
): Promise<void> => {
	const hits: {
		entry: SceneEnvironmentVolume;
		shape: Exclude<ReturnType<typeof environmentVolumeShape>, string>;
		inside: number;
		blend: ReturnType<typeof environmentBlend>;
		activeByDefault: boolean;
	}[] = [];
	for (const entry of entries) {
		const shape = environmentVolumeShape(entry.volume);
		if (typeof shape === 'string') {
			continue;
		}
		const inside = distanceInsideVolume(shape, point);
		if (inside <= 0) {
			continue;
		}
		const activeByDefault =
			entry.loadedByDefault &&
			(entry.sceneStates.length === 0 || entry.sceneStates.some((s) => enabledStates.has(s)));
		hits.push({
			entry,
			shape,
			inside,
			blend: environmentBlend(entry.volume),
			activeByDefault,
		});
	}
	hits.sort((a, b) =>
		compareVolumes(
			{ priority: a.entry.volume.priority, shape: a.shape },
			{ priority: b.entry.volume.priority, shape: b.shape },
		),
	);
	const rows = await Promise.all(
		hits.map(async (hit) => {
			const { volume } = hit.entry;
			let weight = 1;
			if (typeof hit.blend !== 'string' && hit.blend.kind === 'depth' && hit.blend.distance > 0) {
				weight = Math.min(1, hit.inside / hit.blend.distance);
			}
			return {
				name: fromPrefabs.has(volume) ? `${volume.name} (prefab)` : volume.name,
				priority: volume.priority,
				shape: hit.shape.kind,
				inside: Number.isFinite(hit.inside) ? +hit.inside.toFixed(2) : null,
				weight: +weight.toFixed(3),
				blend: typeof hit.blend === 'string' ? hit.blend : hit.blend.kind,
				activeByDefault: hit.activeByDefault,
				phase: await phaseName(volume),
			};
		}),
	);
	if (json) {
		console.log(JSON.stringify({ point, volumes: rows }, null, '\t'));
		return;
	}
	console.log(`environment volumes at (${point.join(', ')}): ${rows.length} covering (bottom → top)`);
	console.log('  on   priority  shape   inside     weight  blend      volume → phase');
	for (const row of rows) {
		const inside = row.inside === null ? 'global' : `${row.inside.toFixed(1)} m`;
		console.log(
			`  ${row.activeByDefault ? 'yes' : 'no '}  ${String(row.priority).padStart(8)}  ${row.shape.padEnd(6)}  ${inside.padStart(8)}  ${row.weight.toFixed(2).padStart(6)}  ${row.blend.padEnd(9)}  ${row.name} → ${row.phase}`,
		);
	}
};

const showControls = async (context: Context, scene: string, json: boolean): Promise<void> => {
	const { world } = context;
	const [variants, states, links, variables] = await Promise.all([
		loadSceneryVariants(world, scene),
		loadSceneStates(world, scene),
		loadUpgradeLinks(context, scene),
		loadMapVariables(world, scene),
	]);
	const game = new GameState({ links, variables });
	game.note(mapDefined(states, ({ condition }) => condition ?? undefined));
	const enabled = defaultSceneStates(states, game);
	if (json) {
		console.log(
			JSON.stringify(
				{
					...variants,
					sceneStates: states.map(({ index, name, condition }) => ({
						control: sceneStateControl(index),
						name,
						defaultOn: enabled.has(index),
						rule: condition === null ? null : ruleText(game.describe(condition)),
					})),
				},
				null,
				'\t',
			),
		);
		return;
	}
	if (states.length > 0) {
		console.log(`${scene}: ${states.length} scene states`);
		for (const { index, name, condition } of states) {
			console.log(
				`  ${enabled.has(index) ? 'on ' : 'off'} ${sceneStateControl(index).padEnd(14)} ${name}: ${
					condition === null ? 'only set by name' : ruleText(game.describe(condition))
				}`,
			);
		}
		console.log();
	}
	console.log(`${variants.scene}: ${variants.areas.length} stream areas with static chunks`);
	console.log('        area  root  shown inside zones            files  entities  level');
	for (const area of variants.areas) {
		const inside = area.shownInside.join(',') || '-';
		console.log(
			`${String(area.id).padStart(12)}  ${area.rootVisible ? 'yes ' : '    '}  ${inside.padEnd(30)} ${String(area.chunkFiles).padStart(5)}  ${String(area.entities).padStart(8)}  ${area.levelId ?? '-'} ${area.levelName ?? ''}`,
		);
	}
	console.log(
		`\n${variants.progressions.length} progression controllers (DynamicStreaming LogicState levels)`,
	);
	console.log(
		'kind           key                            level                         levels (groups)       default',
	);
	for (const p of variants.progressions) {
		const levels = p.levels.map((level) => `${level}(${p.groupsPerLevel[level]})`).join(' ');
		console.log(
			`${p.kind.padEnd(14)} ${p.key.padEnd(30)} ${`${p.levelId ?? '-'} ${p.levelName ?? ''}`.padEnd(29)} ${levels.padEnd(21)} ${p.defaultLevel}`,
		);
	}
};

// #endregion

// #region entity json

const entityJson = (
	entity: IndexedEntity,
	partition: LevelPartition | undefined,
	names: AssetNames,
): object => ({
	id: entity.id,
	levelTag: entity.levelTag,
	level: entity.membership.level?.id ?? (partition && levelOfTag(partition, entity.levelTag)?.id) ?? null,
	bucket: entity.membership.bucket,
	placement: entity.membership.placement,
	cellOwner: entity.membership.cellOwner?.id ?? null,
	name: entity.name,
	layer: layerName(entity.layer),
	source: entity.source.name,
	sceneState: entity.source.sceneState,
	area: entity.source.area,
	pivot: entity.pivot,
	...chunkEntityJson(entity, names),
});

const layerName = (layer: number): string =>
	Object.entries(StreamingLayer).find(([, value]) => value === layer)?.[0] ?? String(layer);

const chunkEntityJson = (entity: ChunkEntity, { pathOf, bundleOf }: AssetNames): object => ({
	matrix: entity.matrix === null ? null : [...entity.matrix],
	bounds: entity.bounds,
	decal: entity.decal,
	components: entity.components,
	renderer:
		entity.renderer === null
			? null
			: {
					lodCount: entity.renderer.lodCount,
					draws: entity.renderer.draws.map((draw) => ({
						lod: draw.lod,
						mesh: pathOf(draw.meshHash) ?? `0x${draw.meshHash.toString(16)}`,
						meshBundle: bundleOf(draw.meshHash),
						material: pathOf(draw.materialHash) ?? `0x${draw.materialHash.toString(16)}`,
						materialBundle: bundleOf(draw.materialHash),
						submesh: draw.submesh,
						flags: draw.flags,
						lodMaxSquared: draw.lodMaxSquared,
						lodMinSquared: draw.lodMinSquared,
					})),
				},
});

// #endregion
