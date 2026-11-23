import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DEFAULT_PROFILE } from './default-profile.ts';
import { cloudLook, deriveEnvironment, reflectionProbeLumaSh, shaderShL1, skyViewScale } from './derive.ts';
import type { CloudInput } from './profile-input.ts';

// Power Plateau's overcast phase once e3m5 reaches state 3 (Env_map01_lv007_art_overcast_brightness)
const overcast: CloudInput = {
	enable: true,
	cloudTexture: 7,
	cloudTint: [0.507, 0.4585, 0.548, 0.0745],
	cloudContrast: 1,
	lightAffectCloud: true,
	cloudBrightness: -0.31,
	cloudAbsoluteBrightness: 1,
	brightnessAffectCloudAlpha: true,
	drawCloudAfterPlanet: true,
	cloudTextureMode: 1,
	cloudOpacityR: 0.374,
	cloudOpacityG: 0.569,
	cloudFadeAlpha: 1,
	rotation: 0,
	enableCloudShadow: false,
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- unread by the panorama
	cloudShadowConfig: null as unknown as CloudInput['cloudShadowConfig'],
};
const light = { directLux: 90000, directEV100: 13.5 };
const sky = { proceduralSkyLuxFactor: 2.43 };

describe('cloudLook', () => {
	it('lights the clouds by the exposed sun when lightAffectCloud is set, alpha included', () => {
		const look = cloudLook(overcast, light, sky);
		assert.ok(look !== null);
		const brightness = (-0.31 + 90000 / (1.2 * 2 ** 13.5) / Math.PI) * 2.43;
		assert.ok(Math.abs(look.tint[0] - 0.507 * brightness) < 1e-9);
		assert.ok(Math.abs(look.tint[3] - 0.0745 * brightness) < 1e-9);
		// about 4.3×, so the overcast reads instead of a 7% veil
		assert.ok(look.tint[3] > 0.3);
	});

	it('takes the absolute brightness otherwise, keeping alpha unless asked', () => {
		const look = cloudLook(
			{ ...overcast, lightAffectCloud: false, cloudAbsoluteBrightness: 3, brightnessAffectCloudAlpha: false },
			light,
			sky,
		);
		assert.ok(look !== null);
		assert.ok(Math.abs(look.tint[0] - 0.507 * 3) < 1e-9);
		assert.equal(look.tint[3], 0.0745);
	});
});

describe('skyViewScale', () => {
	it('is the outer sun colour × the exposed sun × the procedural sky lux factor', () => {
		const scale = skyViewScale(light, sky, { outerSunIrradianceColor: [1, 0.5, 0.25, 1] });
		const expected = (90000 / (1.2 * 2 ** 13.5)) * 2.43;
		assert.ok(Math.abs(scale[0] - expected) < 1e-9);
		assert.ok(Math.abs(scale[1] - expected * 0.5) < 1e-9);
		assert.ok(Math.abs(scale[2] - expected * 0.25) < 1e-9);
	});
});

describe('shaderShL1', () => {
	it('packs pure L1 coefficients scaled by factor without the L2 u6 fold', () => {
		const sh = Array.from({ length: 27 }, (_, i) => i + 1);
		const out = shaderShL1(sh, 2);
		assert.equal(out.length, 12);
		// channel 0: u3=4, u1=2, u2=3, u0=1 (ignoring u6=7), × 2
		assert.deepEqual([...out.subarray(0, 4)], [8, 4, 6, 2]);
		// channel 1: u3=13, u1=11, u2=12, u0=10, × 2
		assert.deepEqual([...out.subarray(4, 8)], [26, 22, 24, 20]);
		// channel 2: u3=22, u1=20, u2=21, u0=19, × 2
		assert.deepEqual([...out.subarray(8, 12)], [44, 40, 42, 38]);
	});
});

describe('deriveEnvironment ivDefaultSh', () => {
	it('scales skyAmbientSH by skyDirectIntensity and indirectDiffuseFactor', () => {
		const sh = Array.from({ length: 27 }, (_, i) => (i % 9 === 0 ? 0.5 : 0));
		const env = deriveEnvironment({
			...DEFAULT_PROFILE,
			light: { ...DEFAULT_PROFILE.light, indirectDiffuseFactor: 1.5 },
			sky: {
				...DEFAULT_PROFILE.sky,
				skyAmbientSH: sh,
				skyDirectIntensity: 2,
				useCustomIVDefaultSH: false,
			},
		});
		// L0 = 0.5 × 2 × 1.5 = 1.5 per channel
		assert.deepEqual([...env.ivDefaultSh], [0, 0, 0, 1.5, 0, 0, 0, 1.5, 0, 0, 0, 1.5]);
	});

	it('switches to customIVDefaultSH when useCustomIVDefaultSH is set', () => {
		const skySh = Array.from({ length: 27 }, () => 0.1);
		const customSh = Array.from({ length: 27 }, (_, i) => (i % 9 === 0 ? 0.25 : 0));
		const env = deriveEnvironment({
			...DEFAULT_PROFILE,
			light: { ...DEFAULT_PROFILE.light, indirectDiffuseFactor: 1 },
			sky: {
				...DEFAULT_PROFILE.sky,
				skyAmbientSH: skySh,
				skyDirectIntensity: 4,
				useCustomIVDefaultSH: true,
				customIVDefaultSH: customSh,
			},
		});
		assert.deepEqual([...env.ivDefaultSh], [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]);
	});
});

describe('reflectionProbeLumaSh', () => {
	it('packs unscaled pure L1 luminance with Y and Z swapped as PrepareConstantBuffer does', () => {
		const sh = Array.from({ length: 27 }, () => 0);
		// uniform white across channels: u0=1, u1=2, u2=3, u3=4, u6=10 (ignored)
		for (let c = 0; c < 3; c++) {
			sh[c * 9 + 0] = 1;
			sh[c * 9 + 1] = 2;
			sh[c * 9 + 2] = 3;
			sh[c * 9 + 3] = 4;
			sh[c * 9 + 6] = 10;
		}
		const out = reflectionProbeLumaSh(sh);
		assert.ok(Math.abs(out[0] - 4) < 1e-6);
		assert.ok(Math.abs(out[1] - 3) < 1e-6);
		assert.ok(Math.abs(out[2] - 2) < 1e-6);
		assert.ok(Math.abs(out[3] - 1) < 1e-6);

		const env = deriveEnvironment({
			...DEFAULT_PROFILE,
			light: { ...DEFAULT_PROFILE.light, indirectDiffuseFactor: 3 },
			sky: { ...DEFAULT_PROFILE.sky, skyAmbientSH: sh, skyDirectIntensity: 5 },
		});
		assert.deepEqual(env.reflectionProbeSh, out);
	});
});
