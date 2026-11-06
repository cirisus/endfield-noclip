/* oxlint-disable no-await-in-loop -- release each asset before loading the next */
import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

import { readNavTile } from '@endfield-noclip/formats/unity/navmesh';
import {
	arrayField,
	bytesField,
	isObject,
	objectField,
	vector3Field,
} from '@endfield-noclip/formats/unity/values';

import { withContext } from '../context.ts';

export const summary = 'export source-bound navigation tile topology without inventing player connectivity';
export const usage = 'usage: endfield-extract navmesh <scene> -o <file> [--limit n] --config <config>';

/**
 * @param args scene and output arguments @returns after decoding selected navigation assets; partial exports
 *   are explicitly marked
 */
export const run = async (args: string[]): Promise<void> => {
	const { values, positionals } = parseArgs({
		args,
		allowPositionals: true,
		options: {
			output: { type: 'string', short: 'o' },
			config: { type: 'string' },
			limit: { type: 'string' },
		},
	});
	if (positionals.length !== 1 || !values.output) {
		throw new Error(usage);
	}
	const limit = values.limit === undefined ? Infinity : Number(values.limit);
	if (!(limit > 0) || (limit !== Infinity && !Number.isInteger(limit))) {
		throw new Error('invalid limit');
	}
	await withContext(values.config, async (ctx) => {
		const resolver = await ctx.resolver(),
			build = await ctx.world.manifest();
		const prefix = `Assets/Beyond/DynamicAssets/Scenes/PC/${positionals[0]}/NavMeshChunks/`;
		const assets = [...(await ctx.world.pathHash()).entries()].filter(
			([, path]) => path.startsWith(prefix) && path.endsWith('_NavMeshChunkData.asset'),
		);
		if (!assets.length) {
			throw new Error('no navigation assets');
		}
		const rows = [];
		for (const [hash, path] of assets.slice(0, limit)) {
			const data = await resolver.read(await resolver.findUnique({ hash, path }, 238));
			const tiles = arrayField(data, 'm_NavMeshTiles').map((tile) => {
				if (!isObject(tile)) {
					throw new Error('invalid navmesh tile');
				}
				return readNavTile(bytesField(tile, 'm_MeshData'));
			});
			rows.push({
				asset: path.slice(prefix.length),
				position: vector3Field(data, 'm_Position'),
				rotation: objectField(data, 'm_Rotation'),
				settings: objectField(data, 'm_NavMeshBuildSettings'),
				tiles,
			});
		}
		await writeFile(
			values.output!,
			JSON.stringify({
				version: 1,
				scene: positionals[0],
				source: { buildGuid: build.guid, contentHash: build.contentHash },
				partial: rows.length !== assets.length,
				assets: rows,
			}),
		);
		console.log(
			JSON.stringify({
				assets: rows.length,
				totalAssets: assets.length,
				polygons: rows.reduce((n, row) => n + row.tiles.reduce((m, tile) => m + tile.polygons.length, 0), 0),
			}),
		);
	});
};
