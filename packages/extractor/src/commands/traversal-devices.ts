/* oxlint-disable no-await-in-loop -- decode and release level files, caching each small template once */
import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

import { readInteractiveTable } from '@endfield-noclip/formats/endfield/interactive-model';
import { isObject } from '@endfield-noclip/formats/unity/values';

import { withContext } from '../context.ts';
import { ropePairs, traversalDevice } from '../game/traversal-devices.ts';
import { VfsGroup } from '../hg/vfs.ts';

export const summary =
	'export rope references and movement-device parameters, without assuming traversal or unlock state';
export const usage = 'usage: endfield-extract traversal-devices <scene> -o <file> --config <config>';

/** @param args scene, output and install config @returns after exporting build-bound device inputs */
export const run = async (args: string[]): Promise<void> => {
	const { values, positionals } = parseArgs({
		args,
		allowPositionals: true,
		options: { output: { type: 'string', short: 'o' }, config: { type: 'string' } },
	});
	if (positionals.length !== 1 || !values.output) {
		throw new Error(usage);
	}
	const scene = positionals[0];
	await withContext(values.config, async (ctx) => {
		const read = async (path: string) => {
			const file = await ctx.vfs.find(VfsGroup.JsonData, path);
			if (!file) {
				throw new Error(`missing ${path}`);
			}
			return ctx.vfs.readVerified(file);
		};
		const pool = await ctx.world.stringPool(),
			reader = await ctx.memoryPack();
		const table = readInteractiveTable(await read('Data/Json/Interactive/InteractiveTable.json'), (id) =>
			pool.get(id),
		);
		const paths = await ctx.world.pathLookup();
		const levels = [...(await ctx.world.levelConfigs()).values()].filter((level) => level.mapId === scene);
		if (levels.length === 0) {
			throw new Error(`unknown scene ${scene}`);
		}
		const devices = [],
			templates = new Map<string, unknown>();
		let files = 0,
			autoSpawnedReferences = 0;
		for (const level of levels) {
			for (const hash of level.levelDataPathHashes ?? []) {
				const path = paths(hash);
				if (!path) {
					throw new Error('missing level path');
				}
				const data = reader.decode(await read(path), 'Beyond_Gameplay_LevelDataForMemoryPack');
				if (
					!isObject(data) ||
					!Array.isArray(data.interactives) ||
					!Array.isArray(data.autoSpawnedInteractives)
				) {
					throw new Error('invalid level interactives');
				}
				files++;
				autoSpawnedReferences += data.autoSpawnedInteractives.length;
				const spawned = new Set<string>();
				for (const id of data.autoSpawnedInteractives) {
					if (typeof id !== 'string' || !/^[1-9]\d*$/.test(id)) {
						throw new Error('invalid automatic spawn reference');
					}
					spawned.add(id);
				}
				for (const row of data.interactives) {
					const device = traversalDevice(row, level.id);
					if (!device) {
						continue;
					}
					devices.push({ ...device, source: path, autoSpawned: spawned.has(device.id) });
					if (!templates.has(device.template)) {
						const templateId = table.templates.get(device.template);
						const templatePath = templateId === undefined ? undefined : table.templatePaths.get(templateId);
						if (!templatePath) {
							throw new Error(`missing device template ${device.template}`);
						}
						const template = reader.decode(
							await read(templatePath),
							'Beyond_Gameplay_InteractiveTemplateDataForMemoryPack',
						);
						if (!isObject(template) || !Array.isArray(template.componentList)) {
							throw new Error('invalid device template');
						}
						const components = [];
						for (const component of template.componentList) {
							if (isObject(component) && Array.isArray(component.propertyList)) {
								components.push({ type: component.$type, properties: component.propertyList });
							}
						}
						templates.set(device.template, {
							source: templatePath,
							config: template.configProperties,
							saved: template.saveProperties,
							temporary: template.tempProperties,
							variants: template.templateVariant,
							components,
						});
					}
				}
			}
		}
		const ropes = ropePairs(devices),
			build = await ctx.world.manifest();
		await writeFile(
			values.output!,
			JSON.stringify({
				version: 1,
				scene,
				source: { buildGuid: build.guid, contentHash: build.contentHash },
				coverage: { levels: levels.length, files, autoSpawnedReferences, scope: 'authored-interactives' },
				devices,
				templates: Object.fromEntries(templates),
				ropes,
			}),
		);
		console.log(
			`${devices.length} devices, ${ropes.pairs.length} reciprocal rope pairs, ${ropes.unpaired.length} unpaired rope endpoints`,
		);
	});
};
