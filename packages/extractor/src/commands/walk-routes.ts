import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

import { planGroundRoute } from '@oem/ganglia';

import { groundData } from '../game/ground-data.ts';

export const summary = 'plan selected ground routes and export source-bound inputs for Atlos';
export const usage =
	'walk-routes --navigation <file> --walls <file> --request <file> -o <routes> --data <ground-data> [--travel-points <file>]';

/**
 * @param args matching navigation/wall exports and explicit state/profile/arrival request
 * @returns after writing routes for oem-views and ground data for Atlos
 */
export const run = async (args: string[]): Promise<void> => {
	const { values } = parseArgs({
		args,
		options: {
			navigation: { type: 'string' },
			walls: { type: 'string' },
			request: { type: 'string' },
			output: { type: 'string', short: 'o' },
			data: { type: 'string' },
			'travel-points': { type: 'string' },
		},
	});
	if (
		!values.navigation ||
		!values.walls ||
		!values.request ||
		!values.output ||
		!values.data ||
		values.output === values.data
	) {
		throw new Error(usage);
	}
	const input = await Promise.all(
		[values.navigation, values.walls, values.request].map((path) => readFile(path, 'utf8')),
	);
	const travel: unknown = values['travel-points']
		? JSON.parse(await readFile(values['travel-points'], 'utf8'))
		: undefined;
	const data = groundData(JSON.parse(input[0]), JSON.parse(input[1]), JSON.parse(input[2]), travel);
	const binding = createHash('sha256').update(JSON.stringify(data)).digest('hex');
	const routes = data.targets.map((target) => ({
		id: target.id,
		...planGroundRoute(data.surfaces, data.arrivals, target.position, data.options),
	}));
	await writeFile(values.data, JSON.stringify({ version: 1, binding, ...data }));
	await writeFile(
		values.output,
		JSON.stringify({
			release: data.release,
			binding,
			routes: routes.filter((route) => route.status === 'complete'),
			unresolved: routes.filter((route) => route.status !== 'complete'),
		}),
	);
	console.log(
		JSON.stringify({
			binding,
			surfaces: data.surfaces.length,
			routes: routes.length,
			complete: routes.filter((route) => route.status === 'complete').length,
		}),
	);
};
