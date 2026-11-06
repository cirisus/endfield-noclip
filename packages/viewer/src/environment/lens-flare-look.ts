/**
 * the sun's lens flare as the environment sets it: SRP core's data-driven lens flare, which the game draws
 * for its sun from the environment's `lensFlare` section. `render/post/lens-flare-layout.ts` lays it out on
 * screen each frame
 *
 * @module
 */

import type {
	LensFlareConfig,
	LensFlareElement,
	LightConfig,
} from '@endfield-noclip/package-format/environment';
import type { Vec3, Vec4 } from '@endfield-noclip/package-format/values';

import { mapDefined, unique } from '@mary-ext/array-fns';

import { type SunDirections, towardsEffectLight } from './sun.ts';

/** the flare in effect: the config's settings and the elements that can draw */
export interface LensFlareLook {
	/** unit vector towards the sun */
	direction: Vec3;
	/** the light's raw colour, which elements marked `modulateByLightColor` take */
	lightColor: Vec4;
	intensity: number;
	scale: number;
	/** the occlusion test, or `null` without one */
	occlusion: { radius: number; samples: number } | null;
	allowOffScreen: boolean;
	/** visible image and circle elements, in drawing order */
	elements: LensFlareElement[];
}

/** the profile sections the flare comes from; absent in packages from before it was packed */
export interface LensFlareInput {
	lensFlare?: LensFlareConfig;
	light?: Pick<LightConfig, 'directColor'> & SunDirections<'lensFlare'>;
}

/** `flareType` of an image element */
export const FLARE_IMAGE = 0;
/** `flareType` of a circle element */
const FLARE_CIRCLE = 1;

/**
 * the sun's flare as the game overrides the sun's flare component with the environment's: the section's
 * flare, intensity, scale and occlusion, the light's flare direction and colour. polygons aren't drawn
 *
 * @param input the blended profile's sections, or `null` for the defaults (no flare)
 * @returns the flare, or `null` when nothing draws
 */
export const lensFlareLook = (input: LensFlareInput | null): LensFlareLook | null => {
	const config = input?.lensFlare;
	const light = input?.light;
	const data = config?.lensFlareData ?? null;
	if (
		config === undefined ||
		light === undefined ||
		data === null ||
		!config.enable ||
		config.intensity <= 0
	) {
		return null;
	}
	const elements = data.elements.filter(
		(element) =>
			element.visible &&
			element.count > 0 &&
			element.localIntensity > 0 &&
			((element.flareType === FLARE_IMAGE && element.lensFlareTexture !== null) ||
				element.flareType === FLARE_CIRCLE),
	);
	if (elements.length === 0) {
		return null;
	}
	const [r, g, b, a] = light.directColor;
	return {
		direction: towardsEffectLight(light, 'lensFlare'),
		lightColor: [r, g, b, a],
		intensity: config.intensity,
		scale: config.scale,
		occlusion: config.useOcclusion ? { radius: config.occlusionRadius, samples: config.sampleCount } : null,
		allowOffScreen: config.allowOffScreen,
		elements,
	};
};

/**
 * @param look the flare, or `null` for none
 * @returns the texture-table ids the flare's image elements sample
 */
export const lensFlareTextures = (look: LensFlareLook | null): number[] =>
	unique(
		mapDefined(look?.elements ?? [], ({ flareType, lensFlareTexture }) =>
			flareType === FLARE_IMAGE && lensFlareTexture !== null ? lensFlareTexture : undefined,
		),
	);
