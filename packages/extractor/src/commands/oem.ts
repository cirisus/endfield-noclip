import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { zstdDecompressSync } from 'node:zlib';

import type { MemoryPackValue } from '@endfield-noclip/formats/endfield/memory-pack';
import {
	PACKAGE_FORMAT,
	PACKAGE_VERSION,
	type PackageManifest,
} from '@endfield-noclip/package-format/manifest';
import type { Catalog, Companion, Point } from '@endfield-noclip/package-format/oem';
import type { SceneControl, StatesInfo } from '@endfield-noclip/package-format/states';
import type { Vec3 } from '@endfield-noclip/package-format/values';

import { fromUint8Array, openArchive } from '@mary-ext/czar';

import { withContext } from '../context.ts';
import { GameState, type GameCondition } from '../game/game-state.ts';
import { pointPresets } from '../game/oem-presets.ts';
import { labelStory } from '../game/story.ts';
import { VfsGroup } from '../hg/vfs.ts';

/* oxlint-disable no-await-in-loop -- one stateful decoder and bounded archive copies; never decode concurrently */

export const summary =
	'export an immutable OEM companion release: oem --atlos <talos> --packages <dir> -o <dir>';

type Node = { [key: string]: MemoryPackValue };
const node = (v: MemoryPackValue | undefined): Node => {
	if (v === null || typeof v !== 'object' || Array.isArray(v)) {
		throw new Error('expected a game data object');
	}
	return v;
};
const list = (v: MemoryPackValue | undefined): MemoryPackValue[] => (Array.isArray(v) ? v : []);
const text = (v: MemoryPackValue | undefined): string => {
	if (typeof v !== 'string' && typeof v !== 'number') {
		throw new Error('expected an identifier');
	}
	return String(v);
};
const vec = (v: MemoryPackValue | undefined): Vec3 => {
	if (
		Array.isArray(v) &&
		v.length === 3 &&
		typeof v[0] === 'number' &&
		typeof v[1] === 'number' &&
		typeof v[2] === 'number' &&
		v.every(Number.isFinite)
	) {
		return [v[0], v[1], v[2]];
	}
	const p = node(v);
	if (typeof p.x !== 'number' || typeof p.y !== 'number' || typeof p.z !== 'number') {
		throw new Error('invalid position');
	}
	return [p.x, p.y, p.z];
};

const condition = (value: MemoryPackValue | undefined): GameCondition | null => {
	if (value == null) {
		return null;
	}
	const v = node(value),
		type = text(v.$type);
	if (type.includes('CombinedConditionRuntime')) {
		const children = list(v.subConditions).map(condition);
		if (children.some((c) => c === null) || ![0, 1].includes(Number(v.conditionOperator))) {
			throw new Error('unsupported combined prerequisite');
		}
		return {
			kind: Number(v.conditionOperator) === 0 ? 'all' : 'any',
			reverse: Boolean(v.reverse),
			conditions: children.filter((c) => c !== null),
		};
	}
	const kind = type.includes('SimpleConditionCheckQuestState')
		? 'quest'
		: type.includes('SimpleConditionCheckMissionState')
			? 'mission'
			: null;
	if (kind === null) {
		throw new Error(`unsupported prerequisite ${type}`);
	}
	const id = v[kind === 'quest' ? 'questId' : 'missionId'],
		compare = v.compareOperator,
		target = v.compareTarget;
	if (
		typeof id !== 'string' ||
		typeof compare !== 'number' ||
		![0, 1, 2, 3, 4, 5].includes(compare) ||
		typeof target !== 'number'
	) {
		throw new Error('invalid quest prerequisite');
	}
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- enum domain checked above
	return { kind, id, compare: compare as 0 | 1 | 2 | 3 | 4 | 5, target };
};

/**
 * reads a core without importing the browser viewer or changing its archive format.
 *
 * @param path package directory
 * @returns the current package's manifest
 * @throws {Error} for a foreign or incompatible package
 */
export const readCore = async (path: string): Promise<PackageManifest> => {
	const archive = await openArchive(fromUint8Array(await readFile(join(path, 'core.czar'))));
	const entry = archive.get('manifest.json.zst');
	if (!entry) {
		throw new Error(`missing manifest in ${path}`);
	}
	const value: unknown = JSON.parse(zstdDecompressSync(await entry.bytes()).toString());
	if (
		!value ||
		typeof value !== 'object' ||
		!('format' in value) ||
		value.format !== PACKAGE_FORMAT ||
		!('version' in value) ||
		value.version !== PACKAGE_VERSION
	) {
		throw new Error(`incompatible package ${path}`);
	}
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- same versioned contract as the viewer's core reader
	return value as PackageManifest;
};

export const run = async (args: string[]): Promise<void> => {
	const { values } = parseArgs({
		args,
		options: {
			config: { type: 'string' },
			atlos: { type: 'string' },
			packages: { type: 'string' },
			output: { type: 'string', short: 'o' },
		},
	});
	if (!values.atlos || !values.packages || !values.output) {
		throw new Error(summary);
	}
	const atlos = resolve(values.atlos),
		packages = resolve(values.packages),
		output = resolve(values.output);
	const sceneIds = [
		'map01',
		'map02',
		'indie_dg005',
		'indie_dg007',
		'indie_dg016',
		'base01_lv001',
		'dung01_wrdg001',
	];
	const cores = new Map<string, PackageManifest>();
	for (const scene of sceneIds) {
		cores.set(scene, await readCore(join(packages, scene)));
	}
	await withContext(values.config, async (ctx) => {
		const bundle = await ctx.world.manifest();
		const source = { buildGuid: bundle.guid, contentHash: bundle.contentHash };
		for (const [scene, core] of cores) {
			if (
				core.scene.id !== scene ||
				JSON.stringify(core.source) !== JSON.stringify(source) ||
				core.subset !== null
			) {
				throw new Error(`package/source mismatch or partial package: ${scene}`);
			}
		}
		const group = await ctx.vfs.group(VfsGroup.JsonData),
			reader = await ctx.memoryPack();
		const read = async (path: string): Promise<Uint8Array> => {
			const f = await ctx.vfs.find(VfsGroup.JsonData, path);
			if (!f) {
				throw new Error(`missing ${path}`);
			}
			return ctx.vfs.readVerified(f);
		};
		const placements = new Map<string, { row: Node; level: string; path: string; kind: string }>();
		const locks = new Map<string, Node[]>();
		const levels = await ctx.world.levelConfigs();
		const sceneFor = (level: string): string =>
			levels.get(level)?.defaultState.exportedSceneConfigPath?.split('/')[0] ?? '';
		for (const path of group.files.keys()) {
			const match = /^Data\/Json\/LevelData\/([^/]+)\//.exec(path);
			if (!match || !sceneIds.includes(sceneFor(match[1]))) {
				continue;
			}
			const data = node(reader.decode(await read(path), 'Beyond_Gameplay_LevelDataForMemoryPack'));
			for (const kind of ['interactives', 'enemies', 'npcs']) {
				for (const entry of list(data[kind])) {
					const row = node(entry),
						id = text(row.levelLogicId);
					const previous = placements.get(id);
					if (previous && previous.level !== match[1]) {
						throw new Error(`ambiguous entity ${id}`);
					}
					placements.set(id, { row, level: match[1], path, kind });
				}
			}
			for (const entry of list(data.interactiveLockData)) {
				const lock = node(entry);
				locks.set(text(lock.logicIdGlobal), list(lock.locks).map(node));
			}
		}
		const registryPath = 'Data/Json/GameplayConfig/WorldEntityRegistry.json';
		const registry: Node = node(JSON.parse(new TextDecoder().decode(await read(registryPath))));
		const proxies = node(registry.npcProxyBriefInfos);
		const proxyTable = node(
			JSON.parse(new TextDecoder().decode(await read('Data/Json/GameplayConfig/NpcProxyTable.json'))),
		);
		const proxyLevels = node(proxyTable.dataTable);
		const game = new GameState();
		const regionConfig: unknown = JSON.parse(await readFile(join(atlos, 'src/data/map/region.json'), 'utf8'));
		if (!regionConfig || typeof regionConfig !== 'object' || Array.isArray(regionConfig)) {
			throw new Error('invalid OEM region configuration');
		}
		const subregions = new Map<string, string>();
		for (const [region, config] of Object.entries(regionConfig)) {
			if (
				!config ||
				typeof config !== 'object' ||
				!('subregions' in config) ||
				!Array.isArray(config.subregions)
			) {
				throw new Error(`invalid subregions for ${region}`);
			}
			for (const subregion of config.subregions) {
				if (typeof subregion !== 'string' || !/^[A-Z]+_\d+$/.test(subregion) || subregions.has(subregion)) {
					throw new Error(`invalid or duplicate OEM subregion: ${String(subregion)}`);
				}
				subregions.set(subregion, region);
			}
		}
		const partitions = new Map<string, Point[]>();
		for (const [subregion, region] of [...subregions].toSorted(([a], [b]) => a.localeCompare(b))) {
			const file = `${subregion}.json`;
			const rows: unknown = JSON.parse(await readFile(join(atlos, 'src/data/marker/data', file), 'utf8'));
			if (!Array.isArray(rows)) {
				throw new Error(`invalid marker partition ${file}`);
			}
			const points: Point[] = [];
			for (const raw of rows) {
				if (!Array.isArray(raw) || raw.length < 6 || !Number.isFinite(raw[4])) {
					throw new Error(`invalid marker tuple in ${file}`);
				}
				const id = String(raw[0]),
					placed = placements.get(id),
					proxy = proxies[id];
				if (!placed && !proxy) {
					throw new Error(`unresolved point ${id}`);
				}
				const proxyConfig = proxy ? node(proxyLevels[text(node(proxy).proxyId)]) : undefined;
				const level = placed?.level ?? text(proxyConfig?.levelId ?? '');
				const scene = sceneFor(level),
					core = cores.get(scene);
				if (!core || !core.levels.some((l) => l.id === level && l.instances > 0)) {
					throw new Error(`no packed level for ${id}: ${scene}/${level}`);
				}
				const unknown: string[] = [],
					row = placed?.row ?? node(proxy);
				let gate: GameCondition | null = null;
				try {
					gate = condition(row.progressLockCondition);
				} catch (error) {
					unknown.push(error instanceof Error ? error.message : String(error));
				}
				const prerequisite = gate ? { alternatives: game.requirements(gate) } : null;
				if (!placed) {
					unknown.push('npc-activation');
				}
				if (placed && row.createState !== 0) {
					unknown.push('script-spawn');
				}
				const lockKinds = new Map([
					[1, 'ScriptLock'],
					[2, 'MiniGame'],
					[4, 'Quest'],
					[5, 'Sludge'],
				]);
				const pointLocks = (locks.get(id) ?? []).map((lock) => ({
					kind: lockKinds.get(Number(lock.unlockType)) ?? `Unknown:${text(lock.unlockType)}`,
					quests: typeof lock.questId === 'string' && lock.questId ? [lock.questId] : [],
					games: list(lock.miniGameIds).map(String),
				}));
				if (pointLocks.length) {
					unknown.push('interaction-runtime');
				}
				points.push({
					id,
					scene,
					level,
					region,
					subregion,
					tier: Number(raw[4]),
					position: vec(row.position),
					condition: prerequisite,
					locks: pointLocks,
					drivers: core.states.controls.find((c) => c.id === `script:${id}`)?.drivers ?? [],
					unknown,
					presets: [],
					source: {
						path: placed?.path ?? registryPath,
						kind: placed?.kind ?? 'npc-proxy',
						createState: typeof row.createState === 'number' ? row.createState : null,
					},
				});
			}
			partitions.set(subregion, points);
		}
		const extra = game.controls(),
			missions = await labelStory(ctx.world, extra);
		const labels: Companion['labels'] = {};
		for (const [locale, language] of Object.entries({
			'en-US': 'EN',
			'zh-CN': 'CN',
			'zh-TW': 'TC',
			'ja-JP': 'JP',
			'ko-KR': 'KR',
			'ru-RU': 'RU',
			'es-ES': 'MX',
			'pt-BR': 'BR',
			'de-DE': 'DE',
			'fr-FR': 'FR',
			'vi-VN': 'VN',
			'th-TH': 'TH',
			'id-ID': 'ID',
			'it-IT': 'IT',
		})) {
			const controls = extra.map((c) => ({ ...c })),
				names = await labelStory(ctx.world, controls, language);
			labels[locale] = Object.fromEntries(
				controls.map((c) => {
					const mission = names.find((m) => m.id === c.story?.mission)?.name;
					return [c.id, c.kind === 'quest' && mission ? `${mission}: ${c.name}` : c.name];
				}),
			);
		}
		const payloads = new Map<string, Companion>();
		const presets = new Map<string, Point['presets']>();
		for (const [subregion, points] of partitions) {
			for (const p of points) {
				const base = cores.get(p.scene)!.states,
					byId = new Map<string, SceneControl>(base.controls.map((c) => [c.id, c]));
				for (const c of extra) {
					if (!byId.has(c.id)) {
						byId.set(c.id, c);
					}
				}
				const states: StatesInfo = {
					...base,
					controls: [...byId.values()],
					missions: [...new Map([...base.missions, ...missions].map((m) => [m.id, m])).values()],
				};
				const key = `${p.scene}:${JSON.stringify(p.condition)}`;
				let choices = presets.get(key);
				if (!choices) {
					choices = pointPresets(states, p.condition);
					presets.set(key, choices);
				}
				p.presets = choices;
				if (!p.presets.some((preset) => preset.satisfies)) {
					p.unknown.push('no-consistent-story-preset');
				}
			}
			payloads.set(subregion, { version: 1, release: '', controls: extra, missions, labels, points });
		}
		const release = createHash('sha256')
			.update(
				JSON.stringify({
					source,
					generations: [...cores.values()].map((c) => c.generation),
					payloads: [...payloads],
				}),
			)
			.digest('hex')
			.slice(0, 16);
		const destination = join(output, release);
		await mkdir(join(destination, 'points'), { recursive: true });
		const catalog: Catalog = {
			format: 'oem-noclip',
			version: 1,
			release,
			source,
			packages: {},
			files: {},
			pointIndex: {},
		};
		for (const [scene, core] of cores) {
			catalog.packages[scene] = {
				path: `packages/${scene}/`,
				generation: core.generation,
				version: core.version,
			};
			for (const archive of core.archives) {
				const target = join(destination, 'packages', scene, archive.name);
				await mkdir(resolve(target, '..'), { recursive: true });
				await cp(join(packages, scene, archive.name), target, {
					force: false,
					errorOnExist: true,
					mode: constants.COPYFILE_FICLONE,
				});
			}
		}
		for (const [id, payload] of payloads) {
			payload.release = release;
			catalog.files[id] = `points/${id}.json`;
			for (const point of payload.points) {
				if (catalog.pointIndex[point.id]) {
					throw new Error(`duplicate point ${point.id}`);
				}
				catalog.pointIndex[point.id] = id;
			}
			await writeFile(join(destination, catalog.files[id]), JSON.stringify(payload));
		}
		await writeFile(join(destination, 'index.json'), JSON.stringify(catalog));
		console.log(
			`OEM release ${release}: ${Object.keys(catalog.pointIndex).length} points, ${cores.size} scenes, ${destination}`,
		);
	});
};
