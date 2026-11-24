import { availableParallelism } from 'node:os';

import { merge, object, or } from '@optique/core/constructs';
import { message } from '@optique/core/message';
import { map, optional, withDefault } from '@optique/core/modifiers';
import type { InferValue } from '@optique/core/parser';
import { argument, constant, flag, option } from '@optique/core/primitives';
import { integer, string } from '@optique/core/valueparser';

import { bounds, configOption } from '../../parsers.ts';

/**
 * default worker count at most; each worker holds roughly 150–200 MB of its own catalogs and caches (the
 * bundle manifest is shared), before the assets of its jobs in flight
 */
const MAX_DEFAULT_JOBS = 8;
const DEFAULT_JOBS = Math.max(1, Math.min(MAX_DEFAULT_JOBS, availableParallelism() - 1));

const packTargetParser = or(
	object({
		existing: flag('--existing', {
			description: message`repack every existing package under out/ (or -o) using one install session`,
		}),
	}),
	object({
		existing: constant(false),
		scene: argument(string({ metavar: 'SCENE' }), {
			description: message`streaming scene id (e.g. map02)`,
		}),
		level: optional(
			option('--level', string({ metavar: 'ID' }), {
				description: message`keep only content owned by one level and terrain under its cells`,
			}),
		),
		bounds: optional(
			option('--bounds', bounds(), {
				description: message`keep content whose centre lies in the world x, z rectangle`,
			}),
		),
	}),
);

/** parser for `endfield-extract pack` */
export const packParser = merge(
	object({
		command: constant('pack'),
		output: optional(
			option('-o', '--output', string({ metavar: 'DIR' }), {
				description: message`output package directory (or parent dir with --existing)`,
			}),
		),
		maxTextureSize: optional(
			option('--max-texture-size', integer({ min: 1, metavar: 'PX' }), {
				description: message`cap converted texture dimensions in pixels`,
			}),
		),
		zstdLevel: withDefault(
			option('--zstd-level', integer({ min: 1, max: 22, metavar: 'N' }), {
				description: message`zstd compression level for non-texture blobs (1–22)`,
			}),
			19,
		),
		textureZstdLevel: withDefault(
			option('--texture-zstd-level', integer({ min: 1, max: 22, metavar: 'N' }), {
				description: message`zstd compression level for texture blobs (1–22)`,
			}),
			9,
		),
		jobs: withDefault(
			option('--jobs', integer({ min: 1, metavar: 'N' }), {
				description: message`worker threads converting meshes and textures`,
			}),
			DEFAULT_JOBS,
		),
		cache: optional(
			or(
				option('--cache', string({ metavar: 'DIR' }), {
					description: message`cache directory shared across packs (default out/.cache)`,
				}),
				map(
					flag('--no-cache', {
						description: message`convert everything without reading or writing the pack cache`,
					}),
					() => null,
				),
			),
		),
		noAssets: option('--no-assets', {
			description: message`skip geometry, material, and texture conversion`,
		}),
		json: option('--json', {
			description: message`emit the pack report as JSON`,
		}),
	}),
	packTargetParser,
	configOption,
);

/** parsed arguments for `pack` */
export type PackArgs = InferValue<typeof packParser>;
