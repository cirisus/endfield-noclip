import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { readEmissiveOverride } from './emissive-override.ts';

// the water drone targets' component (int_waterdrone_floating_target_postmodel) and material
// (M_anm_map02_machine+1_003_02, `_EMISSIVE_ANIM_SWEEP`)
const TARGET = {
	m_Enabled: 1,
	affectRenderers: [
		{ m_FileID: 0, m_PathID: 6008603127270556715n },
		{ m_FileID: 0, m_PathID: -582741042123488213n },
	],
	affectEntityRenderHelper: { m_FileID: 0, m_PathID: 0n },
	emissiveColor: { r: 0, g: 1, b: 0.16790390014648438, a: 1 },
	emissiveAlbedoColor: { r: 1, g: 0.04339611530303955, b: 0.04339611530303955, a: 0 },
	breathFrequency: 0,
	breathIntensity: 0,
};

describe('readEmissiveOverride', () => {
	it('reads the listed renderers, resting colours and breathing', () => {
		const read = readEmissiveOverride(TARGET);
		assert.equal(read.renderers.length, 2);
		assert.deepEqual(read.colors.color, [0, 1, 0.16790390014648438, 1]);
		// at alpha 0 the albedo tint tints nothing
		assert.deepEqual(read.colors.albedo, [1, 0.04339611530303955, 0.04339611530303955, 0]);
		assert.equal(read.colors.breath, null);

		const breathing = readEmissiveOverride({ ...TARGET, breathFrequency: 0.5, breathIntensity: 1.5 });
		assert.deepEqual(breathing.colors.breath, { frequency: 0.5, intensity: 1 });
	});
});
