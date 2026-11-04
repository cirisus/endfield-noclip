/* oxlint-disable no-await-in-loop -- decode one level at a time and cache small template metadata */
import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

import { readInteractiveTable } from '@endfield-noclip/formats/endfield/interactive-model';
import { isObject } from '@endfield-noclip/formats/unity/values';

import { withContext } from '../context.ts';
import { interactionPoint, interactionRules } from '../game/interaction-rules.ts';
import { VfsGroup } from '../hg/vfs.ts';

export const summary = 'export build-bound placed interaction triggers and unresolved override scopes';
export const usage = 'usage: endfield-extract interaction-points <scene> -o <file> --config <config>';

/** @param args scene, output and local install config @returns after exporting placed interaction rules */
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
		const build = await ctx.world.manifest();
		const source = { buildGuid: build.guid, contentHash: build.contentHash };
		const pool = await ctx.world.stringPool(),
			reader = await ctx.memoryPack();
		const table = readInteractiveTable(await read('Data/Json/Interactive/InteractiveTable.json'), (id) =>
			pool.get(id),
		);
		const lookup = await ctx.world.pathLookup();
		const levels = [...(await ctx.world.levelConfigs()).values()].filter((level) => level.mapId === scene);
		if (!levels.length) {
			throw new Error(`unknown scene ${scene}`);
		}
		type Template = { value: unknown; rules: ReturnType<typeof interactionRules>; error: string | null };
		const templates = new Map<string, Template>(),
			points = [],
			errors = [];
		let files = 0;
		for (const level of levels) {
			for (const hash of level.levelDataPathHashes ?? []) {
				const path = lookup(hash);
				if (!path) {
					throw new Error('missing level data path');
				}
				const data = reader.decode(await read(path), 'Beyond_Gameplay_LevelDataForMemoryPack');
				if (!isObject(data) || !Array.isArray(data.interactives)) {
					throw new Error('invalid level interactives');
				}
				files++;
				for (const row of data.interactives) {
					if (!isObject(row) || typeof row.entityDataIdKey !== 'string') {
						throw new Error('invalid interactive identity');
					}
					const templateId = table.templates.get(row.entityDataIdKey);
					const templatePath = templateId === undefined ? undefined : table.templatePaths.get(templateId);
					let template: Template = { value: null, rules: null, error: 'missing template reference' };
					if (templatePath) {
						const cached = templates.get(templatePath);
						if (cached) {
							template = cached;
						} else {
							try {
								const value = reader.decode(
									await read(templatePath),
									'Beyond_Gameplay_InteractiveTemplateDataForMemoryPack',
								);
								template = {
									value,
									rules: interactionRules(value, { ...source, path: templatePath }),
									error: null,
								};
							} catch (error) {
								template = { value: null, rules: null, error: String(error) };
							}
							templates.set(templatePath, template);
						}
					}
					if (template.error) {
						errors.push({
							id: row.levelLogicId,
							level: level.id,
							template: row.entityDataIdKey,
							path: templatePath ?? null,
							error: template.error,
						});
					}
					points.push({
						...interactionPoint(row, level.id, template.value, template.rules),
						source: path,
						templatePath: templatePath ?? null,
					});
				}
			}
		}
		const counts = {
			levels: levels.length,
			files,
			templates: templates.size,
			points: points.length,
			withRules: points.filter((point) => point.rules).length,
			baseRuleCompatible: points.filter((point) => point.effective.status === 'base-rule-compatible').length,
			pointsWithTriggerOverrides: points.filter((point) =>
				Object.values(point.overrides.triggerCandidates).some((items) => items.length > 0),
			).length,
			overridesApplied: points.filter((point) => point.effective.status === 'overrides-applied').length,
			unresolvedRules: points.filter((point) => point.effective.status === 'unresolved').length,
			navigationGoals: points.filter((point) => point.navigationGoal).length,
			errors: errors.length,
		};
		await writeFile(
			values.output!,
			JSON.stringify(
				{
					version: 1,
					scene,
					source,
					coverage: { scope: 'authored-interactives', runtimeState: 'unresolved', ...counts },
					points,
					errors,
				},
				(_, value) => (typeof value === 'bigint' ? String(value) : value),
			),
		);
		console.log(counts);
	});
};
