import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
	AnimationFlags,
	AnimationKind,
	decodeAnimationBlob,
	encodeAnimationBlob,
	MaterialParamId,
	sampleTransformClip,
	type AnimationBlob,
	type TransformAnimationBlob,
} from './animation.ts';

describe('AnimationBlob (EFAN)', () => {
	it('round-trips every animation kind', () => {
		const clips: AnimationBlob[] = [
			{
				kind: AnimationKind.Skin,
				flags: AnimationFlags.Loop,
				duration: 2,
				frameRate: 1,
				frameCount: 2,
				boneCount: 1,
				bounds: { min: [-1, -2, -3], max: [1, 2, 3] },
				matrices: new Float32Array(24).fill(1),
			},
			{
				kind: AnimationKind.Transform,
				flags: AnimationFlags.Loop | AnimationFlags.TranslationOnly,
				duration: 2,
				frameRate: 1,
				frameCount: 2,
				frames: new Float32Array([0, 0, 0, 2, 4, 6]),
			},
			{
				kind: AnimationKind.Spin,
				flags: AnimationFlags.Loop,
				duration: 0,
				frameRate: 0,
				frameCount: 0,
				pivot: [1, 2, 3],
				axis: [0, 1, 0],
				speed: 1.5,
			},
			{
				kind: AnimationKind.WaterFloat,
				flags: 0,
				duration: 0,
				frameRate: 0,
				frameCount: 0,
				waterVolume: 4,
				offset: -0.25,
				lag: 0.5,
			},
			{
				kind: AnimationKind.Vat,
				flags: AnimationFlags.Loop,
				duration: 3,
				frameRate: 30,
				frameCount: 90,
				posTexture: 12,
				normalTexture: 13,
				posMin: [-1, -1, -1],
				posMax: [1, 1, 1],
			},
			{
				kind: AnimationKind.Material,
				flags: AnimationFlags.Loop | AnimationFlags.Stepped,
				duration: 1,
				frameRate: 2,
				frameCount: 2,
				tracks: [
					{
						paramId: MaterialParamId.EmissiveIntensity,
						components: 1,
						flags: 1,
						samples: new Float32Array([0.5, 2.0]),
					},
				],
			},
		];

		for (const clip of clips) {
			const decoded = decodeAnimationBlob(encodeAnimationBlob(clip));
			assert.deepEqual(decoded, clip);
		}
	});

	it('samples looping translation-only transform clips with wrap interpolation', () => {
		const clip: TransformAnimationBlob = {
			kind: AnimationKind.Transform,
			flags: AnimationFlags.Loop | AnimationFlags.TranslationOnly,
			duration: 2,
			frameRate: 1,
			frameCount: 2,
			frames: new Float32Array([0, 0, 0, 10, 20, 30]),
		};
		assert.deepEqual(sampleTransformClip(clip, 0.5, [0, 0, 0]), [5, 10, 15]);
		assert.deepEqual(sampleTransformClip(clip, 1.5, [0, 0, 0]), [5, 10, 15]);
	});
});
