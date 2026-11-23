import { parseArgs } from 'node:util';

import { save } from '../cli-args.ts';
import { withContext } from '../context.ts';
import { errorText } from '../errors.ts';
import { VfsGroup } from '../hg/vfs.ts';

export const summary = 'list virtual filesystem groups and files; extract logical files';

/** command usage, available without opening the install */
export const usage = `usage:
  vfs groups
  vfs ls <group|name> [--filter re]
  vfs cat <group|name> <path> -o <file>

<group|name> is an 8-hex group hash or a VfsGroup name (e.g. JsonData, Table, Bundle).`;

const GROUP_NAMES = new Map<string, string>(
	Object.entries(VfsGroup).map(([name, hash]) => [name.toLowerCase(), hash]),
);

const resolveGroup = (input: string): string => GROUP_NAMES.get(input.toLowerCase()) ?? input;

export const run = async (args: string[]): Promise<void> => {
	const { values, positionals } = parseArgs({
		args,
		allowPositionals: true,
		options: {
			config: { type: 'string' },
			filter: { type: 'string' },
			output: { type: 'string', short: 'o' },
		},
	});
	const [sub, group, name] = positionals;

	await withContext(values.config, async ({ vfs }) => {
		switch (sub) {
			case 'groups': {
				const hashes = await vfs.listGroups();
				const mounted = await Promise.allSettled(hashes.map((hash) => vfs.group(hash)));
				for (const [i, result] of mounted.entries()) {
					const hash = hashes[i];
					if (result.status === 'rejected') {
						console.log(`${hash}  (unreadable: ${errorText(result.reason)})`);
						continue;
					}
					const { catalog } = result.value;
					const gib = (catalog.chunksLength / 1024 ** 3).toFixed(2);
					console.log(
						`${hash}  ${catalog.groupName.padEnd(20)} ${String(catalog.fileCount).padStart(7)} files  ${gib} GiB`,
					);
				}
				break;
			}
			case 'ls': {
				if (group === undefined) {
					throw new Error('vfs ls needs a group hash or name');
				}
				const filter = values.filter === undefined ? undefined : new RegExp(values.filter, 'i');
				for (const entry of (await vfs.group(resolveGroup(group))).catalog) {
					if (filter === undefined || filter.test(entry.name)) {
						console.log(
							`${String(entry.length).padStart(11)}  ${entry.ivSeed === null ? ' ' : 'E'}  ${entry.name}`,
						);
					}
				}
				break;
			}
			case 'cat': {
				if (group === undefined || name === undefined || values.output === undefined) {
					throw new Error('vfs cat needs <group|name> <path> -o <file>');
				}
				const data = await vfs.read(resolveGroup(group), name);
				await save(values.output, data);
				console.log(`wrote ${data.length} bytes to ${values.output}`);
				break;
			}
			default: {
				throw new Error('usage: vfs groups | ls <group|name> | cat <group|name> <path> -o <file>');
			}
		}
	});
};
