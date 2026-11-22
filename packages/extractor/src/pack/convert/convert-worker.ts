import { parentPort, workerData } from 'node:worker_threads';
/**
 * worker thread that converts meshes and textures: it reads the source bundles through its own VFS and asset
 * resolver, converts, compresses and hashes the blobs, and writes them to the blob directory, so only small
 * results cross back to the packer. see {@link ConvertPool} for the packer's side
 *
 * @module
 */

import type { DecodedMesh } from '@endfield-noclip/formats/unity/mesh';
import { UnityClass } from '@endfield-noclip/formats/unity/serialized-file';
import { bakeSkinPose } from '@endfield-noclip/formats/unity/skin-pose';

import { errorText } from '../../errors.ts';
import { loadMesh, loadTexture } from '../../game/assets/asset-decode.ts';
import { AssetResolver, type ObjectLocator, objectKey, recordBundleReads } from '../../game/assets/assets.ts';
import { sharedBundleManifest } from '../../hg/bundles.ts';
import { Vfs } from '../../hg/vfs.ts';
import { zstdSync } from '../../zstd.ts';
import { BlobDir, type BlobMeta, storedBlob } from '../store/blob-file.ts';

import type {
	ConvertJob,
	ConvertOutput,
	ConvertResult,
	ConvertWorkerData,
	WorkerReply,
	WorkerRequest,
} from './convert-pool.ts';
import { convertMesh, geometryReady, rigidSkin } from './geometry.ts';
import { type VatBake, vatSkin, type VatTexels, vatTexels } from './vat-skin.ts';
import { syntheticMesh, syntheticMeshKey } from './synthetic-mesh.ts';
import { convertTexture } from './textures.ts';

// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- set by ConvertPool
const data = workerData as ConvertWorkerData;
const port = parentPort!;
const vfs = new Vfs(data.gameData, data.keys.vfsKey);
const blobs = new BlobDir(data.blobDir);
const resolver = new AssetResolver({ vfs, keys: data.keys }, sharedBundleManifest(data.manifest));

const store = async (raw: Uint8Array, zstdLevel: number): Promise<BlobMeta> => {
	const { meta, stored } = storedBlob(raw, zstdSync(raw, zstdLevel));
	await blobs.write(meta.hash, stored);
	return meta;
};

const convert = async (job: ConvertJob): Promise<ConvertResult> => {
	const { result, bundles } = await recordBundleReads(() => convertWith(job));
	const sources = await Promise.all(
		bundles.map(async (index) => ({
			bundle: resolver.manifest.bundleName(index),
			md5: await resolver.bundleMd5(index),
		})),
	);
	return { ...result, sources };
};

/** @returns a VAT texture's texels */
const loadVatTexels = async ({ bundleIndex, file, pathId }: ObjectLocator): Promise<VatTexels> =>
	vatTexels(await loadTexture(resolver, await resolver.objectIn(bundleIndex, file, pathId)));

/** bakes a mesh's rigid-body animation from its textures */
const bakeVat = async (
	mesh: DecodedMesh,
	bake: VatBake,
): Promise<ReturnType<typeof vatSkin>> => {
	// an animation that can't be read leaves the mesh still rather than failing it
	try {
		return vatSkin(mesh, bake, await loadVatTexels(bake.position), await loadVatTexels(bake.rotation));
	} catch (error) {
		return { reason: `a rigid-body animation whose textures can't be read: ${errorText(error)}` };
	}
};

const convertWith = async (job: ConvertJob): Promise<ConvertOutput> => {
	switch (job.kind) {
		case 'geometry': {
			await geometryReady;
			if (job.asset.synthetic !== undefined) {
				const converted = convertMesh(syntheticMesh(job.asset.synthetic), job.tangentUv, {
					sway: job.sway ?? undefined,
					offset: job.offset ?? undefined,
				});
				return {
					kind: 'geometry',
					object: syntheticMeshKey(job.asset.synthetic),
					name: syntheticMeshKey(job.asset.synthetic),
					entry: converted.entry,
					gpuBytes: converted.gpuBytes,
					blob: await store(converted.blob, job.zstdLevel),
				};
			}
			const ref = await resolver.findUnique(job.asset, UnityClass.Mesh);
			const mesh = await loadMesh(resolver, ref);
			// an animated mesh stays in its bind space; a posed one is baked into its pose
			const { pose, motion } = job.asset;
			let source = pose ? bakeSkinPose(mesh, pose) : mesh;
			let skin = motion?.skin;
			let unanimated: string | undefined;
			if (motion?.kind === 'rigid') {
				source = rigidSkin(source);
			}
			if (job.vat !== null) {
				// a renderer's own animation or pose and a VAT's would compound; the renderer's is kept
				const baked =
					pose !== undefined || motion !== undefined
						? { reason: 'a rigid-body animation on a posed or animated renderer' }
						: await bakeVat(source, job.vat);
				if ('reason' in baked) {
					unanimated = baked.reason;
				} else {
					source = baked.mesh;
					skin = baked.motion;
				}
			}
			const converted = convertMesh(source, job.tangentUv, {
				sway: job.sway ?? undefined,
				offset: job.offset ?? undefined,
				motion: skin,
			});
			return {
				kind: 'geometry',
				object: objectKey(ref),
				name: mesh.name,
				entry: converted.entry,
				gpuBytes: converted.gpuBytes,
				blob: await store(converted.blob, job.zstdLevel),
				...(unanimated === undefined ? {} : { unanimated }),
			};
		}
		case 'texture': {
			const { bundleIndex, file, pathId } = job.locator;
			const texture = await loadTexture(resolver, await resolver.objectIn(bundleIndex, file, pathId));
			const converted = convertTexture(texture);
			const metas = await Promise.all(converted.pieces.map((piece) => store(piece.data, job.zstdLevel)));
			return {
				kind: 'texture',
				name: texture.name,
				entry: converted.entry,
				contentKey: converted.contentKey,
				approximations: converted.approximations,
				pieces: converted.pieces.map(({ firstLevel, levelCount }, i) => ({
					firstLevel,
					levelCount,
					blob: metas[i],
				})),
			};
		}
	}
};

port.on('message', (request: WorkerRequest) => {
	if (request.type === 'close') {
		void vfs.close().finally(() => port.close());
		return;
	}
	convert(request.job).then(
		(result) => port.postMessage({ id: request.id, result } satisfies WorkerReply),
		(error: unknown) => port.postMessage({ id: request.id, error: errorText(error) } satisfies WorkerReply),
	);
});
