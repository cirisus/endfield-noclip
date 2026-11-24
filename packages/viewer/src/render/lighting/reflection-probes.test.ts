import assert from 'node:assert/strict';
import { it } from 'node:test';

import {
	ReflectionProbeShape,
	type ReflectionProbeEntry,
} from '@endfield-noclip/package-format/reflection-probes';

import { MAX_REFLECTION_PROBES, selectVisibleProbes } from './reflection-probes.ts';

const probe = (id: number, x: number, halfExtent: number, importance: number): ReflectionProbeEntry => ({
	entityId: id,
	group: 0,
	texture: id,
	importance,
	shape: ReflectionProbeShape.Box,
	boxProjection: true,
	intensity: 1,
	center: [x, 0, 0],
	boundsExtents: [halfExtent, halfExtent, halfExtent],
	halfExtents: [halfExtent, halfExtent, halfExtent],
	invBlendDistance: [1, 1, 1],
	worldToLocal: [1, 0, 0, -x, 0, 1, 0, 0, 0, 0, 1, 0],
	lumaSh: [0, 0, 0, 1],
});

it('keeps nearby probes ahead of distant higher-importance probes, then sorts kept probes by importance', () => {
	const entries: ReflectionProbeEntry[] = [
		// camera is inside this low-importance probe
		probe(1, 0, 10, 2),
		// nearby medium-importance probe
		probe(2, 25, 10, 5),
	];
	// fill more than MAX_REFLECTION_PROBES distant high-importance probes
	for (let i = 0; i < MAX_REFLECTION_PROBES + 5; i++) {
		entries.push(probe(100 + i, 500 + i * 20, 10, 100));
	}

	const selected = selectVisibleProbes(entries, [0, 0, 0], []);
	assert.equal(selected.length, MAX_REFLECTION_PROBES);
	// both nearby probes must survive eviction by the 37 distant high-importance probes
	assert.ok(selected.some((p) => p.texture === 1));
	assert.ok(selected.some((p) => p.texture === 2));
	// shading order puts highest importance first (distant 100, then 5, then 2)
	assert.equal(selected.at(-2)?.texture, 2);
	assert.equal(selected.at(-1)?.texture, 1);
});
