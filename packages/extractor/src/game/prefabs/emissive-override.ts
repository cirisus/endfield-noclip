import { FormatError } from '@endfield-noclip/formats/binary/binary-reader';
import { hasTypeFields, type TypeTreeObject } from '@endfield-noclip/formats/unity/type-tree';
import {
	arrayField,
	asPPtr,
	booleanField,
	colorField,
	numberField,
	type PPtr,
	pptrField,
} from '@endfield-noclip/formats/unity/values';

import type { AssetResolver, ObjectRef } from '../assets/assets.ts';

export type Rgba = [number, number, number, number];

/**
 * what an `AnimationProperties_Emissive` writes into the per-draw data of its renderers
 * ([emission](../../../../docs/game-data/materials.md#emission))
 */
export interface EmissiveColors {
	/** `emissiveColor`: HDR, linear; its alpha is how far it replaces the material's `_EmissiveColor` */
	color: Rgba;
	/**
	 * `emissiveAlbedoColor`: HDR, linear; its alpha is how strongly it tints the albedo where the emission's
	 * strength is at least 0.1
	 */
	albedo: Rgba;
	/** per-draw breathing (`_m8.xy`) applied on `_EMISSIVE_ANIM_SWEEP` materials, or `null` when still */
	breath: { frequency: number; intensity: number } | null;
}

/**
 * an `AnimationProperties_Emissive` component: a VFX playable that starts playing when enabled and writes its
 * colours into the per-draw data of the renderers it lists
 */
export interface EmissiveOverride {
	/** the renderers it writes to */
	renderers: PPtr[];
	colors: EmissiveColors;
}

/** @returns breathing parameters when both frequency and intensity are positive, else `null` */
const breathingOf = (frequency: number, intensity: number): { frequency: number; intensity: number } | null =>
	frequency > 0 && intensity > 0 ? { frequency, intensity: Math.min(Math.max(intensity, 0), 1) } : null;

/**
 * @param ref a MonoBehaviour
 * @returns whether its serialized fields are an `AnimationProperties_Emissive`'s, without reading the object
 */
export const isEmissiveOverrideType = (ref: ObjectRef): boolean =>
	hasTypeFields(ref.info.type, 'affectRenderers', 'emissiveColor', 'emissiveAlbedoColor', 'breathFrequency');

/**
 * reads the resting colours and breathing of an `AnimationProperties_Emissive`
 *
 * @param data the component's fields (see {@link isEmissiveOverrideType})
 * @returns the renderers it lists and the per-draw values it gives them
 */
export const readEmissiveOverride = (data: TypeTreeObject): EmissiveOverride => ({
	renderers: arrayField(data, 'affectRenderers').map((pointer) => asPPtr(pointer)),
	colors: {
		color: colorField(data, 'emissiveColor'),
		albedo: colorField(data, 'emissiveAlbedoColor'),
		breath: breathingOf(numberField(data, 'breathFrequency'), numberField(data, 'breathIntensity')),
	},
});

/**
 * the GameObject name a pose's emissive configs give the prefab root, which a root animator's empty name
 * means
 */
export const ROOT_EMISSIVE = '';

/** what an `InteractiveEmissiveConfig` leaves `emissiveAlbedoColor` at without a base colour */
const NO_ALBEDO: Rgba = [1, 1, 1, 0];

/**
 * reads an `InteractiveEmissiveConfig`, which an interactive's view states apply to an
 * `AnimationProperties_Emissive` in place of its saved values, and the colour and cycle assets it points to
 *
 * @param resolver bundle reader
 * @param ref the config's MonoBehaviour
 * @returns the values it sets on the component: its base colour asset's as the albedo tint (or white at alpha
 *   0 without one) and its breathing cycle when non-constant
 * @throws {FormatError} if it has no colour asset, which the game requires
 */
export const readEmissiveConfig = async (
	resolver: AssetResolver,
	ref: ObjectRef,
): Promise<EmissiveColors> => {
	const config = await resolver.read(ref);
	const colorRef = await resolver.resolve(ref, pptrField(config, 'colorConfig'));
	if (colorRef === null) {
		throw new FormatError(`emissive config ${ref.info.pathId} has no colour config`);
	}
	const color = colorField(await resolver.read(colorRef), 'emissiveColor');
	const baseRef = await resolver.resolve(ref, pptrField(config, 'baseColorConfig'));
	const albedo = baseRef === null ? NO_ALBEDO : colorField(await resolver.read(baseRef), 'baseColor');
	const cycleRef = await resolver.resolve(ref, pptrField(config, 'cycleConfig'));
	let breath: EmissiveColors['breath'] = null;
	if (cycleRef !== null) {
		const cycle = await resolver.read(cycleRef);
		const isConst = booleanField(cycle, 'isConst');
		const duration = numberField(cycle, 'cycleDuration');
		const intensity = numberField(cycle, 'cycleIntensity');
		if (!isConst && duration > 1e-6 && intensity > 0) {
			breath = breathingOf(1 / duration, intensity);
		}
	}
	return { color, albedo, breath };
};
