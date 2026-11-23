import { createReadStream } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import {
	ChainFlags,
	DrawRole,
	type Chain,
	type InstanceBlock,
} from '@endfield-noclip/package-format/instances';
import {
	CONTENT_KIND_NAMES,
	ContentKind,
	type ContentRef,
	type Tree,
	type TreeInfo,
	type TreeNode,
} from '@endfield-noclip/package-format/tree';
import type { Bounds, Rect } from '@endfield-noclip/package-format/values';

import {
	DEFAULT_OUT,
	need as needArg,
	parseNumbers,
	parseOptionalInteger,
	separatePositionals,
} from '../cli-args.ts';
import { compareStrings } from '../compare.ts';
import { ignoreMissing } from '../errors.ts';
import { DEBUG_DIR, STAND_INS_FILE, type StandInReport, type UnsupportedInput } from '../pack/debug.ts';
import { PackedPackage } from '../pack/read-package.ts';

export const summary =
	'survey packed packages and debug data: list, tree, instances, materials, geometries, stand-ins, interactives, water, env';

/** command usage, available without opening the install */
export const usage = `usage:
  audit list [--has water-volumes|stand-ins|errors] [--dir <outDir>] [--json]
                                           summarize all packed packages under out/
  audit tree <scene> [--at x,y,z] [--from x,y,z] [--blob <hash|id>] [--level n] [--limit n] [--json]
                                           inspect core.czar tile tree nodes, bounds, refs and distances
  audit instances <scene> [--name re] [--id N] [--blob <hash>] [--chain N] [--from x,y,z]
      [--limit n] [--json]                 trace packed instances to their blob, tile node and LOD chain
  audit materials <scene> [--shader re] [--name re] [--unsupported] [--undrawn] [--gap re] [--error]
      [--group] [--limit n] [--json]
                                           query debug/assets.json materials; --group tallies by shader/reason
  audit geometries <scene> [--unanimated] [--error] [--tangent-uv] [--limit n] [--json]
                                           query debug/assets.json geometries (VAT gaps, errors, tangent UVs)
  audit stand-ins <scene> [--reason re] [--name re] [--group] [--limit n] [--json]
                                           query debug/stand-ins.json; --group tallies by reason
  audit interactives <scene> [--reason re] [--group] [--limit n] [--json]
                                           query debug/unsupported-interactives.json
  audit water <scene> [--json]             summarize debug/water.json (surfaces, volumes, sectors, configs)
  audit env <scene> [--json]               summarize debug/environments.json (per-level base env & problems)

reads from out/<scene>/ (override with --dir <packageDir>); no game install required.`;

const OPTIONS = {
	config: { type: 'string' },
	dir: { type: 'string' },
	has: { type: 'string' },
	at: { type: 'string' },
	from: { type: 'string' },
	blob: { type: 'string' },
	level: { type: 'string' },
	id: { type: 'string' },
	chain: { type: 'string' },
	shader: { type: 'string' },
	name: { type: 'string' },
	reason: { type: 'string' },
	gap: { type: 'string' },
	unsupported: { type: 'boolean', default: false },
	undrawn: { type: 'boolean', default: false },
	error: { type: 'boolean', default: false },
	unanimated: { type: 'boolean', default: false },
	'tangent-uv': { type: 'boolean', default: false },
	group: { type: 'boolean', default: false },
	limit: { type: 'string' },
	json: { type: 'boolean', default: false },
} as const;

export const run = async (args: string[]): Promise<void> => {
	const { values, positionals } = parseArgs({
		args: separatePositionals(args, OPTIONS),
		allowPositionals: true,
		options: OPTIONS,
	});
	const [sub, scene] = positionals;
	const limit = parseLimit(values.limit);

	if (sub === 'list') {
		await auditList(values.dir ?? fileURLToPath(DEFAULT_OUT), {
			has: values.has,
			json: values.json,
		});
		return;
	}

	const target = needArg(scene, 'scene', usage);
	const packageDir = values.dir ?? join(fileURLToPath(DEFAULT_OUT), target);
	const debugDir = join(packageDir, DEBUG_DIR);

	switch (sub) {
		case 'tree': {
			await auditTree(packageDir, {
				at: values.at === undefined ? undefined : parseNumbers(values.at, 3, '--at'),
				from: values.from === undefined ? undefined : parseNumbers(values.from, 3, '--from'),
				blob: values.blob,
				level: parseOptionalInteger(values.level, '--level'),
				limit,
				json: values.json,
			});
			break;
		}
		case 'instances': {
			await auditInstances(packageDir, {
				name: optionalRegex(values.name),
				id: parseOptionalInteger(values.id, '--id'),
				blob: values.blob?.toLowerCase(),
				chain: parseOptionalInteger(values.chain, '--chain'),
				from: values.from === undefined ? undefined : parseNumbers(values.from, 3, '--from'),
				limit,
				json: values.json,
			});
			break;
		}
		case 'materials': {
			await auditMaterials(debugDir, {
				shader: optionalRegex(values.shader),
				name: optionalRegex(values.name),
				gap: optionalRegex(values.gap),
				unsupported: values.unsupported,
				undrawn: values.undrawn,
				error: values.error,
				group: values.group,
				limit,
				json: values.json,
			});
			break;
		}
		case 'geometries': {
			await auditGeometries(debugDir, {
				unanimated: values.unanimated,
				error: values.error,
				tangentUv: values['tangent-uv'],
				limit,
				json: values.json,
			});
			break;
		}
		case 'stand-ins': {
			await auditStandIns(debugDir, {
				reason: optionalRegex(values.reason),
				name: optionalRegex(values.name),
				group: values.group,
				limit,
				json: values.json,
			});
			break;
		}
		case 'interactives': {
			await auditInteractives(debugDir, {
				reason: optionalRegex(values.reason),
				group: values.group,
				limit,
				json: values.json,
			});
			break;
		}
		case 'water': {
			await auditWater(debugDir, values.json);
			break;
		}
		case 'env': {
			await auditEnv(debugDir, values.json);
			break;
		}
		default: {
			throw new Error(usage);
		}
	}
};

const optionalRegex = (pattern: string | undefined): RegExp | undefined =>
	pattern === undefined ? undefined : new RegExp(pattern, 'i');

const parseLimit = (text: string | undefined): number => {
	const limit = parseOptionalInteger(text, '--limit') ?? 100;
	if (limit < 1) {
		throw new Error('--limit must be a positive integer');
	}
	return limit;
};

const readDebugJson = async <T>(debugDir: string, file: string): Promise<T> => {
	const path = join(debugDir, file);
	try {
		const parsed: T = JSON.parse(await readFile(path, 'utf8'));
		return parsed;
	} catch (error) {
		if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
			throw new Error(`${path} not found; pack the scene first (\`pnpm extract pack <scene>\`)`, {
				cause: error,
			});
		}
		throw error;
	}
};

/** tallies items by key, descending by count, keeping up to 3 sample labels per bucket */
const tallyBy = <T>(
	items: readonly T[],
	keyOf: (item: T) => string,
	sampleOf: (item: T) => string,
): { key: string; count: number; samples: string[] }[] => {
	const groups = new Map<string, { key: string; count: number; samples: string[] }>();
	for (const item of items) {
		const key = keyOf(item);
		const bucket = groups.getOrInsertComputed(key, () => ({ key, count: 0, samples: [] }));
		bucket.count++;
		if (bucket.samples.length < 3) {
			const sample = sampleOf(item);
			if (!bucket.samples.includes(sample)) {
				bucket.samples.push(sample);
			}
		}
	}
	const sorted = [...groups.values()];
	sorted.sort((a, b) => b.count - a.count || compareStrings(a.key, b.key));
	return sorted;
};

// #region materials

interface DebugMaterialRow {
	hash: string;
	path: string | null;
	object?: string;
	name?: string;
	shader?: string;
	error?: string | null;
	unsupported?: string | null;
	undrawn?: string | null;
	keywordsNotDrawn?: string[];
	slotErrors?: Record<string, string>;
}

interface DebugGeometryRow {
	hash: string;
	path: string | null;
	object?: string;
	name?: string;
	error?: string | null;
	unanimated?: string;
	tangentUvs?: number[];
}

interface DebugAssetsFile {
	geometries: DebugGeometryRow[];
	materials: DebugMaterialRow[];
}

const auditMaterials = async (
	debugDir: string,
	options: {
		shader: RegExp | undefined;
		name: RegExp | undefined;
		gap: RegExp | undefined;
		unsupported: boolean;
		undrawn: boolean;
		error: boolean;
		group: boolean;
		limit: number;
		json: boolean;
	},
): Promise<void> => {
	const { materials } = await readDebugJson<DebugAssetsFile>(debugDir, 'assets.json');
	const matched: (DebugMaterialRow & { id: number })[] = [];
	for (const [id, row] of materials.entries()) {
		if (options.shader !== undefined && !options.shader.test(row.shader ?? '')) {
			continue;
		}
		if (
			options.name !== undefined &&
			!options.name.test(row.name ?? '') &&
			!options.name.test(row.path ?? '')
		) {
			continue;
		}
		if (options.unsupported && !row.unsupported) {
			continue;
		}
		if (options.undrawn && !row.undrawn) {
			continue;
		}
		if (options.error && !row.error && Object.keys(row.slotErrors ?? {}).length === 0) {
			continue;
		}
		if (
			options.gap !== undefined &&
			!(row.keywordsNotDrawn ?? []).some((keyword) => options.gap!.test(keyword))
		) {
			continue;
		}
		matched.push({ id, ...row });
	}

	if (options.group) {
		const groups = tallyBy(
			matched,
			(row) => {
				const shader = row.shader ?? '(no shader)';
				if (row.error) {
					return `${shader}  [error: ${row.error}]`;
				}
				if (row.unsupported) {
					return `${shader}  [unsupported: ${row.unsupported}]`;
				}
				if (row.undrawn) {
					return `${shader}  [undrawn: ${row.undrawn}]`;
				}
				if ((row.keywordsNotDrawn?.length ?? 0) > 0) {
					return `${shader}  [gaps: ${row.keywordsNotDrawn!.join(' ')}]`;
				}
				return shader;
			},
			(row) => row.name ?? row.path ?? row.hash,
		);
		const shown = groups.slice(0, options.limit);
		if (options.json) {
			console.log(JSON.stringify(shown, null, '\t'));
		} else {
			for (const g of shown) {
				console.log(`${String(g.count).padStart(5)}  ${g.key}  (e.g. ${g.samples.join(', ')})`);
			}
		}
		console.error(`${matched.length} materials in ${groups.length} groups`);
		return;
	}

	const shown = matched.slice(0, options.limit);
	if (options.json) {
		console.log(JSON.stringify(shown, null, '\t'));
	} else {
		for (const row of shown) {
			const status: string[] = [];
			if (row.error) {
				status.push(`ERROR: ${row.error}`);
			}
			if (row.unsupported) {
				status.push(`unsupported: ${row.unsupported}`);
			}
			if (row.undrawn) {
				status.push(`undrawn: ${row.undrawn}`);
			}
			if ((row.keywordsNotDrawn?.length ?? 0) > 0) {
				status.push(`gaps: ${row.keywordsNotDrawn!.join(' ')}`);
			}
			const label = row.path ?? row.object ?? row.hash;
			console.log(
				`${String(row.id).padStart(5)}  ${(row.shader ?? '-').padEnd(34)} ${(row.name ?? '-').padEnd(40)} ${status.join('; ')}  ${label}`,
			);
		}
	}
	console.error(
		`${shown.length} of ${matched.length} matching materials${matched.length > options.limit ? ' (raise --limit for more)' : ''}`,
	);
};

// #endregion

// #region geometries

const auditGeometries = async (
	debugDir: string,
	options: {
		unanimated: boolean;
		error: boolean;
		tangentUv: boolean;
		limit: number;
		json: boolean;
	},
): Promise<void> => {
	const { geometries } = await readDebugJson<DebugAssetsFile>(debugDir, 'assets.json');
	const anyFilter = options.unanimated || options.error || options.tangentUv;
	const matched: (DebugGeometryRow & { id: number })[] = [];
	for (const [id, row] of geometries.entries()) {
		if (!anyFilter) {
			if (row.error || row.unanimated || (row.tangentUvs?.length ?? 0) > 1) {
				matched.push({ id, ...row });
			}
			continue;
		}
		if (options.unanimated && !row.unanimated) {
			continue;
		}
		if (options.error && !row.error) {
			continue;
		}
		if (options.tangentUv && (row.tangentUvs?.length ?? 0) <= 1) {
			continue;
		}
		matched.push({ id, ...row });
	}
	const shown = matched.slice(0, options.limit);
	if (options.json) {
		console.log(JSON.stringify(shown, null, '\t'));
	} else {
		for (const row of shown) {
			const notes: string[] = [];
			if (row.error) {
				notes.push(`ERROR: ${row.error}`);
			}
			if (row.unanimated) {
				notes.push(`unanimated: ${row.unanimated}`);
			}
			if ((row.tangentUvs?.length ?? 0) > 1) {
				notes.push(`tangentUvs: ${row.tangentUvs!.join(',')}`);
			}
			console.log(
				`${String(row.id).padStart(5)}  ${(row.name ?? '-').padEnd(32)} ${notes.join('; ')}  ${row.path ?? row.object ?? row.hash}`,
			);
		}
	}
	console.error(`${shown.length} of ${matched.length} geometries`);
};

// #endregion

// #region stand-ins & interactives

const auditStandIns = async (
	debugDir: string,
	options: {
		reason: RegExp | undefined;
		name: RegExp | undefined;
		group: boolean;
		limit: number;
		json: boolean;
	},
): Promise<void> => {
	const rows = await readDebugJson<StandInReport[]>(debugDir, STAND_INS_FILE);
	const matched = rows.filter(
		(row) =>
			(options.reason === undefined || options.reason.test(row.reason)) &&
			(options.name === undefined || options.name.test(row.name) || options.name.test(row.path)),
	);
	if (options.group) {
		const groups = tallyBy(
			matched,
			(row) => row.reason,
			(row) => `${row.name} (${row.path.split('/').pop()})`,
		);
		const shown = groups.slice(0, options.limit);
		if (options.json) {
			console.log(JSON.stringify(shown, null, '\t'));
		} else {
			for (const g of shown) {
				console.log(`${String(g.count).padStart(5)}  ${g.key}  (e.g. ${g.samples.join(', ')})`);
			}
		}
		console.error(`${matched.length} stand-ins in ${groups.length} reasons`);
		return;
	}
	const shown = matched.slice(0, options.limit);
	if (options.json) {
		console.log(JSON.stringify(shown, null, '\t'));
	} else {
		for (const row of shown) {
			const pos = row.position === null ? '-' : row.position.join(',');
			console.log(`${pos.padEnd(20)} ${row.name.padEnd(32)} ${row.reason}  (${row.path})`);
		}
	}
	console.error(`${shown.length} of ${matched.length} stand-ins`);
};

const auditInteractives = async (
	debugDir: string,
	options: { reason: RegExp | undefined; group: boolean; limit: number; json: boolean },
): Promise<void> => {
	const rows = await readDebugJson<UnsupportedInput[]>(debugDir, 'unsupported-interactives.json');
	const matched = rows.filter((row) => options.reason === undefined || options.reason.test(row.reason));
	if (options.group) {
		const groups = tallyBy(
			matched,
			(row) => row.reason,
			(row) => row.path,
		);
		const shown = groups.slice(0, options.limit);
		if (options.json) {
			console.log(JSON.stringify(shown, null, '\t'));
		} else {
			for (const g of shown) {
				console.log(`${String(g.count).padStart(5)}  ${g.key}  (e.g. ${g.samples.join(', ')})`);
			}
		}
		console.error(`${matched.length} unsupported interactives in ${groups.length} reasons`);
		return;
	}
	const shown = matched.slice(0, options.limit);
	if (options.json) {
		console.log(JSON.stringify(shown, null, '\t'));
	} else {
		for (const row of shown) {
			console.log(`${row.path.padEnd(44)} ${row.reason}`);
		}
	}
	console.error(`${shown.length} of ${matched.length} unsupported interactives`);
};

// #endregion

// #region water & env

interface DebugWaterFile {
	surfaces: { scene: number; packed: number };
	volumes: { scene: number; packed: number };
	global: string | null;
	sectors: { scene: number; packed: number; untiled: number };
	untiledSectors: string[];
	rows: { config: string | null; mesh: string | null; renderTypeMask?: number }[];
	errors: { asset: string; reason: string }[];
}

const auditWater = async (debugDir: string, json: boolean): Promise<void> => {
	const data = await readDebugJson<DebugWaterFile>(debugDir, 'water.json');
	if (json) {
		console.log(JSON.stringify(data, null, '\t'));
		return;
	}
	console.log(
		`surfaces: ${data.surfaces.packed}/${data.surfaces.scene} packed  volumes: ${data.volumes.packed}/${data.volumes.scene} packed  global: ${data.global ?? '(none)'}`,
	);
	console.log(
		`sectors: ${data.sectors.packed}/${data.sectors.scene} packed (${data.sectors.untiled} untiled)  errors: ${data.errors.length}`,
	);
	const byConfig = tallyBy(
		data.rows,
		(row) => row.config?.split('/').pop() ?? '(none)',
		(row) => row.mesh?.split('##').pop() ?? '(volume)',
	);
	console.log(`\nby config (${byConfig.length}):`);
	for (const g of byConfig) {
		console.log(`  ${String(g.count).padStart(5)}  ${g.key}`);
	}
	if (data.errors.length > 0) {
		console.log(`\nerrors (${data.errors.length}):`);
		for (const err of data.errors.slice(0, 20)) {
			console.log(`  ${err.asset}: ${err.reason}`);
		}
	}
};

interface DebugEnvFile {
	levels: {
		level: string;
		volume: string | null;
		covered: number;
		shown: number;
		phase: string | null;
		post: string | null;
		error: string | null;
	}[];
	problems: { kind: string; volume: string; reason: string }[];
}

const auditEnv = async (debugDir: string, json: boolean): Promise<void> => {
	const data = await readDebugJson<DebugEnvFile>(debugDir, 'environments.json');
	if (json) {
		console.log(JSON.stringify(data, null, '\t'));
		return;
	}
	console.log(`levels (${data.levels.length}):`);
	for (const level of data.levels) {
		const cov = `${(level.covered * 100).toFixed(0)}%`;
		const err = level.error === null ? '' : `  ERROR: ${level.error}`;
		console.log(
			`  ${level.level.padEnd(14)} ${cov.padStart(4)}  phase=${(level.phase ?? '-').padEnd(34)} post=${level.post ?? '-'}${err}`,
		);
	}
	if (data.problems.length > 0) {
		console.log(`\nproblems (${data.problems.length}):`);
		for (const p of data.problems) {
			console.log(`  [${p.kind}] ${p.volume}: ${p.reason}`);
		}
	}
};

// #endregion

// #region list

const HAS_FILTERS = new Set(['water-volumes', 'stand-ins', 'errors']);

interface PackageSummary {
	dir: string;
	scene: string;
	name: string | null;
	version: number;
	levels: number;
	instances: number;
	archives: number;
	subset: string | null;
	waterSurfaces: number | null;
	waterVolumes: number | null;
	standIns: number | null;
	errors: number;
}

const readOptionalJson = async <T>(path: string): Promise<T | null> => {
	const text = await ignoreMissing(readFile(path, 'utf8'), null);
	if (text === null) {
		return null;
	}
	const parsed: T = JSON.parse(text);
	return parsed;
};

const auditList = async (
	outRoot: string,
	options: { has: string | undefined; json: boolean },
): Promise<void> => {
	if (options.has !== undefined && !HAS_FILTERS.has(options.has)) {
		throw new Error(`--has must be one of ${[...HAS_FILTERS].join(', ')}`);
	}
	const entries = await ignoreMissing(readdir(outRoot, { withFileTypes: true }), []);
	const dirs = entries
		.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
		.map((entry) => entry.name)
		.toSorted(compareStrings);

	const rows: PackageSummary[] = [];
	for (const name of dirs) {
		const dir = join(outRoot, name);
		// oxlint-disable-next-line no-await-in-loop -- few packed directories, keeps handle count low
		const pkg = await ignoreMissing(PackedPackage.open(dir), null);
		if (pkg === null) {
			continue;
		}
		let manifest;
		try {
			manifest = pkg.manifest;
		} finally {
			// oxlint-disable-next-line no-await-in-loop -- paired with open above
			await pkg[Symbol.asyncDispose]();
		}
		const debugDir = join(dir, DEBUG_DIR);
		// oxlint-disable-next-line no-await-in-loop -- reads small debug files per package
		const [water, standIns, assets] = await Promise.all([
			readOptionalJson<DebugWaterFile>(join(debugDir, 'water.json')),
			readOptionalJson<StandInReport[]>(join(debugDir, STAND_INS_FILE)),
			readOptionalJson<DebugAssetsFile>(join(debugDir, 'assets.json')),
		]);
		const assetErrors =
			assets === null
				? 0
				: assets.materials.filter((m) => Boolean(m.error) || Object.keys(m.slotErrors ?? {}).length > 0)
						.length + assets.geometries.filter((g) => Boolean(g.error)).length;
		const errors = assetErrors + (water?.errors.length ?? 0);
		let subset: string | null = null;
		if (manifest.subset !== null) {
			const parts: string[] = [];
			if (manifest.subset.level !== null) {
				parts.push(manifest.subset.level);
			}
			if (manifest.subset.bounds !== null) {
				const b = manifest.subset.bounds;
				parts.push(`bounds(${b.minX}..${b.maxX},${b.minZ}..${b.maxZ})`);
			}
			subset = parts.join(' ');
		}
		const row: PackageSummary = {
			dir: name,
			scene: manifest.scene.id,
			name: manifest.scene.name,
			version: manifest.version,
			levels: manifest.levels.length,
			instances: manifest.levels.reduce((sum, level) => sum + level.instances, 0),
			archives: manifest.archives.length,
			subset,
			waterSurfaces: water?.surfaces.packed ?? null,
			waterVolumes: water?.volumes.packed ?? null,
			standIns: standIns?.length ?? null,
			errors,
		};
		if (options.has === 'water-volumes' && (row.waterVolumes ?? 0) === 0) {
			continue;
		}
		if (options.has === 'stand-ins' && (row.standIns ?? 0) === 0) {
			continue;
		}
		if (options.has === 'errors' && row.errors === 0) {
			continue;
		}
		rows.push(row);
	}

	if (options.json) {
		console.log(JSON.stringify(rows, null, '\t'));
		return;
	}
	console.log('package               ver  levels  instances  water(s/v)  stand-ins  errors  subset');
	for (const row of rows) {
		const water = row.waterSurfaces === null ? '-' : `${row.waterSurfaces}/${row.waterVolumes ?? 0}`;
		const standIns = row.standIns === null ? '-' : String(row.standIns);
		console.log(
			`${row.dir.padEnd(20)} ${String(row.version).padStart(4)}  ${String(row.levels).padStart(6)}  ${String(row.instances).padStart(9)}  ${water.padStart(10)}  ${standIns.padStart(9)}  ${String(row.errors).padStart(6)}  ${row.subset ?? ''}`,
		);
	}
	console.error(`${rows.length} packed packages in ${outRoot}`);
};

// #endregion

// #region tree

const boundsDistance = (bounds: Bounds, point: readonly number[]): number => {
	const dx = Math.max(bounds.min[0] - point[0], 0, point[0] - bounds.max[0]);
	const dy = Math.max(bounds.min[1] - point[1], 0, point[1] - bounds.max[1]);
	const dz = Math.max(bounds.min[2] - point[2], 0, point[2] - bounds.max[2]);
	return Math.hypot(dx, dy, dz);
};

const boundsDistanceXZ = (bounds: Bounds, point: readonly number[]): number => {
	const dx = Math.max(bounds.min[0] - point[0], 0, point[0] - bounds.max[0]);
	const dz = Math.max(bounds.min[2] - point[2], 0, point[2] - bounds.max[2]);
	return Math.hypot(dx, dz);
};

const tileRect = (info: TreeInfo, node: Pick<TreeNode, 'level' | 'x' | 'z'>): Rect => {
	const size = info.rootSize / (1 << node.level);
	const minX = info.origin[0] + node.x * size;
	const minZ = info.origin[1] + node.z * size;
	return { minX, maxX: minX + size, minZ, maxZ: minZ + size };
};

const formatBounds = (bounds: Bounds): string =>
	`[${bounds.min.map((v) => v.toFixed(1)).join(',')}]..[${bounds.max.map((v) => v.toFixed(1)).join(',')}]`;

const formatReach = (reach: Rect): string =>
	`[${reach.minX.toFixed(0)}..${reach.maxX.toFixed(0)}, ${reach.minZ.toFixed(0)}..${reach.maxZ.toFixed(0)}]`;

const formatRef = (
	ref: ContentRef,
	hashes: ReadonlyMap<number, string>,
	reaches: readonly Rect[],
): string => {
	const kind = ref.kind === ContentKind.Hlod ? `hlod${ref.tier}` : CONTENT_KIND_NAMES[ref.kind];
	const hash = hashes.get(ref.blob);
	const hashText = hash === undefined ? '' : ` (${hash.slice(0, 12)})`;
	const slice = ref.first === 0 ? `${ref.count} rows` : `${ref.first}+${ref.count} rows`;
	const reach = ref.reach === null ? '' : ` reach=${formatReach(reaches[ref.reach])}`;
	return `${kind}  blob#${ref.blob}${hashText}  group=${ref.group}  ${slice}${reach}`;
};

const auditTree = async (
	packageDir: string,
	options: {
		at: number[] | undefined;
		from: number[] | undefined;
		blob: string | undefined;
		level: number | undefined;
		limit: number;
		json: boolean;
	},
): Promise<void> => {
	await using pkg = await PackedPackage.open(packageDir);
	const [tree, blobs] = await Promise.all([pkg.tree(), pkg.blobs()]);
	const info = pkg.manifest.tree;

	let blobId: number | undefined;
	if (options.blob !== undefined) {
		if (/^\d+$/.test(options.blob)) {
			blobId = Number(options.blob);
		} else {
			const lower = options.blob.toLowerCase();
			const located = await pkg.locateInstanceBlobs(new Set([lower]));
			blobId = located.get(lower);
			if (blobId === undefined) {
				throw new Error(`blob hash ${options.blob} not found in ${packageDir} instance archives`);
			}
		}
	}

	const hasFilter = options.at !== undefined || blobId !== undefined || options.level !== undefined;
	if (!hasFilter) {
		const byLevel = new Map<number, number>();
		for (const node of tree.nodes) {
			byLevel.set(node.level, (byLevel.get(node.level) ?? 0) + 1);
		}
		const byKind: Record<string, number> = {};
		for (const ref of tree.refs) {
			const name = CONTENT_KIND_NAMES[ref.kind];
			byKind[name] = (byKind[name] ?? 0) + 1;
		}
		const overview = {
			scene: pkg.manifest.scene.id,
			tree: info,
			nodes: tree.nodes.length,
			nodesByLevel: Object.fromEntries([...byLevel.entries()].toSorted((a, b) => a[0] - b[0])),
			refs: tree.refs.length,
			refsByKind: byKind,
			globalRefs: tree.global.length,
			reaches: tree.reaches.length,
			blobs: blobs.length,
		};
		if (options.json) {
			console.log(JSON.stringify(overview, null, '\t'));
			return;
		}
		console.log(
			`${overview.scene}: origin=(${info.origin.join(',')}) rootSize=${info.rootSize} leaf=${info.leafLevel} cell=${info.cellLevel} hlod=${info.hlodLevels.join(',')} shard=${info.shardLevel}`,
		);
		console.log(
			`nodes: ${overview.nodes} (${Object.entries(overview.nodesByLevel)
				.map(([l, n]) => `L${l}:${n}`)
				.join(' ')})`,
		);
		console.log(
			`refs: ${overview.refs} (${Object.entries(byKind)
				.map(([k, n]) => `${k}:${n}`)
				.join(' ')})  global: ${overview.globalRefs}  reaches: ${overview.reaches}  blobs: ${overview.blobs}`,
		);
		return;
	}

	const matchedNodes: {
		index: number;
		node: TreeNode;
		refs: ContentRef[];
		d3d: number | null;
		dXZ: number | null;
	}[] = [];
	for (const [index, node] of tree.nodes.entries()) {
		if (options.level !== undefined && node.level !== options.level) {
			continue;
		}
		if (options.at !== undefined) {
			const [x, , z] = options.at;
			const rect = tileRect(info, node);
			if (x < rect.minX || x >= rect.maxX || z < rect.minZ || z >= rect.maxZ) {
				continue;
			}
		}
		const slice = tree.refs.slice(node.refFirst, node.refFirst + node.refCount);
		const refs = blobId === undefined ? slice : slice.filter((ref) => ref.blob === blobId);
		if (blobId !== undefined && refs.length === 0) {
			continue;
		}
		const d3d = options.from === undefined ? null : boundsDistance(node.bounds, options.from);
		const dXZ = options.from === undefined ? null : boundsDistanceXZ(node.bounds, options.from);
		matchedNodes.push({ index, node, refs, d3d, dXZ });
	}
	if (options.from !== undefined && options.at === undefined) {
		matchedNodes.sort((a, b) => (a.d3d ?? 0) - (b.d3d ?? 0));
	}
	const globalMatches = blobId === undefined ? [] : tree.global.filter((ref) => ref.blob === blobId);

	const shown = matchedNodes.slice(0, options.limit);
	const refBlobIds = new Set<number>();
	for (const entry of shown) {
		for (const ref of entry.refs) {
			refBlobIds.add(ref.blob);
		}
	}
	for (const ref of globalMatches) {
		refBlobIds.add(ref.blob);
	}
	const hashes = await pkg.blobHashes(refBlobIds);

	const refJson = (ref: ContentRef) => ({
		kind: CONTENT_KIND_NAMES[ref.kind],
		tier: ref.tier,
		group: ref.group,
		blob: ref.blob,
		hash: hashes.get(ref.blob) ?? null,
		first: ref.first,
		count: ref.count,
		reach: ref.reach === null ? null : tree.reaches[ref.reach],
	});

	if (options.json) {
		console.log(
			JSON.stringify(
				{
					nodes: shown.map(({ index, node, refs, d3d, dXZ }) => ({
						index,
						level: node.level,
						x: node.x,
						z: node.z,
						tile: tileRect(info, node),
						bounds: node.bounds,
						geometricError: node.geometricError,
						...(d3d !== null ? { distance: +d3d.toFixed(2), distanceXZ: +dXZ!.toFixed(2) } : {}),
						refs: refs.map(refJson),
					})),
					...(globalMatches.length > 0 ? { global: globalMatches.map(refJson) } : {}),
				},
				null,
				'\t',
			),
		);
		return;
	}

	for (const { index, node, refs, d3d, dXZ } of shown) {
		const rect = tileRect(info, node);
		const dist = d3d === null ? '' : `  d=${d3d.toFixed(1)}m (xz ${dXZ!.toFixed(1)}m)`;
		console.log(
			`node #${index}  L${node.level} (${node.x},${node.z})  tile=[${rect.minX}..${rect.maxX}, ${rect.minZ}..${rect.maxZ}]  err=${node.geometricError.toFixed(1)}  bounds=${formatBounds(node.bounds)}${dist}`,
		);
		for (const ref of refs) {
			console.log(`  ${formatRef(ref, hashes, tree.reaches)}`);
		}
	}
	for (const ref of globalMatches) {
		console.log(`global  ${formatRef(ref, hashes, tree.reaches)}`);
	}
	console.error(
		`${shown.length} of ${matchedNodes.length} nodes${globalMatches.length > 0 ? `, ${globalMatches.length} global refs` : ''}${matchedNodes.length > options.limit ? ' (raise --limit for more)' : ''}`,
	);
};

// #endregion

// #region instances

interface InstanceLogLine {
	blob: string;
	rows: [id: number, name: string, fileIndex: number][];
}

interface TreePlacement {
	where: string;
	nodeIndex: number | null;
	level: number | null;
	x: number | null;
	z: number | null;
	kind: string;
	tier: number;
	group: number;
	bounds: Bounds | null;
	reach: Rect | null;
}

const indexBlobPlacements = (tree: Tree): Map<number, TreePlacement[]> => {
	const map = new Map<number, TreePlacement[]>();
	const add = (blob: number, placement: TreePlacement): void => {
		map.getOrInsertComputed(blob, () => []).push(placement);
	};
	for (const [nodeIndex, node] of tree.nodes.entries()) {
		for (let i = node.refFirst; i < node.refFirst + node.refCount; i++) {
			const ref = tree.refs[i];
			add(ref.blob, {
				where: `node #${nodeIndex} L${node.level} (${node.x},${node.z})`,
				nodeIndex,
				level: node.level,
				x: node.x,
				z: node.z,
				kind: ref.kind === ContentKind.Hlod ? `hlod${ref.tier}` : CONTENT_KIND_NAMES[ref.kind],
				tier: ref.tier,
				group: ref.group,
				bounds: node.bounds,
				reach: ref.reach === null ? null : tree.reaches[ref.reach],
			});
		}
	}
	for (const ref of tree.global) {
		add(ref.blob, {
			where: 'global',
			nodeIndex: null,
			level: null,
			x: null,
			z: null,
			kind: 'global',
			tier: ref.tier,
			group: ref.group,
			bounds: null,
			reach: ref.reach === null ? null : tree.reaches[ref.reach],
		});
	}
	return map;
};

const drawRoleName = (role: DrawRole): string => {
	switch (role) {
		case DrawRole.Lit: {
			return 'lit';
		}
		case DrawRole.ShadowOnly: {
			return 'shadow';
		}
		case DrawRole.Unsupported: {
			return 'stand-in';
		}
	}
};

const formatThreshold = (squared: number, isDistance: boolean): string => {
	if (squared < 0) {
		return '-inf';
	}
	if (squared >= 1e30) {
		return 'inf';
	}
	const value = Math.sqrt(squared);
	return isDistance ? `${value.toFixed(1)}m` : value.toFixed(4);
};

const summarizeChain = (
	chain: Chain,
	assets: DebugAssetsFile | null,
): { flags: string[]; draws: object[]; lines: string[] } => {
	const isDistance = (chain.flags & ChainFlags.CameraDistance) !== 0;
	const flags: string[] = [];
	if ((chain.flags & ChainFlags.BillboardFacing) !== 0) {
		flags.push('billboard-facing');
	}
	if ((chain.flags & ChainFlags.BillboardUpright) !== 0) {
		flags.push('billboard-upright');
	}
	if (isDistance) {
		flags.push('camera-distance');
	}
	const draws: object[] = [];
	const lines: string[] = [];
	for (const draw of chain.draws) {
		const geo = assets?.geometries[draw.geometry];
		const mat = draw.material === null ? null : assets?.materials[draw.material];
		const geoName = geo?.name ?? geo?.path ?? `geo#${draw.geometry}`;
		const matName = draw.material === null ? '(none)' : (mat?.name ?? mat?.path ?? `mat#${draw.material}`);
		const minText = formatThreshold(draw.minSquared, isDistance);
		const maxText = formatThreshold(draw.maxSquared, isDistance);
		draws.push({
			lod: draw.lod,
			role: drawRoleName(draw.role),
			geometry: draw.geometry,
			geometryName: geoName,
			material: draw.material,
			materialName: matName,
			submesh: draw.submesh,
			minSquared: draw.minSquared,
			maxSquared: draw.maxSquared,
			range: `${minText}..${maxText}`,
		});
		lines.push(
			`lod${draw.lod} [${minText}..${maxText}] ${drawRoleName(draw.role)}  ${geoName} (sub ${draw.submesh})  ${matName}`,
		);
	}
	return { flags, draws, lines };
};

const rowGeometry = (
	block: InstanceBlock,
	rowIndex: number,
): { chain: number; position: [number, number, number]; bounds: Bounds } => {
	const [ox, oy, oz] = block.origin;
	const t = rowIndex * 12;
	const b = rowIndex * 6;
	const cx = ox + block.bounds[b];
	const cy = oy + block.bounds[b + 1];
	const cz = oz + block.bounds[b + 2];
	const ex = block.bounds[b + 3];
	const ey = block.bounds[b + 4];
	const ez = block.bounds[b + 5];
	return {
		chain: block.chains[rowIndex],
		position: [ox + block.transforms[t + 3], oy + block.transforms[t + 7], oz + block.transforms[t + 11]],
		bounds: { min: [cx - ex, cy - ey, cz - ez], max: [cx + ex, cy + ey, cz + ez] },
	};
};

const auditInstances = async (
	packageDir: string,
	options: {
		name: RegExp | undefined;
		id: number | undefined;
		blob: string | undefined;
		chain: number | undefined;
		from: number[] | undefined;
		limit: number;
		json: boolean;
	},
): Promise<void> => {
	if (
		options.name === undefined &&
		options.id === undefined &&
		options.blob === undefined &&
		options.chain === undefined
	) {
		throw new Error('audit instances needs at least one of --name, --id, --blob, or --chain');
	}
	const debugDir = join(packageDir, DEBUG_DIR);
	const [chunkFiles, assets] = await Promise.all([
		readOptionalJson<string[]>(join(debugDir, 'chunk-files.json')),
		readOptionalJson<DebugAssetsFile>(join(debugDir, 'assets.json')),
	]);

	await using pkg = await PackedPackage.open(packageDir);
	const [tree, chains] = await Promise.all([pkg.tree(), pkg.chains()]);

	// if only --chain is given, show the chain summary directly and stop once enough rows match
	const preMatches: { blob: string; rowIndex: number; id: number; name: string; fileIndex: number }[] = [];
	const instancesPath = join(debugDir, 'instances.jsonl');
	const rl = createInterface({ input: createReadStream(instancesPath, 'utf8'), crlfDelay: Infinity });
	const idText = options.id === undefined ? undefined : String(options.id);
	const scanCap = options.chain === undefined ? options.limit : Math.max(options.limit * 20, 2000);
	for await (const line of rl) {
		if (line.length === 0) {
			continue;
		}
		if (options.blob !== undefined && !line.includes(options.blob)) {
			continue;
		}
		if (idText !== undefined && !line.includes(idText)) {
			continue;
		}
		const entry: InstanceLogLine = JSON.parse(line);
		if (options.blob !== undefined && entry.blob !== options.blob) {
			continue;
		}
		for (let i = 0; i < entry.rows.length; i++) {
			const [id, name, fileIndex] = entry.rows[i];
			if (options.id !== undefined && id !== options.id) {
				continue;
			}
			if (options.name !== undefined && !options.name.test(name)) {
				continue;
			}
			preMatches.push({ blob: entry.blob, rowIndex: i, id, name, fileIndex });
			if (preMatches.length >= scanCap) {
				break;
			}
		}
		if (preMatches.length >= scanCap) {
			rl.close();
			break;
		}
	}

	const blobHashes = new Set(preMatches.map((m) => m.blob));
	const located = await pkg.locateInstanceBlobs(blobHashes);
	const placements = indexBlobPlacements(tree);
	const decodedBlocks = new Map<number, InstanceBlock>();
	const blockFor = async (blobId: number): Promise<InstanceBlock> => {
		const cached = decodedBlocks.get(blobId);
		if (cached !== undefined) {
			return cached;
		}
		const block = await pkg.readInstanceBlock(blobId);
		decodedBlocks.set(blobId, block);
		return block;
	};

	const results: {
		id: number;
		name: string;
		source: string | null;
		blob: string;
		blobId: number | null;
		rowIndex: number;
		chain: number | null;
		position: [number, number, number] | null;
		bounds: Bounds | null;
		distance: number | null;
		distanceXZ: number | null;
		placements: (TreePlacement & { distance: number | null; distanceXZ: number | null })[];
		chainInfo: ReturnType<typeof summarizeChain> | null;
	}[] = [];

	for (const match of preMatches) {
		const blobId = located.get(match.blob) ?? null;
		// oxlint-disable-next-line no-await-in-loop -- few distinct blocks, cached per blobId
		const block = blobId === null ? null : await blockFor(blobId);
		const geom = block === null ? null : rowGeometry(block, match.rowIndex);
		if (options.chain !== undefined && geom?.chain !== options.chain) {
			continue;
		}
		const nodePlacements: (TreePlacement & { distance: number | null; distanceXZ: number | null })[] = [];
		for (const p of blobId === null ? [] : (placements.get(blobId) ?? [])) {
			nodePlacements.push({
				where: p.where,
				nodeIndex: p.nodeIndex,
				level: p.level,
				x: p.x,
				z: p.z,
				kind: p.kind,
				tier: p.tier,
				group: p.group,
				bounds: p.bounds,
				reach: p.reach,
				distance:
					options.from === undefined || p.bounds === null ? null : boundsDistance(p.bounds, options.from),
				distanceXZ:
					options.from === undefined || p.bounds === null ? null : boundsDistanceXZ(p.bounds, options.from),
			});
		}
		const chainObj = geom === null ? undefined : chains[geom.chain];
		results.push({
			id: match.id,
			name: match.name,
			source: chunkFiles?.[match.fileIndex] ?? null,
			blob: match.blob,
			blobId,
			rowIndex: match.rowIndex,
			chain: geom?.chain ?? null,
			position: geom?.position ?? null,
			bounds: geom?.bounds ?? null,
			distance:
				options.from === undefined || geom === null ? null : boundsDistance(geom.bounds, options.from),
			distanceXZ:
				options.from === undefined || geom === null ? null : boundsDistanceXZ(geom.bounds, options.from),
			placements: nodePlacements,
			chainInfo: chainObj === undefined ? null : summarizeChain(chainObj, assets),
		});
		if (results.length >= options.limit) {
			break;
		}
	}

	if (options.json) {
		console.log(
			JSON.stringify(
				results.map(({ chainInfo, ...rest }) => ({
					...rest,
					chainFlags: chainInfo?.flags ?? [],
					draws: chainInfo?.draws ?? [],
				})),
				null,
				'\t',
			),
		);
		return;
	}

	for (const r of results) {
		const pos = r.position === null ? '-' : r.position.map((v) => v.toFixed(1)).join(',');
		const dist = r.distance === null ? '' : `  d=${r.distance.toFixed(1)}m (xz ${r.distanceXZ!.toFixed(1)}m)`;
		console.log(
			`${r.name}  (id=${r.id}  pos=${pos}${dist}  chain=${r.chain ?? '-'}  blob=${r.blob.slice(0, 12)}#${r.blobId ?? '?'}[${r.rowIndex}])`,
		);
		if (r.source !== null) {
			console.log(`  source: ${r.source.split('/').pop()}`);
		}
		for (const p of r.placements) {
			const pDist =
				p.distance === null ? '' : `  d=${p.distance.toFixed(1)}m (xz ${p.distanceXZ!.toFixed(1)}m)`;
			const reach = p.reach === null ? '' : `  reach=${formatReach(p.reach)}`;
			console.log(`  tile: ${p.where}  ${p.kind}  group=${p.group}${pDist}${reach}`);
		}
		if (r.chainInfo !== null) {
			for (const line of r.chainInfo.lines) {
				console.log(`  ${line}`);
			}
		}
	}
	console.error(
		`${results.length} instances${results.length >= options.limit ? ' (limit reached; raise --limit for more)' : ''}`,
	);
};

// #endregion
