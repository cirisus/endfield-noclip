/**
 * procedural GPU meshes for the weather passes: quad clouds for near rain/snow and ground splashes, and a
 * unit open cylinder for middle/far rain curtains and distant rain waves
 *
 * @module
 */

/** quad count for `SceneEffectRain` and `SceneEffectSnow` */
export const SCENE_EFFECT_QUAD_COUNT = 4096;
/** quad count for `RainSplash` */
export const RAIN_SPLASH_QUAD_COUNT = 1024;

const FAR_RAIN_RADIAL_SEGMENTS = 32;
const FAR_RAIN_HEIGHT_SEGMENTS = 12;

/** deterministic xorshift32 PRNG returning values in [0, 1) */
const makeRng = (seed: number): (() => number) => {
	let s = seed >>> 0 || 1;
	return () => {
		s ^= s << 13;
		s ^= s >>> 17;
		s ^= s << 5;
		return (s >>> 0) / 4294967296;
	};
};

/** one procedural weather mesh's GPU buffers */
export interface WeatherMesh {
	readonly vertex: GPUBuffer;
	readonly index: GPUBuffer;
	readonly indexCount: number;
	readonly bytes: number;
}

const uploadMesh = (
	device: GPUDevice,
	label: string,
	vertices: Float32Array,
	indices: Uint16Array,
): WeatherMesh => {
	const vertex = device.createBuffer({
		label: `${label} vertices`,
		size: vertices.byteLength,
		usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
	});
	device.queue.writeBuffer(vertex, 0, vertices.buffer, vertices.byteOffset, vertices.byteLength);
	const index = device.createBuffer({
		label: `${label} indices`,
		size: indices.byteLength,
		usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
	});
	device.queue.writeBuffer(index, 0, indices.buffer, indices.byteOffset, indices.byteLength);
	return {
		vertex,
		index,
		indexCount: indices.length,
		bytes: vertices.byteLength + indices.byteLength,
	};
};

const CORNERS: readonly (readonly [number, number])[] = [
	[-1, -1],
	[1, -1],
	[1, 1],
	[-1, 1],
];

/**
 * builds the 4096-quad volumetric cloud used by `SceneEffectRain` and `SceneEffectSnow`. vertex layout (32
 * bytes): `center: vec3f`, `corner: vec2f`, `rand: vec3f`.
 *
 * @param device the device
 * @returns uploaded vertex/index buffers
 */
export const createSceneEffectMesh = (device: GPUDevice): WeatherMesh => {
	const rng = makeRng(0x5241494e);
	const vertices = new Float32Array(SCENE_EFFECT_QUAD_COUNT * 4 * 8);
	const indices = new Uint16Array(SCENE_EFFECT_QUAD_COUNT * 6);
	let v = 0;
	let idx = 0;
	for (let i = 0; i < SCENE_EFFECT_QUAD_COUNT; i++) {
		const cx = rng() * 2 - 1;
		const cy = rng() * 2 - 1;
		const cz = rng() * 2 - 1;
		const r0 = rng();
		// stratify r1 so intensity thresholds drop/add quads uniformly across the volume
		const r1 = (i + rng()) / SCENE_EFFECT_QUAD_COUNT;
		const r2 = rng();
		const base = i * 4;
		for (const [sx, sy] of CORNERS) {
			vertices[v++] = cx;
			vertices[v++] = cy;
			vertices[v++] = cz;
			vertices[v++] = sx;
			vertices[v++] = sy;
			vertices[v++] = r0;
			vertices[v++] = r1;
			vertices[v++] = r2;
		}
		indices[idx++] = base;
		indices[idx++] = base + 1;
		indices[idx++] = base + 2;
		indices[idx++] = base;
		indices[idx++] = base + 2;
		indices[idx++] = base + 3;
	}
	return uploadMesh(device, 'weather scene effect', vertices, indices);
};

/**
 * builds the 1024-quad ground splash cloud used by `RainSplash`. vertex layout (24 bytes): `center: vec2f`,
 * `corner: vec2f`, `rand: vec2f`.
 *
 * @param device the device
 * @returns uploaded vertex/index buffers
 */
export const createRainSplashMesh = (device: GPUDevice): WeatherMesh => {
	const rng = makeRng(0x53504c41);
	const vertices = new Float32Array(RAIN_SPLASH_QUAD_COUNT * 4 * 6);
	const indices = new Uint16Array(RAIN_SPLASH_QUAD_COUNT * 6);
	let v = 0;
	let idx = 0;
	for (let i = 0; i < RAIN_SPLASH_QUAD_COUNT; i++) {
		const cx = rng() - 0.5;
		const cz = rng() - 0.5;
		const r0 = (i + rng()) / RAIN_SPLASH_QUAD_COUNT;
		const r1 = rng();
		const base = i * 4;
		for (const [sx, sy] of CORNERS) {
			vertices[v++] = cx;
			vertices[v++] = cz;
			vertices[v++] = sx;
			vertices[v++] = sy;
			vertices[v++] = r0;
			vertices[v++] = r1;
		}
		indices[idx++] = base;
		indices[idx++] = base + 1;
		indices[idx++] = base + 2;
		indices[idx++] = base;
		indices[idx++] = base + 2;
		indices[idx++] = base + 3;
	}
	return uploadMesh(device, 'weather rain splash', vertices, indices);
};

/**
 * builds the unit open cylinder (`radius = 1`, `y ∈ [-1, 1]`) used by middle rain, far rain, and rain wave.
 * vertex layout (20 bytes): `pos: vec3f`, `uv: vec2f`.
 *
 * @param device the device
 * @returns uploaded vertex/index buffers
 */
export const createFarRainMesh = (device: GPUDevice): WeatherMesh => {
	const cols = FAR_RAIN_RADIAL_SEGMENTS;
	const rows = FAR_RAIN_HEIGHT_SEGMENTS;
	const vertices = new Float32Array((cols + 1) * (rows + 1) * 5);
	const indices = new Uint16Array(cols * rows * 6);
	let v = 0;
	for (let r = 0; r <= rows; r++) {
		const ty = r / rows;
		const y = ty * 2 - 1;
		for (let c = 0; c <= cols; c++) {
			const tx = c / cols;
			const angle = tx * Math.PI * 2;
			vertices[v++] = Math.cos(angle);
			vertices[v++] = y;
			vertices[v++] = Math.sin(angle);
			vertices[v++] = tx;
			vertices[v++] = ty;
		}
	}
	let idx = 0;
	const stride = cols + 1;
	for (let r = 0; r < rows; r++) {
		for (let c = 0; c < cols; c++) {
			const a = r * stride + c;
			const b = a + 1;
			const d = a + stride;
			const e = d + 1;
			indices[idx++] = a;
			indices[idx++] = b;
			indices[idx++] = e;
			indices[idx++] = a;
			indices[idx++] = e;
			indices[idx++] = d;
		}
	}
	return uploadMesh(device, 'weather far rain', vertices, indices);
};
