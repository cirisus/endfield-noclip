import { merge, object, or } from '@optique/core/constructs';
import { message } from '@optique/core/message';
import { optional, withDefault } from '@optique/core/modifiers';
import type { InferValue } from '@optique/core/parser';
import { argument, command, constant, option } from '@optique/core/primitives';
import { integer, string } from '@optique/core/valueparser';

import { ciRegExp, configOption, targetsOrStdin } from '../../parsers.ts';

const defaultLimit = withDefault(
	option('--limit', integer({ min: 1, metavar: 'N' }), {
		description: message`maximum rows to print`,
	}),
	100,
);

const dataPathsParser = merge(
	object({
		command: constant('data'),
		subcommand: constant('paths'),
		pattern: argument(ciRegExp(), {
			description: message`case-insensitive regex matching asset paths`,
		}),
		limit: defaultLimit,
		json: option('--json', { description: message`emit JSON array` }),
	}),
	configOption,
);

const dataResolveParser = merge(
	object({
		command: constant('data'),
		subcommand: constant('resolve'),
		json: option('--json', { description: message`emit JSON` }),
	}),
	targetsOrStdin('PATH|HASH'),
	configOption,
);

const dataTablesParser = merge(
	object({
		command: constant('data'),
		subcommand: constant('tables'),
		filter: optional(option('--filter', ciRegExp(), { description: message`filter table names by regex` })),
	}),
	configOption,
);

const dataTableParser = merge(
	object({
		command: constant('data'),
		subcommand: constant('table'),
		name: argument(string({ metavar: 'NAME' }), {
			description: message`SparkBuffer table name (e.g. DungeonTable)`,
		}),
		key: optional(
			option('--key', string({ metavar: 'KEY' }), { description: message`exact row key lookup` }),
		),
		filter: optional(option('--filter', ciRegExp(), { description: message`filter rows by regex` })),
		limit: defaultLimit,
		json: option('--json', { description: message`emit JSON` }),
	}),
	configOption,
);

const dataScriptsParser = merge(
	object({
		command: constant('data'),
		subcommand: constant('scripts'),
		level: argument(string({ metavar: 'LEVEL' }), {
			description: message`level id`,
		}),
		id: optional(option('--id', string({ metavar: 'N' }), { description: message`script id filter` })),
		filter: optional(option('--filter', ciRegExp(), { description: message`filter scripts by regex` })),
		limit: defaultLimit,
		json: option('--json', { description: message`emit JSON` }),
	}),
	configOption,
);

const dataInteractivesParser = merge(
	object({
		command: constant('data'),
		subcommand: constant('interactives'),
		level: argument(string({ metavar: 'LEVEL' }), {
			description: message`level id`,
		}),
		id: optional(option('--id', string({ metavar: 'N' }), { description: message`interactive id filter` })),
		filter: optional(option('--filter', ciRegExp(), { description: message`filter interactives by regex` })),
		limit: defaultLimit,
		json: option('--json', { description: message`emit JSON` }),
	}),
	configOption,
);

const dataViewStatesParser = merge(
	object({
		command: constant('data'),
		subcommand: constant('view-states'),
		model: optional(
			argument(ciRegExp('MODEL-RE'), {
				description: message`optional model name regex`,
			}),
		),
		emissive: optional(
			option('--emissive', ciRegExp(), { description: message`filter emissive entries by regex` }),
		),
		filter: optional(option('--filter', ciRegExp(), { description: message`filter entries by regex` })),
		limit: defaultLimit,
		json: option('--json', { description: message`emit JSON` }),
	}),
	configOption,
);

/** parser for `endfield-extract data` */
export const dataParser = or(
	command('paths', dataPathsParser, {
		brief: message`search both path catalogs, with hashes and bundles`,
	}),
	command('resolve', dataResolveParser, {
		brief: message`resolve path ↔ hash, bundle, and dependencies`,
	}),
	command('tables', dataTablesParser, {
		brief: message`list SparkBuffer config tables in the Table group`,
	}),
	command('table', dataTableParser, {
		brief: message`decode a SparkBuffer config table`,
	}),
	command('scripts', dataScriptsParser, {
		brief: message`decode MemoryPack level scripts for one level`,
	}),
	command('interactives', dataInteractivesParser, {
		brief: message`decode LevelData interactive placements for one level`,
	}),
	command('view-states', dataViewStatesParser, {
		brief: message`inspect or search ModelViewStateControllerData JSONs`,
	}),
);

/** parsed arguments for `data` */
export type DataArgs = InferValue<typeof dataParser>;
