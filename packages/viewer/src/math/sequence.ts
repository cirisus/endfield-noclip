/**
 * @param index the element, from 1
 * @param base the sequence's base, a prime
 * @returns element `index` of the Halton sequence in `base`, in [0, 1)
 */
export const halton = (index: number, base: number): number => {
	let result = 0;
	let fraction = 1 / base;
	for (let i = index; i > 0; i = Math.floor(i / base)) {
		result += (i % base) * fraction;
		fraction /= base;
	}
	return result;
};
