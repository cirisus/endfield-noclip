import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
	decodeReflectionProbesTable,
	encodeReflectionProbesTable,
	type ReflectionProbeEntry,
	ReflectionProbeShape,
} from './reflection-probes.ts';

describe('reflection-probes binary codec', () => {
	it('round-trips reflection probe entries', () => {
		const probe: ReflectionProbeEntry = {
			entityId: 0x7006f13,
			group: 3,
			texture: 15100,
			shape: ReflectionProbeShape.Box,
			boxProjection: true,
			importance: 5,
			intensity: 1.5,
			center: [-898.5, 293.5, 425.25],
			boundsExtents: [150, 60, 110],
			halfExtents: [150, 60, 110],
			invBlendDistance: [0.0625, 0.125, 0.09375],
			worldToLocal: [1, 0, 0, 898.5, 0, 1, 0, -293.5, 0, 0, 1, -425.25],
			lumaSh: [0.25, -0.5, 0.125, 0.0625],
		};
		const encoded = encodeReflectionProbesTable({ probes: [probe] });
		const decoded = decodeReflectionProbesTable(encoded);
		assert.deepEqual(decoded.probes, [probe]);
	});

	it('round-trips an empty table', () => {
		const decoded = decodeReflectionProbesTable(encodeReflectionProbesTable({ probes: [] }));
		assert.deepEqual(decoded.probes, []);
	});
});
