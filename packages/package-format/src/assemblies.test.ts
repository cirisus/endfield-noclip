import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { decodeAssembliesTable, encodeAssembliesTable, type AssembliesTable } from './assemblies.ts';

describe('AssembliesTable (EFAS)', () => {
	it('round-trips assemblies, transform nodes, and state bindings', () => {
		const table: AssembliesTable = {
			assemblies: [
				{
					firstNode: 0,
					nodeCount: 2,
					flags: 1,
					group: 3,
					firstState: 0,
					stateCount: 1,
					defaultState: 0,
				},
			],
			nodes: [
				{
					parent: -1,
					animBlob: 42,
					localTransform: [1, 0, 0, 10, 0, 1, 0, 20, 0, 0, 1, 30],
				},
				{
					parent: 0,
					animBlob: null,
					localTransform: [1, 0, 0, 0, 0, 1, 0, 2, 0, 0, 1, 0],
				},
			],
			states: [{ control: 5, valueMask: 2, animBlob: 77 }],
		};
		assert.deepEqual(decodeAssembliesTable(encodeAssembliesTable(table)), table);
	});
});
