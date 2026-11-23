import { parseArgs } from 'node:util';

import {
	readLevelInteractives,
	UnsupportedLevelData,
} from '@endfield-noclip/formats/endfield/level-interactives';
import { parseSparkTable } from '@endfield-noclip/formats/hg/spark-buffer';

import { definite } from '@mary-ext/array-fns';

import {
	hashText,
	jsonReplacer,
	need as needArg,
	parseHash,
	parseOptionalInteger,
	separatePositionals,
} from '../cli-args.ts';
import { compareNatural, compareStrings } from '../compare.ts';
import { type Context, withContext } from '../context.ts';
import { errorText } from '../errors.ts';
import { readViewStates, records, text } from '../game/interactives/view-state-poses.ts';
import { toScript } from '../game/script-drivers.ts';
import type { WorldIndex } from '../game/world/world-index.ts';
import { VfsGroup } from '../hg/vfs.ts';
import { mapPool } from '../pool.ts';

export const summary = 'search asset paths, resolve hashes, and read SparkBuffer tables & level data';

/** command usage, available without opening the install */
export const usage = `usage:
  data paths <re> [--limit n] [--json]               search both path catalogs, with hashes and bundles
  data resolve <path|hash>                           path ↔ hash, then asset → bundle + dependencies
  data tables [--filter re]                          list SparkBuffer config tables in the Table group
  data table <name> [--key k] [--filter re] [--limit n] [--json]
                                                     decode a SparkBuffer table (e.g. DungeonTable)
  data scripts <level> [--id N] [--filter re] [--limit n] [--json]
                                                     decode MemoryPack level scripts for one level
  data interactives <level> [--id N] [--filter re] [--limit n] [--json]
                                                     decode LevelData interactive placements for one level
  data view-states [model-re] [--emissive re] [--filter re] [--limit n] [--json]
                                                     inspect or search ModelViewStateControllerData JSONs`;

const OPTIONS = {
	config: { type: 'string' },
	key: { type: 'string' },
	id: { type: 'string' },
	emissive: { type: 'string' },
	filter: { type: 'string' },
	limit: { type: 'string' },
	json: { type: 'boolean', default: false },
} as const;

export const run = async (args: string[]): Promise<void> => {
	const { values, positionals } = parseArgs({
		args: separatePositionals(args, OPTIONS),
		allowPositionals: true,
		options: OPTIONS,
	});
	const [sub, arg] = positionals;
	const limit = parseLimit(values.limit);
	const filter = values.filter === undefined ? undefined : new RegExp(values.filter, 'i');

	await withContext(values.config, async (context) => {
		switch (sub) {
			case 'paths': {
				await findPaths(context.world, new RegExp(needArg(arg, 'pattern', usage), 'i'), limit, values.json);
				break;
			}
			case 'resolve': {
				await resolve(context.world, needArg(arg, 'path or hash', usage));
				break;
			}
			case 'tables': {
				await listTables(context, filter);
				break;
			}
			case 'table': {
				await readTable(context, needArg(arg, 'table name', usage), {
					key: values.key,
					filter,
					limit,
					json: values.json,
				});
				break;
			}
			case 'scripts': {
				await readScripts(context, needArg(arg, 'level', usage), {
					id: values.id,
					filter,
					limit,
					json: values.json,
				});
				break;
			}
			case 'interactives': {
				await readInteractives(context, needArg(arg, 'level', usage), {
					id: values.id,
					filter,
					limit,
					json: values.json,
				});
				break;
			}
			case 'view-states': {
				await readViewStatesCmd(context, {
					model: arg === undefined ? undefined : new RegExp(arg, 'i'),
					emissive: values.emissive === undefined ? undefined : new RegExp(values.emissive, 'i'),
					filter,
					limit,
					json: values.json,
				});
				break;
			}
			default: {
				throw new Error(usage);
			}
		}
	});
};

const parseLimit = (raw: string | undefined): number => {
	const limit = parseOptionalInteger(raw, '--limit') ?? 100;
	if (limit < 1) {
		throw new Error('--limit must be a positive integer');
	}
	return limit;
};

// #region paths & resolve

const findPaths = async (world: WorldIndex, pattern: RegExp, limit: number, json: boolean): Promise<void> => {
	const [main, initial, manifest] = await Promise.all([
		world.pathHash(),
		world.initPathHash(),
		world.manifest(),
	]);
	const rows: { hash: string; path: string; bundles: string[] }[] = [];
	const seen = new Set<string>();
	for (const table of [main, initial]) {
		for (const [hash, path] of table.entries((candidate) => pattern.test(candidate))) {
			const key = `${hash}:${path}`;
			if (seen.has(key)) {
				continue;
			}
			seen.add(key);
			const bundles = [
				...new Set(manifest.findAssets(hash).map((asset) => manifest.bundleName(asset.bundleIndex))),
			];
			rows.push({ hash: hashText(hash), path, bundles });
			if (rows.length >= limit) {
				break;
			}
		}
		if (rows.length >= limit) {
			break;
		}
	}
	if (json) {
		console.log(JSON.stringify(rows, null, '\t'));
	} else {
		for (const row of rows) {
			console.log(`${row.hash}\t${row.path}\t${row.bundles.join(',') || '-'}`);
		}
	}
	console.error(
		`${rows.length} matches${rows.length === limit ? ' (limit reached; raise --limit for more)' : ''}`,
	);
};

const resolve = async (world: WorldIndex, query: string): Promise<void> => {
	const manifest = await world.manifest();
	let hashes: bigint[];
	const parsed = parseHash(query);
	if (parsed !== null) {
		hashes = [parsed];
		const path = await world.pathOf(parsed);
		console.log(`hash ${parsed} (${hashText(parsed)}) → ${path ?? '(not in StringPathHash)'}`);
	} else {
		hashes = await world.hashesOf(query);
		if (hashes.length === 0) {
			throw new Error(`${query} is not in StringPathHash`);
		}
		console.log(`${query} → hash ${hashes.map((hash) => `${hash} (0x${hash.toString(16)})`).join(', ')}`);
	}

	for (const hash of hashes) {
		const assets = manifest.findAssets(hash);
		if (assets.length === 0) {
			console.log('  not a bundled asset (no manifest AssetInfo)');
		}
		const seen = new Set<number>();
		for (const asset of assets) {
			if (seen.has(asset.bundleIndex)) {
				continue;
			}
			seen.add(asset.bundleIndex);
			const bundle = manifest.bundle(asset.bundleIndex);
			console.log(`  asset ${manifest.assetPath(asset)} (${asset.assetSize} bytes)`);
			console.log(`  bundle #${bundle.index} ${bundle.name}`);
			console.log(`    direct deps (${bundle.directDependencies.length}):`);
			for (const dep of bundle.directDependencies) {
				console.log(`      ${manifest.bundleName(dep)}`);
			}
			console.log(`    closure: ${bundle.dependencies.length} bundles`);
		}
	}
};

// #endregion

// #region SparkBuffer tables

const TABLE_PREFIX = 'Data/TableCfg/';
const TABLE_SUFFIX = '.bytes';

const tableShortName = (name: string): string =>
	name.startsWith(TABLE_PREFIX) && name.endsWith(TABLE_SUFFIX)
		? name.slice(TABLE_PREFIX.length, -TABLE_SUFFIX.length)
		: name;

const listTables = async (context: Context, filter: RegExp | undefined): Promise<void> => {
	const group = await context.vfs.group(VfsGroup.Table);
	const names = Iterator.from(group.catalog)
		.filter((file) => file.name.endsWith(TABLE_SUFFIX))
		.map((file) => ({ name: tableShortName(file.name), length: file.length }))
		.filter((entry) => filter === undefined || filter.test(entry.name))
		.toArray();
	names.sort((a, b) => compareStrings(a.name, b.name));
	for (const entry of names) {
		console.log(`${String(entry.length).padStart(10)}  ${entry.name}`);
	}
	console.error(`${names.length} tables`);
};

const readTable = async (
	context: Context,
	name: string,
	options: { key: string | undefined; filter: RegExp | undefined; limit: number; json: boolean },
): Promise<void> => {
	const group = await context.vfs.group(VfsGroup.Table);
	let exactPath = name;
	if (!name.includes('/')) {
		exactPath = `${TABLE_PREFIX}${name}${name.endsWith(TABLE_SUFFIX) ? '' : TABLE_SUFFIX}`;
	}
	let matchedPath = group.catalog.has(exactPath) ? exactPath : undefined;
	if (matchedPath === undefined) {
		const lower = exactPath.toLowerCase();
		for (const candidate of group.catalog.names()) {
			if (candidate.toLowerCase() === lower) {
				matchedPath = candidate;
				break;
			}
		}
	}
	if (matchedPath === undefined) {
		throw new Error(`table ${name} not found; see \`data tables\``);
	}
	const table = parseSparkTable(await context.vfs.read(VfsGroup.Table, matchedPath));
	const matched: { key: string | number | bigint; value: unknown }[] = [];
	for (const [key, value] of table.entries) {
		const keyText = String(key);
		if (options.key !== undefined && keyText !== options.key) {
			continue;
		}
		if (options.filter !== undefined) {
			const hay = `${keyText} ${JSON.stringify(value, jsonReplacer)}`;
			if (!options.filter.test(hay)) {
				continue;
			}
		}
		matched.push({ key, value });
		if (matched.length >= options.limit) {
			break;
		}
	}
	if (options.json || options.key !== undefined) {
		console.log(
			JSON.stringify(
				options.key !== undefined && matched.length === 1 ? matched[0] : matched,
				jsonReplacer,
				'\t',
			),
		);
	} else {
		for (const row of matched) {
			console.log(`${String(row.key).padEnd(32)} ${JSON.stringify(row.value, jsonReplacer)}`);
		}
	}
	console.error(
		`${matched.length} rows of ${table.entries.length} in ${table.name}${matched.length === options.limit ? ' (limit reached; raise --limit for more)' : ''}`,
	);
};

// #endregion

// #region MemoryPack scripts & interactives

const SCRIPT_ROOT = 'Beyond_Gameplay_LevelScriptDataForMemoryPack';

const readScripts = async (
	context: Context,
	level: string,
	options: { id: string | undefined; filter: RegExp | undefined; limit: number; json: boolean },
): Promise<void> => {
	const group = await context.vfs.group(VfsGroup.JsonData);
	const prefix = `Data/Json/LevelScriptData/${level}/`;
	const files = group.catalog
		.names()
		.filter((name) => name.startsWith(prefix) && name.endsWith('.json'))
		.filter((name) => options.id === undefined || name === `${prefix}${options.id}.json`)
		.toArray();
	files.sort(compareNatural);
	if (files.length === 0) {
		throw new Error(
			`no level scripts found for ${level}${options.id === undefined ? '' : ` id ${options.id}`}`,
		);
	}

	const mp = await context.memoryPack();
	const matched: object[] = [];
	for (const name of files) {
		const scriptId = name.slice(prefix.length, -'.json'.length);
		// oxlint-disable-next-line no-await-in-loop -- stops at --limit
		const decoded = mp.decode(await context.vfs.read(VfsGroup.JsonData, name), SCRIPT_ROOT);
		if (options.filter !== undefined && !options.filter.test(JSON.stringify(decoded, jsonReplacer))) {
			continue;
		}
		if (options.id !== undefined || options.json) {
			matched.push({ id: scriptId, file: name, data: decoded });
		} else {
			const graph = toScript(scriptId, level, decoded);
			const types = new Set<string>();
			if (graph !== null) {
				for (const node of graph.nodes.values()) {
					if (typeof node.$type === 'string') {
						types.add(node.$type.replace(/^Beyond_Gameplay_(Actions_)?/, '').replace(/ForMemoryPack$/, ''));
					}
				}
			}
			const list = [...types];
			console.log(
				`${scriptId.padEnd(14)} ${String(graph?.headers.length ?? 0).padStart(2)} headers  ${String(graph?.nodes.size ?? 0).padStart(3)} nodes  ${list.slice(0, 6).join(', ')}${list.length > 6 ? ` (+${list.length - 6})` : ''}`,
			);
			matched.push({ id: scriptId });
		}
		if (matched.length >= options.limit) {
			break;
		}
	}
	if (options.id !== undefined || options.json) {
		console.log(
			JSON.stringify(
				options.id !== undefined && matched.length === 1 ? matched[0] : matched,
				jsonReplacer,
				'\t',
			),
		);
	}
	console.error(
		`${matched.length} scripts matched out of ${files.length}${matched.length === options.limit ? ' (limit reached; raise --limit for more)' : ''}`,
	);
};

const readInteractives = async (
	context: Context,
	level: string,
	options: { id: string | undefined; filter: RegExp | undefined; limit: number; json: boolean },
): Promise<void> => {
	const group = await context.vfs.group(VfsGroup.JsonData);
	const prefix = `Data/Json/LevelData/${level}/`;
	const files = group.catalog
		.names()
		.filter((name) => name.startsWith(prefix) && name.endsWith('.json'))
		.toArray();
	files.sort();
	if (files.length === 0) {
		throw new Error(`no LevelData files found for ${level}`);
	}
	const pool = await context.world.stringPool();
	const resolveString = (id: number): string | null => {
		try {
			return pool.get(id) ?? null;
		} catch {
			return null;
		}
	};

	const matched: object[] = [];
	const skipped: string[] = [];
	for (const name of files) {
		// oxlint-disable-next-line no-await-in-loop -- stops at --limit
		const bytes = await context.vfs.read(VfsGroup.JsonData, name);
		let rows;
		try {
			rows = readLevelInteractives(bytes, resolveString);
		} catch (error) {
			if (error instanceof UnsupportedLevelData) {
				skipped.push(`${name}: ${errorText(error)}`);
				continue;
			}
			throw error;
		}
		for (const row of rows) {
			const idText = row.id.toString();
			if (options.id !== undefined && idText !== options.id) {
				continue;
			}
			const plain = {
				id: idText,
				template: row.template,
				createState: row.createState,
				isLocked: row.isLocked,
				position: row.position,
				rotation: row.rotation,
				scale: row.scale,
				modelScale: row.modelScale,
				properties: row.properties,
				componentProperties: Object.fromEntries(row.componentProperties),
				file: name,
			};
			if (options.filter !== undefined && !options.filter.test(JSON.stringify(plain, jsonReplacer))) {
				continue;
			}
			matched.push(plain);
			if (!options.json && options.id === undefined) {
				const pos = row.position.map((v) => v.toFixed(1)).join(',');
				const flags = definite([
					row.createState !== 0 ? `create=${row.createState}` : '',
					row.isLocked ? 'locked' : '',
				]).join(' ');
				console.log(
					`${idText.padStart(12)}  ${pos.padEnd(24)} ${row.template.padEnd(36)} ${flags}  @ ${name.split('/').pop()}`,
				);
			}
			if (matched.length >= options.limit) {
				break;
			}
		}
		if (matched.length >= options.limit) {
			break;
		}
	}
	if (options.json || options.id !== undefined) {
		console.log(
			JSON.stringify(
				options.id !== undefined && matched.length === 1 ? matched[0] : matched,
				jsonReplacer,
				'\t',
			),
		);
	}
	for (const note of skipped) {
		console.error(`skipped: ${note}`);
	}
	console.error(
		`${matched.length} interactives${matched.length === options.limit ? ' (limit reached; raise --limit for more)' : ''}`,
	);
};

// #endregion

// #region view-states

const VIEW_STATE_PREFIX = 'Data/Json/Interactive/ModelViewStateControllerData/';
const VIEW_STATE_SUFFIX = '.json';
const VIEW_STATE_CONCURRENCY = 16;

interface EmissiveStateHit {
	state: string;
	configHash: string;
	configPath: string | null;
}

const readViewStatesCmd = async (
	context: Context,
	options: {
		model: RegExp | undefined;
		emissive: RegExp | undefined;
		filter: RegExp | undefined;
		limit: number;
		json: boolean;
	},
): Promise<void> => {
	const group = await context.vfs.group(VfsGroup.JsonData);
	const models: string[] = [];
	for (const entry of group.catalog) {
		if (!entry.name.startsWith(VIEW_STATE_PREFIX) || !entry.name.endsWith(VIEW_STATE_SUFFIX)) {
			continue;
		}
		const model = entry.name.slice(VIEW_STATE_PREFIX.length, -VIEW_STATE_SUFFIX.length);
		if (options.model === undefined || options.model.test(model)) {
			models.push(model);
		}
	}
	models.sort(compareNatural);

	// warm up MemoryPack schema & StringPathHash once before fanning out
	await context.memoryPack();
	if (options.emissive !== undefined || !options.json) {
		await context.world.pathHash();
	}

	const rows: {
		model: string;
		states: string[];
		emissives: EmissiveStateHit[];
		data?: unknown;
	}[] = [];

	await mapPool(models, VIEW_STATE_CONCURRENCY, async (model) => {
		const vs = await readViewStates(context, { model, source: model });
		if (vs === null) {
			return;
		}
		const states: string[] = [];
		const emissives: EmissiveStateHit[] = [];
		for (const ac of records(vs.data.modelAnimatorDatas)) {
			for (const layer of records(ac.layerFsmDatas)) {
				for (const state of records(layer.stateDatas)) {
					const stateName = text(state.stateName) ?? text(state.name) ?? '?';
					states.push(stateName);
					for (const behavior of records(state.behaviors)) {
						const type = text(behavior.$type);
						if (type === null || !type.endsWith('_MVSCEmissiveBehaviorDataForMemoryPack')) {
							continue;
						}
						const rawHash = behavior.emissiveConfigHash;
						if (typeof rawHash !== 'string' && typeof rawHash !== 'number' && typeof rawHash !== 'bigint') {
							continue;
						}
						const hash = BigInt.asUintN(64, BigInt(rawHash));
						if (hash === 0n) {
							continue;
						}
						// oxlint-disable-next-line no-await-in-loop -- cached table lookup
						const configPath = (await context.world.pathOf(hash)) ?? null;
						emissives.push({
							state: stateName,
							configHash: hashText(hash),
							configPath,
						});
					}
				}
			}
		}

		if (options.emissive !== undefined) {
			const matchedEmissives = emissives.filter(
				(e) =>
					(e.configPath !== null && options.emissive!.test(e.configPath)) ||
					options.emissive!.test(e.configHash),
			);
			if (matchedEmissives.length === 0) {
				return;
			}
		}
		if (options.filter !== undefined && !options.filter.test(JSON.stringify(vs.data, jsonReplacer))) {
			return;
		}
		rows.push({
			model,
			states,
			emissives,
			...(options.json ? { data: vs.data } : {}),
		});
	});

	rows.sort((a, b) => compareNatural(a.model, b.model));
	const shown = rows.slice(0, options.limit);
	if (options.json) {
		console.log(JSON.stringify(shown, jsonReplacer, '\t'));
	} else {
		for (const row of shown) {
			const emText =
				row.emissives.length === 0
					? ''
					: `  emissives: ${row.emissives
							.map((e) => `${e.state}→${e.configPath?.split('/').pop() ?? e.configHash}`)
							.join(', ')}`;
			console.log(`${row.model.padEnd(44)} states=${row.states.length}${emText}`);
		}
	}
	console.error(
		`${shown.length} of ${rows.length} view states (scanned ${models.length})${rows.length > options.limit ? ' (raise --limit for more)' : ''}`,
	);
};

// #endregion
