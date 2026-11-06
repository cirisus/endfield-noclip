/**
 * @param x a value
 * @param lo the lower bound
 * @param hi the upper bound, at least `lo`
 * @returns `x` limited to `[lo, hi]`
 */
export const clamp = (x: number, lo: number, hi: number): number => Math.min(Math.max(x, lo), hi);
