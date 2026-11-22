import { parseArgs } from 'node:util';

import { writeKtx2 } from '@endfield-noclip/formats/binary/ktx2';
import {
	isWaterGlobalConfig,
	readWaterGlobalConfig,
	readWaterSurfaceConfig,
	type WaterGlobalConfig,
} from '@endfield-noclip/formats/endfield/water';
import { ShaderPropertyFlags, ShaderPropertyType } from '@endfield-noclip/formats/unity/material';
import type { DecodedMesh } from '@endfield-noclip/formats/unity/mesh';
import { typeName, UnityClass } from '@endfield-noclip/formats/unity/serialized-file';
import { type DecodedTexture, toKtx2Texture } from '@endfield-noclip/formats/unity/texture';
import type { TypeTreeObject } from '@endfield-noclip/formats/unity/type-tree';
import { pptrField, type PPtr } from '@endfield-noclip/formats/unity/values';

import { mapDefined } from '@mary-ext/array-fns';

import {
	hashText,
	jsonReplacer,
	need as needArg,
	parseHash,
	parseOptionalInteger,
	parsePathId,
	save as saveFile,
	separatePositionals,
} from '../cli-args.ts';
import { type Context, withContext } from '../context.ts';
import { errorText } from '../errors.ts';
import { loadMesh, loadTexture } from '../game/assets/asset-decode.ts';
import { type AssetResolver, objectKey, type ObjectRef } from '../game/assets/assets.ts';
import { RENDER_PIPELINE_QUAD_PATH } from '../game/assets/builtin-resources.ts';
import { describeMaterial } from '../game/materials/material-describe.ts';
import { loadMaterial, type LoadedMaterial } from '../game/materials/material-load.ts';
import { DECAL_PROJECTOR_CLASS } from '../game/prefabs/decal-projector.ts';
import { readPrefabEnvironmentVolumes } from '../game/prefabs/prefab-environment.ts';
import { readPrefabLights } from '../game/prefabs/prefab-lights.ts';
import { walkPrefab } from '../game/prefabs/prefab-walk.ts';
import { readPrefabRenderers } from '../game/prefabs/prefab.ts';
import { loadSectorTexture } from '../game/water/water-source.ts';
import { DECAL_CUBE_PATH } from '../pack/content/pack-content.ts';
import { convertMaterial, ShaderTable } from '../pack/convert/materials.ts';
import { zstdSync } from '../zstd.ts';

export const summary = 'inspect a prefab, material, mesh, texture, or water config';

/** command usage, available without opening the install */
export const usage = `usage:
  inspect prefab <object> [--effect-lod camera|proxy] [--json]
                                                      hierarchy, components, renderers, particles, lights & env volumes
  inspect material <object> [--all-props]             shader-declared properties, textures and packed surface description
  inspect mesh <object>                               vertex channels, submeshes, bounds, skinning
  inspect texture <object> [-o file.ktx2] [--zstd n]  format, dimensions, mips, sampler; -o writes KTX2
  inspect water-config <object>                       surface WaterConfig or Global_Water_Config as JSON

<object> is <bundle> [--path-id=N], an asset path, or a path hash (as \`scene find\` prints them).
<bundle> is a hex id, main/<hex>.ab or initial/<hex>.ab; omitting --path-id picks the unique matching
object in the bundle. negative path ids need --path-id=-N.`;

const OPTIONS = {
	config: { type: 'string' },
	'path-id': { type: 'string' },
	'all-props': { type: 'boolean', default: false },
	'effect-lod': { type: 'string', default: 'camera' },
	json: { type: 'boolean', default: false },
	output: { type: 'string', short: 'o' },
	zstd: { type: 'string' },
} as const;

export const run = async (args: string[]): Promise<void> => {
	const { values, positionals } = parseArgs({
		args: separatePositionals(args, OPTIONS),
		allowPositionals: true,
		options: OPTIONS,
	});
	const [sub, target] = positionals;
	const pathId = parsePathId(values['path-id'], '--path-id');

	await withContext(values.config, async (context) => {
		const resolver = await context.resolver();
		const resolveTarget = (classId: number) =>
			resolveObjectArg(context, resolver, needArg(target, 'object', usage), classId, pathId);

		switch (sub) {
			case 'prefab': {
				const effectLod = values['effect-lod'];
				if (effectLod !== 'camera' && effectLod !== 'proxy') {
					throw new Error('--effect-lod must be camera or proxy');
				}
				const ref = await resolveTarget(UnityClass.GameObject);
				await inspectPrefab(context, resolver, ref, { effectLod, json: values.json });
				break;
			}
			case 'material': {
				const ref = await resolveTarget(UnityClass.Material);
				const material = await loadMaterial(resolver, ref);
				console.log(
					JSON.stringify(
						await materialJson(resolver, ref, material, values['all-props']),
						jsonReplacer,
						'\t',
					),
				);
				break;
			}
			case 'mesh': {
				const ref = await resolveTarget(UnityClass.Mesh);
				const mesh = await loadMesh(resolver, ref);
				console.log(JSON.stringify({ object: objectKey(ref), ...meshSummary(mesh) }, null, '\t'));
				break;
			}
			case 'texture': {
				const ref = await resolveTarget(UnityClass.Texture2D);
				const texture = await loadTexture(resolver, ref);
				console.log(JSON.stringify({ object: objectKey(ref), ...textureSummary(texture) }, null, '\t'));
				if (values.output !== undefined) {
					const bytes = encodeKtx2(texture, parseOptionalInteger(values.zstd, '--zstd'));
					await saveFile(values.output, bytes);
					console.error(`wrote ${bytes.length} bytes to ${values.output}`);
				}
				break;
			}
			case 'water-config': {
				const ref = await resolveTarget(UnityClass.MonoBehaviour);
				await inspectWaterConfig(resolver, ref);
				break;
			}
			default: {
				throw new Error(usage);
			}
		}
	});
};

// #region target resolution

const BUNDLE_NAME = /^(?:(?:Data\/Bundles\/Windows\/)?(?:main|initial)\/)?[0-9a-f]{24}(?:\.ab)?$/i;

/** resolves `<bundle> [--path-id=N]`, an asset path, or a path hash to a single {@link ObjectRef} */
const resolveObjectArg = async (
	context: Context,
	resolver: AssetResolver,
	target: string,
	classId: number,
	pathId: bigint | undefined,
): Promise<ObjectRef> => {
	if (pathId !== undefined) {
		return resolver.object(resolver.bundleIndex(target), pathId);
	}
	const hash = parseHash(target);
	if (hash !== null) {
		return resolver.findUnique({ hash, path: (await context.world.pathOf(hash)) ?? null }, classId);
	}
	if (BUNDLE_NAME.test(target)) {
		return resolveFromBundle(resolver, target, classId);
	}
	const hashes = await context.world.hashesOf(target);
	if (hashes.length !== 1) {
		throw new Error(
			hashes.length === 0
				? `${target} is not in StringPathHash`
				: `${target} has ${hashes.length} path hashes; pass one of ${hashes.map(hashText).join(', ')}`,
		);
	}
	return resolver.findUnique({ hash: hashes[0], path: target }, classId);
};

/** picks the unique object of `classId` (or main GameObject for prefabs) in a bundle */
const resolveFromBundle = async (
	resolver: AssetResolver,
	bundleName: string,
	classId: number,
): Promise<ObjectRef> => {
	const bundleIndex = resolver.bundleIndex(bundleName);
	const files = await resolver.assetFiles(bundleIndex);
	if (classId === UnityClass.GameObject) {
		const containerRoots: ObjectRef[] = [];
		for (const file of files) {
			// oxlint-disable-next-line no-await-in-loop -- typically one SerializedFile per bundle
			for (const assetBundle of await file.assetBundles()) {
				for (const entry of assetBundle.container) {
					const obj = file.file.objects.find((candidate) => candidate.pathId === entry.asset.pathId);
					if (obj !== undefined && obj.classId === UnityClass.GameObject) {
						containerRoots.push({ bundleIndex, file, info: obj });
					}
				}
			}
		}
		if (containerRoots.length === 1) {
			return containerRoots[0];
		}
	}
	const matches: ObjectRef[] = [];
	for (const file of files) {
		for (const info of file.file.objects) {
			if (info.classId === classId) {
				matches.push({ bundleIndex, file, info });
			}
		}
	}
	if (matches.length === 1) {
		return matches[0];
	}
	if (matches.length === 0) {
		throw new Error(`bundle ${bundleName} has no class-${classId} objects`);
	}
	const sample = matches
		.slice(0, 8)
		.map((ref) => `  --path-id=${ref.info.pathId}`)
		.join('\n');
	throw new Error(
		`bundle ${bundleName} has ${matches.length} class-${classId} objects; pass --path-id=N:\n${sample}`,
	);
};

// #endregion

// #region prefab

interface HierarchyNode {
	depth: number;
	name: string;
	pathId: string;
	active: boolean;
	position: readonly number[];
	scale: readonly number[];
	components: string[];
}

const IDENTITY_POS = (p: readonly number[]): boolean => p[0] === 0 && p[1] === 0 && p[2] === 0;
const IDENTITY_SCALE = (s: readonly number[]): boolean => s[0] === 1 && s[1] === 1 && s[2] === 1;

const findBuiltinMesh = async (
	context: Context,
	resolver: AssetResolver,
	path: string,
): Promise<ObjectRef | null> => {
	const [hash] = await context.world.hashesOf(path);
	return hash === undefined ? null : resolver.findUnique({ hash, path }, UnityClass.Mesh).catch(() => null);
};

const scriptName = async (resolver: AssetResolver, ref: ObjectRef): Promise<string> => {
	try {
		const data = await resolver.read(ref);
		const scriptRef = await resolver.resolve(ref, pptrField(data, 'm_Script'));
		if (scriptRef === null) {
			return 'MonoBehaviour';
		}
		return (await scriptRef.file.peekName(scriptRef.info)) ?? 'MonoBehaviour';
	} catch {
		return 'MonoBehaviour';
	}
};

const inspectPrefab = async (
	context: Context,
	resolver: AssetResolver,
	root: ObjectRef,
	options: { effectLod: 'camera' | 'proxy'; json: boolean },
): Promise<void> => {
	const bundleName = resolver.manifest.bundle(root.bundleIndex).name;
	const rootName = (await root.file.peekName(root.info)) ?? '?';

	// 1. walk the full hierarchy (including inactive nodes) so nothing is hidden
	const hierarchy: HierarchyNode[] = [];
	const scriptNames = new Map<object, Promise<string>>();
	const cachedScriptName = (ref: ObjectRef): Promise<string> =>
		ref.info.type === undefined
			? scriptName(resolver, ref)
			: scriptNames.getOrInsertComputed(ref.info.type, () => scriptName(resolver, ref));
	let hasParticles = false;
	let hasDecal = false;
	await walkPrefab(
		resolver,
		root,
		{
			enter: (_node, depth) => depth + 1,
			visit: async (node, depth) => {
				const components: string[] = [];
				for (const component of node.components) {
					if (component.classId === UnityClass.Transform || component.classId === UnityClass.RectTransform) {
						continue;
					}
					if (
						component.classId === UnityClass.ParticleSystem ||
						component.classId === UnityClass.ParticleSystemRenderer
					) {
						hasParticles = true;
					} else if (component.classId === DECAL_PROJECTOR_CLASS) {
						hasDecal = true;
					}
					if (component.classId === UnityClass.MonoBehaviour) {
						// oxlint-disable-next-line no-await-in-loop -- keeps authored component order
						components.push(await cachedScriptName(component.ref));
					} else {
						components.push(typeName(component.ref.info.type) ?? `class:${component.classId}`);
					}
				}
				hierarchy.push({
					depth,
					name: node.name,
					pathId: node.go.info.pathId.toString(),
					active: node.active,
					position: node.saved.position,
					scale: node.saved.scale,
					components,
				});
			},
		},
		-1,
	);

	// 2. run the packer's own readers (only look up built-in fallback meshes if the prefab needs them)
	const [particleQuad, decalCube] = await Promise.all([
		hasParticles ? findBuiltinMesh(context, resolver, RENDER_PIPELINE_QUAD_PATH) : null,
		hasDecal ? findBuiltinMesh(context, resolver, DECAL_CUBE_PATH) : null,
	]);
	const [renderersResult, lightsResult, volumesResult] = await Promise.all([
		readPrefabRenderers(resolver, root, {
			viewPose: null,
			particleQuad,
			decalCube,
			locked: false,
			effectLod: options.effectLod,
		}).catch((error: unknown) => errorText(error)),
		readPrefabLights(resolver, root).catch((error: unknown) => errorText(error)),
		readPrefabEnvironmentVolumes(resolver, root, {
			position: [0, 0, 0],
			rotation: [0, 0, 0, 1],
			scale: [1, 1, 1],
		}).catch((error: unknown) => errorText(error)),
	]);

	// 3. summarize each renderer's mesh & materials (including describeMaterial), caching repeated materials
	const loadMaterialSummary = async (matRef: ObjectRef) => {
		try {
			const loaded = await loadMaterial(resolver, matRef);
			const described = describeLoadedMaterial(loaded);
			return {
				name: loaded.record.name,
				object: objectKey(matRef),
				bundle: resolver.manifest.bundle(matRef.bundleIndex).name,
				shader: loaded.shader.name,
				queue: loaded.classification.renderQueue,
				blend: loaded.classification.blend,
				surface: described.surface.kind,
				...(described.surface.kind === 'unsupported' || described.surface.kind === 'undrawn'
					? { reason: described.surface.reason }
					: {}),
				...('gaps' in described.surface &&
				Array.isArray(described.surface.gaps) &&
				described.surface.gaps.length > 0
					? { gaps: described.surface.gaps }
					: {}),
			};
		} catch (error) {
			return { object: objectKey(matRef), error: errorText(error) };
		}
	};
	const materialCache = new Map<string, ReturnType<typeof loadMaterialSummary>>();
	const summarizeMaterial = (matRef: ObjectRef) =>
		materialCache.getOrInsertComputed(objectKey(matRef), () => loadMaterialSummary(matRef));
	const rendererSummaries =
		typeof renderersResult === 'string'
			? { error: renderersResult }
			: await Promise.all(
					renderersResult.map(async (renderer) => {
						const meshName =
							(await renderer.mesh.file.peekName(renderer.mesh.info)) ?? objectKey(renderer.mesh);
						const materials = await Promise.all(
							renderer.materials.map(async (matRef) => (matRef === null ? null : summarizeMaterial(matRef))),
						);
						let kind: string = 'mesh';
						if (renderer.decal !== null) {
							kind = 'decal';
						} else if (renderer.particles !== null) {
							kind = 'particles';
						} else if (renderer.pose !== null || renderer.motion?.kind === 'skinned') {
							kind = 'skinned';
						}
						return {
							name: renderer.name,
							kind,
							mesh: meshName,
							meshObject: objectKey(renderer.mesh),
							submeshes: renderer.submeshes,
							shadowOnly: renderer.shadowOnly,
							sorting: renderer.sorting,
							motion:
								renderer.motion === null
									? null
									: {
											kind: renderer.motion.kind,
											duration: renderer.motion.skin.frameCount / renderer.motion.skin.frameRate,
										},
							particles:
								renderer.particles === null
									? null
									: {
											mode: renderer.particles.renderMode,
											rate: renderer.particles.rate,
											bursts: renderer.particles.bursts.length,
											trails: renderer.particles.trail !== null,
											moving: renderer.particles.emitterMotion !== undefined,
										},
							billboard: renderer.billboard,
							sizes: renderer.sizes,
							distances: renderer.distances,
							proxyLevels: renderer.proxyLevels,
							unsupported: renderer.unsupported,
							materials,
						};
					}),
				);

	const lightsSummary =
		typeof lightsResult === 'string'
			? { error: lightsResult }
			: lightsResult.map(({ name, light }) => ({
					name,
					type: light.type,
					color: light.color,
					intensity: light.intensity,
					range: light.range,
					spotAngle: light.spotAngle,
					shadows: light.shadows,
				}));

	const volumesSummary =
		typeof volumesResult === 'string'
			? { error: volumesResult }
			: await Promise.all(
					volumesResult.map(async ({ volume, phase }) => ({
						name: volume.name,
						priority: volume.priority,
						volumeType: volume.volumeType,
						blendMode: volume.blendMode,
						phase: phase === null ? null : ((await phase.file.peekName(phase.info)) ?? objectKey(phase)),
					})),
				);

	const output = {
		name: rootName,
		object: objectKey(root),
		bundle: bundleName,
		hierarchy,
		renderers: rendererSummaries,
		lights: lightsSummary,
		environmentVolumes: volumesSummary,
	};

	if (options.json) {
		console.log(JSON.stringify(output, jsonReplacer, '\t'));
		return;
	}

	console.log(`prefab ${rootName}  (${bundleName}  ${objectKey(root)})`);
	console.log(`\nhierarchy (${hierarchy.length} GameObjects):`);
	for (const node of hierarchy) {
		const indent = '  '.repeat(node.depth + 1);
		const off = node.active ? '' : ' [off]';
		const pos = IDENTITY_POS(node.position)
			? ''
			: ` pos(${node.position.map((v) => +v.toFixed(2)).join(',')})`;
		const scl = IDENTITY_SCALE(node.scale) ? '' : ` scl(${node.scale.map((v) => +v.toFixed(2)).join(',')})`;
		const comps = node.components.length === 0 ? '' : `  [${node.components.join(', ')}]`;
		console.log(`${indent}${node.name}${off}${pos}${scl}${comps}`);
	}

	if ('error' in rendererSummaries) {
		console.log(`\nrenderers: error: ${rendererSummaries.error}`);
	} else {
		console.log(`\nrenderers (${rendererSummaries.length}):`);
		for (const r of rendererSummaries) {
			const tags: string[] = [r.kind];
			if (r.shadowOnly) {
				tags.push('shadow-only');
			}
			if (r.motion !== null) {
				tags.push(`motion:${r.motion.kind}(${r.motion.duration.toFixed(2)}s)`);
			}
			if (r.particles !== null) {
				tags.push(
					`particles:${r.particles.mode}${r.particles.trails ? '+trails' : ''}${r.particles.moving ? '+moving' : ''}`,
				);
			}
			if (r.billboard !== null) {
				tags.push('billboard');
			}
			if (r.sizes !== null) {
				tags.push(`lod:${r.sizes.map((s) => s.lod).join('/')}`);
			}
			if (r.proxyLevels !== null) {
				tags.push(`proxyMask:0x${r.proxyLevels.toString(16)}`);
			}
			if (r.unsupported !== null) {
				tags.push(`STAND-IN: ${r.unsupported}`);
			}
			console.log(`  ${r.name}  (${tags.join(', ')})  mesh=${r.mesh}`);
			for (const mat of r.materials) {
				if (mat === null) {
					console.log('    mat: (null)');
				} else if ('error' in mat) {
					console.log(`    mat: ${mat.object} ERROR: ${mat.error}`);
				} else {
					const extra: string[] = [`surface=${mat.surface}`, `q=${mat.queue}`, mat.blend];
					if ('reason' in mat && mat.reason !== undefined) {
						extra.push(`reason: ${mat.reason}`);
					}
					if ('gaps' in mat && Array.isArray(mat.gaps)) {
						extra.push(`gaps: ${mat.gaps.join(', ')}`);
					}
					console.log(`    mat: ${mat.name}  [${mat.shader}]  ${extra.join('  ')}  (${mat.bundle})`);
				}
			}
		}
	}

	if ('error' in lightsSummary) {
		console.log(`\nlights: error: ${lightsSummary.error}`);
	} else if (lightsSummary.length > 0) {
		console.log(`\nlights (${lightsSummary.length}):`);
		for (const l of lightsSummary) {
			console.log(`  ${l.name}  type=${l.type}  intensity=${l.intensity}  range=${l.range}`);
		}
	}

	if ('error' in volumesSummary) {
		console.log(`\nenvironment volumes: error: ${volumesSummary.error}`);
	} else if (volumesSummary.length > 0) {
		console.log(`\nenvironment volumes (${volumesSummary.length}):`);
		for (const v of volumesSummary) {
			console.log(`  ${v.name}  priority=${v.priority}  type=${v.volumeType}  phase=${v.phase ?? '(none)'}`);
		}
	}
};

// #endregion

// #region material / mesh / texture

const describeLoadedMaterial = (material: LoadedMaterial) => {
	const shaders = new ShaderTable();
	const interned = shaders.intern(material.shader, material.classification.family);
	const slotOrder: string[] = [];
	const slotIds = new Map<string, number>();
	for (const [slot, resolved] of Object.entries(material.textures)) {
		if (resolved.ref !== null) {
			slotIds.set(slot, slotOrder.length);
			slotOrder.push(slot);
		}
	}
	const converted = convertMaterial(material.record, material.classification, interned, (slot) =>
		slotIds.get(slot),
	);
	const surface = describeMaterial(converted.material, interned.entry);
	return { converted, surface, slotOrder };
};

const materialJson = async (
	resolver: AssetResolver,
	ref: ObjectRef,
	material: LoadedMaterial,
	allProps: boolean,
) => {
	const slots = await Promise.all(
		Object.entries(material.textures).map(async ([slot, resolved]): Promise<[string, object] | undefined> => {
			const source = material.record.textures[slot];
			if (resolved.ref === null) {
				return resolved.error === undefined ? undefined : [slot, { error: resolved.error }];
			}
			try {
				const texture = await loadTexture(resolver, resolved.ref);
				return [
					slot,
					{
						object: objectKey(resolved.ref),
						bundle: resolver.manifest.bundle(resolved.ref.bundleIndex).name,
						name: texture.name,
						format: texture.format.name,
						size: [texture.width, texture.height],
						mipCount: texture.mipCount,
						srgb: texture.srgb,
						uvSet: source.uvSet,
						scale: source.scale,
						offset: source.offset,
					},
				];
			} catch (error) {
				return [slot, { object: objectKey(resolved.ref), error: errorText(error) }];
			}
		}),
	);
	const textures = Object.fromEntries(slots.filter((entry) => entry !== undefined));
	const { converted, surface, slotOrder } = describeLoadedMaterial(material);
	const { record } = material;
	return {
		name: record.name,
		object: objectKey(ref),
		bundle: resolver.manifest.bundle(ref.bundleIndex).name,
		shader: material.shader.name,
		classification: material.classification,
		surface,
		surfaceTextures: Object.fromEntries(slotOrder.map((slot, id) => [id, slot])),
		keywords: record.keywords,
		customRenderQueue: record.customRenderQueue,
		tags: record.tags,
		disabledPasses: record.disabledPasses,
		textures,
		floats: converted.material.floats,
		colors: converted.material.colors,
		vectors: converted.material.vectors,
		...(allProps ? { rawFloats: record.floats, rawColors: record.colors, rawInts: record.ints } : {}),
		hdrColors: material.shader.properties
			.filter((p) => p.type === ShaderPropertyType.Color && (p.flags & ShaderPropertyFlags.Hdr) !== 0)
			.map((p) => p.name),
	};
};

const meshSummary = (mesh: DecodedMesh) => ({
	name: mesh.name,
	vertexCount: mesh.vertexCount,
	triangles: mesh.submeshes.reduce((sum, s) => sum + (s.topology === 0 ? s.indexCount / 3 : 0), 0),
	indexFormat: mesh.indices instanceof Uint16Array ? 'u16' : 'u32',
	bounds: mesh.bounds,
	submeshes: mesh.submeshes,
	channels: mapDefined(mesh.channels, (c) =>
		c.dimension > 0
			? `${c.channel}: stream ${c.stream} +${c.offset} format ${c.format} ×${c.dimension}${c.packing ? ` packing ${c.packing}` : ''}`
			: undefined,
	),
	normals: mesh.normals === null ? null : mesh.packedNormals === null ? 'float' : 'packed',
	tangents: mesh.tangents !== null,
	colors: mesh.colors?.dimension ?? null,
	uvs: mesh.uvs.map((uv) => uv?.dimension ?? null),
	skin: mesh.skin,
});

const textureSummary = (texture: DecodedTexture) => ({
	name: texture.name,
	kind: texture.kind,
	size: [texture.width, texture.height, texture.depth],
	layers: texture.layers,
	faces: texture.faces,
	mipCount: texture.mipCount,
	format: texture.format,
	vkFormat: texture.vkFormat,
	srgb: texture.srgb,
	colorSpace: texture.colorSpace,
	sampler: texture.sampler,
	levelBytes: texture.levels.map((level) => level.length),
});

const encodeKtx2 = (texture: DecodedTexture, level: number | undefined): Uint8Array =>
	writeKtx2(toKtx2Texture(texture), {
		writer: 'endfield-noclip extractor',
		zstd: level === undefined ? undefined : (data) => zstdSync(data, level),
	});

// #endregion

// #region water-config

const inspectWaterConfig = async (resolver: AssetResolver, ref: ObjectRef): Promise<void> => {
	const value = await resolver.read(ref);
	const header = { object: objectKey(ref), bundle: resolver.manifest.bundle(ref.bundleIndex).name };
	if (isWaterGlobalConfig(value)) {
		const config = readWaterGlobalConfig(value);
		console.log(
			JSON.stringify({ ...header, ...(await globalWaterJson(resolver, ref, config)) }, jsonReplacer, '\t'),
		);
		return;
	}
	console.log(
		JSON.stringify({ ...header, ...readWaterSurfaceConfig(ref.info.type.nodes, value) }, jsonReplacer, '\t'),
	);
};

const globalWaterJson = async (
	resolver: AssetResolver,
	from: ObjectRef,
	config: WaterGlobalConfig,
): Promise<object> => {
	const texture = async (pptr: PPtr): Promise<object | null> => {
		try {
			const ref = await resolver.resolve(from, pptr);
			if (ref === null) {
				return null;
			}
			const t = await loadTexture(resolver, ref);
			return {
				object: objectKey(ref),
				bundle: resolver.manifest.bundle(ref.bundleIndex).name,
				name: t.name,
				kind: t.kind,
				size: [t.width, t.height],
				layers: t.layers,
				mipCount: t.mipCount,
				format: t.format.name,
				srgb: t.srgb,
				sampler: t.sampler,
			};
		} catch (error) {
			return { error: errorText(error) };
		}
	};
	const surfaceConfigs = await Promise.all(
		config.surfaceConfigs.map(async (pptr): Promise<object> => {
			try {
				const ref = await resolver.resolve(from, pptr);
				if (ref === null) {
					return { null: true };
				}
				const value: TypeTreeObject = await resolver.read(ref);
				return { object: objectKey(ref), name: value.m_Name, materialIndex: value.materialIndex };
			} catch (error) {
				return { error: errorText(error) };
			}
		}),
	);
	const xs = config.sectors.map((sector) => sector.x);
	const zs = config.sectors.map((sector) => sector.z);
	return {
		name: config.name,
		scenePath: config.scenePath,
		sceneCenterOffset: config.sceneCenterOffset,
		mapSize: config.mapSize,
		sectorSize: config.sectorSize,
		flowmapPrecision: config.flowmapPrecision,
		useSectorData: config.useSectorData,
		grid: config.grid,
		textures: {
			flowMap: await texture(config.flowMap),
			causticMap: await texture(config.causticMap),
			rainMap: await texture(config.rainMap),
			normalMapArray: await texture(config.normalMapArray),
		},
		surfaceConfigs,
		sectors: {
			count: config.sectors.length,
			range:
				config.sectors.length === 0
					? null
					: { x: [Math.min(...xs), Math.max(...xs)], z: [Math.min(...zs), Math.max(...zs)] },
			sample: config.sectors.slice(0, 3),
			sampleTexture: config.sectors.length === 0 ? null : await sectorTexture(resolver, config.sectors[0]),
		},
	};
};

const sectorTexture = async (
	resolver: AssetResolver,
	sector: WaterGlobalConfig['sectors'][number],
): Promise<object> => {
	try {
		const { sector: ref, texture: textureRef } = await loadSectorTexture(resolver, sector);
		if (textureRef === null) {
			return { object: objectKey(ref), texture: null };
		}
		const t = await loadTexture(resolver, textureRef);
		return {
			object: objectKey(ref),
			texture: {
				name: t.name,
				size: [t.width, t.height],
				mipCount: t.mipCount,
				format: t.format.name,
				srgb: t.srgb,
			},
		};
	} catch (error) {
		return { error: errorText(error) };
	}
};

// #endregion
