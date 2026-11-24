import { merge, object, or } from '@optique/core/constructs';
import { message } from '@optique/core/message';
import { optional, withDefault } from '@optique/core/modifiers';
import type { InferValue } from '@optique/core/parser';
import { argument, command, constant, option } from '@optique/core/primitives';
import { choice, float, integer, string } from '@optique/core/valueparser';

import {
	ciRegExp,
	configOption,
	pathIdOption,
	pickOption,
	repeatableCsvOption,
	targetsOrStdin,
	vec3,
} from '../../parsers.ts';

const objectFilterOptions = object({
	pathId: pathIdOption,
	name: optional(option('--name', ciRegExp(), { description: message`filter object names by regex` })),
});

const inspectPrefabParser = merge(
	object({
		command: constant('inspect'),
		subcommand: constant('prefab'),
		effectLod: withDefault(
			option('--effect-lod', choice(['camera', 'proxy', 'none'] as const), {
				description: message`effect LOD branch to inspect`,
			}),
			'camera',
		),
		particles: option('--particles', {
			description: message`include raw ParticleSystem module details`,
		}),
		json: option('--json', { description: message`emit JSON` }),
	}),
	objectFilterOptions,
	targetsOrStdin('OBJECT'),
	configOption,
);

const inspectMaterialParser = merge(
	object({
		command: constant('inspect'),
		subcommand: constant('material'),
		all: option('--all', { description: message`inspect every matching material in a bundle` }),
		prop: optional(option('--prop', ciRegExp(), { description: message`filter shader properties by regex` })),
		allProps: option('--all-props', { description: message`include undeclared and default properties` }),
		pick: pickOption,
	}),
	objectFilterOptions,
	targetsOrStdin('OBJECT'),
	configOption,
);

const inspectShaderParser = merge(
	object({
		command: constant('inspect'),
		subcommand: constant('shader'),
		target: argument(string({ metavar: 'OBJECT|NAME-RE' }), {
			description: message`bundle/object target or shader name regex`,
		}),
		prop: optional(
			option('--prop', ciRegExp(), { description: message`filter declared properties by regex` }),
		),
		types: repeatableCsvOption('--type', string({ metavar: 'TYPE' }), {
			description: message`filter properties by type (color, vector, float, range, texture, int)`,
		}),
		flags: repeatableCsvOption('--flag', string({ metavar: 'FLAG' }), {
			description: message`filter properties by ShaderPropertyFlags`,
		}),
		group: withDefault(
			option('--group', choice(['initial', 'main', 'all'] as const), {
				description: message`bundle group when searching by shader name`,
			}),
			'initial',
		),
		json: option('--json', { description: message`emit JSON` }),
	}),
	objectFilterOptions,
	configOption,
);

const inspectMeshParser = merge(
	object({
		command: constant('inspect'),
		subcommand: constant('mesh'),
		vertices: optional(
			option('--vertices', integer({ min: 0, metavar: 'N' }), {
				description: message`sample up to N vertices`,
			}),
		),
		submesh: optional(
			option('--submesh', integer({ min: 0, metavar: 'N' }), {
				description: message`filter sampled vertices to submesh index N`,
			}),
		),
		near: optional(
			option('--near', vec3(), {
				description: message`sample vertices near local point x,y,z`,
			}),
		),
		radius: withDefault(
			option('--radius', float({ min: 0, metavar: 'M' }), {
				description: message`search radius around --near`,
			}),
			2,
		),
	}),
	objectFilterOptions,
	targetsOrStdin('OBJECT'),
	configOption,
);

const inspectTextureParser = merge(
	object({
		command: constant('inspect'),
		subcommand: constant('texture'),
		output: optional(
			option('-o', '--output', string({ metavar: 'FILE' }), {
				description: message`write KTX2 (.ktx2), DX10 DDS (.dds), or uncompressed 8-bit PNG (.png)`,
			}),
		),
		layer: optional(
			option('--layer', integer({ min: 0, metavar: 'N' }), {
				description: message`array/cubemap layer index for .dds/.png export`,
			}),
		),
		mip: optional(
			option('--mip', integer({ min: 0, metavar: 'N' }), {
				description: message`mip level for .dds/.png export`,
			}),
		),
		zstd: optional(
			option('--zstd', integer({ min: 1, max: 22, metavar: 'N' }), {
				description: message`zstd compression level for .ktx2 export (1–22)`,
			}),
		),
	}),
	objectFilterOptions,
	targetsOrStdin('OBJECT'),
	configOption,
);

const inspectWaterConfigParser = merge(
	object({
		command: constant('inspect'),
		subcommand: constant('water-config'),
	}),
	objectFilterOptions,
	targetsOrStdin('OBJECT'),
	configOption,
);

/** parser for `endfield-extract inspect` */
export const inspectParser = or(
	command('prefab', inspectPrefabParser, {
		brief: message`inspect prefab hierarchy, renderers, particles, lights, and env volumes`,
	}),
	command('material', inspectMaterialParser, {
		brief: message`inspect shader-declared properties, textures, and packed surface description`,
	}),
	command('shader', inspectShaderParser, {
		brief: message`inspect shader tags and declared properties`,
	}),
	command('mesh', inspectMeshParser, {
		brief: message`inspect mesh vertex channels, submesh bounds, skinning, and vertex samples`,
	}),
	command('texture', inspectTextureParser, {
		brief: message`inspect texture format, dimensions, mips, and optionally export KTX2/DDS`,
	}),
	command('water-config', inspectWaterConfigParser, {
		brief: message`inspect surface WaterConfig or Global_Water_Config as JSON`,
	}),
);

/** parsed arguments for `inspect` */
export type InspectArgs = InferValue<typeof inspectParser>;

/** parsed arguments for a specific `inspect` subcommand */
export type InspectSubArgs<S extends InspectArgs['subcommand']> = Extract<InspectArgs, { subcommand: S }>;
