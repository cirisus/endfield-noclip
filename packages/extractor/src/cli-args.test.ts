import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { parseArgs } from 'node:util';

import { parseList, separatePositionals } from './cli-args.ts';

describe('separatePositionals', () => {
	const OPTIONS = {
		near: { type: 'string' },
		radius: { type: 'string' },
		'path-id': { type: 'string' },
		json: { type: 'boolean', default: false },
	} as const;

	test('joins negative-prefixed values onto string options so parseArgs accepts them', () => {
		const normalized = separatePositionals(
			['find', 'map01', '--near', '-458,110,-213', '--radius', '25', '--path-id', '-3517388884461567914'],
			OPTIONS,
		);
		const { values, positionals } = parseArgs({
			args: normalized,
			allowPositionals: true,
			options: OPTIONS,
		});
		assert.deepEqual(positionals, ['find', 'map01']);
		assert.equal(values.near, '-458,110,-213');
		assert.equal(values.radius, '25');
		assert.equal(values['path-id'], '-3517388884461567914');
	});

	test('keeps negative positionals behind --', () => {
		const normalized = separatePositionals(['chunk', 'map01', '-13_-10_0_0', '--json'], OPTIONS);
		const { values, positionals } = parseArgs({
			args: normalized,
			allowPositionals: true,
			options: OPTIONS,
		});
		assert.deepEqual(positionals, ['chunk', 'map01', '-13_-10_0_0']);
		assert.equal(values.json, true);
	});
});

describe('parseList', () => {
	test('splits comma-separated and repeated values and drops empties', () => {
		assert.deepEqual(parseList(['a, b', 'c', ' , d']), ['a', 'b', 'c', 'd']);
		assert.deepEqual(parseList(undefined), []);
	});
});
