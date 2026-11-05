import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isObject } from '@endfield-noclip/formats/unity/values';

import type { Surface } from '@oem/ganglia';
import type { BuildOptions, CollisionGeometry, TileCache } from '@oem/ganglia/build';

type Source = { buildGuid: string; contentHash: string };
const validSurface = (value: unknown): value is Surface =>
	isObject(value) &&
	typeof value.id === 'string' &&
	Array.isArray(value.vertices) &&
	value.vertices.length >= 3 &&
	value.vertices.every(
		(point: unknown) => Array.isArray(point) && point.length === 3 && point.every(Number.isFinite),
	);

/** @returns the installed geometry generator identity, independent of runtime route code */
export const groundGeneratorIdentity = async (): Promise<string> => {
	const entry = fileURLToPath(import.meta.resolve('@oem/ganglia/build'));
	const files = [
		entry,
		resolve(dirname(entry), 'support-field.mjs'),
		resolve(dirname(entry), 'clip-surface.mjs'),
	];
	const generator = createHash('sha256');
	for (const bytes of await Promise.all(files.map((file) => readFile(file)))) {
		generator.update(bytes);
	}
	const sdk = JSON.parse(await readFile(resolve(dirname(entry), '../package.json'), 'utf8'));
	generator.update(JSON.stringify(sdk.dependencies));
	return generator.digest('hex');
};

/**
 * @param directory local content-addressed tile storage
 * @param source immutable collision build binding
 * @returns a disk cache keyed by exact padded geometry and physical build settings
 * @throws if the installed generator identity cannot be read
 */
export const groundTileCache = async (directory: string, source: Source): Promise<TileCache> => {
	const identity = await groundGeneratorIdentity();
	const keyFor = (geometry: CollisionGeometry, options: BuildOptions) => {
		const hash = createHash('sha256')
			.update(JSON.stringify({ version: 1, source, generator: identity, options }))
			.update(JSON.stringify([geometry.positions.length, geometry.indices.length]));
		const positions = Float64Array.from(geometry.positions),
			indices = Uint32Array.from(geometry.indices);
		hash.update(Buffer.from(positions.buffer));
		hash.update(Buffer.from(indices.buffer));
		return hash.digest('hex');
	};
	const pathFor = (key: string) => resolve(directory, key.slice(0, 2), `${key}.json`);
	return {
		async load(geometry, options) {
			const key = keyFor(geometry, options);
			try {
				const record: unknown = JSON.parse(await readFile(pathFor(key), 'utf8'));
				if (!isObject(record) || record.key !== key || !Array.isArray(record.surfaces)) {
					return null;
				}
				const ids = new Set<string>();
				const surfaces: Surface[] = [];
				for (const value of record.surfaces) {
					const surface: unknown = value;
					if (!validSurface(surface) || ids.has(surface.id)) {
						return null;
					}
					ids.add(surface.id);
					surfaces.push(surface);
				}
				return surfaces;
			} catch {
				return null;
			}
		},
		async save(geometry, options, surfaces) {
			const key = keyFor(geometry, options),
				path = pathFor(key),
				temporary = `${path}.${randomUUID()}.tmp`;
			try {
				await mkdir(dirname(path), { recursive: true });
				await writeFile(temporary, JSON.stringify({ key, surfaces }));
				await rename(temporary, path);
			} catch (error) {
				console.warn('unable to retain physical tile cache', error);
			} finally {
				await rm(temporary, { force: true }).catch(() => {});
			}
		},
	};
};
