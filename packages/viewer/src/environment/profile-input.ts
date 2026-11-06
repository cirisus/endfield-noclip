/**
 * what the viewer reads of an environment profile: the game's `HGEnvironmentPhase` sections, keeping the
 * game's field names, plus the level's post profile
 *
 * @module
 */

import type {
	AmbientOcclusionSettings,
	AtmosphereConfig,
	BloomSettings,
	CloudConfig,
	FogConfig,
	HeightFogLayers,
	LightConfig,
	LightShaftConfig,
	ScreenSpaceReflectionSettings,
	ShadowConfig,
	SkyConfig,
	VignetteSettings,
	WindConfig,
} from '@endfield-noclip/package-format/environment';

import type { ColorGradingInput } from './color-grading.ts';
import type { AutoExposureInput } from './exposure.ts';
import type { SunDirections } from './sun.ts';

/** the parts of the game's light config the viewer reads */
export type LightInput = Pick<
	LightConfig,
	| 'directColor'
	| 'directLux'
	| 'directEV100'
	| 'directSpecularIntensity'
	| 'indirectDiffuseFactor'
	| 'indirectSpecularFactor'
> &
	SunDirections<'atmosphere' | 'lightShaft' | 'cloudShadow' | 'heightFogDirectionalInscattering'>;

/** the parts of the game's sky config the viewer reads */
export type SkyInput = Pick<
	SkyConfig,
	'skyAmbientSH' | 'skyDirectIntensity' | 'reflectionMap' | 'skyDistance' | 'proceduralSkyLuxFactor'
>;

/** the game's atmosphere config, Unreal's SkyAtmosphere parameters: kilometres and per-kilometre */
export type AtmosphereInput = AtmosphereConfig;

/** the game's distance fog (`HGFogConfig`), an analytic single-scattering fog it calls atmosphere fog */
type FogInput = Pick<
	FogConfig,
	| 'enable'
	| 'startDistance'
	| 'startHeight'
	| 'fallOffHeight'
	| 'fallOffDistance'
	| 'mieScattering'
	| 'mieScatteringScale'
	| 'mieAnisotropy'
	| 'rayleighScattering'
	| 'rayleighScatteringScale'
	| 'inscatterAmbientColor'
>;

/**
 * the game's two-layer exponential height fog, Unreal's ExponentialHeightFog parameters. both
 * `HGHeightFogConfig` and `HGVolumetricFogConfig` carry a set
 */
export type HeightFogInput = Pick<
	HeightFogLayers,
	| 'enable'
	| 'heightFogStartHeight'
	| 'heightFogDensity'
	| 'heightFogFalloff'
	| 'heightFogStartHeightSecond'
	| 'heightFogDensitySecond'
	| 'heightFogFalloffSecond'
	| 'heightFogInscatter'
	| 'heightFogMaxOpacity'
	| 'heightFogStartDistance'
	| 'heightFogStartTransition'
	| 'heightFogCutoffDistance'
	| 'heightFogCutoffTransition'
	| 'heightFogDirectionalInscatteringExponent'
	| 'heightFogDirectionalInscatteringStartDistance'
	| 'heightFogDirectionalInscattering'
	| 'enableFlowNoise'
	| 'flowNoiseIntensity'
	| 'flowNoiseDistance'
	| 'flowNoiseTilling'
	| 'flowNoiseDir'
	| 'flowNoiseSpeed'
>;

/** `HGVolumetricFogConfig`: its height-fog set plus the volumetric fog's own parameters */
export type VolumetricFogInput = HeightFogInput &
	Pick<
		HeightFogLayers,
		| 'volumetricFogScatteringDistribution'
		| 'volumetricFogAlbedo'
		| 'volumetricFogEmissive'
		| 'volumetricFogExtinctionScale'
		| 'volumetricFogDistance'
		| 'volumetricFogStartDistance'
		| 'volumetricFogNearFadeInDistance'
		| 'volumetricFogDirectLightingScatteringIntensity'
		| 'volumetricFogSkyLightingScatteringIntensity'
	>;

/**
 * the parts of the game's post volume the viewer reads (HDRP-style bloom, URP-style vignette, XeGTAO's
 * settings)
 */
export interface PostInput {
	bloom: Pick<
		BloomSettings,
		| 'resolutionHighQuality'
		| 'thresholdHighQuality'
		| 'intensityHighQuality'
		| 'scatterHighQuality'
		| 'tint'
		| 'blendMode'
	> | null;
	ambientOcclusion: Pick<
		AmbientOcclusionSettings,
		| 'enable'
		| 'custom'
		| 'radius'
		| 'radiusMultiplier'
		| 'falloffRange'
		| 'sampleDistributionPower'
		| 'thinOccluderCompensation'
		| 'finalValuePower'
	> | null;
	vignette: Pick<
		VignetteSettings,
		'color' | 'center' | 'intensity' | 'smoothness' | 'roundness' | 'rounded'
	> | null;
	screenSpaceReflection: Pick<
		ScreenSpaceReflectionSettings,
		'enable' | 'fadenessOnScreen' | 'fadenessOnMirrorMul' | 'fadenessOnMirrorAdd'
	> | null;
}

/** the game's panoramic cloud layer */
export type CloudInput = Pick<
	CloudConfig,
	| 'enable'
	| 'cloudTexture'
	| 'cloudTint'
	| 'cloudContrast'
	| 'lightAffectCloud'
	| 'cloudBrightness'
	| 'cloudAbsoluteBrightness'
	| 'brightnessAffectCloudAlpha'
	| 'drawCloudAfterPlanet'
	| 'cloudTextureMode'
	| 'cloudOpacityR'
	| 'cloudOpacityG'
	| 'cloudFadeAlpha'
	| 'rotation'
	| 'enableCloudShadow'
	| 'cloudShadowConfig'
>;

/** the parts of the game's shadow config the viewer reads */
type ShadowInput = Pick<
	ShadowConfig,
	| 'csmIntensity'
	| 'csmRampTexture'
	| 'csmShadowSoftness'
	| 'disableCsmBlendFactor'
	| 'csmSimulatedAttenuation'
>;

/** the parts of the game's light shaft config the viewer reads */
export type LightShaftInput = Pick<
	LightShaftConfig,
	| 'enable'
	| 'bloomScale'
	| 'bloomThreshold'
	| 'bloomMaxBrightness'
	| 'bloomTint'
	| 'blurIntensity'
	| 'occlusionDepthRange'
>;

/** the parts of the game's wind config the viewer reads */
export type WindInput = Pick<WindConfig, 'speed' | 'direction'>;

/** what the viewer reads of an environment profile; extra fields are ignored */
export interface EnvironmentInput {
	name: string;
	light: LightInput;
	shadow: ShadowInput;
	sky: SkyInput;
	atmosphere: AtmosphereInput;
	fog: FogInput;
	heightFog: HeightFogInput;
	/** the volumetric fog, and its own height-fog set, which the game uses while volumetric fog is on */
	volumetricFog: VolumetricFogInput;
	cloud: CloudInput | null;
	colorGrading: ColorGradingInput;
	autoExposure: AutoExposureInput;
	lightShaft: LightShaftInput;
	wind: WindInput;
	post: PostInput | null;
}
