import { type FileHandle, open } from 'node:fs/promises';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

import { decodeBlobTable, type BlobRecord } from '@endfield-noclip/package-format/blob-table';
import { BlobCodec, BlobKind } from '@endfield-noclip/package-format/blobs';
import {
	decodeChains,
	decodeInstanceBlock,
	type Chain,
	type InstanceBlock,
} from '@endfield-noclip/package-format/instances';
import {
	CORE_ARCHIVE,
	CORE_ARCHIVE_INDEX,
	CORE_PATHS,
	type PackageManifest,
} from '@endfield-noclip/package-format/manifest';
import type { MaterialTable } from '@endfield-noclip/package-format/materials';
import { decodeTree, type Tree } from '@endfield-noclip/package-format/tree';

import { openArchive, type Archive } from '@mary-ext/czar';
import { fromFileHandle } from '@mary-ext/czar/node';

import { mapPool } from '../pool.ts';

const BLOB_MEMBER = /^blobs\/(?:.+\/)?([0-9a-f]+)\.[a-z]+$/;
const INSTANCE_MEMBER = /^blobs\/(?:.+\/)?([0-9a-f]+)\.inst$/;

/** concurrent shard header opens when locating blobs by hash */
const ARCHIVE_CONCURRENCY = 8;

/** read-only handle to a packed package directory (`out/<scene>/`) */
export class PackedPackage implements AsyncDisposable {
	readonly dir: string;
	readonly manifest: PackageManifest;
	readonly #coreHandle: FileHandle;
	readonly #core: Archive;
	readonly #coreDataOffset: number;
	#tree: Promise<Tree> | undefined;
	#blobs: Promise<BlobRecord[]> | undefined;
	#chains: Promise<Chain[]> | undefined;
	#materials: Promise<MaterialTable> | undefined;

	private constructor(
		dir: string,
		manifest: PackageManifest,
		coreHandle: FileHandle,
		core: Archive,
		coreDataOffset: number,
	) {
		this.dir = dir;
		this.manifest = manifest;
		this.#coreHandle = coreHandle;
		this.#core = core;
		this.#coreDataOffset = coreDataOffset;
	}

	/**
	 * opens a package's `core.czar` and reads its manifest
	 *
	 * @param dir package directory containing `core.czar`
	 * @returns an open {@link PackedPackage}; dispose it to close the core file handle
	 * @throws {Error} if `core.czar` or its manifest is missing or unreadable
	 */
	static async open(dir: string): Promise<PackedPackage> {
		const corePath = join(dir, CORE_ARCHIVE);
		const coreHandle = await open(corePath);
		try {
			const core = await openArchive(await fromFileHandle(coreHandle));
			const coreDataOffset = core.files[0]?.position ?? 0;
			const manifestBytes = await readCoreMember(core, CORE_PATHS.manifest);
			const manifest: PackageManifest = JSON.parse(new TextDecoder().decode(manifestBytes));
			return new PackedPackage(dir, manifest, coreHandle, core, coreDataOffset);
		} catch (error) {
			await coreHandle.close();
			throw error;
		}
	}

	/** @returns decoded `tree.bin` */
	tree(): Promise<Tree> {
		this.#tree ??= readCoreMember(this.#core, CORE_PATHS.tree).then(decodeTree);
		return this.#tree;
	}

	/** @returns decoded `tables/blobs.bin` */
	blobs(): Promise<BlobRecord[]> {
		this.#blobs ??= readCoreMember(this.#core, CORE_PATHS.blobs).then(decodeBlobTable);
		return this.#blobs;
	}

	/** @returns decoded `tables/chains.bin` */
	chains(): Promise<Chain[]> {
		this.#chains ??= readCoreMember(this.#core, CORE_PATHS.chains).then(decodeChains);
		return this.#chains;
	}

	/** @returns decoded `tables/materials.json.zst` */
	materials(): Promise<MaterialTable> {
		this.#materials ??= readCoreMember(this.#core, CORE_PATHS.materials).then((bytes) => {
			const table: MaterialTable = JSON.parse(new TextDecoder().decode(bytes));
			return table;
		});
		return this.#materials;
	}

	/**
	 * resolves instance blob hashes (as recorded in `debug/instances.jsonl`) to their blob table ids by
	 * scanning `core.czar` and, for hashes not found there, `shards/*.czar` headers
	 *
	 * @param hashes lowercase hex hashes to locate
	 * @returns map of found hash → blob index
	 */
	async locateInstanceBlobs(hashes: ReadonlySet<string>): Promise<Map<string, number>> {
		const found = new Map<string, number>();
		if (hashes.size === 0) {
			return found;
		}
		const blobs = await this.blobs();
		const byArchive = new Map<number, Map<number, number>>();
		for (const [id, record] of blobs.entries()) {
			if (record.kind !== BlobKind.Instances) {
				continue;
			}
			byArchive.getOrInsertComputed(record.archive, () => new Map()).set(record.offset, id);
		}
		const scanArchive = (archiveIndex: number, archive: Archive, dataOffset: number): void => {
			const offsets = byArchive.get(archiveIndex);
			if (offsets === undefined) {
				return;
			}
			for (const file of archive.files) {
				const match = INSTANCE_MEMBER.exec(file.path);
				if (match === null || !hashes.has(match[1])) {
					continue;
				}
				const blobId = offsets.get(file.position - dataOffset);
				if (blobId !== undefined) {
					found.set(match[1], blobId);
				}
			}
		};
		scanArchive(CORE_ARCHIVE_INDEX, this.#core, this.#coreDataOffset);
		if (found.size >= hashes.size) {
			return found;
		}
		const shardIndices: number[] = [];
		for (const [archiveIndex, info] of this.manifest.archives.entries()) {
			if (info.role === 'shards' && byArchive.has(archiveIndex)) {
				shardIndices.push(archiveIndex);
			}
		}
		await mapPool(shardIndices, ARCHIVE_CONCURRENCY, async (archiveIndex) => {
			if (found.size >= hashes.size) {
				return;
			}
			const info = this.manifest.archives[archiveIndex];
			if (info.role === 'core') {
				return;
			}
			await using handle = await open(join(this.dir, info.name));
			const archive = await openArchive(await fromFileHandle(handle));
			scanArchive(archiveIndex, archive, info.dataOffset);
		});
		return found;
	}

	/**
	 * resolves blob table ids back to their content hashes by reading only the archive headers that own them
	 *
	 * @param blobIds blob indices to look up
	 * @returns map of blob index → lowercase hex hash
	 */
	async blobHashes(blobIds: ReadonlySet<number>): Promise<Map<number, string>> {
		const hashes = new Map<number, string>();
		if (blobIds.size === 0) {
			return hashes;
		}
		const blobs = await this.blobs();
		const wantedByArchive = new Map<number, Map<number, number>>();
		for (const id of blobIds) {
			const record = blobs[id];
			if (record === undefined) {
				continue;
			}
			wantedByArchive.getOrInsertComputed(record.archive, () => new Map()).set(record.offset, id);
		}
		const readFromArchive = (archiveIndex: number, archive: Archive, dataOffset: number): void => {
			const wanted = wantedByArchive.get(archiveIndex);
			if (wanted === undefined) {
				return;
			}
			for (const file of archive.files) {
				const id = wanted.get(file.position - dataOffset);
				if (id === undefined) {
					continue;
				}
				const match = BLOB_MEMBER.exec(file.path);
				if (match !== null) {
					hashes.set(id, match[1]);
				}
			}
		};
		if (wantedByArchive.has(CORE_ARCHIVE_INDEX)) {
			readFromArchive(CORE_ARCHIVE_INDEX, this.#core, this.#coreDataOffset);
		}
		const otherArchives = [...wantedByArchive.keys()].filter((index) => index !== CORE_ARCHIVE_INDEX);
		await mapPool(otherArchives, ARCHIVE_CONCURRENCY, async (archiveIndex) => {
			const info = this.manifest.archives[archiveIndex];
			if (info === undefined || info.role === 'core') {
				return;
			}
			await using handle = await open(join(this.dir, info.name));
			const archive = await openArchive(await fromFileHandle(handle));
			readFromArchive(archiveIndex, archive, info.dataOffset);
		});
		return hashes;
	}

	/**
	 * reads and decodes one instance block blob from its archive
	 *
	 * @param blobId blob index of a {@link BlobKind.Instances} blob
	 * @returns the decoded instance block
	 * @throws {Error} if `blobId` is out of range or not an instance block
	 */
	async readInstanceBlock(blobId: number): Promise<InstanceBlock> {
		const blobs = await this.blobs();
		const record = blobs[blobId];
		if (record === undefined) {
			throw new Error(`blob ${blobId} is out of range (${blobs.length} blobs)`);
		}
		if (record.kind !== BlobKind.Instances) {
			throw new Error(`blob ${blobId} is not an instance block (kind ${record.kind})`);
		}
		const info = this.manifest.archives[record.archive];
		if (info === undefined) {
			throw new Error(`blob ${blobId} references missing archive ${record.archive}`);
		}
		let stored: Uint8Array;
		if (info.role === 'core') {
			stored = await readRange(this.#coreHandle, this.#coreDataOffset + record.offset, record.length);
		} else {
			await using handle = await open(join(this.dir, info.name));
			stored = await readRange(handle, info.dataOffset + record.offset, record.length);
		}
		const raw = record.codec === BlobCodec.Zstd ? new Uint8Array(zstdDecompressSync(stored)) : stored;
		return decodeInstanceBlock(raw);
	}

	/** closes the core archive handle */
	async [Symbol.asyncDispose](): Promise<void> {
		await this.#coreHandle.close();
	}
}

const readCoreMember = async (core: Archive, path: string): Promise<Uint8Array> => {
	const file = core.get(path);
	if (file === undefined) {
		throw new Error(`${CORE_ARCHIVE} is missing ${path}`);
	}
	const bytes = await file.bytes();
	return path.endsWith('.zst') ? new Uint8Array(zstdDecompressSync(bytes)) : bytes;
};

const readRange = async (handle: FileHandle, offset: number, length: number): Promise<Uint8Array> => {
	const out = new Uint8Array(length);
	let read = 0;
	while (read < length) {
		// oxlint-disable-next-line no-await-in-loop -- short reads continue until the range is filled
		const { bytesRead } = await handle.read(out, read, length - read, offset + read);
		if (bytesRead === 0) {
			throw new Error(`unexpected EOF reading ${length} bytes at offset ${offset}`);
		}
		read += bytesRead;
	}
	return out;
};
