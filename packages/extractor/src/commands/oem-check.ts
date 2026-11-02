import { readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
	conditionResults,
	groupsShown,
	conditionVisible,
	resolveSceneValues,
} from '@endfield-noclip/package-format/conditions';
import { isNavigation, matchesNavigation } from '@endfield-noclip/package-format/navigation';
import { isCatalog, isCompanion } from '@endfield-noclip/package-format/oem';
import type { StatesInfo } from '@endfield-noclip/package-format/states';
import { completedProgressionPicks } from '@endfield-noclip/package-format/story';
import {
	areasShownIn,
	streamAreaValues,
	zonesAt,
	zonesAround,
} from '@endfield-noclip/package-format/stream-areas';

import { pointViewKey } from '../../../viewer/src/scene/point-view-cache.ts';

import { readCore } from './oem.ts';

export const summary = 'validate every archive, point and authored preset: oem-check <release-directory>';

/** command usage, available without opening the install */
export const usage = 'usage: oem-check <release-directory>';

export const run = async (args: string[]): Promise<void> => {
	if (args.length !== 1) {
		throw new Error(summary);
	}
	const root = resolve(args[0]);
	const value: unknown = JSON.parse(await readFile(join(root, 'index.json'), 'utf8'));
	if (!isCatalog(value)) {
		throw new Error('invalid OEM catalog');
	}
	const catalog = value;
	const cores = new Map<string, Awaited<ReturnType<typeof readCore>>>();
	let archives = 0,
		bytes = 0,
		points = 0,
		presets = 0,
		unknown = 0,
		views = 0,
		fallbackViews = 0;
	for (const [scene, entry] of Object.entries(catalog.packages)) {
		// oxlint-disable-next-line no-await-in-loop -- bound memory while opening scene cores
		const core = await readCore(join(root, entry.path));
		if (
			core.scene.id !== scene ||
			core.generation !== entry.generation ||
			core.version !== entry.version ||
			core.source.buildGuid !== catalog.source.buildGuid ||
			core.source.contentHash !== catalog.source.contentHash
		) {
			throw new Error(`package mismatch: ${scene}`);
		}
		cores.set(scene, core);
		for (const archive of core.archives) {
			// oxlint-disable-next-line no-await-in-loop -- metadata-only verification, no archive bodies read
			const size = (await stat(join(root, entry.path, archive.name))).size;
			if (archive.size !== null && archive.size !== size) {
				throw new Error(`archive size mismatch: ${scene}/${archive.name}`);
			}
			archives++;
			bytes += size;
		}
	}
	if (catalog.navigation) {
		const data: unknown = JSON.parse(await readFile(join(root, catalog.navigation), 'utf8'));
		if (
			!isNavigation(data) ||
			!matchesNavigation(data, catalog) ||
			data.routes.some((r) => !cores.get(r.scene)?.levels.some((l) => l.id === r.level))
		) {
			throw new Error('navigation release/source/level mismatch');
		}
	}
	const seen = new Set<string>();
	for (const [subregion, path] of Object.entries(catalog.files)) {
		// oxlint-disable-next-line no-await-in-loop -- release each partition before loading the next
		const partition: unknown = JSON.parse(await readFile(join(root, path), 'utf8'));
		if (!isCompanion(partition) || partition.release !== catalog.release) {
			throw new Error(`invalid companion: ${path}`);
		}
		const states = new Map<string, StatesInfo>();
		for (const point of partition.points) {
			if (seen.has(point.id) || point.subregion !== subregion || catalog.pointIndex[point.id] !== subregion) {
				throw new Error(`point index mismatch: ${point.id}`);
			}
			seen.add(point.id);
			points++;
			unknown += Number(point.unknown.length > 0);
			const base = cores.get(point.scene)?.states;
			if (!base || !cores.get(point.scene)?.levels.some((l) => l.id === point.level && l.instances > 0)) {
				throw new Error(`missing level: ${point.id}`);
			}
			let merged = states.get(point.scene);
			if (!merged) {
				merged = {
					...base,
					controls: [...new Map([...partition.controls, ...base.controls].map((c) => [c.id, c])).values()],
				};
				states.set(point.scene, merged);
			}
			if (catalog.framing) {
				if (!point.view) {
					throw new Error(`missing baked view: ${point.id}`);
				}
				const level = cores.get(point.scene)!.levels.find((l) => l.id === point.level)!;
				let picks = completedProgressionPicks(merged.controls);
				const areas = merged.streamAreas;
				if (areas) {
					let zones = zonesAt(areas, point.position);
					if (zones.size === 0) {
						zones = zonesAround(areas, point.position);
					}
					picks = { ...streamAreaValues(areas, areasShownIn(areas, zones)), ...picks };
				}
				const shown = groupsShown(
					merged,
					level.tag,
					conditionResults(merged, resolveSceneValues(merged, picks)),
				);
				// oxlint-disable-next-line no-await-in-loop -- validate each point against the exact selected profile
				const key = await pointViewKey(
					cores.get(point.scene)!.generation,
					point.level,
					point.position,
					shown,
				);
				if (
					point.view.key !== key ||
					Math.hypot(point.view.position[0] - point.position[0], point.view.position[2] - point.position[2]) <
						9.999
				) {
					throw new Error(`invalid baked view binding or distance: ${point.id}`);
				}
				for (const interaction of point.view.interactions ?? []) {
					const control = merged.controls.find((entry) => entry.id === interaction.control);
					if (
						!control ||
						control.derived !== null ||
						resolveSceneValues(merged, picks)[control.id] !== interaction.before ||
						!control.values.some((option) => option.value === interaction.after) ||
						!point.view.clear
					) {
						throw new Error(`invalid obstruction preview: ${point.id}`);
					}
				}
				views++;
				fallbackViews += Number(!point.view.clear);
			}
			for (const preset of point.presets) {
				presets++;
				if (
					point.condition &&
					conditionVisible(point.condition, resolveSceneValues(merged, preset.picks)) !== preset.satisfies
				) {
					throw new Error(`invalid preset: ${point.id}/${preset.id}`);
				}
			}
		}
	}
	if (catalog.framing && catalog.framing.points !== views) {
		throw new Error('baked view coverage mismatch');
	}
	if (seen.size !== Object.keys(catalog.pointIndex).length) {
		throw new Error('catalog contains points absent from its partitions');
	}
	console.log(
		JSON.stringify({
			release: catalog.release,
			scenes: cores.size,
			archives,
			bytes,
			points,
			presets,
			unknown,
			views,
			fallbackViews,
		}),
	);
};
