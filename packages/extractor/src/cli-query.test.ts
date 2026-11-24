import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { matchesWhere, parseWhereList, pickFields } from './cli-query.ts';

describe('cli-query', () => {
	const sample = {
		name: 'M_fx_switch_water_004',
		renderQueue: 3000,
		opaque: false,
		keywords: ['HG_ENABLE_MV', '_USE_MAIN2', '_USE_DISTURB'],
		SubModule: {
			enabled: true,
			subEmitters: [
				{ emitProbability: 0, type: 0 },
				{ emitProbability: 1, type: 2 },
			],
		},
	};

	test('matches equality, regex, numeric, truthy, falsy, and nested arrays', () => {
		assert.equal(matchesWhere(sample, parseWhereList(['SubModule.enabled=true'])), true);
		assert.equal(matchesWhere(sample, parseWhereList(['opaque=false', 'renderQueue>=3000'])), true);
		assert.equal(matchesWhere(sample, parseWhereList(['keywords~_USE_MAIN2'])), true);
		assert.equal(matchesWhere(sample, parseWhereList(['keywords!~_ALPHA'])), true);
		assert.equal(matchesWhere(sample, parseWhereList(['SubModule.subEmitters[].emitProbability>0'])), true);
		assert.equal(matchesWhere(sample, parseWhereList(['SubModule.subEmitters.type=2'])), true);
		assert.equal(matchesWhere(sample, parseWhereList(['SubModule.enabled', '!missingField'])), true);
		assert.equal(matchesWhere(sample, parseWhereList(['renderQueue<3000'])), false);
		assert.equal(matchesWhere(sample, parseWhereList(['keywords~_MISSING'])), false);
	});

	test('projects requested dot-paths with pickFields', () => {
		assert.deepEqual(
			pickFields(sample, ['name', 'renderQueue', 'SubModule.enabled', 'SubModule.subEmitters.type']),
			{
				name: 'M_fx_switch_water_004',
				renderQueue: 3000,
				'SubModule.enabled': true,
				'SubModule.subEmitters.type': [0, 2],
			},
		);
	});
});
