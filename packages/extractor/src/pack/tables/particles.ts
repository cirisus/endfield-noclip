import { createHash } from 'node:crypto';

import type { ParticleSystemInfo, ParticlesTable } from '@endfield-noclip/package-format/particles';

const fnv1a32 = (text: string): number => {
	let hash = 0x81_1c_9d_c5;
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 0x01_00_01_93);
	}
	return hash >>> 0;
};

/** the particles table, with equal systems sharing one entry */
export class ParticleTable {
	readonly #systems: ParticleSystemInfo[] = [];
	readonly #keys: string[] = [];
	readonly #ids = new Map<string, number>();

	/**
	 * @param system a particle system
	 * @returns its id; equal systems return equal ids
	 */
	intern(system: ParticleSystemInfo): number {
		return this.#ids.getOrInsertComputed(JSON.stringify(system), (json) => {
			this.#keys.push(createHash('sha256').update(json).digest('hex').slice(0, 32));
			const seedSalt =
				system.seedSalt ??
				fnv1a32(JSON.stringify({ ...system, mesh: 0, pivot: null, trail: null, seedSalt: undefined }));
			return this.#systems.push({ ...system, seedSalt }) - 1;
		});
	}

	/**
	 * @param id a system's id
	 * @returns a key naming the system by its content rather than by when it was first met
	 */
	keyOf(id: number): string {
		return this.#keys[id];
	}

	/** @returns the table as the package stores it */
	table(): ParticlesTable {
		return { systems: this.#systems };
	}
}
