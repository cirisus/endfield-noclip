import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('./cli.ts', import.meta.url));

test('every command provides help without an install or config', async () => {
	const cwd = await mkdtemp(join(tmpdir(), 'extract-help-'));
	try {
		const files = await readdir(new URL('./commands/', import.meta.url));
		await Promise.all(
			files
				.filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
				.map(async (file) => {
					const name = file.slice(0, -3);
					for (const args of [[name], [name, '--help'], [name, 'anything', '-h']]) {
						// oxlint-disable-next-line no-await-in-loop -- verify the three invocation forms for each command
						const result = await exec(process.execPath, [cli, ...args], { cwd });
						assert.match(result.stdout, /usage:/);
						assert.match(result.stdout, /--config/);
						assert.equal(result.stderr, '');
					}
				}),
		);
		await assert.rejects(exec(process.execPath, [cli, '../context'], { cwd }), /unknown command/);
		await assert.rejects(exec(process.execPath, [cli, 'world', '--', '--help'], { cwd }));
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});
