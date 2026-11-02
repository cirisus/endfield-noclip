/* oxlint-disable no-await-in-loop -- keep bundle residency bounded while visiting the small library */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { readEnvironmentPhase } from '@endfield-noclip/formats/hg/environment-phase';
import { isSparkBean, parseSparkTable } from '@endfield-noclip/formats/hg/spark-buffer';
import { toPlainObject } from '@endfield-noclip/formats/unity/plain-object';
import { UnityClass } from '@endfield-noclip/formats/unity/serialized-file';
import { arrayField, asPPtr, isObject, pptrField, stringField } from '@endfield-noclip/formats/unity/values';
import type { ColorGradingConfig } from '@endfield-noclip/package-format/environment';
import type { PhotoFilter, PhotoFilters } from '@endfield-noclip/package-format/photo-filters';

import { withContext } from '../context.ts';
import { loadTexture } from '../game/asset-decode.ts';
import type { ObjectRef } from '../game/assets.ts';
import { loadPhotoEffects } from '../game/photo-effects.ts';
import { readPrefabEnvironmentVolumes } from '../game/prefab-environment.ts';
import { VfsGroup } from '../hg/vfs.ts';

export const summary = 'export the install’s photo filters and LUTs: filters [-o out/photo-filters.json]';

/** command usage, available without opening the install */
export const usage = 'usage: filters [-o out/photo-filters.json]';

/**
 * @param args CLI arguments, including the local config and output path
 * @returns after writing a library; missing or unsupported assets fail explicitly
 */
export const run = async (args: string[]): Promise<void> => {
	const { values } = parseArgs({
		args,
		options: {
			config: { type: 'string' },
			output: { type: 'string', short: 'o', default: 'out/photo-filters.json' },
		},
	});
	await withContext(values.config, async (context) => {
		const table = async (name: string) => {
			const file = await context.vfs.find(VfsGroup.Table, `Data/TableCfg/${name}.bytes`);
			if (file === undefined) {
				throw new Error(`missing ${name}`);
			}
			return parseSparkTable(await context.vfs.readVerified(file)).entries;
		};
		const text = new Map(await table('I18nTextTable_EN'));
		const resolver = await context.resolver();
		const filters: PhotoFilter[] = [];
		const rows = (await table('SnapshotFilterTable'))
			.map(([, row]) => {
				if (!isSparkBean(row)) {
					throw new Error('invalid snapshot filter row');
				}
				return row;
			})
			// oxlint-disable-next-line unicorn/no-array-sort -- sorts the newly mapped rows
			.sort((a, b) => Number(a.sortId) - Number(b.sortId));
		for (const row of rows) {
			const field = (key: string): string => {
				const value = row[key];
				if (typeof value !== 'string') {
					throw new Error(`invalid snapshot filter ${key}`);
				}
				return value;
			};
			const id = field('id');
			const path = `Assets/Beyond/DynamicAssets/Gameplay/Snapshot/Filter/Volume/${field('filterPath')}.prefab`;
			const hashes = await context.world.hashesOf(path);
			if (hashes.length !== 1) {
				throw new Error(`${id}: expected one prefab path hash`);
			}
			const root = await resolver.findUnique({ hash: hashes[0], path }, UnityClass.GameObject);
			const textId = isSparkBean(row.name) ? row.name.id : null;
			const name = typeof textId === 'bigint' ? text.get(textId) : undefined;
			const filter: PhotoFilter = {
				id,
				name: typeof name === 'string' ? name : id,
				unsupported: [],
				grading: null,
				vignette: null,
				bloom: null,
				lut: null,
			};
			if (field('filterEffectPath') !== '') {
				const result = await loadPhotoEffects(context, field('filterEffectPath'));
				filter.effects = result.effects;
				filter.unsupported.push(...result.unsupported);
			}
			const volumes = await readPrefabEnvironmentVolumes(resolver, root, {
				position: [0, 0, 0],
				rotation: [0, 0, 0, 1],
				scale: [1, 1, 1],
			});
			for (const volume of volumes) {
				if (volume.phase === null) {
					continue;
				}
				const phase = readEnvironmentPhase(volume.phase.info.type.nodes, await resolver.read(volume.phase));
				for (const [key, section] of Object.entries(phase.sections)) {
					if (section.active && key !== 'colorGradingConfig') {
						filter.unsupported.push(key);
					}
				}
				const section = phase.sections.colorGradingConfig;
				if (!section.active) {
					continue;
				}
				// the converter preserves the TypeTree's config layout; pointers remain outside the JSON value.
				// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- readEnvironmentPhase preserves the config's TypeTree layout
				filter.grading = section.value as unknown as ColorGradingConfig;
				if (filter.grading.colorCurvesEnabled) {
					filter.unsupported.push('colour curves');
				}
				if (filter.grading.colorLookupEnabled) {
					const pointer = section.textures.find((t) => t.path.join('.') === 'colorLookupTexture');
					const ref = pointer && (await resolver.resolve(volume.phase, pointer.pptr));
					if (!ref) {
						throw new Error(`${id}: missing LUT`);
					}
					const texture = await loadTexture(resolver, ref);
					if (
						texture.kind !== '2d' ||
						texture.width !== texture.height ** 2 ||
						texture.height < 4 ||
						texture.height % 4 !== 0 ||
						texture.srgb ||
						texture.vkFormat !== 145
					) {
						throw new Error(`${id}: unsupported LUT shape or format`);
					}
					filter.lut = {
						size: texture.height,
						format: 'bc7-rgba-unorm',
						data: Buffer.from(texture.levels[0]).toString('base64'),
						contribution: filter.grading.colorLookupContribution,
					};
				}
			}
			// SRP volumes may override only selected parameters; preserve each overrideState.
			const visit = async (go: ObjectRef, depth: number): Promise<void> => {
				if (depth > 64) {
					throw new Error(`${id}: filter hierarchy deeper than 64`);
				}
				const data = await resolver.read(go);
				if (!data.m_IsActive) {
					return;
				}
				for (const item of arrayField(data, 'm_Component')) {
					if (!isObject(item)) {
						continue;
					}
					const ref = await resolver.resolve(go, pptrField(item, 'component'));
					if (ref === null) {
						continue;
					}
					const component = await resolver.read(ref);
					if (ref.info.classId === UnityClass.Transform) {
						for (const pointer of arrayField(component, 'm_Children')) {
							const transform = await resolver.resolve(ref, asPPtr(pointer));
							if (transform !== null) {
								const child = await resolver.resolve(
									transform,
									pptrField(await resolver.read(transform), 'm_GameObject'),
								);
								if (child !== null) {
									await visit(child, depth + 1);
								}
							}
						}
					} else if (component.m_Enabled && component.sharedProfile) {
						const profile = await resolver.resolve(ref, pptrField(component, 'sharedProfile'));
						if (profile === null) {
							continue;
						}
						for (const pointer of arrayField(await resolver.read(profile), 'components')) {
							const target = await resolver.resolve(profile, asPPtr(pointer));
							if (target === null) {
								continue;
							}
							const raw = await resolver.read(target);
							if (!raw.active) {
								continue;
							}
							const componentName = stringField(raw, 'm_Name');
							if (componentName !== 'Vignette' && componentName !== 'Bloom') {
								filter.unsupported.push(componentName);
								continue;
							}
							const { value } = toPlainObject(target.info.type.nodes, raw, {
								keepPPtr: () => false,
								dropField: (key) => key.startsWith('m_') || key === 'active',
							});
							const overrides = Object.fromEntries(
								Object.entries(value).filter(([key]) => isObject(raw[key]) && raw[key].overrideState),
							);
							if (componentName === 'Vignette') {
								filter.vignette = overrides;
							} else {
								const supported = new Set([
									'resolutionHighQuality',
									'thresholdHighQuality',
									'intensityHighQuality',
									'scatterHighQuality',
									'tint',
									'blendMode',
								]);
								filter.bloom = Object.fromEntries(
									Object.entries(overrides).filter(([key]) => supported.has(key)),
								);
								for (const key of [
									'bloomUpsampleAdditive',
									'characterBloomControl',
									'anamorphic',
									'dirtIntensity',
								]) {
									if (overrides[key]) {
										filter.unsupported.push(`bloom ${key}`);
									}
								}
							}
						}
					}
				}
			};
			await visit(root, 0);
			filter.unsupported = [...new Set(filter.unsupported)];
			filters.push(filter);
			console.error(
				`${filter.id}: ${filter.name}${filter.unsupported.length ? ` (partial: ${filter.unsupported.join(', ')})` : ''}`,
			);
		}
		const library: PhotoFilters = { format: 'endfield-noclip.photo-filters', version: 1, filters };
		const output = resolve(values.output);
		await mkdir(dirname(output), { recursive: true });
		await writeFile(output, JSON.stringify(library));
		console.error(`wrote ${filters.length} photo filters to ${output}`);
	});
};
