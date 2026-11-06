/**
 * @param name the constant's WGSL name
 * @param type its WGSL type
 * @param value its value; for `i32` and `u32`, an integer in range
 * @returns a typed WGSL constant declaration, for sharing a TS constant with a shader
 */
export const wgslConst = (name: string, type: 'i32' | 'u32' | 'f32', value: number): string =>
	'const ' + name + ': ' + type + ' = ' + String(value) + ';';
