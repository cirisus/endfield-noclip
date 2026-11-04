import { createHash } from 'node:crypto';
/* oxlint-disable no-await-in-loop -- retain one selected collision export at a time */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs, isDeepStrictEqual } from 'node:util';

import { isObject, numberField, objectField } from '@endfield-noclip/formats/unity/values';

import { buildGroundTiles } from '@oem/ganglia/build';

import { parseInteger } from '../cli-args.ts';
import { withContext } from '../context.ts';
import {
	collisionGeometry,
	walkableCollisionIndices,
	type CollisionInputs,
} from '../game/collision-ground.ts';
import { collectCollisionInputs } from '../game/collision-inputs.ts';

export const summary =
	'build bounded player ground tiles from selected collision sources, including factory floors';
export const usage =
	'usage: endfield-extract player-ground <scene> --bounds <minX,minZ,maxX,maxZ> --scene-state <n> --area <n> --movement-settings <file> -o <ground-file> --collision-output <geometry-file> [--cell-size <m>] [--tile-cells <n>] --config <config>';

/**
 * @param args source selection, build-bound movement parameters and explicit world bounds
 * @returns after writing physical ground and collision evidence independently of AI navigation coverage
 * @throws on unsupported source geometry, missing selected payloads, mismatched builds or failed tile builds
 */
export const run = async (args: string[]): Promise<void> => {
	const { values, positionals } = parseArgs({
		args,
		allowPositionals: true,
		options: {
			bounds: { type: 'string' },
			'scene-state': { type: 'string' },
			area: { type: 'string' },
			'movement-settings': { type: 'string' },
			output: { type: 'string', short: 'o' },
			'collision-output': { type: 'string' },
			'cell-size': { type: 'string', default: '0.15' },
			'tile-cells': { type: 'string', default: '256' },
			config: { type: 'string' },
			'input-cache': { type: 'string' },
		},
	});
	if (
		positionals.length !== 1 ||
		!values.bounds ||
		values['scene-state'] === undefined ||
		values.area === undefined ||
		!values['movement-settings'] ||
		!values.output ||
		!values['collision-output'] ||
		values.output === values['collision-output']
	) {
		throw new Error(usage);
	}
	const bounds = values.bounds.split(',').map(Number);
	if (
		bounds.length !== 4 ||
		!bounds.every(Number.isFinite) ||
		bounds[0] >= bounds[2] ||
		bounds[1] >= bounds[3]
	) {
		throw new Error('invalid player ground bounds');
	}
	const minCell = [Math.floor(bounds[0] / 128) - 1, Math.floor(bounds[1] / 128) - 1];
	const maxCell = [Math.floor(bounds[2] / 128) + 1, Math.floor(bounds[3] / 128) + 1];
	const cellCount = (maxCell[0] - minCell[0] + 1) * (maxCell[1] - minCell[1] + 1);
	if (![...minCell, ...maxCell, cellCount].every(Number.isSafeInteger) || cellCount > 512) {
		throw new Error('player ground region exceeds the collision cell budget');
	}
	const cellSize = Number(values['cell-size']);
	const tileCells = parseInteger(values['tile-cells'], '--tile-cells');
	const tileSpan = cellSize * tileCells;
	const tileRange = [
		Math.floor(bounds[0] / tileSpan),
		Math.floor(bounds[1] / tileSpan),
		Math.ceil(bounds[2] / tileSpan),
		Math.ceil(bounds[3] / tileSpan),
	];
	const tileCount = (tileRange[2] - tileRange[0]) * (tileRange[3] - tileRange[1]);
	if (
		!Number.isFinite(cellSize) ||
		cellSize <= 0 ||
		tileCells < 1 ||
		![...tileRange, tileCount].every(Number.isSafeInteger) ||
		tileCount > 512
	) {
		throw new Error('player ground resolution or tile budget is invalid');
	}
	const movement: unknown = JSON.parse(await readFile(values['movement-settings'], 'utf8'));
	if (
		!isObject(movement) ||
		!isObject(movement.source) ||
		!isObject(movement.defaultProfile) ||
		!Array.isArray(movement.assets)
	) {
		throw new Error('invalid movement export');
	}
	const asset = movement.assets.find(
		(a) => isObject(a) && typeof a.path === 'string' && a.path.endsWith('/MovementSetting_Default.asset'),
	);
	if (!isObject(asset) || !isObject(asset.settings)) {
		throw new Error('missing default movement settings');
	}
	const settings = asset.settings;
	const source = movement.source;
	const profile = {
		radius: numberField(movement.defaultProfile, 'radius'),
		height: numberField(movement.defaultProfile, 'height'),
	};
	const selection = {
		sceneState: parseInteger(values['scene-state'], '--scene-state'),
		area: parseInteger(values.area, '--area'),
		layerMask: numberField(objectField(settings, '_collidableLayers'), 'm_Bits'),
		solidsOnly: true,
	};
	const scene = positionals[0];
	await withContext(values.config, async (ctx) => {
		const manifest = await ctx.world.manifest();
		if (source.buildGuid !== manifest.guid || source.contentHash !== manifest.contentHash) {
			throw new Error('collision and movement sources must share a build');
		}
		const cells: ({ x: number; z: number } | 'global')[] = ['global'];
		// Adjacent cells may own geometry intersecting the region despite an outside actor origin.
		for (let x = minCell[0]; x <= maxCell[0]; x++) {
			for (let z = minCell[1]; z <= maxCell[1]; z++) {
				cells.push({ x, z });
			}
		}
		const cacheKey = createHash('sha256')
			.update(JSON.stringify({ source, scene, selection, format: 2 }))
			.digest('hex');
		const cacheDirectory = values['input-cache'] ? resolve(values['input-cache'], cacheKey) : null;
		if (cacheDirectory) {
			await mkdir(cacheDirectory, { recursive: true });
		}
		const inputs: CollisionInputs[] = [],
			absent = [];
		for (const cell of cells) {
			if (!(await ctx.world.cellChunkFiles(scene, cell, selection)).length) {
				absent.push(cell);
				continue;
			}
			const cacheFile = cacheDirectory
				? resolve(cacheDirectory, cell === 'global' ? 'global.json' : `${cell.x}_${cell.z}.json`)
				: null;
			let input: CollisionInputs | null = null;
			if (cacheFile) {
				try {
					const cached: CollisionInputs = JSON.parse(await readFile(cacheFile, 'utf8'));
					if (
						cached.version === 1 &&
						cached.scene === scene &&
						cached.source.buildGuid === source.buildGuid &&
						cached.source.contentHash === source.contentHash &&
						isDeepStrictEqual(cached.selection, selection) &&
						isDeepStrictEqual(cached.cell, cell)
					) {
						input = cached;
					}
				} catch {
					/* Missing or incomplete cache entries are rebuilt from verified source payloads. */
				}
			}
			if (!input) {
				input = await collectCollisionInputs(ctx, scene, cell, selection);
				if (cacheFile) {
					const temporary = `${cacheFile}.${process.pid}.tmp`;
					await writeFile(temporary, JSON.stringify(input));
					await rename(temporary, cacheFile);
				}
			}
			inputs.push(input);
			console.log(JSON.stringify({ phase: 'collision-inputs', cell, actors: input.actors.length }));
		}
		const geometry = collisionGeometry(inputs, {
			walkableLayers: numberField(objectField(settings, '_walkableLayers'), 'm_Bits'),
		});
		const buildIndices = walkableCollisionIndices(geometry);
		const options = {
			profile,
			maxSlope: numberField(settings, '_slopeLimit'),
			stepUp: numberField(settings, '_stepOffset'),
			stepDown: numberField(settings, '_stepDownOffset'),
			cellSize,
			cellHeight: 0.05,
			tileCells,
			bounds: {
				min: [bounds[0], bounds[1]] as [number, number],
				max: [bounds[2], bounds[3]] as [number, number],
			},
		};
		await writeFile(values['collision-output']!, JSON.stringify({ ...geometry, options, absent }));
		const ground = await buildGroundTiles({ positions: geometry.positions, indices: buildIndices }, options);
		await writeFile(
			values.output!,
			JSON.stringify({
				version: 1,
				source: geometry.source,
				scene,
				selection,
				coverage: geometry.coverage,
				absent,
				build: options,
				tiles: ground.tiles,
				surfaces: ground.surfaces,
				options: {
					speed: numberField(settings, '_runSpeed'),
					maxVertical: 0.5,
					profile,
					walls: geometry.exclusions,
					portals: ground.portals,
					locomotion: movement.sustainedSprint,
				},
			}),
		);
		console.log(
			JSON.stringify({
				phase: 'ground',
				tiles: ground.tiles.length,
				surfaces: ground.surfaces.length,
				portals: ground.portals.length,
			}),
		);
	});
};
