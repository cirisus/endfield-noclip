import { run } from './commands/player-route.ts';
import { createRouteCache } from './route-cache.ts';

type Request = { id: string; args: string[] };
const cache = createRouteCache();
let running = false;
const send = (message: object) => {
	if (process.connected) {
		process.send?.(message);
	}
};

process.on('message', (value: unknown) => {
	if (!value || typeof value !== 'object' || !('id' in value) || typeof value.id !== 'string' || !value.id) {
		return;
	}
	const id = value.id;
	if (
		!('args' in value) ||
		!Array.isArray(value.args) ||
		!value.args.every((argument) => typeof argument === 'string')
	) {
		send({ type: 'error', id, error: 'invalid route worker request' });
		return;
	}
	if (running) {
		send({ type: 'error', id, error: 'route worker is already running' });
		return;
	}
	const request: Request = { id, args: value.args };
	running = true;
	void run(request.args, {
		cache,
		progress: (progress) => send({ type: 'progress', id, progress }),
	})
		.then(() => send({ type: 'done', id, memory: process.memoryUsage() }))
		.catch((error: unknown) => {
			cache.clear();
			send({ type: 'error', id, error: error instanceof Error ? error.message : String(error) });
		})
		.finally(() => {
			running = false;
		});
});
process.on('disconnect', () => {
	cache.clear();
	process.exit(0);
});
send({ type: 'ready', version: 1 });
