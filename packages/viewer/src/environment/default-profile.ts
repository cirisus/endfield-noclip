/**
 * the look for packages without environment profiles
 *
 * @module
 */

import { NEUTRAL_GRADING } from './color-grading.ts';
import type { EnvironmentInput, HeightFogInput, PostInput } from './profile-input.ts';

/** a thin haze */
const DEFAULT_HEIGHT_FOG: HeightFogInput = {
	enable: true,
	heightFogStartHeight: 0,
	heightFogDensity: 0.02,
	heightFogFalloff: 0.2,
	heightFogStartHeightSecond: 0,
	heightFogDensitySecond: 0,
	heightFogFalloffSecond: 0.2,
	heightFogInscatter: [0.6, 0.75, 1, 1],
	heightFogMaxOpacity: 1,
	heightFogStartDistance: 0,
	heightFogStartTransition: 0.001,
	heightFogCutoffDistance: 100000,
	heightFogCutoffTransition: 0.001,
	heightFogDirectionalInscatteringExponent: 4,
	heightFogDirectionalInscatteringStartDistance: 0,
	heightFogDirectionalInscattering: [0, 0, 0, 1],
	enableFlowNoise: false,
	flowNoiseIntensity: 0,
	flowNoiseDistance: 60,
	flowNoiseTilling: 0.01,
	flowNoiseDir: [0, 0, 1],
	flowNoiseSpeed: 0,
};

/** the post-processing of {@link DEFAULT_PROFILE}, which also stands in for a level without a post profile */
export const DEFAULT_POST: PostInput = {
	bloom: {
		resolutionHighQuality: 2,
		thresholdHighQuality: 0.95,
		intensityHighQuality: 0.5,
		scatterHighQuality: 0.4,
		tint: [1, 1, 1, 1],
		blendMode: 2,
	},
	ambientOcclusion: {
		enable: true,
		custom: false,
		radius: 4,
		radiusMultiplier: 1,
		falloffRange: 1,
		sampleDistributionPower: 1,
		thinOccluderCompensation: 2,
		finalValuePower: 2.2,
	},
	vignette: {
		color: [0, 0, 0, 1],
		center: [0.5, 0.5],
		intensity: 0.3,
		smoothness: 0.2,
		roundness: 1,
		rounded: false,
	},
	// what every shipped profile sets
	screenSpaceReflection: {
		enable: true,
		fadenessOnScreen: 0.1,
		fadenessOnMirrorMul: 2,
		fadenessOnMirrorAdd: -1,
	},
};

/** the default look: a clear late-afternoon sky */
export const DEFAULT_PROFILE: EnvironmentInput = {
	name: 'default',
	light: {
		directColor: [1, 0.97, 0.92, 1],
		directLux: 60000,
		directEV100: 13,
		directSpecularIntensity: 1,
		directPitchYaw: [38, 35],
		indirectDiffuseFactor: 1,
		indirectSpecularFactor: 1,
		atmospherePitchYawMode: 0,
		atmospherePitchYaw: [38, 35],
		lightShaftPitchYawMode: 0,
		lightShaftPitchYaw: [38, 35],
		cloudShadowPitchYawMode: 0,
		cloudShadowPitchYaw: [38, 35],
		heightFogDirectionalInscatteringPitchYawMode: 0,
		heightFogDirectionalInscatteringPitchYaw: [38, 35],
	},
	shadow: {
		csmIntensity: 1,
		csmRampTexture: null,
		csmShadowSoftness: 0.01,
		disableCsmBlendFactor: 0,
		csmSimulatedAttenuation: 0,
	},
	sky: {
		// a sky brighter overhead than at the horizon, and a darker ground
		skyAmbientSH: [
			0.36, 0.14, 0, 0, 0, 0, 0, 0, 0.0, 0.44, 0.2, 0, 0, 0, 0, 0, 0, 0.0, 0.5, 0.26, 0, 0, 0, 0, 0, 0, 0.0,
		],
		skyDirectIntensity: 1,
		reflectionMap: null,
		skyDistance: 5000,
		proceduralSkyLuxFactor: 1,
	},
	atmosphere: {
		groundRadius: 6360,
		groundAlbedo: [0, 0, 0, 1],
		outerSunIrradianceColor: [1, 1, 1, 1],
		atmosphereHeight: 60,
		multiScatteringFactor: 1,
		rayleighScatteringScale: 0.0331,
		rayleighScattering: [0.175287, 0.409607, 1, 1],
		rayleighExponentialDistribution: 8,
		mieScatteringScale: 0.003996,
		mieScattering: [1, 1, 1, 1],
		mieAbsorptionScale: 0.000444,
		mieAbsorption: [1, 1, 1, 1],
		mieAnisotropy: 0.8,
		mieExponentialDistribution: 1.2,
		ozoneAbsorptionScale: 0.001881,
		ozoneAbsorption: [0.345561, 1, 0.045189, 1],
		tentTipAltitude: 25,
		tentTipValue: 1,
		tentWidth: 15,
	},
	fog: {
		enable: false,
		startDistance: 0,
		startHeight: 0,
		fallOffHeight: 1000,
		fallOffDistance: 1,
		mieScattering: [0, 0, 0, 1],
		mieScatteringScale: 0,
		mieAnisotropy: 0,
		rayleighScattering: [0, 0, 0, 1],
		rayleighScatteringScale: 0,
		inscatterAmbientColor: [0, 0, 0, 1],
	},
	heightFog: DEFAULT_HEIGHT_FOG,
	volumetricFog: {
		...DEFAULT_HEIGHT_FOG,
		enable: false,
		volumetricFogScatteringDistribution: 0.2,
		volumetricFogAlbedo: [1, 1, 1, 1],
		volumetricFogEmissive: [0, 0, 0, 1],
		volumetricFogExtinctionScale: 1,
		volumetricFogDistance: 100,
		volumetricFogStartDistance: 0,
		volumetricFogNearFadeInDistance: 0,
		volumetricFogDirectLightingScatteringIntensity: 1,
		volumetricFogSkyLightingScatteringIntensity: 1,
	},
	cloud: null,
	colorGrading: NEUTRAL_GRADING,
	// still air: the game's default wind isn't known
	wind: { speed: 0, direction: [0, 0, 1] },
	lightShaft: {
		enable: false,
		bloomScale: 0,
		bloomThreshold: 1,
		bloomMaxBrightness: 1,
		bloomTint: [1, 1, 1, 1],
		blurIntensity: 0,
		occlusionDepthRange: 5000,
	},
	post: DEFAULT_POST,
	// held at exposure 1
	autoExposure: {
		autoExposureMode: 1,
		autoExposureManualEvCompensationAuto: 0,
		autoExposureLerpUpSpeed: 1,
		autoExposureLerpDownSpeed: 1,
		autoExposureEv100Range: [-8, 4],
		autoExposureEv100HistogramRange: [-8, 4],
		autoExposureMeteringMode: 0,
		autoExposurePixelLuminanceRange: [0.05, 0.95],
		autoExposureEvClampRange: [0, 0],
		autoExposureManualEvCompensationManual: 0,
	},
};
