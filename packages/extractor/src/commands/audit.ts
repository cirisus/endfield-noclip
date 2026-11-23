import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { DEFAULT_OUT, need as needArg, parseOptionalInteger, separatePositionals } from '../cli-args.ts';
import { compareStrings } from '../compare.ts';
import { DEBUG_DIR, STAND_INS_FILE, type StandInReport, type UnsupportedInput } from '../pack/debug.ts';

export const summary = 'survey packed debug data: materials, geometries, stand-ins, interactives, water, env';

/** command usage, available without opening the install */
export const usage = `usage:
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

reads from out/<scene>/debug/ (override with --dir <packageDir>); no game install required.`;

const OPTIONS = {
	config: { type: 'string' },
	dir: { type: 'string' },
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
	const target = needArg(scene, 'scene', usage);
	const debugDir =
		values.dir !== undefined
			? join(values.dir, DEBUG_DIR)
			: join(fileURLToPath(DEFAULT_OUT), target, DEBUG_DIR);
	const limit = parseLimit(values.limit);

	switch (sub) {
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
