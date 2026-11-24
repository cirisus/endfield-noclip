import { parseArgs } from 'node:util';

import { writeDds } from '@endfield-noclip/formats/binary/dds';
import { writeKtx2 } from '@endfield-noclip/formats/binary/ktx2';
import {
	isWaterGlobalConfig,
	readWaterGlobalConfig,
	readWaterSurfaceConfig,
	type WaterGlobalConfig,
} from '@endfield-noclip/formats/endfield/water';
import {
	type ShaderProperty,
	ShaderPropertyFlags,
	ShaderPropertyType,
	type ShaderSummary,
} from '@endfield-noclip/formats/unity/material';
import type { DecodedMesh } from '@endfield-noclip/formats/unity/mesh';
import { isTextureClass, typeName, UnityClass } from '@endfield-noclip/formats/unity/serialized-file';
import { type DecodedTexture, toKtx2Texture } from '@endfield-noclip/formats/unity/texture';
import type { TypeTreeObject } from '@endfield-noclip/formats/unity/type-tree';
import {
	asPPtr,
	arrayField,
	booleanField,
	isObject,
	numberField,
	objectField,
	pptrField,
	type PPtr,
} from '@endfield-noclip/formats/unity/values';

import { definite, mapDefined } from '@mary-ext/array-fns';

import {
	collectTargets,
	hashText,
	jsonReplacer,
	need as needArg,
	parseHash,
	parseList,
	parseNumber,
	parseNumbers,
	parseOptionalInteger,
	parsePathId,
	save as saveFile,
	separatePositionals,
} from '../cli-args.ts';
import { pickFields } from '../cli-query.ts';
import { compareStrings } from '../compare.ts';
import { type Context, withContext } from '../context.ts';
import { errorText } from '../errors.ts';
import { loadMesh, loadShaderSummary, loadTexture } from '../game/assets/asset-decode.ts';
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
import { openAssetFiles, openBundle } from '../hg/bundles.ts';
import { VfsGroup } from '../hg/vfs.ts';
import { DECAL_CUBE_PATH } from '../pack/content/pack-content.ts';
import { convertMaterial, ShaderTable } from '../pack/convert/materials.ts';
import { mapPool } from '../pool.ts';
import { zstdSync } from '../zstd.ts';

export const summary = 'inspect a prefab, material, shader, mesh, texture, or water config';

/** command usage, available without opening the install */
export const usage = `usage:
  inspect prefab <object>... [--stdin] [--effect-lod camera|proxy] [--particles] [--json]
                                                      hierarchy, components, renderers (with sorting & queues),
                                                      particles (--particles adds raw module details), lights & env volumes
  inspect material <object>... [--stdin] [--name re] [--all] [--prop re] [--all-props] [--pick a,b]
                                                      shader-declared properties, textures and packed surface description
  inspect shader <object|name-re> [--prop re] [--type t,…] [--flag f,…] [--group initial|main|all] [--json]
                                                      shader tags and declared properties (defaults and flags)
  inspect mesh <object>... [--stdin] [--name re] [--vertices [n]] [--submesh n] [--near x,y,z] [--radius m]
                                                      vertex channels, submesh bounds, color/UV ranges, skinning, vertex samples
  inspect texture <object>... [--stdin] [--name re] [-o file.ktx2|file.dds] [--layer n] [--mip n] [--zstd n]
                                                      format, dimensions, mips, sampler; -o writes KTX2 or DX10 DDS
  inspect water-config <object>... [--stdin] [--name re]
                                                      surface WaterConfig or Global_Water_Config as JSON

<object> is <bundle> [--path-id=N] [--name re], an asset path, a unique filename/basename, or a path hash
(as \`scene find\` prints them). <bundle> is a hex id, main/<hex>.ab or initial/<hex>.ab; omitting --path-id
picks the unique matching object in the bundle.`;

const OPTIONS = {
	config: { type: 'string' },
	'path-id': { type: 'string' },
	name: { type: 'string' },
	all: { type: 'boolean', default: false },
	prop: { type: 'string' },
	type: { type: 'string' },
	flag: { type: 'string' },
	group: { type: 'string', default: 'initial' },
	'all-props': { type: 'boolean', default: false },
	'effect-lod': { type: 'string', default: 'camera' },
	particles: { type: 'boolean', default: false },
	pick: { type: 'string', multiple: true },
	stdin: { type: 'boolean', default: false },
	json: { type: 'boolean', default: false },
	output: { type: 'string', short: 'o' },
	layer: { type: 'string' },
	mip: { type: 'string' },
	vertices: { type: 'string' },
	submesh: { type: 'string' },
	near: { type: 'string' },
	radius: { type: 'string' },
	zstd: { type: 'string' },
} as const;

const DEFAULT_VERTEX_SAMPLE = '20';

/** lets `--vertices` be passed without a count (defaulting to 20) while still accepting `--vertices 10` */
const normalizeBareVertices = (args: readonly string[]): string[] => {
	const out: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === '--vertices') {
			const next = args[i + 1];
			if (next === undefined || !/^\d+$/.test(next)) {
				out.push(`--vertices=${DEFAULT_VERTEX_SAMPLE}`);
				continue;
			}
		}
		out.push(arg);
	}
	return out;
};

export const run = async (args: string[]): Promise<void> => {
	const { values, positionals } = parseArgs({
		args: separatePositionals(normalizeBareVertices(args), OPTIONS),
		allowPositionals: true,
		options: OPTIONS,
	});
	const [sub, ...rest] = positionals;
	const target = rest[0];
	const pathId = parsePathId(values['path-id'], '--path-id');
	const nameFilter = values.name === undefined ? undefined : new RegExp(values.name, 'i');
	const propFilter = values.prop === undefined ? undefined : new RegExp(values.prop, 'i');
	const pick = parseList(values.pick);

	await withContext(values.config, async (context) => {
		const resolver = await context.resolver();
		const resolveOne = (raw: string, classId: number) =>
			resolveObjectArg(context, resolver, raw, classId, { pathId, nameFilter });

		switch (sub) {
			case 'prefab': {
				const effectLod = values['effect-lod'];
				if (effectLod !== 'camera' && effectLod !== 'proxy') {
					throw new Error('--effect-lod must be camera or proxy');
				}
				const targets = await collectTargets(rest, values.stdin);
				if (targets.length === 0) {
					throw new Error(`missing object\n${usage}`);
				}
				const jsonOut: unknown[] = [];
				for (const [index, raw] of targets.entries()) {
					if (!values.json && index > 0) {
						console.log('\n' + '─'.repeat(72) + '\n');
					}
					// oxlint-disable-next-line no-await-in-loop -- prints prefabs in target order
					const ref = await resolveOne(raw, UnityClass.GameObject);
					// oxlint-disable-next-line no-await-in-loop -- prints prefabs in target order
					const result = await inspectPrefab(context, resolver, ref, {
						effectLod,
						particles: values.particles,
						json: values.json,
					});
					if (values.json) {
						jsonOut.push(result);
					}
				}
				if (values.json) {
					console.log(JSON.stringify(targets.length === 1 ? jsonOut[0] : jsonOut, jsonReplacer, '\t'));
				}
				break;
			}
			case 'material': {
				const targets = await collectTargets(rest, values.stdin);
				if (targets.length === 0) {
					throw new Error(`missing object\n${usage}`);
				}
				const refs: ObjectRef[] = [];
				for (const raw of targets) {
					// oxlint-disable-next-line no-await-in-loop -- preserves target order
					const resolved = await resolveMaterialTargets(context, resolver, raw, {
						pathId,
						nameFilter,
						all: values.all,
					});
					refs.push(...resolved);
				}
				const results = await Promise.all(
					refs.map(async (ref) => {
						const material = await loadMaterial(resolver, ref);
						const data = materialJson(resolver, ref, material, {
							allProps: values['all-props'],
							propFilter,
						});
						return pick.length === 0 ? data : pickFields(data, pick);
					}),
				);
				console.log(
					JSON.stringify(
						results.length === 1 && !values.all && targets.length === 1 ? results[0] : results,
						jsonReplacer,
						'\t',
					),
				);
				break;
			}
			case 'shader': {
				await inspectShader(context, resolver, needArg(target, 'object or shader name', usage), {
					pathId,
					nameFilter,
					propFilter,
					types: parseShaderTypes(values.type),
					flagMask: parseShaderFlags(values.flag),
					group: values.group,
					json: values.json,
				});
				break;
			}
			case 'mesh': {
				const targets = await collectTargets(rest, values.stdin);
				if (targets.length === 0) {
					throw new Error(`missing object\n${usage}`);
				}
				const vertexCount = parseOptionalInteger(values.vertices, '--vertices');
				if (vertexCount !== undefined && vertexCount < 0) {
					throw new Error('--vertices must be a non-negative integer');
				}
				const near = values.near === undefined ? undefined : parseNumbers(values.near, 3, '--near');
				const radius = values.radius === undefined ? 2 : parseNumber(values.radius, '--radius');
				const submesh = parseOptionalInteger(values.submesh, '--submesh');
				const results = [];
				for (const raw of targets) {
					// oxlint-disable-next-line no-await-in-loop -- preserves target order
					const ref = await resolveOne(raw, UnityClass.Mesh);
					// oxlint-disable-next-line no-await-in-loop -- preserves target order
					const mesh = await loadMesh(resolver, ref);
					if (submesh !== undefined && (submesh < 0 || submesh >= mesh.submeshes.length)) {
						throw new Error(`--submesh must be 0..${mesh.submeshes.length - 1}, got ${submesh}`);
					}
					const sampleLimit = vertexCount ?? (near !== undefined || submesh !== undefined ? 20 : undefined);
					results.push({
						object: objectKey(ref),
						...meshSummary(mesh),
						...(sampleLimit === undefined
							? {}
							: { vertices: sampleMeshVertices(mesh, sampleLimit, { submesh, near, radius }) }),
					});
				}
				console.log(JSON.stringify(results.length === 1 ? results[0] : results, null, '\t'));
				break;
			}
			case 'texture': {
				const targets = await collectTargets(rest, values.stdin);
				if (targets.length === 0) {
					throw new Error(`missing object\n${usage}`);
				}
				if (values.output !== undefined && targets.length > 1) {
					throw new Error('-o cannot be used with multiple texture targets');
				}
				const results = [];
				for (const raw of targets) {
					// oxlint-disable-next-line no-await-in-loop -- preserves target order
					const ref = await resolveOne(raw, UnityClass.Texture2D);
					// oxlint-disable-next-line no-await-in-loop -- preserves target order
					const texture = await loadTexture(resolver, ref);
					results.push({ object: objectKey(ref), ...textureSummary(texture) });
					if (values.output !== undefined) {
						const layer = parseOptionalInteger(values.layer, '--layer');
						const mip = parseOptionalInteger(values.mip, '--mip');
						const isDds = values.output.toLowerCase().endsWith('.dds');
						if (!isDds && (layer !== undefined || mip !== undefined)) {
							throw new Error('--layer and --mip are only supported with .dds output');
						}
						const bytes = isDds
							? writeDds(texture, { layer, mip })
							: encodeKtx2(texture, parseOptionalInteger(values.zstd, '--zstd'));
						// oxlint-disable-next-line no-await-in-loop -- single target when -o is set
						await saveFile(values.output, bytes);
						console.error(`wrote ${bytes.length} bytes to ${values.output}`);
					}
				}
				console.log(JSON.stringify(results.length === 1 ? results[0] : results, null, '\t'));
				break;
			}
			case 'water-config': {
				const targets = await collectTargets(rest, values.stdin);
				if (targets.length === 0) {
					throw new Error(`missing object\n${usage}`);
				}
				for (const raw of targets) {
					// oxlint-disable-next-line no-await-in-loop -- preserves target order
					const ref = await resolveOne(raw, UnityClass.MonoBehaviour);
					// oxlint-disable-next-line no-await-in-loop -- preserves target order
					await inspectWaterConfig(resolver, ref);
				}
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

interface ResolveOptions {
	pathId: bigint | undefined;
	nameFilter: RegExp | undefined;
}

const matchesClass = (actual: number, expected: number): boolean =>
	expected === UnityClass.Texture2D ? isTextureClass(actual) : actual === expected;

/** resolves `<bundle> [--path-id=N] [--name re]`, an asset path, or a path hash to a single {@link ObjectRef} */
const resolveObjectArg = async (
	context: Context,
	resolver: AssetResolver,
	target: string,
	classId: number,
	options: ResolveOptions,
): Promise<ObjectRef> => {
	if (options.pathId !== undefined) {
		return resolver.object(resolver.bundleIndex(target), options.pathId);
	}
	const hash = parseHash(target);
	if (hash !== null) {
		return resolver.findUnique({ hash, path: (await context.world.pathOf(hash)) ?? null }, classId);
	}
	if (BUNDLE_NAME.test(target)) {
		const [ref] = await resolveFromBundle(resolver, target, classId, {
			nameFilter: options.nameFilter,
			all: false,
		});
		return ref;
	}
	const hashes = await context.world.hashesOf(target);
	if (hashes.length === 1) {
		return resolver.findUnique({ hash: hashes[0], path: target }, classId);
	}
	if (hashes.length > 1) {
		throw new Error(
			`${target} has ${hashes.length} path hashes; pass one of ${hashes.map(hashText).join(', ')}`,
		);
	}
	// fall back to matching by filename / suffix in StringPathHash
	const lower = target.toLowerCase();
	const suffix = `/${lower}`;
	const hasSlash = lower.includes('/');
	const [main, initial] = await Promise.all([context.world.pathHash(), context.world.initPathHash()]);
	const matches: { hash: bigint; path: string }[] = [];
	const seen = new Set<string>();
	for (const table of [main, initial]) {
		for (const [entryHash, path] of table.entries((candidate) => {
			const c = candidate.toLowerCase();
			if (c === lower || c.endsWith(suffix)) {
				return true;
			}
			if (!hasSlash) {
				const base = c.slice(c.lastIndexOf('/') + 1);
				const stem = base.includes('.') ? base.slice(0, base.lastIndexOf('.')) : base;
				return stem === lower;
			}
			return false;
		})) {
			const key = `${entryHash}:${path}`;
			if (!seen.has(key)) {
				seen.add(key);
				matches.push({ hash: entryHash, path });
			}
		}
	}
	if (matches.length === 1) {
		return resolver.findUnique({ hash: matches[0].hash, path: matches[0].path }, classId);
	}
	if (matches.length === 0) {
		throw new Error(`${target} is not in StringPathHash`);
	}
	const sample = matches
		.slice(0, 10)
		.map((m) => `  ${hashText(m.hash)}  ${m.path}`)
		.join('\n');
	throw new Error(
		`${target} matched ${matches.length} paths in StringPathHash; pass a full path or hash:\n${sample}`,
	);
};

/** resolves one or more Material targets (supporting `--all` and `--name` on bundle arguments) */
const resolveMaterialTargets = async (
	context: Context,
	resolver: AssetResolver,
	target: string,
	options: ResolveOptions & { all: boolean },
): Promise<ObjectRef[]> => {
	if (options.pathId === undefined && parseHash(target) === null && BUNDLE_NAME.test(target)) {
		return resolveFromBundle(resolver, target, UnityClass.Material, {
			nameFilter: options.nameFilter,
			all: options.all,
		});
	}
	return [await resolveObjectArg(context, resolver, target, UnityClass.Material, options)];
};

/** picks matching objects of `classId` (or main GameObject for prefabs) in a bundle */
const resolveFromBundle = async (
	resolver: AssetResolver,
	bundleName: string,
	classId: number,
	options: { nameFilter: RegExp | undefined; all: boolean },
): Promise<ObjectRef[]> => {
	const bundleIndex = resolver.bundleIndex(bundleName);
	const files = await resolver.assetFiles(bundleIndex);
	if (classId === UnityClass.GameObject && options.nameFilter === undefined && !options.all) {
		const containerRoots: ObjectRef[] = [];
		for (const file of files) {
			// oxlint-disable-next-line no-await-in-loop -- typically one SerializedFile per bundle
			for (const assetBundle of await file.assetBundles()) {
				for (const entry of assetBundle.container) {
					const obj = file.file.objectsByPathId.get(entry.asset.pathId);
					if (obj !== undefined && obj.classId === UnityClass.GameObject) {
						containerRoots.push({ bundleIndex, file, info: obj });
					}
				}
			}
		}
		if (containerRoots.length === 1) {
			return containerRoots;
		}
	}
	const candidates: ObjectRef[] = [];
	for (const file of files) {
		for (const info of file.file.objects) {
			if (matchesClass(info.classId, classId)) {
				candidates.push({ bundleIndex, file, info });
			}
		}
	}
	const matches: ObjectRef[] = [];
	if (options.nameFilter === undefined) {
		matches.push(...candidates);
	} else {
		for (const ref of candidates) {
			// oxlint-disable-next-line no-await-in-loop -- peeks names in object order
			const name = (await ref.file.peekName(ref.info)) ?? '';
			if (options.nameFilter.test(name)) {
				matches.push(ref);
			}
		}
	}
	if (matches.length === 0) {
		const suffix = options.nameFilter === undefined ? '' : ` matching ${options.nameFilter}`;
		throw new Error(`bundle ${bundleName} has no class-${classId} objects${suffix}`);
	}
	if (matches.length === 1 || options.all) {
		return matches;
	}
	const sample = await Promise.all(
		matches.slice(0, 12).map(async (ref) => {
			const name = await ref.file.peekName(ref.info);
			return `  --path-id=${ref.info.pathId}${name === undefined ? '' : `  ${name}`}`;
		}),
	);
	throw new Error(
		`bundle ${bundleName} has ${matches.length} class-${classId} objects; pass --path-id=N, --name <re>, or --all:\n${sample.join('\n')}`,
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
		const script = await ref.file.readField(ref.info, 'm_Script');
		const scriptRef = await resolver.resolve(ref, asPPtr(script));
		if (scriptRef === null) {
			return 'MonoBehaviour';
		}
		return (await scriptRef.file.peekName(scriptRef.info)) ?? 'MonoBehaviour';
	} catch {
		return 'MonoBehaviour';
	}
};

interface RawParticleSummary {
	name: string;
	pathId: string;
	renderMode: number | null;
	simSpace: number;
	scalingMode: number;
	lengthInSec: number;
	looping: boolean;
	playOnAwake: boolean;
	maxParticles: number;
	rateOverTime: number;
	bursts: string[];
	subEmitters: { target: string; type: number; properties: number; prob: number }[];
	lights: { ratio: number; maxLights: number } | null;
	trails: boolean;
	enabledModules: string[];
}

const summarizePrefabParticles = async (
	resolver: AssetResolver,
	root: ObjectRef,
): Promise<RawParticleSummary[]> => {
	const goNames = new Map<bigint, string>();
	const renderModes = new Map<bigint, number>();
	const psById = new Map<bigint, { pathId: bigint; data: TypeTreeObject }>();
	for (const obj of root.file.file.objects) {
		if (obj.classId === UnityClass.GameObject) {
			// oxlint-disable-next-line no-await-in-loop -- peeks GameObject names in prefab file
			const name = await root.file.peekName(obj);
			if (name !== undefined) {
				goNames.set(obj.pathId, name);
			}
		} else if (obj.classId === UnityClass.ParticleSystemRenderer) {
			// oxlint-disable-next-line no-await-in-loop -- reads render mode per ParticleSystemRenderer
			const data = await resolver.read({ ...root, info: obj });
			renderModes.set(pptrField(data, 'm_GameObject').pathId, numberField(data, 'm_RenderMode'));
		} else if (obj.classId === UnityClass.ParticleSystem) {
			// oxlint-disable-next-line no-await-in-loop -- reads ParticleSystem modules
			const data = await resolver.read({ ...root, info: obj });
			psById.set(obj.pathId, { pathId: obj.pathId, data });
		}
	}
	const out: RawParticleSummary[] = [];
	for (const { pathId, data } of psById.values()) {
		const go = pptrField(data, 'm_GameObject').pathId;
		const init = objectField(data, 'InitialModule');
		const emission = objectField(data, 'EmissionModule');
		const rate = objectField(emission, 'rateOverTime');
		const bursts = arrayField(emission, 'm_Bursts')
			.filter(isObject)
			.map((b) => `${numberField(b, 'time')}@${numberField(objectField(b, 'countCurve'), 'scalar')}`);
		const sub = objectField(data, 'SubModule');
		const subEmitters = booleanField(sub, 'enabled')
			? arrayField(sub, 'subEmitters')
					.filter(isObject)
					.map((e) => {
						const targetId = pptrField(e, 'emitter').pathId;
						const targetPs = psById.get(targetId);
						const targetName =
							targetPs === undefined
								? targetId.toString()
								: (goNames.get(pptrField(targetPs.data, 'm_GameObject').pathId) ?? targetId.toString());
						return {
							target: targetName,
							type: numberField(e, 'type'),
							properties: numberField(e, 'properties'),
							prob: numberField(e, 'emitProbability'),
						};
					})
					.filter((e) => e.target !== '0' && e.prob > 0)
			: [];
		const lm = objectField(data, 'LightsModule');
		const lights =
			booleanField(lm, 'enabled') && pptrField(lm, 'light').pathId !== 0n
				? { ratio: numberField(lm, 'ratio'), maxLights: numberField(lm, 'maxLights') }
				: null;
		const tm = isObject(data.TrailModule) ? data.TrailModule : null;
		const enabledModules = Object.entries(data)
			.filter(([k, v]) => k.endsWith('Module') && isObject(v) && v.enabled === true)
			.map(([k]) => k.replace(/Module$/, ''));
		out.push({
			name: goNames.get(go) ?? go.toString(),
			pathId: pathId.toString(),
			renderMode: renderModes.get(go) ?? null,
			simSpace: numberField(data, 'moveWithTransform'),
			scalingMode: numberField(data, 'scalingMode'),
			lengthInSec: numberField(data, 'lengthInSec'),
			looping: booleanField(data, 'looping'),
			playOnAwake: booleanField(data, 'playOnAwake'),
			maxParticles: numberField(init, 'maxNumParticles'),
			rateOverTime: numberField(rate, 'scalar'),
			bursts,
			subEmitters,
			lights,
			trails: tm !== null && tm.enabled === true,
			enabledModules,
		});
	}
	return out;
};

const inspectPrefab = async (
	context: Context,
	resolver: AssetResolver,
	root: ObjectRef,
	options: { effectLod: 'camera' | 'proxy'; particles: boolean; json: boolean },
): Promise<object> => {
	const bundleName = resolver.manifest.bundleName(root.bundleIndex);
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
				bundle: resolver.manifest.bundleName(matRef.bundleIndex),
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
							particles: renderer.particles,
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

	const rawParticles = options.particles ? await summarizePrefabParticles(resolver, root) : undefined;

	const output = {
		name: rootName,
		object: objectKey(root),
		bundle: bundleName,
		hierarchy,
		renderers: rendererSummaries,
		...(rawParticles === undefined ? {} : { particleSystems: rawParticles }),
		lights: lightsSummary,
		environmentVolumes: volumesSummary,
	};

	if (options.json) {
		return output;
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
			if (r.sorting.layer !== 0 || r.sorting.order !== 0) {
				tags.push(`sort=${r.sorting.layer}/${r.sorting.order}`);
			}
			if (r.motion !== null) {
				tags.push(`motion:${r.motion.kind}(${r.motion.duration.toFixed(2)}s)`);
			}
			if (r.particles !== null) {
				const p = r.particles;
				const parts: string[] = [String(p.renderMode)];
				if (p.stretch !== null) {
					parts.push(
						`stretch(${p.stretch.lengthScale}/${p.stretch.velocityScale}${p.stretch.freeform ? ',freeform' : ''})`,
					);
				}
				if (p.motion.kind === 'spline') {
					parts.push('spline');
				} else if (p.motion.clamp !== null) {
					parts.push(`clamp(${p.motion.clamp.kind})`);
				}
				if (p.trail !== null) {
					parts.push('trails');
				}
				if (p.emitterMotion !== undefined) {
					parts.push('moving');
				}
				tags.push(`particles:${parts.join('+')}`);
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

	if (rawParticles !== undefined && rawParticles.length > 0) {
		console.log(`\nparticle systems (${rawParticles.length}):`);
		for (const ps of rawParticles) {
			const parts = [
				`rm=${ps.renderMode ?? '-'}`,
				`sim=${ps.simSpace}`,
				`scale=${ps.scalingMode}`,
				`len=${ps.lengthInSec}`,
				`loop=${ps.looping}`,
				`awake=${ps.playOnAwake}`,
				`max=${ps.maxParticles}`,
				`rate=${ps.rateOverTime}`,
			];
			if (ps.bursts.length > 0) {
				parts.push(`bursts=${ps.bursts.join(',')}`);
			}
			if (ps.subEmitters.length > 0) {
				parts.push(
					`subs=[${ps.subEmitters.map((s) => `${s.target}:t${s.type}/p${s.properties}`).join(',')}]`,
				);
			}
			if (ps.lights !== null) {
				parts.push(`lights=${ps.lights.ratio}x${ps.lights.maxLights}`);
			}
			if (ps.trails) {
				parts.push('trails');
			}
			console.log(`  ${ps.name}  (${parts.join(', ')})  mods=[${ps.enabledModules.join(',')}]`);
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
	return output;
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

const filterRecord = <T>(record: Record<string, T>, filter: RegExp | undefined): Record<string, T> => {
	if (filter === undefined) {
		return record;
	}
	return Object.fromEntries(Object.entries(record).filter(([key]) => filter.test(key)));
};

const materialJson = async (
	resolver: AssetResolver,
	ref: ObjectRef,
	material: LoadedMaterial,
	options: { allProps: boolean; propFilter: RegExp | undefined },
) => {
	const slots = await Promise.all(
		Object.entries(material.textures).map(async ([slot, resolved]): Promise<[string, object] | undefined> => {
			if (options.propFilter !== undefined && !options.propFilter.test(slot)) {
				return undefined;
			}
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
						bundle: resolver.manifest.bundleName(resolved.ref.bundleIndex),
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
	const textures = Object.fromEntries(definite(slots));
	const { converted, surface, slotOrder } = describeLoadedMaterial(material);
	const { record } = material;
	const { propFilter } = options;
	return {
		name: record.name,
		object: objectKey(ref),
		bundle: resolver.manifest.bundleName(ref.bundleIndex),
		shader: material.shader.name,
		classification: material.classification,
		surface,
		surfaceTextures: Object.fromEntries(slotOrder.map((slot, id) => [id, slot])),
		keywords: record.keywords,
		customRenderQueue: record.customRenderQueue,
		tags: record.tags,
		disabledPasses: record.disabledPasses,
		textures,
		floats: filterRecord(converted.material.floats, propFilter),
		colors: filterRecord(converted.material.colors, propFilter),
		vectors: filterRecord(converted.material.vectors, propFilter),
		...(options.allProps
			? {
					rawFloats: filterRecord(record.floats, propFilter),
					rawColors: filterRecord(record.colors, propFilter),
					rawInts: filterRecord(record.ints, propFilter),
				}
			: {}),
		hdrColors: mapDefined(material.shader.properties, (p) =>
			p.type === ShaderPropertyType.Color &&
			(p.flags & ShaderPropertyFlags.Hdr) !== 0 &&
			(propFilter === undefined || propFilter.test(p.name))
				? p.name
				: undefined,
		),
		gammaColors: mapDefined(material.shader.properties, (p) =>
			p.type === ShaderPropertyType.Color &&
			(p.flags & ShaderPropertyFlags.Gamma) !== 0 &&
			(propFilter === undefined || propFilter.test(p.name))
				? p.name
				: undefined,
		),
	};
};

const round4 = (n: number): number => +n.toFixed(4);

const attributeRange = (
	data: Float32Array,
	dimension: number,
	vertexCount: number,
): { min: number[]; max: number[]; constant: boolean } | null => {
	if (vertexCount === 0 || dimension === 0) {
		return null;
	}
	const min = Array.from({ length: dimension }, () => Infinity);
	const max = Array.from({ length: dimension }, () => -Infinity);
	for (let i = 0; i < vertexCount; i++) {
		const base = i * dimension;
		for (let c = 0; c < dimension; c++) {
			const v = data[base + c];
			if (v < min[c]) {
				min[c] = v;
			}
			if (v > max[c]) {
				max[c] = v;
			}
		}
	}
	const constant = min.every((v, c) => v === max[c]);
	return { min: min.map(round4), max: max.map(round4), constant };
};

const sampleMeshVertices = (
	mesh: DecodedMesh,
	limit: number,
	options: { submesh?: number; near?: readonly number[]; radius?: number } = {},
): object[] => {
	let indices: number[];
	if (options.submesh !== undefined) {
		const sm = mesh.submeshes[options.submesh];
		const seen = new Set<number>();
		indices = [];
		for (let i = sm.firstIndex; i < sm.firstIndex + sm.indexCount; i++) {
			const v = mesh.indices[i];
			if (!seen.has(v)) {
				seen.add(v);
				indices.push(v);
			}
		}
	} else {
		indices = Array.from({ length: mesh.vertexCount }, (_, i) => i);
	}
	if (options.near !== undefined) {
		const [nx, ny, nz] = options.near;
		const maxR2 = (options.radius ?? 2) ** 2;
		indices = indices.filter((i) => {
			const dx = mesh.positions[i * 3] - nx;
			const dy = mesh.positions[i * 3 + 1] - ny;
			const dz = mesh.positions[i * 3 + 2] - nz;
			return dx * dx + dy * dy + dz * dz <= maxR2;
		});
	}
	const out: object[] = [];
	for (const i of indices.slice(0, limit)) {
		const row: Record<string, unknown> = {
			index: i,
			position: [
				round4(mesh.positions[i * 3]),
				round4(mesh.positions[i * 3 + 1]),
				round4(mesh.positions[i * 3 + 2]),
			],
		};
		if (mesh.normals !== null) {
			row.normal = [
				round4(mesh.normals[i * 3]),
				round4(mesh.normals[i * 3 + 1]),
				round4(mesh.normals[i * 3 + 2]),
			];
		}
		if (mesh.colors !== null) {
			const d = mesh.colors.dimension;
			row.color = Array.from({ length: d }, (_, c) => round4(mesh.colors!.data[i * d + c]));
		}
		for (const [uvIndex, uv] of mesh.uvs.entries()) {
			if (uv !== null) {
				const d = uv.dimension;
				row[`uv${uvIndex}`] = Array.from({ length: d }, (_, c) => round4(uv.data[i * d + c]));
			}
		}
		out.push(row);
	}
	return out;
};

const submeshBounds = (mesh: DecodedMesh, firstIndex: number, indexCount: number) => {
	if (indexCount === 0) {
		return null;
	}
	let minX = Infinity;
	let minY = Infinity;
	let minZ = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	let maxZ = -Infinity;
	for (let i = firstIndex; i < firstIndex + indexCount; i++) {
		const v = mesh.indices[i] * 3;
		const x = mesh.positions[v];
		const y = mesh.positions[v + 1];
		const z = mesh.positions[v + 2];
		if (x < minX) {
			minX = x;
		}
		if (y < minY) {
			minY = y;
		}
		if (z < minZ) {
			minZ = z;
		}
		if (x > maxX) {
			maxX = x;
		}
		if (y > maxY) {
			maxY = y;
		}
		if (z > maxZ) {
			maxZ = z;
		}
	}
	return { min: [round4(minX), round4(minY), round4(minZ)], max: [round4(maxX), round4(maxY), round4(maxZ)] };
};

const meshSummary = (mesh: DecodedMesh) => ({
	name: mesh.name,
	vertexCount: mesh.vertexCount,
	triangles: mesh.submeshes.reduce((sum, s) => sum + (s.topology === 0 ? s.indexCount / 3 : 0), 0),
	indexFormat: mesh.indices instanceof Uint16Array ? 'u16' : 'u32',
	bounds: mesh.bounds,
	submeshes: mesh.submeshes.map((sm) => ({
		firstIndex: sm.firstIndex,
		indexCount: sm.indexCount,
		topology: sm.topology,
		bounds: submeshBounds(mesh, sm.firstIndex, sm.indexCount),
	})),
	channels: mapDefined(mesh.channels, (c) =>
		c.dimension > 0
			? `${c.channel}: stream ${c.stream} +${c.offset} format ${c.format} ×${c.dimension}${c.packing ? ` packing ${c.packing}` : ''}`
			: undefined,
	),
	normals: mesh.normals === null ? null : mesh.packedNormals === null ? 'float' : 'packed',
	tangents: mesh.tangents !== null,
	colors: mesh.colors?.dimension ?? null,
	...(mesh.colors === null
		? {}
		: { colorStats: attributeRange(mesh.colors.data, mesh.colors.dimension, mesh.vertexCount) }),
	uvs: mesh.uvs.map((uv) => uv?.dimension ?? null),
	uvRanges: mapDefined(mesh.uvs, (uv, channel) =>
		uv === null ? undefined : { channel, ...attributeRange(uv.data, uv.dimension, mesh.vertexCount) },
	),
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

// #region shader

const SHADER_SCAN_CONCURRENCY = 16;

const SHADER_TYPE_NAMES: Record<number, string> = {
	[ShaderPropertyType.Color]: 'Color',
	[ShaderPropertyType.Vector]: 'Vector',
	[ShaderPropertyType.Float]: 'Float',
	[ShaderPropertyType.Range]: 'Range',
	[ShaderPropertyType.Texture]: 'Texture',
	[ShaderPropertyType.Int]: 'Int',
};

const SHADER_TYPE_LOOKUP = new Map<string, number>(
	Object.entries(SHADER_TYPE_NAMES).map(([id, name]) => [name.toLowerCase(), Number(id)]),
);

const SHADER_FLAG_ENTRIES: readonly [string, number][] = [
	['hide', ShaderPropertyFlags.HideInInspector],
	['per-renderer', ShaderPropertyFlags.PerRendererData],
	['no-scale-offset', ShaderPropertyFlags.NoScaleOffset],
	['normal', ShaderPropertyFlags.Normal],
	['hdr', ShaderPropertyFlags.Hdr],
	['gamma', ShaderPropertyFlags.Gamma],
	['non-modifiable', ShaderPropertyFlags.NonModifiableTextureData],
	['main-texture', ShaderPropertyFlags.MainTexture],
	['main-color', ShaderPropertyFlags.MainColor],
];

const SHADER_FLAG_LOOKUP = new Map<string, number>(SHADER_FLAG_ENTRIES);

const parseShaderTypes = (raw: string | undefined): Set<number> | undefined => {
	if (raw === undefined) {
		return undefined;
	}
	const types = new Set<number>();
	for (const part of raw.split(',')) {
		const key = part.trim().toLowerCase();
		const id = SHADER_TYPE_LOOKUP.get(key);
		if (id === undefined) {
			throw new Error(
				`--type must be a comma-separated list of ${[...SHADER_TYPE_LOOKUP.keys()].join(', ')}`,
			);
		}
		types.add(id);
	}
	return types;
};

const parseShaderFlags = (raw: string | undefined): number => {
	if (raw === undefined) {
		return 0;
	}
	let mask = 0;
	for (const part of raw.split(',')) {
		const key = part.trim().toLowerCase();
		const bit = SHADER_FLAG_LOOKUP.get(key);
		if (bit === undefined) {
			throw new Error(
				`--flag must be a comma-separated list of ${[...SHADER_FLAG_LOOKUP.keys()].join(', ')}`,
			);
		}
		mask |= bit;
	}
	return mask;
};

const shaderFlagNames = (flags: number): string[] => {
	const names: string[] = [];
	for (const [name, bit] of SHADER_FLAG_ENTRIES) {
		if ((flags & bit) !== 0) {
			names.push(name);
		}
	}
	return names;
};

const formatPropertyDefault = (prop: ShaderProperty): string => {
	switch (prop.type) {
		case ShaderPropertyType.Float:
		case ShaderPropertyType.Int: {
			return String(prop.default[0]);
		}
		case ShaderPropertyType.Range: {
			return `${prop.default[0]} (${prop.default[1]}..${prop.default[2]})`;
		}
		case ShaderPropertyType.Texture: {
			return prop.defaultTexture === '' ? '(none)' : prop.defaultTexture;
		}
		default: {
			return `(${prop.default.map((n) => +n.toFixed(4)).join(', ')})`;
		}
	}
};

interface ResolvedShader {
	bundle: string;
	object: string;
	summary: ShaderSummary;
}

const findShadersByName = async (
	context: Context,
	resolver: AssetResolver,
	pattern: RegExp,
	groupName: string,
): Promise<ResolvedShader[]> => {
	let groups: (typeof VfsGroup)[keyof typeof VfsGroup][];
	switch (groupName) {
		case 'all': {
			groups = [VfsGroup.InitialBundle, VfsGroup.Bundle];
			break;
		}
		case 'main': {
			groups = [VfsGroup.Bundle];
			break;
		}
		case 'initial': {
			groups = [VfsGroup.InitialBundle];
			break;
		}
		default: {
			throw new Error('--group must be initial, main, or all');
		}
	}
	const catalogs = await Promise.all(groups.map((group) => context.vfs.group(group)));
	const names = catalogs
		.values()
		.flatMap((group) => group.catalog.names())
		.toArray();
	const found: ResolvedShader[] = [];
	await mapPool(names, SHADER_SCAN_CONCURRENCY, async (bundlePath) => {
		let files;
		try {
			files = await openAssetFiles(await openBundle(context, bundlePath), { eager: false });
		} catch {
			return;
		}
		for (const file of files) {
			for (const info of file.file.objects) {
				if (info.classId !== UnityClass.Shader) {
					continue;
				}
				try {
					const ref: ObjectRef = { bundleIndex: resolver.bundleIndex(bundlePath), file, info };
					// oxlint-disable-next-line no-await-in-loop -- few shaders per bundle
					const shader = await loadShaderSummary(resolver, ref);
					if (pattern.test(shader.name)) {
						found.push({
							bundle: resolver.manifest.bundleName(ref.bundleIndex),
							object: objectKey(ref),
							summary: shader,
						});
					}
				} catch {
					// skip unreadable shader objects during broad scan
				}
			}
		}
	});
	found.sort((a, b) => compareStrings(a.summary.name, b.summary.name) || compareStrings(a.object, b.object));
	return found;
};

const inspectShader = async (
	context: Context,
	resolver: AssetResolver,
	target: string,
	options: {
		pathId: bigint | undefined;
		nameFilter: RegExp | undefined;
		propFilter: RegExp | undefined;
		types: Set<number> | undefined;
		flagMask: number;
		group: string;
		json: boolean;
	},
): Promise<void> => {
	let shaders: ResolvedShader[];
	let explicitSingle = false;

	if (options.pathId !== undefined || parseHash(target) !== null || BUNDLE_NAME.test(target)) {
		const refs =
			options.pathId === undefined && parseHash(target) === null
				? await resolveFromBundle(resolver, target, UnityClass.Shader, {
						nameFilter: options.nameFilter,
						all: true,
					})
				: [
						await resolveObjectArg(context, resolver, target, UnityClass.Shader, {
							pathId: options.pathId,
							nameFilter: options.nameFilter,
						}),
					];
		explicitSingle = refs.length === 1;
		shaders = await Promise.all(
			refs.map(async (ref) => ({
				bundle: resolver.manifest.bundleName(ref.bundleIndex),
				object: objectKey(ref),
				summary: await loadShaderSummary(resolver, ref),
			})),
		);
	} else {
		const hashes = await context.world.hashesOf(target);
		if (hashes.length === 1) {
			const ref = await resolver.findUnique({ hash: hashes[0], path: target }, UnityClass.Shader);
			explicitSingle = true;
			shaders = [
				{
					bundle: resolver.manifest.bundleName(ref.bundleIndex),
					object: objectKey(ref),
					summary: await loadShaderSummary(resolver, ref),
				},
			];
		} else {
			shaders = await findShadersByName(context, resolver, new RegExp(target, 'i'), options.group);
		}
	}

	const filteringProps =
		options.propFilter !== undefined || options.types !== undefined || options.flagMask !== 0;
	const rows = mapDefined(shaders, ({ bundle, object, summary: shader }) => {
		const properties = shader.properties.filter((prop) => {
			if (options.propFilter !== undefined && !options.propFilter.test(prop.name)) {
				return false;
			}
			if (options.types !== undefined && !options.types.has(prop.type)) {
				return false;
			}
			if (options.flagMask !== 0 && (prop.flags & options.flagMask) !== options.flagMask) {
				return false;
			}
			return true;
		});
		if (!explicitSingle && filteringProps && properties.length === 0) {
			return undefined;
		}
		return {
			name: shader.name,
			object,
			bundle,
			renderQueue: shader.renderQueue ?? null,
			tags: shader.tags,
			totalProperties: shader.properties.length,
			properties: properties.map((prop) => ({
				name: prop.name,
				type: SHADER_TYPE_NAMES[prop.type] ?? String(prop.type),
				flags: prop.flags,
				flagNames: shaderFlagNames(prop.flags),
				default: prop.type === ShaderPropertyType.Texture ? prop.defaultTexture : prop.default,
				raw: prop,
			})),
		};
	});

	if (options.json) {
		const payload = rows.map(({ properties, ...rest }) => ({
			...rest,
			properties: properties.map(({ raw: _raw, ...p }) => p),
		}));
		console.log(JSON.stringify(explicitSingle ? (payload[0] ?? null) : payload, jsonReplacer, '\t'));
		return;
	}

	for (const [index, row] of rows.entries()) {
		if (index > 0) {
			console.log('');
		}
		const queue = row.renderQueue === null ? '' : `  queue=${row.renderQueue}`;
		console.log(`${row.name}  (${row.bundle}  ${row.object})${queue}`);
		const tagEntries = Object.entries(row.tags);
		if (tagEntries.length > 0) {
			console.log(`  tags: ${tagEntries.map(([k, v]) => `${k}=${v}`).join(', ')}`);
		}
		const countLabel =
			row.properties.length === row.totalProperties
				? `${row.properties.length}`
				: `${row.properties.length} of ${row.totalProperties}`;
		console.log(`  properties (${countLabel}):`);
		for (const prop of row.properties) {
			const flags = prop.flagNames.length === 0 ? '' : `  [${prop.flagNames.join(', ')}]`;
			const flagHex = prop.flags === 0 ? '' : ` (0x${prop.flags.toString(16)})`;
			console.log(
				`    ${prop.name.padEnd(36)} ${prop.type.padEnd(8)} ${formatPropertyDefault(prop.raw).padEnd(26)}${flags}${flagHex}`,
			);
		}
	}
	console.error(`${rows.length} shader${rows.length === 1 ? '' : 's'}`);
};

// #endregion

// #region water-config

const inspectWaterConfig = async (resolver: AssetResolver, ref: ObjectRef): Promise<void> => {
	const value = await resolver.read(ref);
	const header = { object: objectKey(ref), bundle: resolver.manifest.bundleName(ref.bundleIndex) };
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
				bundle: resolver.manifest.bundleName(ref.bundleIndex),
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
