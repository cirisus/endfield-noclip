/**
 * @param count slots in the pool
 * @returns a stack of every slot of a pool, free, that pops the lowest first
 */
export const freeSlots = (count: number): number[] => Array.from({ length: count }, (_, i) => count - 1 - i);
