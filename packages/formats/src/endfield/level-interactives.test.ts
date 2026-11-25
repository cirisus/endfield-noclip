import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FormatError } from '../binary/binary-reader.ts';

import { atomFloat, atomInt, readLevelDataInteractives } from './level-interactives.ts';

test('readLevelDataInteractives converts decoded placements, parameters, and hide-by-type areas', () => {
	const result = readLevelDataInteractives({
		interactives: [
			{
				levelLogicId: '100',
				entityDataIdKey: 'int_shop',
				createState: 0,
				position: [1, 2, 3],
				rotation: [0, 90, 0],
				scale: [1, 1, 1],
				modelScale: 0,
				isLocked: true,
				properties: [
					{
						key: 'state',
						value: {
							type: 2,
							valueArray: [{ valueBit64: '3', valueString: null }],
						},
					},
				],
				componentProperties: [
					[
						26,
						[
							{
								key: 'model',
								value: {
									type: 7,
									valueArray: [{ valueBit64: '0', valueString: 'shop_v1' }],
								},
							},
						],
					],
				],
			},
			{
				levelLogicId: '101',
				entityDataIdKey: 'int_shop',
				createState: 1,
				position: [4, 5, 6],
				rotation: [0, 0, 0],
				scale: [1, 1, 1],
				modelScale: 2,
				isLocked: false,
				properties: [],
				componentProperties: [],
			},
		],
		functionArea: {
			specificDatas: [
				{ $type: 'Beyond_Gameplay_LevelFunctionAreaData_SceneToastUIDataForMemoryPack' },
				{ $type: 'Beyond_Gameplay_LevelFunctionAreaData_HideEntityByTypeParamsForMemoryPack' },
				null,
				{ $type: 'Beyond_Gameplay_LevelFunctionAreaData_HideEntityByTypeParamsForMemoryPack' },
			],
		},
	});

	assert.equal(result.hideByTypeAreas, 2);
	assert.equal(result.interactives.length, 2);
	assert.deepEqual(result.interactives[0], {
		id: 100n,
		template: 'int_shop',
		createState: 0,
		position: [1, 2, 3],
		rotation: [0, 90, 0],
		scale: [1, 1, 1],
		modelScale: 0,
		isLocked: true,
		properties: [{ key: 'state', type: 2, values: [{ bits: 3n, text: null }] }],
		componentProperties: new Map([
			[26, [{ key: 'model', type: 7, values: [{ bits: 0n, text: 'shop_v1' }] }]],
		]),
	});
	assert.equal(result.interactives[1]?.id, 101n);
	assert.equal(result.interactives[1]?.createState, 1);
	assert.equal(result.interactives[1]?.modelScale, 2);
	assert.equal(result.interactives[1]?.isLocked, false);
});

test('readLevelDataInteractives rejects malformed rows', () => {
	assert.throws(
		() => readLevelDataInteractives({ interactives: [{ entityDataIdKey: 'int_shop' }] }),
		FormatError,
	);
	assert.throws(() => readLevelDataInteractives({ interactives: [{ levelLogicId: '1' }] }), FormatError);
});

test('atomFloat and atomInt unpack 64-bit interactive atoms', () => {
	assert.equal(atomFloat(0x3fc00000n), 1.5);
	assert.equal(atomInt(0xffffffffn), -1);
	assert.equal(atomInt(42n), 42);
});
