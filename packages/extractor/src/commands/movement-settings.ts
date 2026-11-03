/* oxlint-disable no-await-in-loop -- keep only one decoded asset at a time */
import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

import { withContext } from '../context.ts';
import { characterMovement } from '../game/character-movement.ts';

export const summary = 'export build-bound player movement settings separately from AI navigation settings';
export const usage = 'movement-settings -o <file> --config <config>';

/**
 * @param args output and local installation arguments
 * @returns after exporting movement assets and their variants without treating them as verified motion links
 * @throws if a required settings asset is missing or cannot be decoded
 */
export const run = async (args: string[]): Promise<void> => {
	const { values, positionals } = parseArgs({
		args,
		allowPositionals: true,
		options: { output: { type: 'string', short: 'o' }, config: { type: 'string' } },
	});
	if (positionals.length || !values.output) {
		throw new Error(usage);
	}
	await withContext(values.config, async (ctx) => {
		const paths = await ctx.world.pathHash(),
			resolver = await ctx.resolver();
		const prefix = 'Assets/Beyond/DynamicAssets/GameData/';
		const movement = 'GameplayConfig/MovementSetting/';
		const required = new Set([
			`${prefix}${movement}MovementSetting_Default.asset`,
			`${prefix}GameplayConfig/WorldSetting.asset`,
			`${prefix}NavMesh/DefaultNavMeshBuildData.asset`,
		]);
		const assets = [];
		const characters = [];
		for (const [hash, path] of paths.entries()) {
			const player = path.startsWith(`${prefix}${movement}`) && path.endsWith('.asset');
			const character = path.startsWith(`${prefix}CharacterData/data_chr_`) && path.endsWith('.asset');
			if (!player && !character && !required.has(path)) {
				continue;
			}
			const settings = await resolver.read(await resolver.findUnique({ hash, path }, 114));
			if (character) {
				characters.push({ path, ...characterMovement(settings) });
				continue;
			}
			assets.push({
				purpose: player ? 'player' : path.includes('/NavMesh/') ? 'ai-navigation' : 'world',
				path,
				settings,
			});
			required.delete(path);
		}
		if (required.size) {
			throw new Error(`missing movement settings: ${[...required].join(', ')}`);
		}
		assets.sort((a, b) => a.path.localeCompare(b.path));
		characters.sort((a, b) => a.id.localeCompare(b.id));
		const build = await ctx.world.manifest();
		await writeFile(
			values.output!,
			JSON.stringify(
				{
					version: 1,
					source: { buildGuid: build.guid, contentHash: build.contentHash },
					// authored inputs do not establish the applied capsule, active modifiers or collision-free trajectories.
					motionValidation: 'unresolved',
					assets,
					characters,
				},
				(_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value),
			),
		);
		console.log(
			JSON.stringify({
				assets: assets.length,
				characters: characters.length,
				motionValidation: 'unresolved',
			}),
		);
	});
};
