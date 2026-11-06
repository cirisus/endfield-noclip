/* oxlint-disable no-await-in-loop -- bound retained chunk data */
import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

import { parseInteger } from '../cli-args.ts';
import { withContext } from '../context.ts';
import { collectCollisionInputs } from '../game/collision-inputs.ts';

export const summary =
	'export streamed collider poses, shapes, filters and cooked geometry for a cell or global chunk';
export const usage =
	'usage: endfield-extract collision-inputs <scene> <x> <z> | <scene> global --scene-state <n> --area <n> [--layers <uint32>] -o <file> --config <config>';

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
			layers: { type: 'string' },
		},
	});
	if (
		!(
			(positionals.length === 3 && positionals[1] !== 'global') ||
			(positionals.length === 2 && positionals[1] === 'global')
		) ||
		!values.output ||
		values['scene-state'] === undefined ||
		values.area === undefined
	) {
		throw new Error(usage);
	}
	const [scene, x, z] = positionals;
	const cell = x === 'global' ? 'global' : { x: parseInteger(x, 'x'), z: parseInteger(z, 'z') };
	const selection = {
		sceneState: parseInteger(values['scene-state'], '--scene-state'),
		area: parseInteger(values.area, '--area'),
		layerMask: values.layers === undefined ? 0xffffffff : parseInteger(values.layers, '--layers'),
	};
	if (selection.layerMask < 0 || selection.layerMask > 0xffffffff) {
		throw new Error('--layers must be an unsigned 32-bit mask');
	}
	await withContext(values.config, async (ctx) => {
		const data = await collectCollisionInputs(ctx, scene, cell, selection);
		await writeFile(values.output!, JSON.stringify(data));
		console.log(
			`${data.actors.length} streamed collider actors; ${data.excludedActors.length} excluded by layer; world coverage remains incomplete`,
		);
	});
};
