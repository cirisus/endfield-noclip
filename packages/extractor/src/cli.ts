#!/usr/bin/env node
import { or } from '@optique/core/constructs';
import { message } from '@optique/core/message';
import { command } from '@optique/core/primitives';
import { run } from '@optique/run';

import { auditParser } from './cli/commands/audit/parser.ts';
import { bundleParser } from './cli/commands/bundle/parser.ts';
import { dataParser } from './cli/commands/data/parser.ts';
import { initParser } from './cli/commands/init/parser.ts';
import { inspectParser } from './cli/commands/inspect/parser.ts';
import { packParser } from './cli/commands/pack/parser.ts';
import { sceneParser } from './cli/commands/scene/parser.ts';
import { vfsParser } from './cli/commands/vfs/parser.ts';

// exit quietly when piped into `head` and the like
process.stdout.on('error', (error: NodeJS.ErrnoException) => {
	if (error.code === 'EPIPE') {
		process.exit(0);
	}
	throw error;
});

const rootParser = or(
	command('audit', auditParser, {
		brief: message`survey packed packages and debug data`,
		description: message`query packed packages under out/<scene>/ (or --dir) without opening a game install.`,
	}),
	command('bundle', bundleParser, {
		brief: message`inspect and search bundle objects; dump JSON or stream payloads`,
		footer: message`<name> is a bundle hex id, main/<hex>.ab, a full logical path, or an asset path/hash.`,
	}),
	command('data', dataParser, {
		brief: message`search asset paths, resolve hashes, and read SparkBuffer tables & level data`,
	}),
	command('init', initParser, {
		brief: message`derive and validate install keys, then write the local config`,
		description: message`derive bundle cipher keys from the install, optionally import missing keys with --keys-from, validate them against the VFS, and write the local config file.`,
	}),
	command('inspect', inspectParser, {
		brief: message`inspect a prefab, material, shader, mesh, texture, or water config`,
		footer: message`<object> is <bundle> [--path-id N] [--name re], an asset path, a unique filename/basename, or a path hash. omitting --path-id picks the unique matching object in the bundle.`,
	}),
	command('pack', packParser, {
		brief: message`build a viewer package for a scene, level, or world rectangle`,
		description: message`write a viewer package for one streaming scene (e.g. map02), or with --existing repack every package already under out/ (preserving each package's scene, --level, and --bounds from its manifest) in one install session.`,
		footer: message`output defaults to out/<scene>[-<level>]. converted meshes, textures, and blobs are cached across packs under out/.cache and swept to what built packages hold; pass --no-cache to bypass caching.`,
	}),
	command('scene', sceneParser, {
		brief: message`browse scenes, levels, controls, environments, and everything placed near a point`,
	}),
	command('vfs', vfsParser, {
		brief: message`list virtual filesystem groups and files; extract logical files`,
		footer: message`<group> is an 8-hex group hash or a VfsGroup name (e.g. JsonData, Table, Bundle).`,
	}),
);

const parsed = run(rootParser, {
	programName: 'endfield-extract',
	brief: message`reads a local Endfield install and builds or inspects viewer packages`,
	footer: message`run \`endfield-extract <command> --help\` or \`endfield-extract help <command> [subcommand]\` for detailed options.`,
	help: 'both',
	aboveError: 'usage',
	showDefault: true,
	showChoices: true,
	termWidth: 'auto',
});

try {
	switch (parsed.command) {
		case 'init': {
			const { runInit } = await import('./cli/commands/init/run.ts');
			await runInit(parsed);
			break;
		}
		case 'vfs': {
			const { runVfs } = await import('./cli/commands/vfs/run.ts');
			await runVfs(parsed);
			break;
		}
		case 'pack': {
			const { runPack } = await import('./cli/commands/pack/run.ts');
			await runPack(parsed);
			break;
		}
		case 'bundle': {
			const { runBundle } = await import('./cli/commands/bundle/run.ts');
			await runBundle(parsed);
			break;
		}
		case 'data': {
			const { runData } = await import('./cli/commands/data/run.ts');
			await runData(parsed);
			break;
		}
		case 'inspect': {
			switch (parsed.subcommand) {
				case 'prefab': {
					const { runInspectPrefab } = await import('./cli/commands/inspect/prefab.ts');
					await runInspectPrefab(parsed);
					break;
				}
				case 'material': {
					const { runInspectMaterial } = await import('./cli/commands/inspect/material.ts');
					await runInspectMaterial(parsed);
					break;
				}
				case 'shader': {
					const { runInspectShader } = await import('./cli/commands/inspect/shader.ts');
					await runInspectShader(parsed);
					break;
				}
				case 'mesh': {
					const { runInspectMesh } = await import('./cli/commands/inspect/mesh.ts');
					await runInspectMesh(parsed);
					break;
				}
				case 'texture': {
					const { runInspectTexture } = await import('./cli/commands/inspect/texture.ts');
					await runInspectTexture(parsed);
					break;
				}
				case 'water-config': {
					const { runInspectWaterConfig } = await import('./cli/commands/inspect/water-config.ts');
					await runInspectWaterConfig(parsed);
					break;
				}
			}
			break;
		}
		case 'scene': {
			switch (parsed.subcommand) {
				case 'list': {
					const { runSceneList } = await import('./cli/commands/scene/list.ts');
					await runSceneList(parsed);
					break;
				}
				case 'levels': {
					const { runSceneLevels } = await import('./cli/commands/scene/list.ts');
					await runSceneLevels(parsed);
					break;
				}
				case 'find': {
					const { runSceneFind } = await import('./cli/commands/scene/find.ts');
					await runSceneFind(parsed);
					break;
				}
				case 'chunk': {
					const { runSceneChunk } = await import('./cli/commands/scene/chunk.ts');
					await runSceneChunk(parsed);
					break;
				}
				case 'prefabs': {
					const { runScenePrefabs } = await import('./cli/commands/scene/prefabs.ts');
					await runScenePrefabs(parsed);
					break;
				}
				case 'env': {
					const { runSceneEnv } = await import('./cli/commands/scene/env.ts');
					await runSceneEnv(parsed);
					break;
				}
				case 'controls': {
					const { runSceneControls } = await import('./cli/commands/scene/controls.ts');
					await runSceneControls(parsed);
					break;
				}
			}
			break;
		}
		case 'audit': {
			switch (parsed.subcommand) {
				case 'list': {
					const { runAuditList } = await import('./cli/commands/audit/list.ts');
					await runAuditList(parsed);
					break;
				}
				case 'core': {
					const { runAuditCore } = await import('./cli/commands/audit/core.ts');
					await runAuditCore(parsed);
					break;
				}
				case 'tree': {
					const { runAuditTree } = await import('./cli/commands/audit/tree.ts');
					await runAuditTree(parsed);
					break;
				}
				case 'instances': {
					const { runAuditInstances } = await import('./cli/commands/audit/instances.ts');
					await runAuditInstances(parsed);
					break;
				}
				case 'materials': {
					const { runAuditMaterials } = await import('./cli/commands/audit/assets.ts');
					await runAuditMaterials(parsed);
					break;
				}
				case 'geometries': {
					const { runAuditGeometries } = await import('./cli/commands/audit/assets.ts');
					await runAuditGeometries(parsed);
					break;
				}
				case 'textures': {
					const { runAuditTextures } = await import('./cli/commands/audit/assets.ts');
					await runAuditTextures(parsed);
					break;
				}
				case 'stand-ins': {
					const { runAuditStandIns } = await import('./cli/commands/audit/stand-ins.ts');
					await runAuditStandIns(parsed);
					break;
				}
				case 'interactives': {
					const { runAuditInteractives } = await import('./cli/commands/audit/interactives.ts');
					await runAuditInteractives(parsed);
					break;
				}
				case 'water': {
					const { runAuditWater } = await import('./cli/commands/audit/water.ts');
					await runAuditWater(parsed);
					break;
				}
				case 'env': {
					const { runAuditEnv } = await import('./cli/commands/audit/env.ts');
					await runAuditEnv(parsed);
					break;
				}
				case 'irradiance': {
					const { runAuditIrradiance } = await import('./cli/commands/audit/irradiance.ts');
					await runAuditIrradiance(parsed);
					break;
				}
			}
			break;
		}
	}
} catch (error) {
	console.error(error instanceof Error ? (error.stack ?? error.message) : error);
	process.exitCode = 1;
}
