import { merge, object, or } from '@optique/core/constructs';
import { message } from '@optique/core/message';
import { optional, withDefault } from '@optique/core/modifiers';
import type { InferValue } from '@optique/core/parser';
import { argument, command, constant, option } from '@optique/core/primitives';
import { choice, float, integer, string } from '@optique/core/valueparser';

import { ciRegExp, pickOption, repeatableCsvOption, vec3, whereOption } from '../../parsers.ts';

const auditCommon = object({
	dir: optional(
		option('--dir', string({ metavar: 'DIR' }), {
			description: message`override package (or out/) directory`,
		}),
	),
	json: option('--json', { description: message`emit JSON` }),
});

const auditLimit = withDefault(
	option('--limit', integer({ min: 1, metavar: 'N' }), {
		description: message`maximum rows to print`,
	}),
	Infinity,
);

const auditIds = repeatableCsvOption('--id', integer({ min: 0, metavar: 'N' }), {
	description: message`filter by asset table id`,
});

const auditListParser = merge(
	object({
		command: constant('audit'),
		subcommand: constant('list'),
		has: optional(
			option('--has', choice(['water-volumes', 'stand-ins', 'errors'] as const), {
				description: message`only list packages with the given feature/issue`,
			}),
		),
	}),
	auditCommon,
);

const auditCoreParser = merge(
	object({
		command: constant('audit'),
		subcommand: constant('core'),
		scene: argument(string({ metavar: 'SCENE' }), { description: message`packed scene directory name` }),
		member: optional(
			argument(string({ metavar: 'MEMBER' }), {
				description: message`core.czar member path or CORE_PATHS shorthand (e.g. manifest, water)`,
			}),
		),
	}),
	auditCommon,
);

const auditTreeParser = merge(
	object({
		command: constant('audit'),
		subcommand: constant('tree'),
		scene: argument(string({ metavar: 'SCENE' }), { description: message`packed scene directory name` }),
		at: optional(option('--at', vec3(), { description: message`filter nodes containing point x,y,z` })),
		from: optional(option('--from', vec3(), { description: message`compute distances from point x,y,z` })),
		blob: optional(
			option('--blob', string({ metavar: 'HASH|ID' }), {
				description: message`filter nodes referencing blob`,
			}),
		),
		level: optional(
			option('--level', integer({ min: 0, metavar: 'N' }), { description: message`filter by tree depth` }),
		),
		limit: auditLimit,
	}),
	auditCommon,
);

const auditInstancesParser = merge(
	object({
		command: constant('audit'),
		subcommand: constant('instances'),
		scene: argument(string({ metavar: 'SCENE' }), { description: message`packed scene directory name` }),
		name: optional(option('--name', ciRegExp(), { description: message`filter instance names by regex` })),
		id: optional(
			option('--id', integer({ min: 0, metavar: 'N' }), { description: message`filter by instance id` }),
		),
		blob: optional(
			option('--blob', string({ metavar: 'HASH' }), { description: message`filter by instance blob hash` }),
		),
		chain: optional(
			option('--chain', integer({ min: 0, metavar: 'N' }), { description: message`filter by LOD chain id` }),
		),
		from: optional(option('--from', vec3(), { description: message`compute distances from point x,y,z` })),
		limit: auditLimit,
	}),
	auditCommon,
);

const auditMaterialsParser = merge(
	object({
		command: constant('audit'),
		subcommand: constant('materials'),
		scene: argument(string({ metavar: 'SCENE|all' }), {
			description: message`packed scene name or "all"`,
		}),
		ids: auditIds,
		shader: optional(option('--shader', ciRegExp(), { description: message`filter by shader name regex` })),
		name: optional(option('--name', ciRegExp(), { description: message`filter by material name regex` })),
		reason: optional(
			option('--reason', ciRegExp(), { description: message`filter by unsupported/undrawn/error reason` }),
		),
		gap: optional(option('--gap', ciRegExp(), { description: message`filter by undrawn keyword/gap regex` })),
		unsupported: option('--unsupported', { description: message`only unsupported materials` }),
		undrawn: option('--undrawn', { description: message`only materials with undrawn keywords` }),
		error: option('--error', { description: message`only failed materials` }),
		packed: option('--packed', { description: message`include packed core.czar material entry` }),
		group: option('--group', { description: message`tally counts by shader and reason` }),
		where: whereOption,
		pick: pickOption,
		limit: auditLimit,
	}),
	auditCommon,
);

const auditGeometriesParser = merge(
	object({
		command: constant('audit'),
		subcommand: constant('geometries'),
		scene: argument(string({ metavar: 'SCENE|all' }), {
			description: message`packed scene name or "all"`,
		}),
		ids: auditIds,
		name: optional(option('--name', ciRegExp(), { description: message`filter by geometry name regex` })),
		unanimated: option('--unanimated', {
			description: message`only meshes left static due to animation conflict`,
		}),
		error: option('--error', { description: message`only failed geometries` }),
		tangentUv: option('--tangent-uv', { description: message`only meshes with tangent UV conflicts` }),
		packed: option('--packed', { description: message`include packed core.czar geometry table fields` }),
		minSpan: optional(
			option('--min-span', float({ min: 0, metavar: 'M' }), {
				description: message`only geometries with bounding span at least M metres`,
			}),
		),
		stats: option('--stats', { description: message`print summary statistics` }),
		where: whereOption,
		pick: pickOption,
		limit: auditLimit,
	}),
	auditCommon,
);

const auditTexturesParser = merge(
	object({
		command: constant('audit'),
		subcommand: constant('textures'),
		scene: argument(string({ metavar: 'SCENE|all' }), {
			description: message`packed scene name or "all"`,
		}),
		ids: auditIds,
		name: optional(option('--name', ciRegExp(), { description: message`filter by texture name regex` })),
		error: option('--error', { description: message`only failed textures` }),
		where: whereOption,
		pick: pickOption,
		limit: auditLimit,
	}),
	auditCommon,
);

const auditStandInsParser = merge(
	object({
		command: constant('audit'),
		subcommand: constant('stand-ins'),
		scene: argument(string({ metavar: 'SCENE|all' }), {
			description: message`packed scene name or "all"`,
		}),
		reason: optional(option('--reason', ciRegExp(), { description: message`filter by stand-in reason` })),
		name: optional(option('--name', ciRegExp(), { description: message`filter by stand-in name` })),
		near: optional(
			option('--near', vec3(), { description: message`sort positioned stand-ins nearest to x,y,z` }),
		),
		radius: withDefault(
			option('--radius', float({ min: 0, metavar: 'M' }), {
				description: message`search radius in metres for --near`,
			}),
			50,
		),
		group: option('--group', { description: message`tally counts by reason` }),
		where: whereOption,
		pick: pickOption,
		limit: auditLimit,
	}),
	auditCommon,
);

const auditInteractivesParser = merge(
	object({
		command: constant('audit'),
		subcommand: constant('interactives'),
		scene: argument(string({ metavar: 'SCENE|all' }), {
			description: message`packed scene name or "all"`,
		}),
		reason: optional(option('--reason', ciRegExp(), { description: message`filter by unsupported reason` })),
		group: option('--group', { description: message`tally counts by reason` }),
		where: whereOption,
		pick: pickOption,
		limit: auditLimit,
	}),
	auditCommon,
);

const auditWaterParser = merge(
	object({
		command: constant('audit'),
		subcommand: constant('water'),
		scene: argument(string({ metavar: 'SCENE' }), { description: message`packed scene directory name` }),
		near: optional(option('--near', vec3(), { description: message`filter surfaces near x,y,z` })),
		radius: withDefault(
			option('--radius', float({ min: 0, metavar: 'M' }), {
				description: message`search radius in metres for --near`,
			}),
			60,
		),
		config: optional(
			option('--config', ciRegExp(), { description: message`filter water config names by regex` }),
		),
		packed: option('--packed', { description: message`query packed core.czar water surfaces/configs` }),
	}),
	auditCommon,
);

const auditEnvParser = merge(
	object({
		command: constant('audit'),
		subcommand: constant('env'),
		scene: argument(string({ metavar: 'SCENE' }), { description: message`packed scene directory name` }),
		phase: optional(option('--phase', ciRegExp(), { description: message`filter phase names by regex` })),
		post: optional(
			option('--post', ciRegExp(), { description: message`filter post profile names by regex` }),
		),
		section: optional(
			option('--section', ciRegExp(), { description: message`filter environment sections by regex` }),
		),
		packed: option('--packed', { description: message`query packed core.czar phases/posts` }),
	}),
	auditCommon,
);

const auditIrradianceParser = merge(
	object({
		command: constant('audit'),
		subcommand: constant('irradiance'),
		scene: argument(string({ metavar: 'SCENE' }), { description: message`packed scene directory name` }),
		at: optional(option('--at', vec3(), { description: message`decode raw probes at world point x,y,z` })),
	}),
	auditCommon,
);

/** parser for `endfield-extract audit` */
export const auditParser = or(
	command('list', auditListParser, {
		brief: message`summarize all packed packages under out/`,
	}),
	command('core', auditCoreParser, {
		brief: message`list core.czar members or print a decoded member`,
	}),
	command('tree', auditTreeParser, {
		brief: message`inspect core.czar tile tree nodes, bounds, refs, and distances`,
	}),
	command('instances', auditInstancesParser, {
		brief: message`trace packed instances to their blob, tile node, and LOD chain`,
	}),
	command('materials', auditMaterialsParser, {
		brief: message`query debug/assets.json and packed materials`,
	}),
	command('geometries', auditGeometriesParser, {
		brief: message`query debug/assets.json and packed geometries`,
	}),
	command('textures', auditTexturesParser, {
		brief: message`query debug/assets.json textures`,
	}),
	command('stand-ins', auditStandInsParser, {
		brief: message`query debug/stand-ins.json`,
	}),
	command('interactives', auditInteractivesParser, {
		brief: message`query debug/unsupported-interactives.json`,
	}),
	command('water', auditWaterParser, {
		brief: message`summarize debug/water.json or query packed water surfaces/configs`,
	}),
	command('env', auditEnvParser, {
		brief: message`summarize debug/environments.json or query packed phases/posts`,
	}),
	command('irradiance', auditIrradianceParser, {
		brief: message`summarize tables/irradiance.bin or decode probes at a point`,
	}),
);

/** parsed arguments for `audit` */
export type AuditArgs = InferValue<typeof auditParser>;

/** parsed arguments for a specific `audit` subcommand */
export type AuditSubArgs<S extends AuditArgs['subcommand']> = Extract<AuditArgs, { subcommand: S }>;
