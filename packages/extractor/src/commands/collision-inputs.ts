/* oxlint-disable no-await-in-loop -- bound retained chunk data */
import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

import { readCollisionHeightfield } from '@endfield-noclip/formats/endfield/collision-heightfield';
import { readEcsCollider } from '@endfield-noclip/formats/endfield/ecs-collider';
import { parseStreamingChunk } from '@endfield-noclip/formats/endfield/streaming-chunk-data';
import { readCollisionMesh, type CollisionMesh } from '@endfield-noclip/formats/unity/collision-mesh';
import { readConvexMesh } from '@endfield-noclip/formats/unity/convex-mesh';
import { bytesField } from '@endfield-noclip/formats/unity/values';

import { parseInteger } from '../cli-args.ts';
import { withContext } from '../context.ts';
import { loadTexture } from '../game/asset-decode.ts';

export const summary =
	'export streamed collider poses, shapes, filters and cooked geometry for a cell or global chunk';
export const usage =
	'collision-inputs <scene> <x> <z> | <scene> global --scene-state <n> --area <n> [--layers <uint32>] -o <file> --config <config>';

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
		const files = await ctx.world.cellChunkFiles(scene, cell, selection);
		if (!files.length) {
			throw new Error('no chunks match the collision selection');
		}
		const actors = [];
		const excludedActors = [];
		const resolver = await ctx.resolver(),
			paths = await ctx.world.pathLookup();
		const geometries = new Map<string, CollisionMesh>();
		const meshGeometry = async (asset: string, kind: 'triangle' | 'convex') => {
			const key = `${asset}/${kind}`;
			if (!geometries.has(key)) {
				const hash = BigInt(asset),
					data = await resolver.read(await resolver.findUnique({ hash, path: paths(hash) ?? null }, 43));
				try {
					geometries.set(
						key,
						kind === 'convex'
							? readConvexMesh(bytesField(data, 'm_BakedConvexCollisionMesh'))
							: readCollisionMesh(bytesField(data, 'm_BakedTriangleCollisionMesh')),
					);
				} catch (cause) {
					throw new Error(
						`cannot decode collision geometry ${key} (${paths(hash) ?? 'unknown asset path'})`,
						{ cause },
					);
				}
			}
			return key;
		};
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
					const assets = Array.from({ length: count }, (_, i) => bindings.get(i)!);
					if (((selection.layerMask >>> collider.layer) & 1) === 0) {
						excludedActors.push({ id: row.id, component, file: file.name, collider, assets });
						continue;
					}
					const shapeGeometry: (string | null)[] = [];
					for (const shape of collider.shapes) {
						shapeGeometry.push(
							shape.kind === 'mesh'
								? await meshGeometry(assets[shape.mesh], shape.convex ? 'convex' : 'triangle')
								: null,
						);
					}
					const complexGeometry = collider.complex
						? await meshGeometry(assets[collider.complex.mesh], 'triangle')
						: null;
					let terrainGeometry: string | null = null;
					if (collider.terrain) {
						const hash = BigInt(assets[0]);
						terrainGeometry = `${hash}/heightfield/${collider.terrain.scale.join('/')}`;
						if (!geometries.has(terrainGeometry)) {
							const texture = await loadTexture(
								resolver,
								await resolver.findUnique({ hash, path: paths(hash) ?? null }, 28),
							);
							if (texture.kind !== '2d' || texture.format.name !== 'RG16') {
								throw new Error('unsupported collision height texture');
							}
							geometries.set(
								terrainGeometry,
								readCollisionHeightfield(texture.levels[0], {
									width: texture.width,
									height: texture.height,
									scale: collider.terrain.scale,
								}),
							);
						}
					}
					actors.push({
						id: row.id,
						component,
						file: file.name,
						collider,
						assets,
						shapeGeometry,
						complexGeometry,
						terrainGeometry,
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
					scope: cell === 'global' ? 'streamed-ecs-global' : 'streamed-ecs-cell',
					complete: false,
					files: files.map((f) => f.name),
					remaining: [
						cell === 'global' ? 'cell-chunks' : 'global-chunks',
						'mono-colliders',
						'interactive-prefabs',
						'foliage',
						'player-layer-policy',
					],
				},
				actors,
				excludedActors,
				geometries: Object.fromEntries(geometries),
			}),
		);
		console.log(
			`${actors.length} streamed collider actors; ${excludedActors.length} excluded by layer; world coverage remains incomplete`,
		);
	});
};
