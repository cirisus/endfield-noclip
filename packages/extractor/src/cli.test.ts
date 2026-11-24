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
		const rootHelp = await exec(process.execPath, [cli, '--help'], { cwd });
		assert.match(rootHelp.stdout, /Usage:/i);
		assert.equal(rootHelp.stderr, '');

		const entries = await readdir(new URL('./cli/commands/', import.meta.url), { withFileTypes: true });
		const commands = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
		await Promise.all(
			commands.map(async (name) => {
				for (const args of [
					[name, '--help'],
					['help', name],
				]) {
					// oxlint-disable-next-line no-await-in-loop -- verify both help invocation forms
					const result = await exec(process.execPath, [cli, ...args], { cwd });
					assert.match(result.stdout, /Usage:/i);
					assert.equal(result.stderr, '');
				}
			}),
		);

		await assert.rejects(exec(process.execPath, [cli, '../context'], { cwd }));
		await assert.rejects(exec(process.execPath, [cli, 'scene'], { cwd }));
		await assert.rejects(exec(process.execPath, [cli, 'scene', '--', '--help'], { cwd }));
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});
