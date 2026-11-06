import assert from 'node:assert/strict';
import { test } from 'node:test';

import { characterMovement, commonCapsule } from './character-movement.ts';

const component = (rid: bigint, radius: number) => ({
	rid,
	type: { class: 'CharacterMovementComponentData', ns: 'Beyond.Gameplay.Core' },
	data: { proxyShape: { radius, height: 1.8 }, movementData: { _overrideStepOffset: -1 } },
});

const fixture = (components: bigint[]) => ({
	data: { rid: 1n },
	references: {
		RefIds: [
			{
				rid: 1n,
				type: { class: 'CharacterTemplateData' },
				data: {
					id: 'character',
					bodyType: { bodyType: 3 },
					componentList: components.map((rid) => ({ rid })),
				},
			},
			component(2n, 0.35),
			component(3n, 9),
		],
	},
});

test('follows template references instead of taking unused movement records', () => {
	assert.deepEqual(characterMovement(fixture([2n])).proxyShape, { radius: 0.35, height: 1.8 });
	assert.throws(() => characterMovement(fixture([3n])), /capsule/);
	assert.throws(() => characterMovement(fixture([2n, 3n])), /one character/);
	assert.throws(() => characterMovement(fixture([99n])), /missing character component/);
});

test('chooses the common capsule independently of character order', () => {
	const base = characterMovement(fixture([2n]));
	const large = { ...base, proxyShape: { radius: 0.45, height: 2 } };
	assert.deepEqual(commonCapsule([large, base, base]), base.proxyShape);
	assert.deepEqual(commonCapsule([base, base, large]), base.proxyShape);
	assert.deepEqual(commonCapsule([base, large]), large.proxyShape);
	assert.throws(() => commonCapsule([]), /no character/);
});
