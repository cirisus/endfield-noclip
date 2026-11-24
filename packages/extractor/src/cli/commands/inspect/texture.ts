import { writeDds } from '@endfield-noclip/formats/binary/dds';
import { writeKtx2 } from '@endfield-noclip/formats/binary/ktx2';
import { UnityClass } from '@endfield-noclip/formats/unity/serialized-file';
import { type DecodedTexture, toKtx2Texture } from '@endfield-noclip/formats/unity/texture';

import { withContext } from '../../../context.ts';
import { loadTexture } from '../../../game/assets/asset-decode.ts';
import { objectKey } from '../../../game/assets/assets.ts';
import { zstdSync } from '../../../zstd.ts';
import { collectTargets, save as saveFile } from '../../helpers.ts';

import type { InspectSubArgs } from './parser.ts';
import { resolveObjectArg } from './shared.ts';

/**
 * runs `endfield-extract inspect texture`
 *
 * @param args parsed CLI arguments
 */
export const runInspectTexture = async (args: InspectSubArgs<'texture'>): Promise<void> => {
	const targets = await collectTargets(args.targets, args.stdin);
	if (targets.length === 0) {
		throw new Error('inspect texture needs at least one target or --stdin');
	}
	if (args.output !== undefined && targets.length > 1) {
		throw new Error('-o cannot be used with multiple texture targets');
	}
	await withContext(args.config, async (context) => {
		const resolver = await context.resolver();
		const results = [];
		for (const raw of targets) {
			// oxlint-disable-next-line no-await-in-loop -- preserves target order
			const ref = await resolveObjectArg(context, resolver, raw, UnityClass.Texture2D, {
				pathId: args.pathId,
				nameFilter: args.name,
			});
			// oxlint-disable-next-line no-await-in-loop -- preserves target order
			const texture = await loadTexture(resolver, ref);
			results.push({ object: objectKey(ref), ...textureSummary(texture) });
			if (args.output !== undefined) {
				const isDds = args.output.toLowerCase().endsWith('.dds');
				if (!isDds && (args.layer !== undefined || args.mip !== undefined)) {
					throw new Error('--layer and --mip are only supported with .dds output');
				}
				const bytes = isDds
					? writeDds(texture, { layer: args.layer, mip: args.mip })
					: encodeKtx2(texture, args.zstd);
				// oxlint-disable-next-line no-await-in-loop -- single target when -o is set
				await saveFile(args.output, bytes);
				console.error(`wrote ${bytes.length} bytes to ${args.output}`);
			}
		}
		console.log(JSON.stringify(results.length === 1 ? results[0] : results, null, '\t'));
	});
};

const textureSummary = (texture: DecodedTexture) => ({
	name: texture.name,
	kind: texture.kind,
	size: [texture.width, texture.height, texture.depth],
	layers: texture.layers,
	faces: texture.faces,
	mipCount: texture.mipCount,
	format: texture.format,
	vkFormat: texture.vkFormat,
	srgb: texture.srgb,
	colorSpace: texture.colorSpace,
	sampler: texture.sampler,
	levelBytes: texture.levels.map((level) => level.length),
});

const encodeKtx2 = (texture: DecodedTexture, level: number | undefined): Uint8Array =>
	writeKtx2(toKtx2Texture(texture), {
		writer: 'endfield-noclip extractor',
		zstd: level === undefined ? undefined : (data) => zstdSync(data, level),
	});
