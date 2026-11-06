/**
 * the sun as the game's light config sets it: its exposed intensity, and the directions the shading and each
 * effect draw it at (docs/viewer/lighting.md#sun)
 *
 * @module
 */

import type { LightConfig } from '@endfield-noclip/package-format/environment';
import type { Vec2, Vec3 } from '@endfield-noclip/package-format/values';

/** the effects that draw the sun along a direction of their own (`<effect>PitchYaw`) */
export const SUN_EFFECTS = [
	'atmosphere',
	'lightShaft',
	'sunDisc',
	'lensFlare',
	'cloudShadow',
	'heightFogDirectionalInscattering',
] as const;

/** one of {@link SUN_EFFECTS} */
type SunEffect = (typeof SUN_EFFECTS)[number];

/** the light config's direction fields for the given effects */
export type SunDirections<E extends SunEffect> = Pick<
	LightConfig,
	'directPitchYaw' | `${E}PitchYawMode` | `${E}PitchYaw`
>;

/**
 * @param light the light config
 * @param effect the effect
 * @returns the pitch and yaw (degrees) the effect draws the sun at: its own when its mode is 1, else the
 *   sun's
 */
export const effectPitchYaw = <E extends SunEffect>(light: SunDirections<E>, effect: E): Vec2 => {
	const mode: number = light[`${effect}PitchYawMode`];
	const own: Vec2 = light[`${effect}PitchYaw`];
	return mode === 1 ? own : light.directPitchYaw;
};

/**
 * @param pitchYaw degrees: pitch below the horizon the light travels at, yaw from +Z towards +X
 * @returns the unit vector pointing back at the light
 */
export const towardsLight = ([pitch, yaw]: Vec2): Vec3 => {
	const p = (pitch * Math.PI) / 180;
	const y = (yaw * Math.PI) / 180;
	// the light travels along (cos p sin y, -sin p, cos p cos y)
	return [-Math.cos(p) * Math.sin(y), Math.sin(p), -Math.cos(p) * Math.cos(y)];
};

/**
 * @param light the light config
 * @param effect the effect
 * @returns the unit vector towards the sun as the effect draws it
 */
export const towardsEffectLight = <E extends SunEffect>(light: SunDirections<E>, effect: E): Vec3 =>
	towardsLight(effectPitchYaw(light, effect));

/**
 * the sun's pre-exposed illuminance, `directLux · preExposure`. computed rather than read from the config's
 * `directIntensity`, which some phases carry stale
 *
 * @param light the light config
 * @returns the intensity
 */
export const exposedSunIntensity = (light: Pick<LightConfig, 'directLux' | 'directEV100'>): number =>
	light.directLux / (1.2 * 2 ** light.directEV100);
