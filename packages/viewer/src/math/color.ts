import type { Color, Vec3 } from '@endfield-noclip/package-format/values';

const SRGB_LUT_SIZE = 256;
const srgbLut = new Float32Array(SRGB_LUT_SIZE + 1);
for (let i = 0; i <= SRGB_LUT_SIZE; i++) {
	const c = i / SRGB_LUT_SIZE;
	srgbLut[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/**
 * converts a sRGB-encoded colour channel (Unity colour fields) to linear
 *
 * @param c channel value
 * @returns the linear value
 */
export const srgbToLinear = (c: number): number => {
	if (c <= 0.04045) {
		return c / 12.92;
	}
	// HDR values: like Unity's `Mathf.GammaToLinearSpace`, a plain 2.2 power past 1
	if (c >= 1) {
		return c ** 2.2;
	}
	const x = c * SRGB_LUT_SIZE;
	const i = x | 0;
	const f = x - i;
	const a = srgbLut[i];
	return a + (srgbLut[i + 1] - a) * f;
};

/**
 * @param c a sRGB-encoded colour (alpha ignored)
 * @returns its linear rgb
 */
export const linearRgb = (c: Readonly<Color>): Vec3 => [
	srgbToLinear(c[0]),
	srgbToLinear(c[1]),
	srgbToLinear(c[2]),
];

/**
 * @param c a linear rgb colour
 * @returns its Rec.709 luminance
 */
export const rec709Luminance = (c: Readonly<Vec3>): number =>
	c[0] * 0.2126729 + c[1] * 0.7151522 + c[2] * 0.072175;
