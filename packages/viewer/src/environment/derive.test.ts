import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { cloudLook, skyViewScale } from './derive.ts';
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
