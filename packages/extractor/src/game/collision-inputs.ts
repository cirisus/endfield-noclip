/* oxlint-disable no-await-in-loop -- retain one streamed payload at a time */
import { readCollisionHeightfield } from '@endfield-noclip/formats/endfield/collision-heightfield';
import { readEcsCollider } from '@endfield-noclip/formats/endfield/ecs-collider';
import { parseStreamingChunk } from '@endfield-noclip/formats/endfield/streaming-chunk-data';
import { readCollisionMesh } from '@endfield-noclip/formats/unity/collision-mesh';
import { readConvexMesh } from '@endfield-noclip/formats/unity/convex-mesh';
import type { TypeTreeObject } from '@endfield-noclip/formats/unity/type-tree';
import { aabbField, bytesField } from '@endfield-noclip/formats/unity/values';

import type { Context } from '../context.ts';

import { loadTexture } from './asset-decode.ts';
import type { CollisionInputs, MeshGeometry } from './collision-ground.ts';

/**
 * @param data source Unity Mesh object bound by a collider
 * @param kind requested collision representation
 * @param allowMissingCookBounds whether an empty cook may retain its source bounds as an unknown obstacle
 * @returns decoded collision geometry or an explicitly marked empty-cook bounds record
 * @throws for absent cooks in strict mode, corrupt nonempty cooks or invalid source bounds
 */
export const readColliderGeometry = (
	data: TypeTreeObject,
	kind: 'triangle' | 'convex',
	allowMissingCookBounds: boolean,
): MeshGeometry => {
	const bytes = bytesField(
		data,
		kind === 'convex' ? 'm_BakedConvexCollisionMesh' : 'm_BakedTriangleCollisionMesh',
	);
	if (bytes.length || !allowMissingCookBounds) {
		return kind === 'convex' ? readConvexMesh(bytes) : readCollisionMesh(bytes);
	}
	const { center, extents } = aabbField(data, 'm_LocalAABB');
	if (!center.every(Number.isFinite) || !extents.every((value) => Number.isFinite(value) && value >= 0)) {
		throw new Error('invalid missing-cook collision bounds');
	}
	return {
		vertices: [],
		triangles: [],
		faceRemap: null,
		materials: null,
		bounds: {
			min: [center[0] - extents[0], center[1] - extents[1], center[2] - extents[2]],
			max: [center[0] + extents[0], center[1] + extents[1], center[2] + extents[2]],
		},
		approximation: 'missing-cook-bounds',
	};
};

/**
 * @param ctx open installation context, reused across cells
 * @param scene source scene identifier
 * @param cell explicit cell coordinates or global chunks
 * @param selection source state, area and layer selection; solidsOnly retains empty-cook bounds as unknown
 *   obstacles
 * @returns decoded collider inputs with source identity and explicit coverage limits
 */
export const collectCollisionInputs = async (
	ctx: Context,
	scene: string,
	cell: { x: number; z: number } | 'global',
	selection: { sceneState: number; area: number; layerMask: number; solidsOnly?: boolean },
): Promise<CollisionInputs> => {
	const files = await ctx.world.cellChunkFiles(scene, cell, selection);
	if (!files.length) {
		throw new Error('no chunks match the collision selection');
	}
	const actors = [];
	const excludedActors = [];
	const resolver = await ctx.resolver(),
		paths = await ctx.world.pathLookup();
	const geometries = new Map<string, MeshGeometry>();
	const meshGeometry = async (asset: string, kind: 'triangle' | 'convex') => {
		const key = `${asset}/${kind}`;
		if (!geometries.has(key)) {
			const hash = BigInt(asset),
				data = await resolver.read(await resolver.findUnique({ hash, path: paths(hash) ?? null }, 43));
			try {
				geometries.set(key, readColliderGeometry(data, kind, selection.solidsOnly === true));
			} catch (cause) {
				throw new Error(`cannot decode collision geometry ${key} (${paths(hash) ?? 'unknown asset path'})`, {
					cause,
				});
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
						shape.kind === 'mesh' && (!selection.solidsOnly || (shape.enabled && !shape.trigger))
							? await meshGeometry(assets[shape.mesh], shape.convex ? 'convex' : 'triangle')
							: null,
					);
				}
				const complexGeometry =
					collider.complex && !selection.solidsOnly
						? await meshGeometry(assets[collider.complex.mesh], 'triangle')
						: null;
				let terrainGeometry: string | null = null;
				if (collider.terrain && (!selection.solidsOnly || collider.terrain.enabled)) {
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
	return {
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
	};
};
