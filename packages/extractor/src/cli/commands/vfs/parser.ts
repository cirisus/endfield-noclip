import { merge, object, or } from '@optique/core/constructs';
import { message } from '@optique/core/message';
import { optional } from '@optique/core/modifiers';
import type { InferValue } from '@optique/core/parser';
import { argument, command, constant, option } from '@optique/core/primitives';
import { string } from '@optique/core/valueparser';

import { ciRegExp, configOption } from '../../parsers.ts';

const vfsGroupsParser = merge(
	object({
		command: constant('vfs'),
		subcommand: constant('groups'),
	}),
	configOption,
);

const vfsLsParser = merge(
	object({
		command: constant('vfs'),
		subcommand: constant('ls'),
		group: argument(string({ metavar: 'GROUP' }), {
			description: message`8-hex group hash or VfsGroup name (e.g. JsonData, Table, Bundle)`,
		}),
		filter: optional(option('--filter', ciRegExp(), { description: message`filter entry paths by regex` })),
	}),
	configOption,
);

const vfsCatParser = merge(
	object({
		command: constant('vfs'),
		subcommand: constant('cat'),
		group: argument(string({ metavar: 'GROUP' }), {
			description: message`8-hex group hash or VfsGroup name`,
		}),
		path: argument(string({ metavar: 'PATH' }), {
			description: message`logical file path within the group`,
		}),
		output: option('-o', '--output', string({ metavar: 'FILE' }), {
			description: message`destination file path`,
		}),
	}),
	configOption,
);

/** parser for `endfield-extract vfs` */
export const vfsParser = or(
	command('groups', vfsGroupsParser, {
		brief: message`list VFS groups and file counts`,
	}),
	command('ls', vfsLsParser, {
		brief: message`list logical files in a VFS group`,
	}),
	command('cat', vfsCatParser, {
		brief: message`extract one logical file from a VFS group`,
	}),
);

/** parsed arguments for `vfs` */
export type VfsArgs = InferValue<typeof vfsParser>;
