import { createHash } from 'node:crypto';
import { open, readFile, mkdir, writeFile, rename, link } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import {
	conditionResults,
	groupsShown,
	resolveSceneValues,
} from '@endfield-noclip/package-format/conditions';
import { isNavigation, matchesNavigation } from '@endfield-noclip/package-format/navigation';
import {
	isCatalog,
	isCompanion,
	isPointView,
	type Companion,
	type Point,
} from '@endfield-noclip/package-format/oem';
import type { StatesInfo } from '@endfield-noclip/package-format/states';
import { completedProgressionPicks } from '@endfield-noclip/package-format/story';
import {
	areasShownIn,
	streamAreaValues,
	zonesAt,
	zonesAround,
} from '@endfield-noclip/package-format/stream-areas';
import { isTerrainHole, TERRAIN_PAGE_SAMPLES, terrainHeight } from '@endfield-noclip/package-format/terrain';
import { tileAt, tileId } from '@endfield-noclip/package-format/tiles';

import { decodeData } from '../../../viewer/src/package/decode-data.ts';
import type { DecodeJob, DecodePool } from '../../../viewer/src/package/decode-pool.ts';
import type { Decoded } from '../../../viewer/src/package/decode-protocol.ts';
import type { PackageSource } from '../../../viewer/src/package/package-source.ts';
import { openViewerPackage } from '../../../viewer/src/package/viewer-package.ts';
import { pointPreview } from '../../../viewer/src/scene/point-preview.ts';
import { pointViewKey } from '../../../viewer/src/scene/point-view-cache.ts';
import { buildTileTree } from '../../../viewer/src/scene/tile-tree.ts';

/* oxlint-disable no-await-in-loop -- process in scene order to bound memory and checkpoint deterministic output */
export const summary =
	'bake every completed-profile point view into a new immutable release: oem-views <release> -o <releases> --cache <work-directory>';

/** command usage, available without opening the install */
export const usage =
	'usage: oem-views <release> -o <releases> --cache <work-directory> [--scenes map01,map02] [--subregions WL_1,WL_2] [--points <id>,<id>]';

export const run = async (args: string[]): Promise<void> => {
	const { values, positionals } = parseArgs({
		args,
		allowPositionals: true,
		options: {
			output: { type: 'string', short: 'o' },
			cache: { type: 'string' },
			scenes: { type: 'string' },
			subregions: { type: 'string' },
			points: { type: 'string' },
		},
	});
	if (positionals.length !== 1 || !values.output || !values.cache) {
		throw new Error(summary);
	}
	const root = resolve(positionals[0]),
		output = resolve(values.output),
		cache = resolve(values.cache);
	const raw: unknown = JSON.parse(await readFile(join(root, 'index.json'), 'utf8'));
	if (!isCatalog(raw)) {
		throw new Error('invalid source OEM release');
	}
	const catalog = raw;
	const points = values.points ? new Set(values.points.split(',')) : null;
	const scenes = values.scenes ? new Set(values.scenes.split(',')) : null;
	const subregions = values.subregions ? new Set(values.subregions.split(',')) : null;
	if (subregions && [...subregions].some((id) => !Object.hasOwn(catalog.files, id))) {
		throw new Error('unknown framing partition');
	}
	if (scenes && [...scenes].some((scene) => !Object.hasOwn(catalog.packages, scene))) {
		throw new Error('unknown framing scene');
	}
	await mkdir(cache, { recursive: true });
	const partitions = new Map<string, Companion>();
	for (const [id, path] of Object.entries(catalog.files)) {
		const value: unknown = JSON.parse(await readFile(join(root, path), 'utf8'));
		if (!isCompanion(value) || value.release !== catalog.release) {
			throw new Error(`invalid companion ${id}`);
		}
		partitions.set(id, value);
	}
	if (
		points &&
		[...points].some((id) => ![...partitions.values()].some((p) => p.points.some((point) => point.id === id)))
	) {
		throw new Error('unknown framing point');
	}
	const decoder: Pick<DecodePool, 'run'> = {
		async run<J extends DecodeJob>(job: J): Promise<Extract<Decoded, { kind: J['kind'] }>> {
			const { response } = await decodeData({ ...job, id: 0 });
			if (response.kind === 'error' || response.kind !== job.kind) {
				throw new Error('offline decoder kind mismatch');
			}
			// The discriminant matches J; TypeScript cannot narrow a generic conditional return type.
			// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- discriminant checked against the generic job above
			return response as Extract<Decoded, { kind: J['kind'] }>;
		},
	};
	let count = 0,
		fallback = 0;
	const started = performance.now();
	for (const [scene, entry] of Object.entries(catalog.packages)) {
		if (scenes && !scenes.has(scene)) {
			continue;
		}
		const handles = new Map<string, ReturnType<typeof open>>();
		const handle = (path: string) => {
			let pending = handles.get(path);
			if (!pending) {
				pending = open(join(root, entry.path, path), 'r');
				handles.set(path, pending);
			}
			return pending;
		};
		const source: PackageSource = {
			label: scene,
			async readFile(path) {
				return Uint8Array.from(await readFile(join(root, entry.path, path)));
			},
			async readRange(path, range, signal) {
				signal?.throwIfAborted();
				const file = await handle(path);
				if ((await file.stat()).size !== range.fileSize) {
					throw new Error(`archive size mismatch ${scene}/${path}`);
				}
				const bytes = new Uint8Array(range.length);
				let offset = 0;
				while (offset < bytes.length) {
					const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, range.offset + offset);
					if (bytesRead === 0) {
						throw new Error(`short archive read ${path}`);
					}
					offset += bytesRead;
				}
				return bytes;
			},
		};
		try {
			const pkg = await openViewerPackage(source, () => {});
			if (
				pkg.manifest.generation !== entry.generation ||
				pkg.manifest.version !== entry.version ||
				pkg.manifest.source.buildGuid !== catalog.source.buildGuid ||
				pkg.manifest.source.contentHash !== catalog.source.contentHash
			) {
				throw new Error(`source mismatch ${scene}`);
			}
			const tree = buildTileTree(pkg.manifest, pkg.tree),
				heights = new Map<number, Uint16Array>();
			const terrain = pkg.manifest.terrain;
			const heightAt = (x: number, z: number): number | null => {
				if (!terrain) {
					return null;
				}
				for (let level = tree.terrainLeafLevel; level >= tree.terrainRootLevel; level--) {
					const node = tree.byId.get(tileId(tileAt(pkg.manifest.tree, level, x, z))),
						blob = node?.terrain?.blob;
					const samples = blob === undefined ? undefined : heights.get(blob);
					if (!node || !samples) {
						continue;
					}
					const side = TERRAIN_PAGE_SAMPLES,
						spacing = node.size / (side - 1),
						fx = Math.min(side - 1, Math.max(0, (x - node.minX) / spacing)),
						fz = Math.min(side - 1, Math.max(0, (z - node.minZ) / spacing));
					const sample = samples[Math.round(fz) * side + Math.round(fx)];
					return isTerrainHole(sample) ? null : terrainHeight(terrain, sample);
				}
				return null;
			};
			const prepareTerrain = async (point: Point) => {
				if (!terrain) {
					return;
				}
				for (let level = tree.terrainRootLevel; level <= tree.terrainLeafLevel; level++) {
					const min = tileAt(pkg.manifest.tree, level, point.position[0] - 16, point.position[2] - 16),
						max = tileAt(pkg.manifest.tree, level, point.position[0] + 16, point.position[2] + 16);
					for (let x = min.x; x <= max.x; x++) {
						for (let z = min.z; z <= max.z; z++) {
							const blob = tree.byId.get(tileId({ level, x, z }))?.terrain?.blob;
							if (blob === undefined || heights.has(blob)) {
								continue;
							}
							const record = pkg.blobs[blob];
							let data: ArrayBuffer;
							if (record.archive === 0) {
								data = await pkg.readCoreBlob(blob);
							} else {
								const range = pkg.blobRange(blob);
								data = (
									await source.readRange(range.path, {
										offset: range.start,
										length: range.length,
										fileSize: range.archiveSize,
									})
								).buffer;
							}
							const decoded = await decoder.run({
								kind: 'heights',
								data,
								codec: record.codec,
								rawLength: record.rawLength,
							});
							heights.set(blob, decoded.samples);
						}
					}
				}
			};
			for (const [subregion, partition] of partitions) {
				if (subregions && !subregions.has(subregion)) {
					continue;
				}
				const rows = partition.points
					.filter((p) => p.scene === scene && (!points || points.has(p.id)))
					.toSorted(
						(a, b) =>
							Math.floor(a.position[0] / 64) - Math.floor(b.position[0] / 64) ||
							Math.floor(a.position[2] / 64) - Math.floor(b.position[2] / 64),
					);
				if (rows.length === 0) {
					continue;
				}
				const controls = [
					...new Map([...partition.controls, ...pkg.manifest.states.controls].map((c) => [c.id, c])).values(),
				];
				const states: StatesInfo = { ...pkg.manifest.states, controls },
					completed = completedProgressionPicks(controls);
				const checkpoint = join(cache, `${scene}-${subregion}.json`);
				let saved: Record<string, NonNullable<Point['view']>> = {};
				try {
					const value: unknown = JSON.parse(await readFile(checkpoint, 'utf8'));
					if (
						!value ||
						typeof value !== 'object' ||
						Array.isArray(value) ||
						!Object.values(value).every(isPointView)
					) {
						throw new Error('invalid view checkpoint');
					}
					saved = Object.fromEntries(
						Object.entries(value).filter((item): item is [string, NonNullable<Point['view']>] =>
							isPointView(item[1]),
						),
					);
				} catch (error) {
					if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
						throw error;
					}
				}
				const flush = async () => {
					await writeFile(checkpoint + '.tmp', JSON.stringify(saved));
					await rename(checkpoint + '.tmp', checkpoint);
				};
				for (const point of rows) {
					const areas = states.streamAreas;
					let picks = completed;
					if (areas) {
						let zones = zonesAt(areas, point.position);
						if (zones.size === 0) {
							zones = zonesAround(areas, point.position);
						}
						picks = { ...streamAreaValues(areas, areasShownIn(areas, zones)), ...picks };
					}
					const level = pkg.manifest.levels.find((l) => l.id === point.level);
					if (!level) {
						throw new Error(`missing point level ${point.id}`);
					}
					const shown = groupsShown(
						states,
						level.tag,
						conditionResults(states, resolveSceneValues(states, picks)),
					);
					const key = await pointViewKey(pkg.manifest.generation, point.level, point.position, shown);
					let view = saved[point.id];
					if (!view || view.key !== key) {
						await prepareTerrain(point);
						const pose = await pointPreview(
							pkg,
							decoder,
							point.position,
							states,
							level.tag,
							picks,
							heightAt,
							new AbortController().signal,
						);
						view = { key, ...pose };
						saved[point.id] = view;
					}
					point.view = view;
					count++;
					fallback += Number(!view.clear);
					if (count % 100 === 0) {
						await flush();
						console.log(
							`${scene}: ${count} points, ${fallback} fallbacks, ${Math.round((performance.now() - started) / 1000)} s`,
						);
					}
					// Keep only height pages needed around the next target; instances/geometry have their own bounded cache.
					if (heights.size > 512) {
						heights.clear();
					}
				}
				await flush();
			}
		} finally {
			for (const file of handles.values()) {
				await (await file).close();
			}
		}
	}
	if (scenes || subregions || points) {
		console.log(
			JSON.stringify({
				scenes: scenes ? [...scenes] : null,
				subregions: subregions ? [...subregions] : null,
				points: count,
				fallback,
				seconds: Math.round((performance.now() - started) / 1000),
				checkpointOnly: true,
			}),
		);
		return;
	}
	const release = createHash('sha256')
		.update(JSON.stringify({ base: catalog.release, framing: 3, partitions: [...partitions] }))
		.digest('hex')
		.slice(0, 16);
	const destination = join(output, release);
	await mkdir(destination, { recursive: false });
	for (const entry of Object.values(catalog.packages)) {
		const dir = join(root, entry.path);
		// Only immutable release archives are linked; later pack operations replace different paths atomically.
		const core = await import('./oem.ts').then((m) => m.readCore(dir));
		for (const archive of core.archives) {
			const target = join(destination, entry.path, archive.name);
			await mkdir(dirname(target), { recursive: true });
			await link(join(dir, archive.name), target);
		}
	}
	for (const [id, partition] of partitions) {
		partition.release = release;
		const target = join(destination, catalog.files[id]);
		await mkdir(dirname(target), { recursive: true });
		await writeFile(target, JSON.stringify(partition));
	}
	if (catalog.navigation) {
		const navigation: unknown = JSON.parse(await readFile(join(root, catalog.navigation), 'utf8'));
		if (!isNavigation(navigation) || !matchesNavigation(navigation, catalog)) {
			throw new Error('invalid navigation companion');
		}
		await writeFile(join(destination, catalog.navigation), JSON.stringify({ ...navigation, release }));
	}
	await writeFile(
		join(destination, 'index.json'),
		JSON.stringify({ ...catalog, release, framing: { version: 5, profile: 'completed', points: count } }),
	);
	console.log(
		JSON.stringify({
			release,
			points: count,
			fallback,
			seconds: Math.round((performance.now() - started) / 1000),
			destination,
		}),
	);
};
