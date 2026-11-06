interface Entry {
	/** the parts the group was built from */
	parts: unknown[];
	group: GPUBindGroup;
}

/**
 * bind groups by key, each rebuilt when any of the parts it was built from (views, buffers, binding versions)
 * changes identity
 */
export class BindGroupCache<K> {
	#entries = new Map<K, Entry>();

	/**
	 * @param key which group
	 * @param parts what the group is built from, compared by identity with the parts of the cached group; may
	 *   be a scratch array the caller reuses, since it's copied when kept
	 * @param create builds the group from the current parts; called only when they changed
	 * @returns the group for these parts
	 */
	get(key: K, parts: readonly unknown[], create: () => GPUBindGroup): GPUBindGroup {
		const cached = this.#entries.get(key);
		if (
			cached !== undefined &&
			cached.parts.length === parts.length &&
			cached.parts.every((part, i) => part === parts[i])
		) {
			return cached.group;
		}
		const group = create();
		this.#entries.set(key, { parts: [...parts], group });
		return group;
	}

	/** forgets every group */
	clear(): void {
		this.#entries.clear();
	}
}
