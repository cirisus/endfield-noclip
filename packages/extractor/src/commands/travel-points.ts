/* oxlint-disable no-await-in-loop -- decode and release each factory level in turn */
import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

import { isObject } from '@endfield-noclip/formats/unity/values';

import { withContext } from '../context.ts';
import { VfsGroup } from '../hg/vfs.ts';

export const summary = 'export map teleport landing positions; availability remains a player-state input';
export const usage = 'usage: endfield-extract travel-points -o <file> --config <config>';

/** @param args output and install config @returns after exporting authored camp landing positions */
export const run = async (args: string[]): Promise<void> => {
	const { values } = parseArgs({
		args,
		options: { output: { type: 'string', short: 'o' }, config: { type: 'string' } },
	});
	if (!values.output) {
		throw new Error(usage);
	}
	await withContext(values.config, async (ctx) => {
		const file = await ctx.vfs.find(
			VfsGroup.JsonData,
			'Data/Json/GameplayConfig/MapTeleportValidationDataTable.json',
		);
		if (!file) {
			throw new Error('missing map teleport data');
		}
		const reader = await ctx.memoryPack();
		const data = reader.decode(
			await ctx.vfs.readVerified(file),
			'Beyond_Gameplay_TeleportValidationDataTableForMemoryPack',
		);
		if (!isObject(data) || !Array.isArray(data.teleportValidationDatas)) {
			throw new Error('invalid teleport table');
		}
		const levels = await ctx.world.levelConfigs();
		const points = [],
			unmapped = [];
		for (const entry of data.teleportValidationDatas) {
			if (!Array.isArray(entry) || entry.length !== 2 || !isObject(entry[1])) {
				throw new Error('invalid teleport entry');
			}
			const row = entry[1];
			if (row.teleportReason !== 2 || typeof row.id !== 'string' || !row.id.startsWith('TpForMap_ent_')) {
				continue;
			}
			const position: unknown = row.position;
			if (
				typeof row.sceneId !== 'string' ||
				!Array.isArray(position) ||
				position.length !== 3 ||
				!position.every((v: unknown) => typeof v === 'number' && Number.isFinite(v))
			) {
				throw new Error('invalid teleport position');
			}
			const level = levels.get(row.sceneId);
			if (!level) {
				unmapped.push({ id: row.id, level: row.sceneId });
				continue;
			}
			points.push({
				id: row.id,
				kind: 'teleport',
				level: level.id,
				scene: level.mapId,
				position,
				availability: 'unknown',
			});
		}
		const paths = await ctx.world.pathLookup();
		const baseIds = new Set<string>();
		for (const level of levels.values()) {
			if (!level.mapId || !['map01', 'map02'].includes(level.mapId)) {
				continue;
			}
			for (const hash of level.levelDataPathHashes ?? []) {
				const path = paths(hash);
				if (!path) {
					throw new Error('missing factory level path');
				}
				const levelFile = await ctx.vfs.find(VfsGroup.JsonData, path);
				if (!levelFile) {
					throw new Error(`missing ${path}`);
				}
				const levelData = reader.decode(
					await ctx.vfs.readVerified(levelFile),
					'Beyond_Gameplay_LevelDataForMemoryPack',
				);
				if (!isObject(levelData) || !Array.isArray(levelData.factoryRegions)) {
					throw new Error('invalid factory regions');
				}
				for (const region of levelData.factoryRegions) {
					if (!isObject(region) || !Array.isArray(region.areas)) {
						throw new Error('invalid factory region');
					}
					for (const area of region.areas) {
						if (!isObject(area) || typeof area.isMain !== 'boolean') {
							continue;
						}
						const stageData: unknown = area.levelData;
						if (
							!Array.isArray(stageData) ||
							typeof region.regionId !== 'string' ||
							typeof area.index !== 'number' ||
							!Number.isInteger(area.index)
						) {
							throw new Error('invalid base area');
						}
						const stages = stageData.filter(isObject).toSorted((a, b) => Number(a.level) - Number(b.level));
						const stage = stages.at(-1);
						if (
							!stage ||
							!Array.isArray(stage.levelBounds) ||
							stage.levelBounds.length !== 1 ||
							!isObject(stage.levelBounds[0])
						) {
							throw new Error('unsupported multi-bound base centre');
						}
						const bounds = stage.levelBounds[0];
						const start: unknown = bounds.start,
							size: unknown = bounds.size;
						if (
							!Array.isArray(start) ||
							!Array.isArray(size) ||
							start.length !== 3 ||
							size.length !== 3 ||
							![...start, ...size].every((v: unknown) => typeof v === 'number' && Number.isFinite(v)) ||
							size.some((v: number) => v <= 0)
						) {
							throw new Error('invalid base bounds');
						}
						const id = `${region.regionId}:${String(area.index)}`;
						if (baseIds.has(id)) {
							throw new Error('duplicate base');
						}
						baseIds.add(id);
						points.push({
							id,
							kind: 'base',
							level: level.id,
							scene: level.mapId,
							position: start.map((v: number, i: number) => v + Number(size[i]) / 2),
							availability: 'unknown',
							approximate: true,
							requiresGroundProjection: true,
							groundRange: [Number(start[1]), Number(start[1]) + Number(size[1])],
							areaLevel: Number(stage.level),
						});
					}
				}
			}
		}
		const build = await ctx.world.manifest();
		await writeFile(
			values.output!,
			JSON.stringify({
				version: 1,
				source: { buildGuid: build.guid, contentHash: build.contentHash },
				points,
				unmapped,
			}),
		);
		console.log(JSON.stringify({ points: points.length, bases: baseIds.size, unmapped: unmapped.length }));
	});
};
