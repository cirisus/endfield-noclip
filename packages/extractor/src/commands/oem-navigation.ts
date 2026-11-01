import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, link } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { isNavigation, type Navigation, type Volume } from '@endfield-noclip/package-format/navigation';
import { isCatalog, isCompanion, type Companion } from '@endfield-noclip/package-format/oem';

import { withContext } from '../context.ts';
import { VfsGroup } from '../hg/vfs.ts';

import { readCore } from './oem.ts';

/* oxlint-disable no-await-in-loop -- bound file handles and preserve deterministic source order */
const vector = (p: { x: number; y: number; z: number }): [number, number, number] => [p.x, p.y, p.z];

export const summary =
	'add source-authored navigation to a baked OEM release: oem-navigation <release> -o <releases> --config <config>';

/** @param args command arguments @returns after writing a new immutable release without copying model bytes */
export const run = async (args: string[]): Promise<void> => {
	const { values, positionals } = parseArgs({
		args,
		allowPositionals: true,
		options: { output: { type: 'string', short: 'o' }, config: { type: 'string' } },
	});
	if (positionals.length !== 1 || !values.output) {
		throw new Error(summary);
	}
	const root = resolve(positionals[0]),
		output = resolve(values.output);
	const catalog: unknown = JSON.parse(await readFile(join(root, 'index.json'), 'utf8'));
	if (!isCatalog(catalog)) {
		throw new Error('invalid OEM catalog');
	}
	await withContext(values.config, async (ctx) => {
		const build = await ctx.world.manifest();
		if (build.guid !== catalog.source.buildGuid || build.contentHash !== catalog.source.contentHash) {
			throw new Error('navigation game build differs from release');
		}
		const file = await ctx.vfs.find(VfsGroup.JsonData, 'Data/Json/GameplayConfig/MapRegionTable.json');
		if (!file) {
			throw new Error('missing MapRegionTable');
		}
		// Only normalized geometry is exported. The final validator rejects unsupported source fields/shapes.
		// The local game table is normalized below and isNavigation validates every emitted number and shape.
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- source table, strict output validation before writing
		const table = JSON.parse(new TextDecoder().decode(await ctx.vfs.readVerified(file))) as Record<
			string,
			{
				levelId: string;
				mapRegionType: number;
				tierIndex: number;
				priority: number;
				shapeList: {
					shapeType: number;
					position: { x: number; y: number; z: number };
					rotation: { x: number; y: number; z: number };
					size: { x: number; y: number; z: number };
					radius: number;
					polyLinePoints: { x: number; y: number }[];
				}[];
			}[]
		>;
		const rows = Object.values(table).flat();
		const levels = await ctx.world.levelConfigs();
		const navigation: Navigation = {
			version: 1,
			release: '',
			source: catalog.source,
			generations: {},
			routes: [],
		};
		const cores = new Map<string, Awaited<ReturnType<typeof readCore>>>();
		for (const [scene, pack] of Object.entries(catalog.packages)) {
			const core = await readCore(join(root, pack.path));
			if (
				core.generation !== pack.generation ||
				core.source.buildGuid !== build.guid ||
				core.source.contentHash !== build.contentHash
			) {
				throw new Error(`package mismatch ${scene}`);
			}
			cores.set(scene, core);
			navigation.generations[scene] = core.generation;
		}
		const partitions = new Map<string, Companion>();
		for (const [id, path] of Object.entries(catalog.files)) {
			const payload: unknown = JSON.parse(await readFile(join(root, path), 'utf8'));
			if (!isCompanion(payload) || payload.release !== catalog.release) {
				throw new Error(`invalid companion ${id}`);
			}
			partitions.set(id, payload);
			const keys = new Set<string>();
			for (const point of payload.points) {
				const key = `${point.scene}/${point.level}`;
				if (keys.has(key)) {
					continue;
				}
				keys.add(key);
				const level = cores.get(point.scene)?.levels.find((l) => l.id === point.level);
				if (!level) {
					throw new Error(`missing route level ${point.level}`);
				}
				navigation.routes.push({
					scene: point.scene,
					level: point.level,
					region: point.region,
					subregion: id,
					seamless: levels.get(point.level)?.isSeamless ?? false,
					bounds: level.contentBounds,
					volumes: rows
						.filter((r) => r.levelId === point.level && r.mapRegionType === 3)
						.map((r) => ({
							tier: r.tierIndex,
							priority: r.priority,
							shapes: r.shapeList.map((s): Volume => {
								if (![1, 2, 3].includes(s.shapeType)) {
									throw new Error('unsupported map volume');
								}
								return {
									kind: s.shapeType === 1 ? 'box' : s.shapeType === 2 ? 'sphere' : 'polygon',
									position: vector(s.position),
									rotation: vector(s.rotation),
									size: vector(s.size),
									radius: s.radius,
									points: s.polyLinePoints.map((p) => [p.x, p.y]),
								};
							}),
						})),
				});
			}
		}
		for (const route of navigation.routes) {
			if (route.seamless || route.volumes.length) {
				continue;
			}
			// Decorative content bounds can span kilometres. Without a tier volume, only the verified
			// gameplay-point footprint is evidence for entering this independent scene.
			const points = partitions
				.get(route.subregion)!
				.points.filter((p) => p.scene === route.scene && p.level === route.level);
			const min = (axis: number): number => Math.min(...points.map((p) => p.position[axis])) - 10;
			const max = (axis: number): number => Math.max(...points.map((p) => p.position[axis])) + 10;
			route.bounds = { min: [min(0), min(1), min(2)], max: [max(0), max(1), max(2)] };
		}
		if (!isNavigation(navigation)) {
			throw new Error('invalid navigation geometry');
		}
		const release = createHash('sha256')
			.update(JSON.stringify({ base: catalog.release, navigation }))
			.digest('hex')
			.slice(0, 16);
		navigation.release = release;
		const destination = join(output, release);
		await mkdir(destination, { recursive: false });
		for (const [scene, core] of cores) {
			for (const archive of core.archives) {
				const target = join(destination, catalog.packages[scene].path, archive.name);
				await mkdir(dirname(target), { recursive: true });
				await link(join(root, catalog.packages[scene].path, archive.name), target);
			}
		}
		for (const [id, payload] of partitions) {
			payload.release = release;
			const target = join(destination, catalog.files[id]);
			await mkdir(dirname(target), { recursive: true });
			await writeFile(target, JSON.stringify(payload));
		}
		await writeFile(join(destination, 'navigation.json'), JSON.stringify(navigation));
		await writeFile(
			join(destination, 'index.json'),
			JSON.stringify({ ...catalog, release, navigation: 'navigation.json' }),
		);
		console.log(
			JSON.stringify({
				release,
				routes: navigation.routes.length,
				volumes: navigation.routes.reduce((n, r) => n + r.volumes.length, 0),
				bytes: JSON.stringify(navigation).length,
			}),
		);
	});
};
