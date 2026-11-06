import type { Decoded, DecodeRequest, DecodeResponse } from './decode-protocol.ts';

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** a {@link DecodeRequest} before the pool numbers it */
export type DecodeJob = DistributiveOmit<DecodeRequest, 'id'>;

/**
 * jobs posted to a worker at most at once; the rest wait in the pool, where they can still be cancelled. a
 * worker's answer waits for the main thread, which is busy for most of a frame while streaming, so a worker
 * with one job in hand would idle between them
 */
const POSTED_PER_WORKER = 4;

interface Queued {
	request: DecodeJob;
	signal: AbortSignal;
	resolve: (value: Decoded) => void;
	reject: (reason: unknown) => void;
}

interface Pending {
	kind: DecodeJob['kind'];
	resolve: (value: Decoded) => void;
	reject: (reason: Error) => void;
	worker: number;
}

/** runs {@link DecodeRequest}s on worker threads */
export class DecodePool {
	#workers: Worker[] = [];
	#busy: number[] = [];
	#queue: Queued[] = [];
	#jobs = new Map<number, Pending>();
	/** signals whose abort drops their queued jobs */
	#watched = new WeakSet<AbortSignal>();
	#nextId = 1;

	/** @param size worker count */
	constructor(size: number) {
		for (let i = 0; i < size; i++) {
			const worker = new Worker(new URL('./decode-worker.ts', import.meta.url), {
				type: 'module',
				name: `decode-${i}`,
			});
			worker.addEventListener('message', (event: MessageEvent<DecodeResponse>) => this.#settle(event.data));
			worker.addEventListener('error', (event) => console.error('decode worker:', event.message));
			this.#workers.push(worker);
			this.#busy.push(0);
		}
	}

	/**
	 * queues a job for the least busy worker.
	 *
	 * @param request the job; its `data` buffer is transferred once a worker takes it
	 * @param signal aborting it rejects the job with its reason, unless a worker has already taken it
	 * @returns the decoded blob, of the job's kind
	 */
	run<J extends DecodeJob>(request: J, signal: AbortSignal): Promise<Extract<Decoded, { kind: J['kind'] }>> {
		return new Promise((resolve, reject) => {
			if (signal.aborted) {
				reject(signal.reason);
				return;
			}
			if (!this.#watched.has(signal)) {
				this.#watched.add(signal);
				signal.addEventListener('abort', () => this.#dropAborted(), { once: true });
			}
			this.#queue.push({
				request,
				signal,
				// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- #settle checks the answer's kind
				resolve: resolve as (value: Decoded) => void,
				reject,
			});
			this.#post();
		});
	}

	/**
	 * jobs {@link run} can take now without waiting in the pool, so a caller that orders its own work can hand
	 * it over as late as possible
	 */
	get free(): number {
		return this.#workers.length * POSTED_PER_WORKER - this.#jobs.size - this.#queue.length;
	}

	/** terminates the workers; pending jobs never settle */
	destroy(): void {
		for (const worker of this.#workers) {
			worker.terminate();
		}
		this.#queue = [];
		this.#jobs.clear();
	}

	/** hands queued jobs to workers with room */
	#post(): void {
		while (this.#queue.length > 0) {
			let worker = 0;
			for (let i = 1; i < this.#workers.length; i++) {
				if (this.#busy[i] < this.#busy[worker]) {
					worker = i;
				}
			}
			if (this.#busy[worker] >= POSTED_PER_WORKER) {
				return;
			}
			const job = this.#queue.shift();
			if (job === undefined) {
				return;
			}
			const id = this.#nextId++;
			this.#busy[worker]++;
			this.#jobs.set(id, { kind: job.request.kind, resolve: job.resolve, reject: job.reject, worker });
			this.#workers[worker].postMessage({ ...job.request, id }, [job.request.data]);
		}
	}

	/** rejects and drops the queued jobs whose signal was aborted */
	#dropAborted(): void {
		const kept: Queued[] = [];
		for (const job of this.#queue) {
			if (job.signal.aborted) {
				job.reject(job.signal.reason);
			} else {
				kept.push(job);
			}
		}
		this.#queue = kept;
	}

	#settle(response: DecodeResponse): void {
		const job = this.#jobs.get(response.id);
		if (job === undefined) {
			return;
		}
		this.#jobs.delete(response.id);
		this.#busy[job.worker]--;
		this.#post();
		if (response.kind === 'error') {
			job.reject(new Error(response.message));
		} else if (response.kind !== job.kind) {
			job.reject(new Error(`decode worker answered a ${job.kind} job with ${response.kind}`));
		} else {
			job.resolve(response);
		}
	}
}
