import { merge, object, or } from '@optique/core/constructs';
import { message } from '@optique/core/message';
import { map, optional, withDefault } from '@optique/core/modifiers';
import type { InferValue } from '@optique/core/parser';
import { argument, command, constant, flag, option } from '@optique/core/primitives';
import { choice, integer, string } from '@optique/core/valueparser';

import {
	ciRegExp,
	configOption,
	pathIdOption,
	pickOption,
	repeatableCsvOption,
	targetsOrStdin,
	whereOption,
} from '../../parsers.ts';

const bundleInfoParser = merge(
	object({
		command: constant('bundle'),
		subcommand: constant('info'),
		name: argument(string({ metavar: 'NAME' }), {
			description: message`bundle hex id, main/<hex>.ab, logical path, or asset path/hash`,
		}),
	}),
	configOption,
);

const bundleDumpParser = merge(
	object({
		command: constant('bundle'),
		subcommand: constant('dump'),
		pathId: pathIdOption,
		classes: repeatableCsvOption('--class', string({ metavar: 'CLASS' }), {
			description: message`filter by Unity class name or numeric id (e.g. Mesh,43)`,
		}),
		name: optional(option('--name', ciRegExp(), { description: message`filter object names by regex` })),
		joinGo: option('--join-go', {
			description: message`attach gameObject names to components`,
		}),
		where: whereOption,
		pick: pickOption,
		format: withDefault(
			or(
				map(
					flag('--text', { description: message`print TextAsset m_Script directly` }),
					() => 'text' as const,
				),
				map(
					flag('--json', { description: message`emit one JSON array instead of JSONL` }),
					() => 'json' as const,
				),
			),
			'jsonl' as const,
		),
		limit: withDefault(
			option('--limit', integer({ min: 1, metavar: 'N' }), {
				description: message`maximum objects to dump`,
			}),
			Infinity,
		),
		maxArray: withDefault(
			or(
				option('--max-array', integer({ min: 0, metavar: 'N' }), {
					description: message`truncate arrays longer than N elements`,
				}),
				map(flag('--full', { description: message`disable array truncation` }), () => Infinity),
			),
			16,
		),
	}),
	targetsOrStdin('NAME'),
	configOption,
);

const bundleStreamParser = merge(
	object({
		command: constant('bundle'),
		subcommand: constant('stream'),
		name: argument(string({ metavar: 'NAME' }), {
			description: message`bundle hex id, path, or asset path/hash`,
		}),
		pathId: option('--path-id', integer({ type: 'bigint', metavar: 'N' }), {
			description: message`Unity object path id`,
		}),
		output: option('-o', '--output', string({ metavar: 'FILE' }), {
			description: message`destination file for m_StreamData payload`,
		}),
	}),
	configOption,
);

const bundleFindParser = merge(
	object({
		command: constant('bundle'),
		subcommand: constant('find'),
		filter: optional(
			or(
				option('--filter', ciRegExp(), {
					description: message`regex matching m_Container paths`,
				}),
				argument(ciRegExp(), {
					description: message`regex matching m_Container paths`,
				}),
			),
		),
		classes: repeatableCsvOption('--class', string({ metavar: 'CLASS' }), {
			description: message`match objects of a Unity class name or id`,
		}),
		scan: withDefault(
			option('--scan', integer({ min: 1, metavar: 'N' }), {
				description: message`maximum bundles to scan`,
			}),
			Infinity,
		),
		limit: withDefault(
			option('--limit', integer({ min: 1, metavar: 'N' }), {
				description: message`maximum results to print`,
			}),
			Infinity,
		),
		group: withDefault(
			option('--group', choice(['main', 'initial', 'all'] as const), {
				description: message`bundle group to search`,
			}),
			'main',
		),
	}),
	configOption,
);

/** parser for `endfield-extract bundle` */
export const bundleParser = or(
	command('info', bundleInfoParser, {
		brief: message`show bundle header, nodes, and per-class object counts`,
	}),
	command('dump', bundleDumpParser, {
		brief: message`dump bundle objects as JSONL, JSON, or TextAsset text`,
	}),
	command('stream', bundleStreamParser, {
		brief: message`write an object's m_StreamData (.resS) payload to a file`,
	}),
	command('find', bundleFindParser, {
		brief: message`search bundles for container paths and/or object classes`,
	}),
);

/** parsed arguments for `bundle` */
export type BundleArgs = InferValue<typeof bundleParser>;
