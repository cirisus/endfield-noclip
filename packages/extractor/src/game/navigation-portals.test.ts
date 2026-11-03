import assert from 'node:assert/strict';
import { test } from 'node:test';

import { navigationPortals } from './navigation-portals.ts';

test('joins only opposing authored boundaries over their shared span and allowed height', () => {
	const edges = [
		{ id: 'a', side: 0, climb: 0.39, a: [2, 0, 0], b: [2, 0, 4] },
		{ id: 'b', side: 4, climb: 0.39, a: [2, 0.2, 2], b: [2, 0.2, 0] },
		{ id: 'c', side: 4, climb: 0.39, a: [2, 0.2, 4], b: [2, 0.2, 2] },
	] as Parameters<typeof navigationPortals>[0];
	const result = navigationPortals(edges, { up: 0.1, down: 0.3 });
	assert.equal(result.length, 2);
	assert.deepEqual(
		result.map((p) => [p.from, p.to]),
		[
			['b', 'a'],
			['c', 'a'],
		],
	);
	assert.equal(navigationPortals(edges, { up: 0.3, down: 0.3 }).length, 4);
	assert.equal(
		navigationPortals(
			edges.map((e) => ({ ...e, climb: 0.1 })),
			{ up: 0.3, down: 0.3 },
		).length,
		0,
	);
	assert.equal(navigationPortals([edges[0], { ...edges[1], side: 0 }], { up: 0.3, down: 0.3 }).length, 0);
	const shifted: (typeof edges)[number] = { ...edges[1], a: [2.1, 0.2, 2], b: [2.1, 0.2, 0] };
	assert.equal(navigationPortals([edges[0], shifted], { up: 0.3, down: 0.3 }).length, 0);
	assert.equal(
		navigationPortals([...edges, { ...edges[1], id: 'duplicate' }], { up: 0.3, down: 0.3 }).length,
		2,
	);
});
