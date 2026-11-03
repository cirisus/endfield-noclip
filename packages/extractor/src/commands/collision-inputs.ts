/* oxlint-disable no-await-in-loop -- bound retained chunk data */
import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

import { readEcsCollider } from '@endfield-noclip/formats/endfield/ecs-collider';
import { parseStreamingChunk } from '@endfield-noclip/formats/endfield/streaming-chunk-data';

import { parseInteger } from '../cli-args.ts';
import { withContext } from '../context.ts';

export const summary =
	'export streamed collider poses, shapes, filters and asset bindings for one cell/state';
export const usage =
	'collision-inputs <scene> <x> <z> --scene-state <n> --area <n> -o <file> --config <config>';

/**
 * @param args explicit cell/state selection and output @returns after exporting collision inputs with
 *   coverage limits
 */
export const run = async (args: string[]): Promise<void> => {
	const { values, positionals } = parseArgs({
		args,
		allowPositionals: true,
		options: {
			output: { type: 'string', short: 'o' },
			config: { type: 'string' },
			'scene-state': { type: 'string' },
			area: { type: 'string' },
		},
	});
	if (
		positionals.length !== 3 ||
		!values.output ||
		values['scene-state'] === undefined ||
		values.area === undefined
	) {
		throw new Error(usage);
	}
	const [scene, x, z] = positionals;
	const cell = { x: parseInteger(x, 'x'), z: parseInteger(z, 'z') };
	const selection = {
		sceneState: parseInteger(values['scene-state'], '--scene-state'),
		area: parseInteger(values.area, '--area'),
	};
	await withContext(values.config, async (ctx) => {
		const files = await ctx.world.cellChunkFiles(scene, cell, selection);
		if (!files.length) {
			throw new Error('no chunks match the collision selection');
		}
		const actors = [];
		for (const file of files) {
			const payload = await ctx.world.readStreamingPayload(file);
			if (!payload) {
				throw new Error(`missing streaming collision input for ${file.name}`);
			}
			for (const row of parseStreamingChunk(payload).records) {
				for (const property of row.properties) {
					const component = property.key >>> 24;
					if (
						row.kind !== 2 ||
						![4, 5, 6, 7, 8, 9, 31].includes(component) ||
						(property.key & 0xffffff) !== 0
					) {
						continue;
					}
					if (property.value.type !== 'blob') {
						throw new Error('expected streamed collider blob');
					}
					const collider = readEcsCollider(property.value.value);
					const bindings = new Map<number, string>();
					for (const p of row.properties) {
						if (p.key >>> 16 !== ((component << 8) | 1)) {
							continue;
						}
						const index = p.key & 0xffff;
						if (
							p.value.type !== 'asset' ||
							p.value.kind !== (collider.terrain ? 3 : 2) ||
							bindings.has(index)
						) {
							throw new Error('invalid collider asset binding');
						}
						bindings.set(index, p.value.hash.toString());
					}
					const count = collider.terrain ? 1 : collider.meshCount;
					if (bindings.size !== count || [...bindings.keys()].some((i) => i >= count)) {
						throw new Error('incomplete collider asset bindings');
					}
					actors.push({
						id: row.id,
						component,
						file: file.name,
						collider,
						assets: Array.from({ length: count }, (_, i) => bindings.get(i)!),
					});
				}
			}
		}
		const build = await ctx.world.manifest();
		await writeFile(
			values.output!,
			JSON.stringify({
				version: 1,
				source: { buildGuid: build.guid, contentHash: build.contentHash },
				scene,
				cell,
				selection,
				coverage: {
					scope: 'streamed-ecs-cell',
					complete: false,
					files: files.map((f) => f.name),
					remaining: [
						'global-chunks',
						'mono-colliders',
						'interactive-prefabs',
						'foliage',
						'terrain-heightmaps',
						'player-layer-policy',
					],
				},
				actors,
			}),
		);
		console.log(`${actors.length} streamed collider actors; world coverage remains incomplete`);
	});
};
