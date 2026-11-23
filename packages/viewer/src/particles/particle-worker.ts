import type { ParticleSystemInfo } from '@endfield-noclip/package-format/particles';

import { ROW_WORDS } from '../content/instance-rows.ts';

import type { ParticleWorkerMessage, ParticleWorkerResponse } from './particle-protocol.ts';
import { type EmitterState, ParticleRowWriter } from './row-writer.ts';
import { ParticleSimulation } from './simulation.ts';

/** initial packed output buffer capacity in words (4096 rows ≈ 384 KiB) */
const INITIAL_OUT_WORDS = 4096 * ROW_WORDS;

/**
 * builds the particle worker's message handler, decoupled from `self` so unit tests can drive it directly
 *
 * @param post sends a result and its transferred buffers back to the main thread
 * @returns handler for incoming {@link ParticleWorkerMessage}s
 */
export const createParticleWorkerHandler = (
	post: (response: ParticleWorkerResponse, transfer: Transferable[]) => void,
): ((message: ParticleWorkerMessage) => void) => {
	const systems = new Map<number, ParticleSystemInfo>();
	const emitters = new Map<number, EmitterState>();
	const writer = new ParticleRowWriter();

	return (message: ParticleWorkerMessage): void => {
		switch (message.kind) {
			case 'system': {
				systems.set(message.system, message.info);
				break;
			}
			case 'add': {
				const info = systems.get(message.system);
				if (info === undefined) {
					break;
				}
				emitters.set(message.id, {
					simulation: new ParticleSimulation(info, message.seed),
					start: message.start,
					offset: message.offset,
					capacity: message.capacity,
					origin: message.origin,
					blockSlot: message.blockSlot,
				});
				break;
			}
			case 'remove': {
				for (let i = 0; i < message.ids.length; i++) {
					emitters.delete(message.ids[i]);
				}
				break;
			}
			case 'step': {
				const { seq, view, ids, transforms, buffer } = message;
				const n = ids.length;
				const counts = new Uint32Array(n);
				let out =
					buffer !== null && buffer.byteLength >= INITIAL_OUT_WORDS * 4
						? new Uint32Array(buffer)
						: new Uint32Array(INITIAL_OUT_WORDS);
				let offset = 0;
				for (let i = 0; i < n; i++) {
					const emitter = emitters.get(ids[i]);
					if (emitter === undefined) {
						counts[i] = 0;
						continue;
					}
					const count = writer.write(emitter, transforms, i * 12, view);
					counts[i] = count;
					const words = count * ROW_WORDS;
					if (words === 0) {
						continue;
					}
					if (offset + words > out.length) {
						let nextLength = out.length * 2;
						while (nextLength < offset + words) {
							nextLength *= 2;
						}
						const grown = new Uint32Array(nextLength);
						grown.set(out.subarray(0, offset));
						out = grown;
					}
					out.set(writer.rows.subarray(0, words), offset);
					offset += words;
				}
				const packed = out.subarray(0, offset);
				post({ kind: 'result', seq, ids, counts, rows: packed }, [ids.buffer, counts.buffer, out.buffer]);
				break;
			}
		}
	};
};

if (typeof self !== 'undefined' && typeof postMessage === 'function') {
	const handle = createParticleWorkerHandler((response, transfer) => {
		self.postMessage(response, { transfer });
	});
	self.addEventListener('message', (event: MessageEvent<ParticleWorkerMessage>) => {
		handle(event.data);
	});
}
