/** @returns a well-mixed 32-bit hash of two 32-bit values (a PCG-style permutation) */
export const hash2 = (a: number, b: number): number => {
	let h = Math.imul(a ^ 0x9e37_79b9, 0x85eb_ca6b) ^ Math.imul(b + 0x7f4a_7c15, 0xc2b2_ae35);
	h = Math.imul(h ^ (h >>> 16), 0x7feb_352d);
	h = Math.imul(h ^ (h >>> 15), 0x846c_a68b);
	return (h ^ (h >>> 16)) >>> 0;
};

/** @returns a value in [0, 1) for one particle and one of its random channels */
export const random = (seed: number, particle: number, channel: number): number =>
	hash2(hash2(seed, particle), channel) / 4_294_967_296;

/** the random channels a particle draws from */
export const Channel = {
	Lifetime: 0,
	Speed: 1,
	Size: 2,
	RotationX: 3,
	RotationY: 4,
	RotationZ: 5,
	Gravity: 6,
	Mesh: 7,
	Shape0: 8,
	Shape1: 9,
	Shape2: 10,
	Direction0: 11,
	Direction1: 12,
	Position0: 13,
	Position1: 14,
	Position2: 15,
	VelocityX: 16,
	VelocityY: 17,
	VelocityZ: 18,
	OrbitalX: 19,
	OrbitalY: 20,
	OrbitalZ: 21,
	Radial: 22,
	SpeedModifier: 23,
	SpinX: 24,
	SpinY: 25,
	SpinZ: 26,
	SizeOverLifetime: 27,
	Burst: 28,
	SheetRow: 29,
	StartFrame: 30,
	FrameOverTime: 31,
	Color: 32,
	ColorOverLifetime: 33,
	Drag: 34,
	SpeedLimit: 35,
	SplineSpeed: 36,
	StartDelay: 37,
	ForceMultiplier: 38,
	ForceTiltX: 39,
	ForceTiltZ: 40,
	ForceDirectionX: 41,
	ForceDirectionY: 42,
	ForceDirectionZ: 43,
	ForceGravity: 44,
	ForceSpin: 45,
	ForceAttraction: 46,
	ForceDrag: 47,
	CustomX: 48,
	CustomY: 49,
	CustomZ: 50,
	CustomW: 51,
} as const;

/**
 * @param seed text to hash
 * @returns a 32-bit FNV-1a hash
 */
export const hashText = (seed: string): number => {
	let h = 0x811c_9dc5;
	for (let i = 0; i < seed.length; i++) {
		h = Math.imul(h ^ seed.charCodeAt(i), 0x0100_0193);
	}
	return h >>> 0;
};
