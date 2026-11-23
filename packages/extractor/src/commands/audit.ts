import { createReadStream } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { BlobKind } from '@endfield-noclip/package-format/blobs';
import { resolveEnvironment, type EnvironmentSections } from '@endfield-noclip/package-format/environment';
import {
	ChainFlags,
	DrawRole,
	type Chain,
	type InstanceBlock,
} from '@endfield-noclip/package-format/instances';
import { CORE_PATHS } from '@endfield-noclip/package-format/manifest';
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
	parseIntegerSet,
	parseNumber,
	parseNumbers,
	parseOptionalInteger,
	separatePositionals,
} from '../cli-args.ts';
import { compareStrings } from '../compare.ts';
import { ignoreMissing } from '../errors.ts';
import { DEBUG_DIR, STAND_INS_FILE, type StandInReport, type UnsupportedInput } from '../pack/debug.ts';
import { PackedPackage, resolveCorePath } from '../pack/read-package.ts';

export const summary =
	'survey packed packages and debug data: list, core, tree, instances, materials, geometries, textures, stand-ins, interactives, water, env, irradiance';

/** command usage, available without opening the install */
export const usage = `usage:
  audit list [--has water-volumes|stand-ins|errors] [--dir <outDir>] [--json]
                                           summarize all packed packages under out/
  audit core <scene> [member] [--json]     list core.czar members or print a decoded/decompressed member
                                           (accepts CORE_PATHS shorthands: manifest, water, environment, …)
  audit tree <scene> [--at x,y,z] [--from x,y,z] [--blob <hash|id>] [--level n] [--limit n] [--json]
                                           inspect core.czar tile tree nodes, bounds, refs and distances
  audit instances <scene> [--name re] [--id N] [--blob <hash>] [--chain N] [--from x,y,z]
      [--limit n] [--json]                 trace packed instances to their blob, tile node and LOD chain
  audit materials <scene|all> [--id N[,…]] [--shader re] [--name re] [--unsupported] [--undrawn]
      [--gap re] [--error] [--packed] [--group] [--limit n] [--json]
                                           query debug/assets.json materials; --id is repeatable/comma-separated;
                                           --packed includes core.czar entry; --group tallies by shader/reason
  audit geometries <scene|all> [--id N[,…]] [--name re] [--unanimated] [--error] [--tangent-uv]
      [--packed] [--min-span m] [--stats] [--limit n] [--json]
                                           query debug/assets.json geometries; --packed/--min-span/--stats read
                                           core.czar geometry table (vertex counts, bounds, span)
  audit textures <scene> [--id N[,…]] [--name re] [--error] [--limit n] [--json]
                                           query debug/assets.json textures (by table id, name, or error)
  audit stand-ins <scene> [--reason re] [--name re] [--group] [--limit n] [--json]
                                           query debug/stand-ins.json; --group tallies by reason
  audit interactives <scene> [--reason re] [--group] [--limit n] [--json]
                                           query debug/unsupported-interactives.json
  audit water <scene> [--near x,y,z] [--radius m] [--config re] [--packed] [--json]
                                           summarize debug/water.json, or query packed core.czar surfaces/configs
  audit env <scene> [--phase re] [--post re] [--section re] [--packed] [--json]
                                           summarize debug/environments.json, or query packed phases/posts
  audit irradiance <scene> [--at x,y,z] [--json]
                                           summarize tables/irradiance.bin or decode raw probes at a world point

reads from out/<scene>/ (override with --dir <packageDir>); no game install required.`;

const OPTIONS = {
	config: { type: 'string' },
	dir: { type: 'string' },
	has: { type: 'string' },
	at: { type: 'string' },
	from: { type: 'string' },
	near: { type: 'string' },
	radius: { type: 'string' },
	blob: { type: 'string' },
	level: { type: 'string' },
	id: { type: 'string', multiple: true },
	chain: { type: 'string' },
	shader: { type: 'string' },
	name: { type: 'string' },
	reason: { type: 'string' },
	gap: { type: 'string' },
	phase: { type: 'string' },
	post: { type: 'string' },
	section: { type: 'string' },
	'min-span': { type: 'string' },
	unsupported: { type: 'boolean', default: false },
	undrawn: { type: 'boolean', default: false },
	error: { type: 'boolean', default: false },
	packed: { type: 'boolean', default: false },
	stats: { type: 'boolean', default: false },
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
	const [sub, scene, extra] = positionals;
	const limit = parseLimit(values.limit);
	const ids = parseIntegerSet(values.id, '--id');
	const outRoot = fileURLToPath(DEFAULT_OUT);

	if (sub === 'list') {
		await auditList(values.dir ?? outRoot, {
			has: values.has,
			json: values.json,
		});
		return;
	}

	const target = needArg(scene, 'scene', usage);
	const singleId = (): number | undefined => {
		if (ids === undefined) {
			return undefined;
		}
		if (ids.size > 1) {
			throw new Error(`audit ${sub} accepts only one --id`);
		}
		return [...ids][0];
	};

	if (target === 'all' && (sub === 'materials' || sub === 'geometries')) {
		const packages = await listPackedDirs(values.dir ?? outRoot);
		if (sub === 'materials') {
			await auditMaterialsMulti(packages, {
				ids,
				shader: optionalRegex(values.shader),
				name: optionalRegex(values.name),
				gap: optionalRegex(values.gap),
				unsupported: values.unsupported,
				undrawn: values.undrawn,
				error: values.error,
				packed: values.packed,
				group: values.group,
				limit,
				json: values.json,
			});
		} else {
			await auditGeometriesMulti(packages, {
				ids,
				name: optionalRegex(values.name),
				unanimated: values.unanimated,
				error: values.error,
				tangentUv: values['tangent-uv'],
				packed: values.packed || values['min-span'] !== undefined || values.stats,
				minSpan: values['min-span'] === undefined ? undefined : parseNumber(values['min-span'], '--min-span'),
				stats: values.stats,
				limit,
				json: values.json,
			});
		}
		return;
	}

	const packageDir = values.dir ?? join(outRoot, target);
	const debugDir = join(packageDir, DEBUG_DIR);

	switch (sub) {
		case 'core': {
			await auditCore(packageDir, extra, values.json);
			break;
		}
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
				id: singleId(),
				blob: values.blob?.toLowerCase(),
				chain: parseOptionalInteger(values.chain, '--chain'),
				from: values.from === undefined ? undefined : parseNumbers(values.from, 3, '--from'),
				limit,
				json: values.json,
			});
			break;
		}
		case 'materials': {
			await auditMaterials(packageDir, debugDir, {
				ids,
				shader: optionalRegex(values.shader),
				name: optionalRegex(values.name),
				gap: optionalRegex(values.gap),
				unsupported: values.unsupported,
				undrawn: values.undrawn,
				error: values.error,
				packed: values.packed,
				group: values.group,
				limit,
				json: values.json,
			});
			break;
		}
		case 'geometries': {
			await auditGeometries(packageDir, debugDir, {
				ids,
				name: optionalRegex(values.name),
				unanimated: values.unanimated,
				error: values.error,
				tangentUv: values['tangent-uv'],
				packed: values.packed || values['min-span'] !== undefined || values.stats,
				minSpan: values['min-span'] === undefined ? undefined : parseNumber(values['min-span'], '--min-span'),
				stats: values.stats,
				limit,
				json: values.json,
			});
			break;
		}
		case 'textures': {
			await auditTextures(debugDir, {
				ids,
				name: optionalRegex(values.name),
				error: values.error,
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
			await auditWater(packageDir, debugDir, {
				near: values.near === undefined ? undefined : parseNumbers(values.near, 3, '--near'),
				radius: values.radius === undefined ? 60 : parseNumber(values.radius, '--radius'),
				config: optionalRegex(values.config),
				packed: values.packed,
				json: values.json,
			});
			break;
		}
		case 'env': {
			await auditEnv(packageDir, debugDir, {
				phase: optionalRegex(values.phase),
				post: optionalRegex(values.post),
				section: optionalRegex(values.section),
				packed: values.packed,
				json: values.json,
			});
			break;
		}
		case 'irradiance': {
			await auditIrradiance(packageDir, {
				at: values.at === undefined ? undefined : parseNumbers(values.at, 3, '--at'),
				json: values.json,
			});
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

const listPackedDirs = async (outRoot: string): Promise<{ name: string; dir: string }[]> => {
	const entries = await ignoreMissing(readdir(outRoot, { withFileTypes: true }), []);
	const names = entries
		.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
		.map((entry) => entry.name)
		.toSorted(compareStrings);
	const out: { name: string; dir: string }[] = [];
	for (const name of names) {
		const dir = join(outRoot, name);
		// oxlint-disable-next-line no-await-in-loop -- few packed directories
		const pkg = await ignoreMissing(PackedPackage.open(dir), null);
		if (pkg !== null) {
			// oxlint-disable-next-line no-await-in-loop -- paired with open above
			await pkg[Symbol.asyncDispose]();
			out.push({ name, dir });
		}
	}
	return out;
};

// #region core

const CORE_SHORTHANDS = new Map<string, string>(Object.entries(CORE_PATHS).map(([key, path]) => [path, key]));

const auditCore = async (packageDir: string, member: string | undefined, json: boolean): Promise<void> => {
	await using pkg = await PackedPackage.open(packageDir);
	if (member === undefined) {
		const files = pkg.coreFiles().map((file) => ({
			path: file.path,
			shorthand: CORE_SHORTHANDS.get(file.path) ?? null,
			size: file.size,
		}));
		if (json) {
			console.log(JSON.stringify(files, null, '\t'));
			return;
		}
		for (const file of files) {
			const alias = file.shorthand === null ? '' : `  (${file.shorthand})`;
			console.log(`${String(file.size).padStart(10)}  ${file.path}${alias}`);
		}
		console.error(`${files.length} members in core.czar`);
		return;
	}

	const resolved = resolveCorePath(member);
	switch (resolved) {
		case CORE_PATHS.geometries: {
			const table = await pkg.geometries();
			const entries = Array.from({ length: table.count }, (_, id) => ({ id, ...table.entry(id) }));
			console.log(JSON.stringify(entries, null, '\t'));
			return;
		}
		case CORE_PATHS.blobs: {
			console.log(JSON.stringify(await pkg.blobs(), null, '\t'));
			return;
		}
		case CORE_PATHS.chains: {
			console.log(JSON.stringify(await pkg.chains(), null, '\t'));
			return;
		}
		case CORE_PATHS.tree: {
			console.log(JSON.stringify(await pkg.tree(), null, '\t'));
			return;
		}
		case CORE_PATHS.lights: {
			console.log(JSON.stringify(await pkg.lights(), null, '\t'));
			return;
		}
		case CORE_PATHS.luts: {
			const table = await pkg.luts();
			console.log(
				JSON.stringify(
					{
						curves: table.curves.length,
						gradients: table.gradients.length,
						shapeMeshes: table.shapeMeshes.map((m, i) => ({
							id: i,
							primSize: m.primSize,
							vertices: m.positions.length / 3,
							primitives: m.areaCdf.length,
							hasNormals: m.normals !== null,
							hasColor: m.hasColor,
							totalArea: m.areaCdf.at(-1) ?? 0,
						})),
					},
					null,
					'\t',
				),
			);
			return;
		}
		case CORE_PATHS.irradiance: {
			const table = await pkg.irradiance();
			const entries = Array.from({ length: table.keys.length }, (_, i) => ({
				key: `0x${table.keys[i].toString(16).padStart(8, '0')}`,
				level: table.keys[i] >>> 24,
				blob: table.blobs[i],
				group: table.groups[i],
			}));
			console.log(JSON.stringify(entries, null, '\t'));
			return;
		}
		default: {
			const bytes = await pkg.readCore(resolved);
			if (resolved.endsWith('.json') || resolved.endsWith('.json.zst')) {
				const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
				console.log(JSON.stringify(parsed, null, '\t'));
				return;
			}
			console.log(JSON.stringify({ path: resolved, bytes: bytes.byteLength }, null, '\t'));
		}
	}
};

// #endregion

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

interface DebugTextureRow {
	id?: number;
	object?: string;
	name?: string;
	error?: string | null;
}

interface DebugAssetsFile {
	geometries: DebugGeometryRow[];
	materials: DebugMaterialRow[];
	textures?: DebugTextureRow[];
}

interface AuditMaterialsOptions {
	ids: ReadonlySet<number> | undefined;
	shader: RegExp | undefined;
	name: RegExp | undefined;
	gap: RegExp | undefined;
	unsupported: boolean;
	undrawn: boolean;
	error: boolean;
	packed: boolean;
	group: boolean;
	limit: number;
	json: boolean;
}

const filterMaterials = (
	materials: readonly DebugMaterialRow[],
	options: AuditMaterialsOptions,
): (DebugMaterialRow & { id: number })[] => {
	const matched: (DebugMaterialRow & { id: number })[] = [];
	for (const [id, row] of materials.entries()) {
		if (options.ids !== undefined && !options.ids.has(id)) {
			continue;
		}
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
	return matched;
};

const formatMaterialStatus = (row: DebugMaterialRow): string => {
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
	return status.join('; ');
};

const auditMaterials = async (
	packageDir: string,
	debugDir: string,
	options: AuditMaterialsOptions,
): Promise<void> => {
	const { materials } = await readDebugJson<DebugAssetsFile>(debugDir, 'assets.json');
	const matched = filterMaterials(materials, options);

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
	if (options.packed) {
		await using pkg = await PackedPackage.open(packageDir);
		const table = await pkg.materials();
		const detailed = shown.map((row) => ({ ...row, packed: table.entries[row.id] ?? null }));
		const single = options.ids !== undefined && options.ids.size === 1 && detailed.length === 1;
		console.log(JSON.stringify(single ? detailed[0] : detailed, null, '\t'));
		console.error(
			`${shown.length} of ${matched.length} matching materials${matched.length > options.limit ? ' (raise --limit for more)' : ''}`,
		);
		return;
	}
	if (options.json) {
		console.log(JSON.stringify(shown, null, '\t'));
	} else {
		for (const row of shown) {
			const label = row.path ?? row.object ?? row.hash;
			console.log(
				`${String(row.id).padStart(5)}  ${(row.shader ?? '-').padEnd(34)} ${(row.name ?? '-').padEnd(40)} ${formatMaterialStatus(row)}  ${label}`,
			);
		}
	}
	console.error(
		`${shown.length} of ${matched.length} matching materials${matched.length > options.limit ? ' (raise --limit for more)' : ''}`,
	);
};

const auditMaterialsMulti = async (
	packages: readonly { name: string; dir: string }[],
	options: AuditMaterialsOptions,
): Promise<void> => {
	const matched: (DebugMaterialRow & { package: string; id: number; packed?: unknown })[] = [];
	for (const { name, dir } of packages) {
		// oxlint-disable-next-line no-await-in-loop -- reads small debug files per package
		const assets = await readOptionalJson<DebugAssetsFile>(join(dir, DEBUG_DIR, 'assets.json'));
		if (assets === null) {
			continue;
		}
		const rows = filterMaterials(assets.materials, options);
		if (rows.length === 0) {
			continue;
		}
		if (options.packed) {
			// oxlint-disable-next-line no-await-in-loop -- opens core.czar only for packages with matches
			await using pkg = await PackedPackage.open(dir);
			// oxlint-disable-next-line no-await-in-loop -- paired with open above
			const table = await pkg.materials();
			for (const row of rows) {
				matched.push({ package: name, ...row, packed: table.entries[row.id] ?? null });
			}
		} else {
			for (const row of rows) {
				matched.push({ package: name, ...row });
			}
		}
	}
	const shown = matched.slice(0, options.limit);
	if (options.json || options.packed) {
		console.log(JSON.stringify(shown, null, '\t'));
	} else {
		for (const row of shown) {
			const label = row.path ?? row.object ?? row.hash;
			console.log(
				`${row.package.padEnd(18)} ${String(row.id).padStart(5)}  ${(row.shader ?? '-').padEnd(30)} ${(row.name ?? '-').padEnd(36)} ${formatMaterialStatus(row)}  ${label}`,
			);
		}
	}
	console.error(
		`${shown.length} of ${matched.length} matching materials across ${packages.length} packages${matched.length > options.limit ? ' (raise --limit for more)' : ''}`,
	);
};

// #endregion

// #region geometries & textures

interface AuditGeometriesOptions {
	ids: ReadonlySet<number> | undefined;
	name: RegExp | undefined;
	unanimated: boolean;
	error: boolean;
	tangentUv: boolean;
	packed: boolean;
	minSpan: number | undefined;
	stats: boolean;
	limit: number;
	json: boolean;
}

interface DetailedGeometryRow extends DebugGeometryRow {
	id: number;
	package?: string;
	vertexCount?: number;
	indexCount?: number;
	submeshCount?: number;
	bounds?: Bounds;
	span?: number;
	attributes?: number;
}

const boundsSpan = (bounds: Bounds): number =>
	Math.max(bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1], bounds.max[2] - bounds.min[2]);

const collectGeometries = async (
	packageDir: string,
	debugDir: string,
	options: AuditGeometriesOptions,
	pkgName?: string,
): Promise<{ matched: DetailedGeometryRow[]; totalReady: number; totalVerts: number }> => {
	const { geometries } = await readDebugJson<DebugAssetsFile>(debugDir, 'assets.json');
	const anyFilter =
		options.ids !== undefined ||
		options.name !== undefined ||
		options.unanimated ||
		options.error ||
		options.tangentUv ||
		options.packed ||
		options.minSpan !== undefined ||
		options.stats;

	let table: Awaited<ReturnType<PackedPackage['geometries']>> | null = null;
	if (options.packed) {
		await using pkg = await PackedPackage.open(packageDir);
		table = await pkg.geometries();
	}

	let totalReady = 0;
	let totalVerts = 0;
	const matched: DetailedGeometryRow[] = [];
	for (const [id, row] of geometries.entries()) {
		const entry = table !== null && id < table.count ? table.entry(id) : null;
		const ready = entry !== null && entry.status === 'ready' ? entry : null;
		if (ready !== null) {
			totalReady++;
			totalVerts += ready.vertexCount;
		}
		if (!anyFilter) {
			if (row.error || row.unanimated || (row.tangentUvs?.length ?? 0) > 1) {
				matched.push({ ...(pkgName === undefined ? {} : { package: pkgName }), id, ...row });
			}
			continue;
		}
		if (options.ids !== undefined && !options.ids.has(id)) {
			continue;
		}
		if (
			options.name !== undefined &&
			!options.name.test(row.name ?? '') &&
			!options.name.test(row.path ?? '')
		) {
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
		const span = ready === null ? undefined : boundsSpan(ready.bounds);
		if (options.minSpan !== undefined && (span === undefined || span < options.minSpan)) {
			continue;
		}
		const detail: DetailedGeometryRow = {
			...(pkgName === undefined ? {} : { package: pkgName }),
			id,
			...row,
			...(ready === null
				? {}
				: {
						vertexCount: ready.vertexCount,
						indexCount: ready.indexCount,
						submeshCount: ready.submeshCount,
						bounds: ready.bounds,
						span: +span!.toFixed(3),
						attributes: ready.attributes,
					}),
		};
		matched.push(detail);
	}
	return { matched, totalReady, totalVerts };
};

const SPAN_THRESHOLDS = [6.5, 10, 16, 32, 64] as const;

const summarizeGeometryStats = (
	label: string,
	rows: readonly DetailedGeometryRow[],
	totalReady: number,
	totalVerts: number,
) => {
	const readyRows = rows.filter((r) => r.vertexCount !== undefined);
	const matchedVerts = readyRows.reduce((sum, r) => sum + (r.vertexCount ?? 0), 0);
	const bySpan = SPAN_THRESHOLDS.map((threshold) => {
		const over = readyRows.filter((r) => (r.span ?? 0) > threshold);
		const verts = over.reduce((sum, r) => sum + (r.vertexCount ?? 0), 0);
		return { threshold, meshes: over.length, vertices: verts };
	});
	return { label, totalReady, totalVerts, matchedMeshes: readyRows.length, matchedVerts, bySpan };
};

const printGeometryStats = (stats: ReturnType<typeof summarizeGeometryStats>): void => {
	console.log(
		`${stats.label}: ${stats.matchedMeshes}/${stats.totalReady} ready meshes, ${(stats.matchedVerts / 1e6).toFixed(2)}M/${(stats.totalVerts / 1e6).toFixed(2)}M verts`,
	);
	for (const b of stats.bySpan) {
		const pct = stats.totalVerts === 0 ? 0 : (b.vertices / stats.totalVerts) * 100;
		console.log(
			`  span > ${String(b.threshold).padStart(4)}m: ${String(b.meshes).padStart(5)} meshes  ${(b.vertices / 1e6).toFixed(2).padStart(6)}M verts (${pct.toFixed(1)}%)`,
		);
	}
};

const auditGeometries = async (
	packageDir: string,
	debugDir: string,
	options: AuditGeometriesOptions,
): Promise<void> => {
	const { matched, totalReady, totalVerts } = await collectGeometries(packageDir, debugDir, options);
	if (options.stats) {
		const stats = summarizeGeometryStats(packageDir, matched, totalReady, totalVerts);
		if (options.json) {
			console.log(JSON.stringify(stats, null, '\t'));
		} else {
			printGeometryStats(stats);
		}
		return;
	}
	if (options.minSpan !== undefined) {
		matched.sort((a, b) => (b.span ?? 0) - (a.span ?? 0));
	}
	const shown = matched.slice(0, options.limit);
	if (options.json) {
		console.log(JSON.stringify(shown, null, '\t'));
	} else {
		for (const row of shown) {
			const notes: string[] = [];
			if (row.span !== undefined) {
				notes.push(`span=${row.span.toFixed(2)}m verts=${row.vertexCount}`);
			}
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

const auditGeometriesMulti = async (
	packages: readonly { name: string; dir: string }[],
	options: AuditGeometriesOptions,
): Promise<void> => {
	if (options.stats) {
		const allStats = [];
		for (const { name, dir } of packages) {
			// oxlint-disable-next-line no-await-in-loop -- reads one package at a time
			const { matched, totalReady, totalVerts } = await collectGeometries(
				dir,
				join(dir, DEBUG_DIR),
				options,
				name,
			);
			const stats = summarizeGeometryStats(name, matched, totalReady, totalVerts);
			allStats.push(stats);
			if (!options.json) {
				printGeometryStats(stats);
			}
		}
		if (options.json) {
			console.log(JSON.stringify(allStats, null, '\t'));
		}
		return;
	}

	const matched: DetailedGeometryRow[] = [];
	for (const { name, dir } of packages) {
		// oxlint-disable-next-line no-await-in-loop -- reads one package at a time
		const result = await collectGeometries(dir, join(dir, DEBUG_DIR), options, name);
		matched.push(...result.matched);
	}
	if (options.minSpan !== undefined) {
		matched.sort((a, b) => (b.span ?? 0) - (a.span ?? 0));
	}
	const shown = matched.slice(0, options.limit);
	if (options.json) {
		console.log(JSON.stringify(shown, null, '\t'));
	} else {
		for (const row of shown) {
			const span = row.span === undefined ? '' : `span=${row.span.toFixed(2)}m verts=${row.vertexCount}  `;
			console.log(
				`${(row.package ?? '').padEnd(18)} ${String(row.id).padStart(5)}  ${(row.name ?? '-').padEnd(32)} ${span}${row.path ?? row.object ?? row.hash}`,
			);
		}
	}
	console.error(`${shown.length} of ${matched.length} geometries across ${packages.length} packages`);
};

const auditTextures = async (
	debugDir: string,
	options: {
		ids: ReadonlySet<number> | undefined;
		name: RegExp | undefined;
		error: boolean;
		limit: number;
		json: boolean;
	},
): Promise<void> => {
	const { textures = [] } = await readDebugJson<DebugAssetsFile>(debugDir, 'assets.json');
	const matched: (DebugTextureRow & { id: number })[] = [];
	for (const [index, row] of textures.entries()) {
		const id = row.id ?? index;
		if (options.ids !== undefined && !options.ids.has(id)) {
			continue;
		}
		if (
			options.name !== undefined &&
			!options.name.test(row.name ?? '') &&
			!options.name.test(row.object ?? '')
		) {
			continue;
		}
		if (options.error && !row.error) {
			continue;
		}
		matched.push({ ...row, id });
	}
	const shown = matched.slice(0, options.limit);
	if (options.json) {
		const single = options.ids !== undefined && options.ids.size === 1 && shown.length === 1;
		console.log(JSON.stringify(single ? shown[0] : shown, null, '\t'));
	} else {
		for (const row of shown) {
			const err = row.error ? `  ERROR: ${row.error}` : '';
			console.log(
				`${String(row.id).padStart(6)}  ${(row.name ?? '-').padEnd(44)} ${row.object ?? '-'}${err}`,
			);
		}
	}
	console.error(
		`${shown.length} of ${matched.length} textures${matched.length > options.limit ? ' (raise --limit for more)' : ''}`,
	);
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

const auditWater = async (
	packageDir: string,
	debugDir: string,
	options: {
		near: number[] | undefined;
		radius: number;
		config: RegExp | undefined;
		packed: boolean;
		json: boolean;
	},
): Promise<void> => {
	if (options.near !== undefined || options.config !== undefined || options.packed) {
		await using pkg = await PackedPackage.open(packageDir);
		const table = await pkg.water();
		const surfaces = table.surfaces
			.map((surface, index) => ({
				index,
				kind: surface.kind,
				entityId: surface.entityId,
				group: surface.group,
				configIndex: surface.config,
				configName: table.configs[surface.config]?.name ?? '(unknown)',
				distance: options.near === undefined ? null : boundsDistance(surface.bounds, options.near),
				bounds: surface.bounds,
			}))
			.filter((row) => {
				if (options.near !== undefined && row.distance! > options.radius) {
					return false;
				}
				if (options.config !== undefined && !options.config.test(row.configName)) {
					return false;
				}
				return true;
			})
			.toSorted((a, b) => (a.distance ?? 0) - (b.distance ?? 0) || a.index - b.index);
		const configIndices = new Set(surfaces.map((s) => s.configIndex));
		if (options.config !== undefined && options.near === undefined) {
			for (const [i, cfg] of table.configs.entries()) {
				if (options.config.test(cfg.name)) {
					configIndices.add(i);
				}
			}
		}
		const configs = [...configIndices]
			.toSorted((a, b) => a - b)
			.map((i) => ({ index: i, name: table.configs[i].name, values: table.configs[i].values }));
		if (options.json) {
			console.log(JSON.stringify({ surfaces, configs }, null, '\t'));
			return;
		}
		for (const s of surfaces) {
			const dist = s.distance === null ? '' : `d=${s.distance.toFixed(1)}m  `;
			console.log(
				`${dist}${s.kind.padEnd(6)}  cfg#${s.configIndex} ${s.configName.padEnd(28)} group=${s.group}  bounds=${formatBounds(s.bounds)}`,
			);
		}
		for (const cfg of configs) {
			console.log(`\n=== config #${cfg.index}: ${cfg.name} ===`);
			console.log(JSON.stringify(cfg.values, null, '\t'));
		}
		console.error(`${surfaces.length} matching surfaces, ${configs.length} configs`);
		return;
	}

	const data = await readDebugJson<DebugWaterFile>(debugDir, 'water.json');
	if (options.json) {
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

const auditEnv = async (
	packageDir: string,
	debugDir: string,
	options: {
		phase: RegExp | undefined;
		post: RegExp | undefined;
		section: RegExp | undefined;
		packed: boolean;
		json: boolean;
	},
): Promise<void> => {
	if (
		options.phase !== undefined ||
		options.post !== undefined ||
		options.section !== undefined ||
		options.packed
	) {
		await using pkg = await PackedPackage.open(packageDir);
		const env = resolveEnvironment(await pkg.environment());
		const phases =
			options.post !== undefined && options.phase === undefined && options.section === undefined
				? []
				: env.phases
						.map((phase, index) => {
							const sections =
								options.section === undefined
									? phase.sections
									: (Object.fromEntries(
											Object.entries(phase.sections).filter(([key]) => options.section!.test(key)),
										) as Partial<EnvironmentSections>);
							return { index, name: phase.name, active: phase.active, sections };
						})
						.filter((p) => options.phase === undefined || options.phase.test(p.name));
		const posts =
			options.phase !== undefined && options.post === undefined
				? []
				: env.posts
						.map((post, index) => ({ index, name: post.name, profile: post }))
						.filter((p) => options.post === undefined || options.post.test(p.name));
		if (options.json) {
			console.log(JSON.stringify({ phases, posts }, null, '\t'));
			return;
		}
		if (options.phase === undefined && options.section === undefined && options.post === undefined) {
			console.log(`phases (${phases.length}):`);
			for (const p of phases) {
				console.log(`  ${String(p.index).padStart(3)}  ${p.name.padEnd(40)} active=${p.active.join(',')}`);
			}
			console.log(`\nposts (${posts.length}):`);
			for (const p of posts) {
				console.log(`  ${String(p.index).padStart(3)}  ${p.name}`);
			}
			return;
		}
		for (const p of phases) {
			console.log(`=== phase #${p.index}: ${p.name} (active: ${p.active.join(', ')}) ===`);
			console.log(JSON.stringify(p.sections, null, '\t'));
		}
		for (const p of posts) {
			console.log(`=== post #${p.index}: ${p.name} ===`);
			console.log(JSON.stringify(p.profile, null, '\t'));
		}
		return;
	}

	const data = await readDebugJson<DebugEnvFile>(debugDir, 'environments.json');
	if (options.json) {
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

// #region irradiance

const IRRADIANCE_ORIGIN = 8192;

const popcount32 = (n: number): number => {
	let x = n >>> 0;
	x -= (x >>> 1) & 0x55555555;
	x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
	return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
};

const unpackFloat16 = (half: number): number => {
	const exp = (half >>> 10) & 31;
	const mant = half & 1023;
	if (exp === 0) {
		return mant * 2 ** -24;
	}
	if (exp === 31) {
		return mant === 0 ? Number.POSITIVE_INFINITY : Number.NaN;
	}
	return (1 + mant / 1024) * 2 ** (exp - 15);
};

const unpackUnorm4 = (w: number): [number, number, number, number] => [
	(w & 255) / 255,
	((w >>> 8) & 255) / 255,
	((w >>> 16) & 255) / 255,
	((w >>> 24) & 255) / 255,
];

const unpackProbeWords = (u32: Uint32Array, at: number) => {
	const word = u32[at];
	const l0: [number, number, number] = [
		unpackFloat16((word << 4) & 0x7ff0),
		unpackFloat16((word >>> 7) & 0x7ff0),
		unpackFloat16((word >>> 17) & 0x7fe0),
	];
	const b0 = unpackUnorm4(u32[at + 1]);
	const b1 = unpackUnorm4(u32[at + 2]);
	const b2 = unpackUnorm4(u32[at + 3]);
	return { l0, b0, b1, b2 };
};

const findProbeWordInCell = (
	u32: Uint32Array,
	p: readonly [number, number, number],
	level: number,
): number => {
	const t = u32[0];
	const o = u32[1];
	const mask = (64 << level) - 1;
	const shift = 2 + 2 * level;
	const bx = (p[0] & mask) >> shift;
	const by = (p[1] & mask) >> shift;
	const bz = (p[2] & mask) >> shift;
	const sx = (p[0] >> (2 * level)) & 3;
	const sy = (p[1] >> (2 * level)) & 3;
	const sz = (p[2] >> (2 * level)) & 3;
	const bit = (((sx << 2) | sx) & 9) | (((sy << 3) | (sy << 1)) & 18) | (((sz << 4) | (sz << 2)) & 36);
	const oi = (bx % o) + (by % o) * o + (bz % o) * o * o;
	const offset = u32[2 + oi];
	const hx = (bx + (offset & 255)) % t;
	const hy = (by + ((offset >>> 8) & 255)) % t;
	const hz = (bz + ((offset >>> 16) & 255)) % t;
	const entry = 2 + o * o * o + (hx + hy * t + hz * t * t) * 4;
	if (u32[entry] !== (bx | (by << 8) | (bz << 16)) >>> 0) {
		return -1;
	}
	const lo = u32[entry + 2];
	const hi = u32[entry + 3];
	let below: number;
	if (bit < 32) {
		if (((lo >>> bit) & 1) === 0) {
			return -1;
		}
		below = popcount32(lo & ((1 << bit) - 1));
	} else {
		if (((hi >>> (bit - 32)) & 1) === 0) {
			return -1;
		}
		below = popcount32(lo) + popcount32(hi & ((1 << (bit - 32)) - 1));
	}
	return (u32[entry + 1] >>> 2) + below * 4;
};

const auditIrradiance = async (
	packageDir: string,
	options: { at: number[] | undefined; json: boolean },
): Promise<void> => {
	await using pkg = await PackedPackage.open(packageDir);
	const table = await pkg.irradiance();
	const regions = pkg.manifest.irradianceRegions;

	if (options.at === undefined) {
		const byLevel = new Map<number, number>();
		for (let i = 0; i < table.keys.length; i++) {
			const level = table.keys[i] >>> 24;
			byLevel.set(level, (byLevel.get(level) ?? 0) + 1);
		}
		const summaryData = {
			entries: table.keys.length,
			byLevel: Object.fromEntries([...byLevel.entries()].toSorted((a, b) => a[0] - b[0])),
			regions: regions.length,
		};
		if (options.json) {
			console.log(JSON.stringify(summaryData, null, '\t'));
			return;
		}
		console.log(
			`cells: ${summaryData.entries} (${Object.entries(summaryData.byLevel)
				.map(([l, n]) => `L${l}:${n}`)
				.join(' ')})  regions: ${summaryData.regions}`,
		);
		return;
	}

	const [wx, wy, wz] = options.at;
	const regionHits = [];
	const idx0: [number, number, number] = [Math.round(wx * 2), Math.round(wy * 2), Math.round(wz * 2)];
	for (const region of regions) {
		const lx = idx0[0] - region.origin[0];
		const ly = idx0[1] - region.origin[1];
		const lz = idx0[2] - region.origin[2];
		if (lx >= 0 && ly >= 0 && lz >= 0 && lx < region.size[0] && ly < region.size[1] && lz < region.size[2]) {
			// oxlint-disable-next-line no-await-in-loop -- at most a handful of overlapping regions
			const bytes = await pkg.readBlob(region.blob, BlobKind.Irradiance);
			const u32 = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >>> 2);
			const at = 4 * (lx + ly * region.size[0] + lz * region.size[0] * region.size[1]);
			regionHits.push({
				name: region.name,
				group: region.group,
				blob: region.blob,
				local: [lx, ly, lz],
				probe: unpackProbeWords(u32, at),
			});
		}
	}

	const levelHits = [];
	for (let level = 0; level <= 2; level++) {
		const spacing = 0.5 * (1 << (2 * level));
		const index: [number, number, number] = [
			Math.round(wx / spacing),
			Math.round(wy / spacing),
			Math.round(wz / spacing),
		];
		const p: [number, number, number] = [
			index[0] * (1 << (2 * level)) + IRRADIANCE_ORIGIN,
			index[1] * (1 << (2 * level)) + IRRADIANCE_ORIGIN,
			index[2] * (1 << (2 * level)) + IRRADIANCE_ORIGIN,
		];
		const cellShift = 6 + level;
		const cellSizeUnits = 1 << level;
		const cx = (p[0] >> cellShift) * cellSizeUnits;
		const cy = (p[1] >> cellShift) * cellSizeUnits;
		const cz = (p[2] >> cellShift) * cellSizeUnits;
		const key = (cx | (cy << 8) | (cz << 16) | (level << 24)) >>> 0;
		const matches = [];
		for (let i = 0; i < table.keys.length; i++) {
			if (table.keys[i] !== key) {
				continue;
			}
			const blob = table.blobs[i];
			const group = table.groups[i];
			// oxlint-disable-next-line no-await-in-loop -- at most 3 levels × few state bakes
			const bytes = await pkg.readBlob(blob, BlobKind.Irradiance);
			const u32 = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >>> 2);
			const at = findProbeWordInCell(u32, p, level);
			matches.push({
				group,
				blob,
				probe: at < 0 ? null : unpackProbeWords(u32, at),
			});
		}
		levelHits.push({
			level,
			spacing,
			probeWorld: [index[0] * spacing, index[1] * spacing, index[2] * spacing],
			cellKey: `0x${key.toString(16).padStart(8, '0')}`,
			bakes: matches,
		});
	}

	if (options.json) {
		console.log(JSON.stringify({ at: options.at, regions: regionHits, levels: levelHits }, null, '\t'));
		return;
	}
	for (const r of regionHits) {
		const l0 = r.probe.l0.map((v) => v.toFixed(4)).join(', ');
		console.log(
			`region ${r.name} (group=${r.group}, blob#${r.blob}): L0=[${l0}] valid=${r.probe.b0[3].toFixed(3)}`,
		);
	}
	for (const hit of levelHits) {
		const pos = hit.probeWorld.map((v) => v.toFixed(2)).join(', ');
		if (hit.bakes.length === 0) {
			console.log(`L${hit.level} (${hit.spacing}m, probe=[${pos}], key=${hit.cellKey}): no cell`);
			continue;
		}
		for (const bake of hit.bakes) {
			if (bake.probe === null) {
				console.log(
					`L${hit.level} (${hit.spacing}m, probe=[${pos}], key=${hit.cellKey}, group=${bake.group}): empty probe`,
				);
			} else {
				const l0 = bake.probe.l0.map((v) => v.toFixed(4)).join(', ');
				console.log(
					`L${hit.level} (${hit.spacing}m, probe=[${pos}], key=${hit.cellKey}, group=${bake.group}): L0=[${l0}] valid=${bake.probe.b0[3].toFixed(3)}`,
				);
			}
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
