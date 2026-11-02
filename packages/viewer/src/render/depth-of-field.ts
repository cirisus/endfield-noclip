import { HDR_FORMAT } from '../gfx/render-targets.ts';
import type { Camera, Vec3 } from '../scene/camera.ts';

import { focusCoefficients } from './depth-of-field-optics.ts';
import depthOfFieldWgsl from './shaders/depth-of-field.wgsl?raw';

/** camera-local photography settings; changing them does not modify an environment profile */
export interface FocusSettings {
	aperture: number;
	focusDistance: number;
	/** maximum foreground/background radii at a 1440-pixel render height */
	nearRadius: number;
	farRadius: number;
	temporalFactor: number;
}

const UNIFORM_BYTES = 224;
const BINDINGS = {
	coc: [0, 7, 8, 9],
	downsample: [0, 1, 2, 3, 4, 5, 7, 8, 9, 10],
	tile: [0, 1, 2, 9],
	tile_blur: [0, 1, 2, 9],
	near_x: [0, 1, 2, 3, 4, 9, 10],
	near_y: [0, 1, 2, 3, 4, 9],
	alpha_x: [0, 1, 2, 9],
	alpha_y: [0, 1, 2, 3, 9],
	far_y: [0, 1, 2, 3, 9, 10, 11],
	far_x: [0, 1, 2, 3, 4, 5, 6, 9],
	composite: [0, 1, 2, 3, 4, 5, 9],
} as const;
type Stage = keyof typeof BINDINGS;
interface Pass {
	stage: Stage;
	group: GPUBindGroup;
	width: number;
	height: number;
}
interface Sized {
	width: number;
	height: number;
	lowWidth: number;
	lowHeight: number;
	tileWidth: number;
	tileHeight: number;
	scene: GPUTexture;
	depth: GPUTextureView;
	waterDepth: GPUTextureView;
	textures: GPUTexture[];
	output: GPUTexture;
	passes: [Pass[], Pass[]];
}

/** owns the high-quality circular depth-of-field passes and their private temporal history */
export class DepthOfField {
	#device: GPUDevice;
	#uniforms: GPUBuffer;
	#data = new Float32Array(UNIFORM_BYTES / 4);
	#sampler: GPUSampler;
	#pipelines = new Map<string, GPUComputePipeline>();
	#sized: Sized | null = null;
	#index = 0;
	#valid = false;
	#previousViewProj = new Float32Array(16);
	#previousEye: Vec3 = [0, 0, 0];
	#previousLens = '';

	/** @param device the viewer's GPU device */
	constructor(device: GPUDevice) {
		this.#device = device;
		this.#uniforms = device.createBuffer({
			label: 'depth of field uniforms',
			size: UNIFORM_BYTES,
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
		});
		this.#sampler = device.createSampler({
			label: 'depth of field bilinear',
			magFilter: 'linear',
			minFilter: 'linear',
			addressModeU: 'clamp-to-edge',
			addressModeV: 'clamp-to-edge',
		});
		const module = device.createShaderModule({ label: 'depth of field', code: depthOfFieldWgsl });
		for (const stage of Object.keys(BINDINGS)) {
			this.#pipelines.set(
				stage,
				device.createComputePipeline({
					label: `depth of field ${stage}`,
					layout: 'auto',
					compute: { module, entryPoint: `cs_${stage}` },
				}),
			);
		}
	}

	/** @returns memory occupied by the effect's render targets */
	get bytes(): number {
		return this.#sized?.textures.reduce((sum, texture) => sum + texture.width * texture.height * 8, 0) ?? 0;
	}

	/** discards temporal samples after a camera cut, scene switch or an interval with the effect disabled */
	reset(): void {
		this.#valid = false;
	}

	/** releases targets while photography is disabled */
	release(): void {
		for (const texture of this.#sized?.textures ?? []) {
			texture.destroy();
		}
		this.#sized = null;
		this.reset();
	}

	#resize(scene: GPUTexture, depth: GPUTextureView, waterDepth: GPUTextureView): Sized {
		const old = this.#sized;
		if (old !== null && old.scene === scene && old.depth === depth && old.waterDepth === waterDepth) {
			return old;
		}
		this.release();
		const device = this.#device;
		const { width, height } = scene;
		const lowWidth = width;
		const lowHeight = height;
		const tileWidth = Math.max(1, Math.ceil(width / 8));
		const tileHeight = Math.max(1, Math.ceil(height / 8));
		const textures: GPUTexture[] = [];
		const texture = (label: string, w = lowWidth, h = lowHeight): GPUTexture => {
			const result = device.createTexture({
				label: `depth of field ${label}`,
				size: [w, h],
				format: HDR_FORMAT,
				usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC,
			});
			textures.push(result);
			return result;
		};
		const coc = texture('signed radius', width, height);
		const colors = [texture('colour 0'), texture('colour 1')];
		const radii = [texture('radius 0'), texture('radius 1')];
		const tile = texture('tiles', tileWidth, tileHeight);
		const tileBlur = texture('smooth tiles', tileWidth, tileHeight);
		const nearReal = texture('near real');
		const nearImaginary = texture('near imaginary');
		const nearRaw = texture('near unfiltered coverage');
		const alpha = texture('near coverage');
		const near = texture('near');
		const farRed = texture('far red');
		const farGreen = texture('far green');
		const farBlue = texture('far blue');
		const far = texture('far');
		const output = texture('composite', width, height);
		const views = new Map<GPUTexture, GPUTextureView>();
		for (const value of [scene, ...textures]) {
			views.set(value, value.createView());
		}
		const pass = (stage: Stage, sources: GPUTexture[], outputs: GPUTexture[]): Pass => {
			const resources = new Map<number, GPUBindingResource>([
				[0, { buffer: this.#uniforms }],
				[1, this.#sampler],
				[7, depth],
				[8, waterDepth],
			]);
			sources.forEach((value, i) => resources.set(i + 2, views.get(value)!));
			outputs.forEach((value, i) => resources.set(i + 9, views.get(value)!));
			return {
				stage,
				width: outputs[0].width,
				height: outputs[0].height,
				group: device.createBindGroup({
					label: `depth of field ${stage}`,
					layout: this.#pipelines.get(stage)!.getBindGroupLayout(0),
					entries: BINDINGS[stage].map((binding) => ({ binding, resource: resources.get(binding)! })),
				}),
			};
		};
		const passes = (i: number): Pass[] => [
			pass('coc', [], [coc]),
			pass('downsample', [coc, scene, colors[1 - i], radii[1 - i]], [radii[i], colors[i]]),
			pass('tile', [radii[i]], [tile]),
			pass('tile_blur', [tile], [tileBlur]),
			pass('near_x', [tileBlur, colors[i], radii[i]], [nearReal, nearImaginary]),
			pass('near_y', [tileBlur, nearReal, nearImaginary], [nearRaw]),
			pass('alpha_x', [nearRaw], [alpha]),
			pass('alpha_y', [alpha, nearRaw], [near]),
			pass('far_y', [radii[i], colors[i]], [farRed, farGreen, farBlue]),
			pass('far_x', [radii[i], colors[i], farRed, farGreen, farBlue], [far]),
			pass('composite', [scene, coc, near, far], [output]),
		];
		this.#sized = {
			width,
			height,
			lowWidth,
			lowHeight,
			tileWidth,
			tileHeight,
			scene,
			depth,
			waterDepth,
			textures,
			output,
			passes: [passes(0), passes(1)],
		};
		return this.#sized;
	}

	/**
	 * writes the focused HDR scene back into `scene`. it must allow copying into it. the two depth views use
	 * the same render size and reversed infinite projection; water must be zero where absent.
	 *
	 * @param encoder this frame's encoder
	 * @param input camera, validated photography settings and this frame's render targets
	 */
	encode(
		encoder: GPUCommandEncoder,
		input: {
			camera: Camera;
			jitter: readonly [number, number];
			settings: FocusSettings;
			scene: GPUTexture;
			depth: GPUTextureView;
			waterDepth: GPUTextureView;
		},
	): void {
		const { camera, jitter, settings, scene, depth, waterDepth } = input;
		const sized = this.#resize(scene, depth, waterDepth);
		const { width, height, lowWidth, lowHeight, tileWidth, tileHeight } = sized;
		// the viewer's focal-length readout fixes the sensor height at 24 mm. fitting that same sensor
		// vertically preserves framing on any aspect ratio, instead of changing FOV when enabling DoF.
		const coefficients = focusCoefficients({
			focalLength: camera.focalLength,
			aperture: settings.aperture,
			focusDistance: settings.focusDistance,
			sensorSpan: 24,
			pixels: height,
			near: camera.near,
			far: Infinity,
		});
		const lens = `${camera.fovY}/${settings.aperture}/${settings.focusDistance}/${settings.nearRadius}/${settings.farRadius}/${settings.temporalFactor}`;
		if (lens !== this.#previousLens) {
			this.reset();
		}
		const data = this.#data;
		data.set([width, height, 1 / width, 1 / height], 0);
		data.set([lowWidth, lowHeight, 1 / lowWidth, 1 / lowHeight], 4);
		data.set([tileWidth, tileHeight, 1 / tileWidth, 1 / tileHeight], 8);
		data.set(
			[
				coefficients.offset,
				coefficients.scale,
				(settings.nearRadius * height) / 1440,
				(settings.farRadius * height) / 1440,
			],
			12,
		);
		data.set(
			[
				Number(this.#valid),
				// the effect uses this rounded exponent, rather than Euler's constant.
				// oxlint-disable-next-line approx-constant
				(2 * Math.min(1, Math.max(0.1, settings.temporalFactor))) ** 2.718,
				camera.near,
				0,
			],
			16,
		);
		data.set(camera.forward(), 20);
		const tangent = Math.tan(camera.fovY / 2);
		data.set(
			camera.right().map((v) => (v * tangent * width) / height),
			24,
		);
		data.set(
			camera.up().map((v) => v * tangent),
			28,
		);
		data.set(
			camera.position.map((v, i) => v - this.#previousEye[i]),
			32,
		);
		data.set(this.#previousViewProj, 36);
		data.set(jitter, 52);
		this.#device.queue.writeBuffer(this.#uniforms, 0, data);
		for (const pass of sized.passes[this.#index]) {
			const compute = encoder.beginComputePass({ label: `depth of field ${pass.stage}` });
			compute.setPipeline(this.#pipelines.get(pass.stage)!);
			compute.setBindGroup(0, pass.group);
			compute.dispatchWorkgroups(Math.ceil(pass.width / 8), Math.ceil(pass.height / 8));
			compute.end();
		}
		encoder.copyTextureToTexture({ texture: sized.output }, { texture: scene }, [width, height]);
		camera.writeViewProjection(width / height, this.#previousViewProj);
		for (let column = 0; column < 4; column++) {
			const w = this.#previousViewProj[column * 4 + 3];
			this.#previousViewProj[column * 4] += jitter[0] * w;
			this.#previousViewProj[column * 4 + 1] += jitter[1] * w;
		}
		this.#previousEye = [...camera.position];
		this.#previousLens = lens;
		this.#valid = true;
		this.#index = 1 - this.#index;
	}

	/** frees all resources owned by the effect */
	destroy(): void {
		this.release();
		this.#uniforms.destroy();
	}
}
