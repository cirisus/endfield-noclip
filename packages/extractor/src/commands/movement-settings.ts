/* oxlint-disable no-await-in-loop -- keep only one decoded asset at a time */
import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

import { parseSparkBean } from '@endfield-noclip/formats/hg/spark-buffer';
import { numberField } from '@endfield-noclip/formats/unity/values';

import { withContext } from '../context.ts';
import { characterMovement, commonCapsule } from '../game/character-movement.ts';
import { VfsGroup } from '../hg/vfs.ts';

export const summary = 'export build-bound player movement settings separately from AI navigation settings';
export const usage = 'usage: endfield-extract movement-settings -o <file> --config <config>';

const positive = (value: unknown, name: string): number => {
	if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
		throw new Error(`invalid movement setting ${name}`);
	}
	return value;
};

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
		const settings = assets.find((asset) => asset.path.endsWith('/MovementSetting_Default.asset'))!.settings;
		const constantsFile = await ctx.vfs.find(VfsGroup.Table, 'Data/TableCfg/GlobalConst.bytes');
		if (!constantsFile) {
			throw new Error('missing movement resource constants');
		}
		const constants = parseSparkBean(await ctx.vfs.readVerified(constantsFile));
		if (constants.name !== 'GlobalConst') {
			throw new Error('unexpected movement resource constants');
		}

		const energyCost = positive(constants.value.dashCostEnergyValue, 'dashCostEnergyValue');
		const capacity = positive(constants.value.maxDashEnergyLimit, 'maxDashEnergyLimit') / energyCost;
		const delay = numberField(settings, '_dashBlockRecoverTime');
		if (capacity < 1 || !Number.isFinite(delay) || delay < 0) {
			throw new Error('invalid sprint resource bounds');
		}
		// sprint activation shares the action resource. holding the gait does not repeatedly pay entry cost.
		// normalize capacity by one activation and initialize at the requested maximum, without regional buffs.
		const sustainedSprint = {
			speed: positive(numberField(settings, '_runSpeed'), '_runSpeed'),
			sprintSpeed: positive(numberField(settings, '_sprintSpeed'), '_sprintSpeed'),
			sprintAcceleration: positive(numberField(settings, '_sprintAcceleration'), '_sprintAcceleration'),
			// held sprint intent survives ordinary air transitions without a fresh input activation.
			sprintThrough: ['jump', 'drop'],
			stamina: {
				capacity,
				initial: capacity,
				activationCost: 1,
				sprintDrain: 0,
				recoveryRate: 1 / positive(numberField(settings, '_dashCd'), '_dashCd'),
				recoveryDelay: delay,
				reserve: 0,
				recoveryDuringSprint: true,
				recoveryDuringNonWalk: true,
			},
		};
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
					defaultProfile: commonCapsule(characters),
					sustainedSprint,
				},
				(_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value),
			),
		);
		console.log(
			JSON.stringify({
				assets: assets.length,
				characters: characters.length,
				sustainedSprint,
				motionValidation: 'unresolved',
			}),
		);
	});
};
