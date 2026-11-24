import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';

/**
 * reads non-empty trimmed lines from stdin (used by `--stdin` batch commands)
 *
 * @returns non-empty lines from `process.stdin`
 */
export const readStdinLines = async (): Promise<string[]> => {
	const lines: string[] = [];
	const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
	for await (const line of rl) {
		const trimmed = line.trim();
		if (trimmed.length > 0) {
			lines.push(trimmed);
		}
	}
	return lines;
};

/**
 * resolves batch targets from positional arguments and/or `--stdin`, preserving order and deduplicating
 *
 * @param positionals positional target arguments
 * @param stdin whether `--stdin` was passed
 * @returns deduplicated list of targets
 */
export const collectTargets = async (positionals: readonly string[], stdin: boolean): Promise<string[]> => {
	const raw = stdin ? [...positionals, ...(await readStdinLines())] : [...positionals];
	const seen = new Set<string>();
	const out: string[] = [];
	for (const item of raw) {
		if (!seen.has(item)) {
			seen.add(item);
			out.push(item);
		}
	}
	return out;
};

/**
 * @param text a `<path|hash>` argument
 * @returns the StringPathHash key if it's a decimal or `0x` number (taken as unsigned 64-bit), else `null`
 *   for a path
 */
export const parseHash = (text: string): bigint | null => {
	return /^(0x[0-9a-f]+|\d+)$/i.test(text) ? BigInt.asUintN(64, BigInt(text)) : null;
};

/**
 * @param hash unsigned 64-bit StringPathHash key
 * @returns the key formatted as `0x…`
 */
export const hashText = (hash: bigint): string => {
	return `0x${hash.toString(16)}`;
};

/**
 * JSON.stringify replacer for bigints and typed arrays
 *
 * @param _key property key
 * @param value property value
 * @returns serializable replacement
 */
export const jsonReplacer = (_key: string, value: unknown): unknown => {
	if (typeof value === 'bigint') {
		return value.toString();
	}
	if (ArrayBuffer.isView(value)) {
		return `<${value.constructor.name} ${value.byteLength} bytes>`;
	}
	return value;
};

/**
 * writes a file, creating its directory
 *
 * @param path destination
 * @param bytes contents
 */
export const save = async (path: string, bytes: Uint8Array): Promise<void> => {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, bytes);
};
