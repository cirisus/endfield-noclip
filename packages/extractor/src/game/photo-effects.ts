/* oxlint-disable no-await-in-loop -- bounded prefab traversal and conversion */
import { UnityClass } from '@endfield-noclip/formats/unity/serialized-file';
import { arrayField, asPPtr, isObject, pptrField } from '@endfield-noclip/formats/unity/values';
import { CurveMode, ParticleAlignment, ParticleRenderMode } from '@endfield-noclip/package-format/particles';
import type { PhotoEffect } from '@endfield-noclip/package-format/photo-filters';

import type { Context } from '../context.ts';
import { convertTexture } from '../pack/textures.ts';

import { loadTexture } from './asset-decode.ts';
import type { ObjectRef } from './assets.ts';
import { loadMaterial } from './material-load.ts';
import { findParticleQuad } from './particle-quad.ts';
import { readPrefabRenderers } from './prefab.ts';

/**
 * @param context the source install
 * @param id effect prefab id from the snapshot table
 * @returns supported additive billboard emitters and explicit unsupported parts
 * @throws {Error} for missing assets or malformed prefab data
 */
export const loadPhotoEffects = async (
	context: Context,
	id: string,
): Promise<{ effects: PhotoEffect[]; unsupported: string[] }> => {
	const resolver = await context.resolver();
	const path = `Assets/Beyond/DynamicAssets/Gameplay/Effects/Prefabs/${id}.prefab`;
	const hashes = await context.world.hashesOf(path);
	if (hashes.length !== 1) {
		throw new Error(`${id}: expected one effect prefab hash`);
	}
	const root = await resolver.findUnique({ hash: hashes[0], path }, UnityClass.GameObject);
	const quad = await findParticleQuad(context, resolver);
	if (quad === null) {
		throw new Error(`${id}: missing particle quad`);
	}
	const effects: PhotoEffect[] = [];
	const unsupported: string[] = [];
	for (const draw of await readPrefabRenderers(resolver, root, {
		viewPose: null,
		particleQuad: quad,
		locked: false,
	})) {
		const particles = draw.particles;
		if (
			particles === null ||
			particles.renderMode !== ParticleRenderMode.Billboard ||
			particles.alignment !== ParticleAlignment.View ||
			particles.motion.kind !== 'free' ||
			particles.motion.gravityModifier.mode !== CurveMode.Constant ||
			particles.motion.gravityModifier.scalar !== 0 ||
			particles.motion.velocity !== null ||
			particles.motion.clamp !== null ||
			particles.motion.forces !== null ||
			particles.customData !== null ||
			particles.ringBuffer !== null ||
			particles.bursts.length !== 0 ||
			particles.pivot.some((v) => v !== 0) ||
			particles.startRotation.slice(0, 2).some((v) => v.mode !== CurveMode.Constant || v.scalar !== 0) ||
			(particles.rotationOverLifetime !== null &&
				particles.rotationOverLifetime
					.slice(0, 2)
					.some((v) => v.mode !== CurveMode.Constant || v.scalar !== 0)) ||
			draw.materials.length !== 1 ||
			draw.materials[0] === null
		) {
			unsupported.push(`${draw.name}: unsupported camera emitter`);
			continue;
		}
		const material = await loadMaterial(resolver, draw.materials[0]);
		const { record, shader, textures } = material;
		const main = textures['_MainTex']?.ref;
		if (
			shader.name !== 'HGRP/Effect/VFXBaseV2' ||
			record.keywords.length !== 0 ||
			!main ||
			record.floats['_BlendMode'] !== 1 ||
			record.floats['_UseMainTexAsAlpha'] !== 0 ||
			record.floats['_UseFresnel'] !== 0 ||
			record.floats['_ExpIntensity'] !== 0 ||
			Object.entries(textures).some(([key, slot]) => key !== '_MainTex' && slot.ref !== null)
		) {
			unsupported.push(`${draw.name}: unsupported camera material`);
			continue;
		}
		const slot = record.textures['_MainTex'];
		if (slot.scale.some((v) => v !== 1) || slot.offset.some((v) => v !== 0)) {
			unsupported.push(`${draw.name}: particle texture transform`);
			continue;
		}
		const texture = await loadTexture(resolver, main);
		const converted = convertTexture(texture).entry;
		if (
			texture.kind !== '2d' ||
			(converted.format !== 'bc7-rgba-unorm' && converted.format !== 'bc7-rgba-unorm-srgb')
		) {
			unsupported.push(`${draw.name}: unsupported particle texture`);
			continue;
		}
		if (converted.sampler.mipBias !== 0) {
			unsupported.push(`${draw.name}: particle mip bias`);
			continue;
		}
		const tint = record.colors['_TintColor'] ?? [1, 1, 1, 1];
		const intensity = record.floats['_TintColorIntensity'] ?? 1;
		effects.push({
			name: draw.name,
			matrix: Array.from(draw.matrix),
			particles,
			tint: [
				tint[0] * intensity,
				tint[1] * intensity,
				tint[2] * intensity,
				tint[3] * (record.floats['_TintColorAlpha'] ?? 1),
			],
			ignorePostExposure: record.floats['_IgnorePostExposure'] !== 0,
			texture: {
				width: texture.width,
				height: texture.height,
				format: converted.format,
				sampler: converted.sampler,
				levels: texture.levels.map((level) => Buffer.from(level).toString('base64')),
			},
		});
	}
	// the shared closed-form particle evaluator deliberately ignores Unity's noise module.
	const visit = async (go: ObjectRef, depth: number): Promise<void> => {
		if (depth > 64) {
			throw new Error('effect hierarchy deeper than 64');
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
			if (!ref) {
				continue;
			}
			const raw = await resolver.read(ref);
			if (
				ref.info.classId === UnityClass.ParticleSystem &&
				isObject(raw.NoiseModule) &&
				raw.NoiseModule.enabled
			) {
				unsupported.push('particle noise');
			}
			if (ref.info.classId === UnityClass.Transform) {
				for (const pointer of arrayField(raw, 'm_Children')) {
					const childTransform = await resolver.resolve(ref, asPPtr(pointer));
					if (childTransform) {
						const child = await resolver.resolve(
							childTransform,
							pptrField(await resolver.read(childTransform), 'm_GameObject'),
						);
						if (child) {
							await visit(child, depth + 1);
						}
					}
				}
			}
		}
	};
	await visit(root, 0);
	return { effects, unsupported };
};
