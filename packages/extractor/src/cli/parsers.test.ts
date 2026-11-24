import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { merge, object } from '@optique/core/constructs';
import { optional } from '@optique/core/modifiers';
import { parse } from '@optique/core/parser';
import { option } from '@optique/core/primitives';
import { integer, string } from '@optique/core/valueparser';

import { bundleParser } from './commands/bundle/parser.ts';
import { packParser } from './commands/pack/parser.ts';
import { sceneParser } from './commands/scene/parser.ts';
import {
	bounds,
	pathIdOption,
	repeatableCsvOption,
	targetsOrStdin,
	vec3,
	wherePredicate,
} from './parsers.ts';

describe('cli parsers', () => {
	test('accepts negative coordinates and negative path ids without -- or =', () => {
		const parser = object({
			near: optional(option('--near', vec3())),
			pathId: pathIdOption,
			bounds: optional(option('--bounds', bounds())),
		});
		const res = parse(parser, [
			'--near',
			'-458,110,-213',
			'--path-id',
			'-3517388884461567914',
			'--bounds',
			'-100,100,-200,200',
		]);
		assert.equal(res.success, true);
		if (res.success) {
			assert.deepEqual(res.value.near, [-458, 110, -213]);
			assert.equal(res.value.pathId, -3517388884461567914n);
			assert.deepEqual(res.value.bounds, { minX: -100, maxX: 100, minZ: -200, maxZ: 200 });
		}
	});

	test('rejects invalid vec3 and bounds', () => {
		assert.equal(vec3().parse('1,2').success, false);
		assert.equal(vec3().parse('1,foo,3').success, false);
		assert.equal(bounds().parse('10,5,0,10').success, false);
		assert.equal(bounds().parse('0,10,5,5').success, false);
	});

	test('parses repeatable and comma-separated options', () => {
		const parser = object({
			pick: repeatableCsvOption('--pick', string()),
			ids: repeatableCsvOption('--id', integer()),
		});
		const res = parse(parser, ['--pick', 'a, b', '--pick', 'c', '--id', '1,2', '--id', '3']);
		assert.equal(res.success, true);
		if (res.success) {
			assert.deepEqual(res.value.pick, ['a', 'b', 'c']);
			assert.deepEqual(res.value.ids, [1, 2, 3]);
		}
	});

	test('parses --where predicates', () => {
		const ok = wherePredicate().parse('renderQueue>=3000');
		assert.equal(ok.success, true);
		assert.equal(wherePredicate().parse('renderQueue>abc').success, false);
	});

	test('parses positional targets and --stdin', () => {
		const parser = merge(object({ json: option('--json') }), targetsOrStdin('OBJECT'));

		const withStdin = parse(parser, ['--stdin', 'a']);
		assert.equal(withStdin.success, true);
		if (withStdin.success) {
			assert.equal(withStdin.value.stdin, true);
			assert.deepEqual(withStdin.value.targets, ['a']);
		}

		const withTargets = parse(parser, ['a', 'b', '--json']);
		assert.equal(withTargets.success, true);
		if (withTargets.success) {
			assert.equal(withTargets.value.stdin, false);
			assert.equal(withTargets.value.json, true);
			assert.deepEqual(withTargets.value.targets, ['a', 'b']);
		}
	});

	test('enforces mutual exclusions and coupled groups in command parsers', () => {
		// pack: --existing XOR <scene> / --cache XOR --no-cache
		assert.equal(parse(packParser, ['--existing', 'map02']).success, false);
		assert.equal(parse(packParser, ['map02', '--cache', '/tmp/c', '--no-cache']).success, false);
		assert.equal(parse(packParser, ['map02', '--no-cache']).success, true);

		// scene find: --near and --radius must be paired
		assert.equal(parse(sceneParser, ['find', 'map02', '--near', '-1,2,-3']).success, false);
		assert.equal(parse(sceneParser, ['find', 'map02', '--near', '-1,2,-3', '--radius', '25']).success, true);

		// scene chunk: negative chunk key works without --
		const chunkRes = parse(sceneParser, ['chunk', 'map01', '-13_-10_0_0', '--json']);
		assert.equal(chunkRes.success, true);
		if (chunkRes.success && chunkRes.value.subcommand === 'chunk') {
			assert.equal(chunkRes.value.chunk, '-13_-10_0_0');
		}

		// bundle dump: --text XOR --json, --max-array XOR --full
		assert.equal(parse(bundleParser, ['dump', 'abc', '--text', '--json']).success, false);
		assert.equal(parse(bundleParser, ['dump', 'abc', '--max-array', '4', '--full']).success, false);
		assert.equal(parse(bundleParser, ['dump', 'abc', '--full', '--json']).success, true);
	});
});
