import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

type Entry = { key: string; value: unknown };
type Files = { ground: string; collision: string; movement: string };

const fileIdentity = async (path: string) => {
	const absolute = resolve(path);
	const info = await stat(absolute, { bigint: true });
	return {
		path: absolute,
		bytes: Number(info.size),
		key: JSON.stringify([absolute, info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].map(String)),
	};
};

/**
 * @param maxInputBytes maximum serialized bytes retained for one physical input region
 * @returns a single-region preparation cache; failed work and oversized regions are never retained
 * @throws for a negative or non-integer input byte limit
 */
export const createRouteCache = (maxInputBytes = 512 * 1024 * 1024) => {
	if (!Number.isSafeInteger(maxInputBytes) || maxInputBytes < 0) {
		throw new Error('invalid route input cache limit');
	}
	let generation = '';
	let enabled = false;
	let inputBytes = 0;
	let expected = new Map<string, string>();
	const inputs = new Map<string, Entry>();
	const prepared = new Map<string, Entry>();
	const clear = () => {
		generation = '';
		enabled = false;
		inputs.clear();
		prepared.clear();
		expected.clear();
	};
	return {
		clear,
		async begin(files: Files) {
			const identities = await Promise.all(Object.values(files).map(fileIdentity));
			const key = JSON.stringify(identities.map((entry) => entry.key));
			if (key !== generation) {
				// Release the preceding region before decoding its replacement.
				clear();
				generation = key;
			}
			inputBytes = identities.reduce((sum, entry) => sum + entry.bytes, 0);
			enabled = inputBytes <= maxInputBytes;
			expected = new Map(identities.map((entry) => [entry.path, entry.key]));
			return key;
		},
		async read<T>(slot: 'ground' | 'collision' | 'movement' | 'devices', path: string): Promise<T> {
			const identity = await fileIdentity(path);
			if (slot !== 'devices' && expected.get(identity.path) !== identity.key) {
				clear();
				throw new Error('route input changed after preparation began');
			}
			if (slot === 'devices' && inputBytes + identity.bytes > maxInputBytes) {
				enabled = false;
				inputs.clear();
				prepared.clear();
			}
			const existing = inputs.get(slot);
			if (enabled && existing?.key === identity.key) {
				return existing.value as T;
			}
			const value: unknown = JSON.parse(await readFile(identity.path, 'utf8'));
			const after = await fileIdentity(identity.path);
			if (after.key !== identity.key) {
				clear();
				throw new Error('route input changed while reading');
			}
			if (enabled && identity.bytes <= maxInputBytes) {
				inputs.set(slot, { key: identity.key, value });
			}
			return value as T;
		},
		async memo<T>(
			slot: 'ground' | 'collision' | 'devices' | 'refinement',
			key: string,
			create: () => T | Promise<T>,
		) {
			const existing = prepared.get(slot);
			if (enabled && existing?.key === key) {
				return { value: existing.value as T, reused: true };
			}
			prepared.delete(slot);
			if (slot === 'ground') {
				prepared.delete('refinement');
				prepared.delete('devices');
			}
			const value = await create();
			if (enabled) {
				prepared.set(slot, { key, value });
			}
			return { value, reused: false };
		},
	};
};

export type RouteCache = ReturnType<typeof createRouteCache>;
