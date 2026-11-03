/* oxlint-disable no-await-in-loop -- decode one level file at a time to bound memory */
import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

import { isObject } from '@endfield-noclip/formats/unity/values';

import { withContext } from '../context.ts';
import { routeHazards } from '../game/route-hazards.ts';
import { VfsGroup } from '../hg/vfs.ts';

const vector = (value: unknown): number[] => {
	if (
		!Array.isArray(value) ||
		value.length !== 3 ||
		!value.every((v: unknown) => typeof v === 'number' && Number.isFinite(v))
	) {
		throw new Error('invalid wall vector');
	}
	return value.map(Number);
};

export const summary = 'export conservative air-wall and reset-zone exclusions from the current install';
export const usage = 'air-walls <scene> -o <file> --config <config>';

/**
 * @param args scene and output arguments @returns after exporting every authored level wall and reset zone,
 *   including disabled/conditional exclusions
 */
export const run = async (args: string[]): Promise<void> => {
	const { values, positionals } = parseArgs({
		args,
		allowPositionals: true,
		options: {
			output: { type: 'string', short: 'o' },
			config: { type: 'string' },
		},
	});
	if (positionals.length !== 1 || !values.output) {
		throw new Error(usage);
	}
	await withContext(values.config, async (ctx) => {
		const reader = await ctx.memoryPack(),
			paths = await ctx.world.pathLookup();
		const build = await ctx.world.manifest();
		const levels = [...(await ctx.world.levelConfigs()).values()].filter((c) => c.mapId === positionals[0]);
		if (!levels.length) {
			throw new Error('unknown scene');
		}
		const groups: unknown[] = [];
		const hazards: unknown[] = [];
		for (const level of levels) {
			for (const hash of level.levelDataPathHashes ?? []) {
				const path = paths(hash);
				if (!path) {
					throw new Error('missing level path');
				}
				// oxlint-disable-next-line no-await-in-loop -- bound retained decoded level data
				const file = await ctx.vfs.find(VfsGroup.JsonData, path);
				if (!file) {
					throw new Error(`missing ${path}`);
				}
				// oxlint-disable-next-line no-await-in-loop -- decode one level file at a time
				const data = reader.decode(
					await ctx.vfs.readVerified(file),
					'Beyond_Gameplay_LevelDataForMemoryPack',
				);
				if (!isObject(data) || !Array.isArray(data.airWalls)) {
					throw new Error('invalid level walls');
				}
				for (const zone of routeHazards(data)) {
					hazards.push({ ...zone, level: level.id, path });
				}
				for (const group of data.airWalls) {
					if (!isObject(group) || !Array.isArray(group.polyLineWalls)) {
						throw new Error('invalid wall group');
					}
					for (const wall of group.polyLineWalls) {
						if (
							!isObject(wall) ||
							!isObject(wall.bounds) ||
							!Array.isArray(wall.bounds.m_center) ||
							!Array.isArray(wall.bounds.m_size)
						) {
							throw new Error('missing wall bounds');
						}
						const center = vector(wall.bounds.m_center),
							size = vector(wall.bounds.m_size);
						if (size.some((v) => v < 0)) {
							throw new Error('negative wall size');
						}
						groups.push({
							level: level.id,
							groupId: group.groupId,
							scriptId: group.scriptId,
							slotId: group.slotId,
							defaultOn: group.defaultOn,
							condition: group.checkData,
							state: 'unknown',
							min: center.map((v, i) => v - size[i] / 2),
							max: center.map((v, i) => v + size[i] / 2),
							points: wall.posList,
							height: wall.heightRange,
							usage: wall.usage,
							navigationObstacle: wall.enableNavObstacle,
							pushDistance: wall.pushDis,
							padding: wall.usage === 4 && typeof wall.pushDis === 'number' ? Math.max(0, wall.pushDis) : 0,
						});
					}
				}
			}
		}
		await writeFile(
			values.output!,
			JSON.stringify(
				{
					version: 2,
					scene: positionals[0],
					source: { buildGuid: build.guid, contentHash: build.contentHash },
					walls: groups,
					hazards,
				},
				(_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value),
			),
		);
		console.log(JSON.stringify({ scene: positionals[0], walls: groups.length, hazards: hazards.length }));
	});
};
