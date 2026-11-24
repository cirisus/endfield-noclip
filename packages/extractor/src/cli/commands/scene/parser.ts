import { merge, object, or } from '@optique/core/constructs';
import { message } from '@optique/core/message';
import { optional, withDefault } from '@optique/core/modifiers';
import type { InferValue } from '@optique/core/parser';
import { argument, command, constant, flag, option } from '@optique/core/primitives';
import { choice, float, integer, string } from '@optique/core/valueparser';

import { PLACEMENT_KINDS } from '../../../game/placements.ts';
import { ciRegExp, configOption, pickOption, repeatableCsvOption, vec3, whereOption } from '../../parsers.ts';

const sceneListParser = merge(
	object({
		command: constant('scene'),
		subcommand: constant('list'),
		json: option('--json', { description: message`emit JSON` }),
	}),
	or(
		object({
			dungeons: flag('--dungeons', {
				description: message`list dungeon entries instead of streaming scenes`,
			}),
			category: optional(
				option('--category', ciRegExp(), { description: message`filter dungeon categories by regex` }),
			),
		}),
		object({
			dungeons: constant(false),
		}),
	),
	configOption,
);

const sceneLevelsParser = merge(
	object({
		command: constant('scene'),
		subcommand: constant('levels'),
		map: argument(string({ metavar: 'MAP' }), { description: message`map id (e.g. map02)` }),
		verify: option('--verify', { description: message`vote level tags against cell grids` }),
	}),
	configOption,
);

const sceneFindParser = merge(
	object({
		command: constant('scene'),
		subcommand: constant('find'),
		scene: argument(string({ metavar: 'SCENE' }), { description: message`scene id (e.g. map02)` }),
		name: optional(
			option('--name', ciRegExp(), {
				description: message`match entity, mesh, material, prefab, or source names`,
			}),
		),
		spatial: optional(
			object({
				near: option('--near', vec3(), { description: message`Unity world coordinates x,y,z` }),
				radius: option('--radius', float({ min: 0, metavar: 'M' }), {
					description: message`search radius in metres`,
				}),
			}),
		),
		kinds: repeatableCsvOption('--kind', choice(PLACEMENT_KINDS), {
			description: message`placement kinds to include (default all)`,
		}),
		maxSize: optional(
			option('--max-size', float({ min: 0, metavar: 'M' }), {
				description: message`drop rows whose longest bound side exceeds M metres`,
			}),
		),
		noHlod: option('--no-hlod', { description: message`drop static HLOD0/HLOD1/HLOD2 layers` }),
		hlodLinks: option('--hlod-links', {
			description: message`read StreamingChunkData HLOD parent/child links`,
		}),
		sceneState: optional(
			option('--scene-state', integer({ metavar: 'N' }), {
				description: message`filter static chunks and chunk lights to scene state N`,
			}),
		),
		area: optional(
			option('--area', integer({ metavar: 'N' }), {
				description: message`filter static chunks and chunk lights to stream area N`,
			}),
		),
		limit: withDefault(
			option('--limit', integer({ min: 1, metavar: 'N' }), {
				description: message`maximum rows to print`,
			}),
			50,
		),
		json: option('--json', { description: message`emit JSON array` }),
	}),
	configOption,
);

const sceneChunkParser = merge(
	object({
		command: constant('scene'),
		subcommand: constant('chunk'),
		scene: argument(string({ metavar: 'SCENE' }), { description: message`scene id` }),
		chunk: argument(string({ metavar: 'CHUNK' }), {
			description: message`chunk key (e.g. -13_-10_0_0, -13_-10, or Global_0_0)`,
		}),
		name: optional(option('--name', ciRegExp(), { description: message`filter entities by regex` })),
		hlodStats: option('--hlod-stats', { description: message`print per-layer HLOD parent/cluster counts` }),
		foliage: option('--foliage', { description: message`inspect grass/tree foliage grids` }),
		limit: withDefault(
			option('--limit', integer({ min: 1, metavar: 'N' }), {
				description: message`maximum entities to print`,
			}),
			100,
		),
		json: option('--json', { description: message`emit JSON` }),
	}),
	configOption,
);

const scenePrefabsParser = merge(
	object({
		command: constant('scene'),
		subcommand: constant('prefabs'),
		scenes: argument(string({ metavar: 'SCENE[,…]|all' }), {
			description: message`comma-separated scene ids or "all"`,
		}),
		name: optional(option('--name', ciRegExp(), { description: message`filter prefab paths by regex` })),
		classes: repeatableCsvOption('--class', string({ metavar: 'CLASS' }), {
			description: message`scan Unity objects of these classes inside placed prefabs`,
		}),
		joinGo: option('--join-go', { description: message`attach gameObject names to scanned components` }),
		where: whereOption,
		pick: pickOption,
		limit: withDefault(
			option('--limit', integer({ min: 1, metavar: 'N' }), {
				description: message`maximum results to print`,
			}),
			Infinity,
		),
		json: option('--json', { description: message`emit JSON` }),
	}),
	configOption,
);

const sceneEnvParser = merge(
	object({
		command: constant('scene'),
		subcommand: constant('env'),
		target: argument(string({ metavar: 'MAP|LEVEL' }), { description: message`map id or level id` }),
		at: optional(
			option('--at', vec3(), { description: message`evaluate environment volume stack at Unity x,y,z` }),
		),
		json: option('--json', { description: message`emit JSON` }),
	}),
	configOption,
);

const sceneControlsParser = merge(
	object({
		command: constant('scene'),
		subcommand: constant('controls'),
		scene: argument(string({ metavar: 'SCENE' }), { description: message`scene id` }),
		json: option('--json', { description: message`emit JSON` }),
	}),
	configOption,
);

/** parser for `endfield-extract scene` */
export const sceneParser = or(
	command('list', sceneListParser, {
		brief: message`list streaming scenes or dungeon entries`,
	}),
	command('levels', sceneLevelsParser, {
		brief: message`list levels with tags, cells, and names`,
	}),
	command('find', sceneFindParser, {
		brief: message`search everything placed in a scene`,
		description: message`search all placements in a scene (static, dynamic, model, effect, facility, cabin, light, water, env) across every scene state and stream area, reporting visibility gating and stand-in annotations from out/<scene>/debug/stand-ins.json.`,
		footer: message`--near uses Unity world coordinates and sorts nearest then smallest bounds first. summaries go to stderr so --json emits a single JSON array.`,
	}),
	command('chunk', sceneChunkParser, {
		brief: message`inspect one InitChunkData + StreamingChunkData pair`,
	}),
	command('prefabs', scenePrefabsParser, {
		brief: message`list placed prefabs across scenes or scan their Unity objects`,
	}),
	command('env', sceneEnvParser, {
		brief: message`inspect base environments per level or volume stack at a point`,
	}),
	command('controls', sceneControlsParser, {
		brief: message`inspect scene states, stream areas, and progression controllers`,
	}),
);

/** parsed arguments for `scene` */
export type SceneArgs = InferValue<typeof sceneParser>;

/** parsed arguments for a specific `scene` subcommand */
export type SceneSubArgs<S extends SceneArgs['subcommand']> = Extract<SceneArgs, { subcommand: S }>;
