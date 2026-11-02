import type { PhotoEffect, PhotoFilter } from '@endfield-noclip/package-format/photo-filters';
import { textureLevelLayout } from '@endfield-noclip/package-format/textures';

import { HDR_FORMAT } from '../gfx/render-targets.ts';
import type { Camera, Vec3 } from '../scene/camera.ts';

import { hashText, PARTICLE_FLOATS, ParticleSimulation } from './particles.ts';
import shader from './shaders/photo-particles.wgsl?raw';

const CAPACITY = 1024;
const ROW_FLOATS = 16;

interface Anchor {
	position: Vec3;
	right: Vec3;
	up: Vec3;
	forward: Vec3;
	start: number;
}

interface Emitter {
	effect: PhotoEffect;
	simulation: ParticleSimulation;
	texture: GPUTexture;
	buffer: GPUBuffer;
	sampler: GPUSampler;
	group: GPUBindGroup | null;
	depth: GPUTextureView | null;
}

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** additive photo emitters anchored at the camera's pose on their first selection */
export class PhotoParticles {
	#device: GPUDevice;
	#pipeline: GPURenderPipeline;
	#emitters: Emitter[] = [];
	#anchors = new WeakMap<PhotoFilter, Anchor>();
	#anchor: Anchor | null = null;
	#scratch = new Float32Array(CAPACITY * PARTICLE_FLOATS);
	#rows = new Float32Array(CAPACITY * ROW_FLOATS);

	/** @param device WebGPU device */
	constructor(device: GPUDevice) {
		this.#device = device;
		const module = device.createShaderModule({ label: 'photo particles', code: shader });
		const add: GPUBlendComponent = { srcFactor: 'one', dstFactor: 'one', operation: 'add' };
		this.#pipeline = device.createRenderPipeline({
			label: 'photo particles',
			layout: 'auto',
			vertex: { module, entryPoint: 'vs_particle' },
			fragment: {
				module,
				entryPoint: 'fs_particle',
				targets: [
					{
						format: HDR_FORMAT,
						blend: { color: add, alpha: add },
						writeMask: GPUColorWrite.RED | GPUColorWrite.GREEN | GPUColorWrite.BLUE,
					},
				],
			},
			primitive: { topology: 'triangle-strip' },
		});
	}

	/** @returns whether the selected photo look needs animation frames */
	get active(): boolean {
		return this.#emitters.length > 0;
	}

	/**
	 * @param filter selected look, or null to release its GPU resources
	 * @param camera the spawn pose; selecting an existing look resumes its original anchor and clock
	 */
	set(filter: PhotoFilter | null, camera: Camera): void {
		const effects = filter?.effects ?? [];
		if (effects.length && !this.#device.features.has('texture-compression-bc')) {
			throw new Error('photo particles require BC texture support');
		}
		this.#release();
		if (filter === null || effects.length === 0) {
			this.#anchor = null;
			return;
		}
		let anchor = this.#anchors.get(filter);
		if (!anchor) {
			anchor = {
				position: [...camera.position],
				right: camera.right(),
				up: camera.up(),
				forward: camera.forward(),
				start: performance.now() / 1000,
			};
			this.#anchors.set(filter, anchor);
		}
		this.#anchor = anchor;
		for (const effect of effects) {
			const source = effect.texture;
			const texture = this.#device.createTexture({
				size: [source.width, source.height],
				format: source.format,
				mipLevelCount: source.levels.length,
				usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
			});
			for (const [level, data] of source.levels.entries()) {
				const layout = textureLevelLayout({ ...source, kind: '2d', depthOrArrayLayers: 1 }, level);
				this.#device.queue.writeTexture({ texture, mipLevel: level }, Uint8Array.fromBase64(data), layout, [
					layout.width,
					layout.height,
				]);
			}
			this.#emitters.push({
				effect,
				simulation: new ParticleSimulation(
					{ ...effect.particles, speedLimit: null },
					hashText(`${filter.id}/${effect.name}`),
				),
				texture,
				buffer: this.#device.createBuffer({
					size: this.#rows.byteLength,
					usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
				}),
				sampler: this.#device.createSampler(source.sampler),
				group: null,
				depth: null,
			});
		}
	}

	/**
	 * @param encoder current frame encoder
	 * @param input HDR target, opaque depth and current camera/exposure
	 */
	encode(
		encoder: GPUCommandEncoder,
		input: {
			target: GPUTextureView;
			depth: GPUTextureView;
			camera: Camera;
			aspect: number;
			exposure: number;
		},
	): void {
		const anchor = this.#anchor;
		if (!anchor || !this.active) {
			return;
		}
		const { camera } = input;
		const right = camera.right(),
			up = camera.up(),
			forward = camera.forward();
		const f = 1 / Math.tan(camera.fovY / 2);
		const elapsed = performance.now() / 1000 - anchor.start;
		for (const emitter of this.#emitters) {
			const { effect, simulation } = emitter;
			const m = effect.matrix;
			const local: Vec3 = [0, 0, 0];
			const relative: Vec3 = [0, 0, 0];
			const scale = effect.particles.shapeScaling ? 1 : Math.hypot(m[0], m[1], m[2]);
			const exposure = effect.ignorePostExposure ? 1 / Math.max(input.exposure, 1e-6) : 1;
			const tiles = effect.particles.textureSheet?.tiles ?? [1, 1];
			const count = simulation.evaluate(
				elapsed * effect.particles.simulationSpeed,
				[0, -1, 0],
				(v) => v,
				this.#scratch,
			);
			let visible = 0;
			for (let i = 0; i < count; i++) {
				const at = i * PARTICLE_FLOATS;
				const p = this.#scratch;
				for (let axis = 0; axis < 3; axis++) {
					local[axis] = m[12 + axis] + m[axis] * p[at] + m[4 + axis] * p[at + 1] + m[8 + axis] * p[at + 2];
				}
				for (let axis = 0; axis < 3; axis++) {
					relative[axis] =
						anchor.position[axis] -
						camera.position[axis] +
						anchor.right[axis] * local[0] +
						anchor.up[axis] * local[1] +
						anchor.forward[axis] * local[2];
				}
				const depth = dot(relative, forward);
				if (depth < camera.near) {
					continue;
				}
				const row = visible++ * ROW_FLOATS;
				this.#rows.set(
					[(f / input.aspect) * dot(relative, right), f * dot(relative, up), camera.near, depth],
					row,
				);
				const qx = p[at + 3],
					qy = p[at + 4],
					qz = p[at + 5],
					qw = p[at + 6];
				const roll = Math.atan2(2 * (qw * qz + qx * qy), 1 - 2 * (qy * qy + qz * qz));
				const x = (p[at + 7] * scale) / 2;
				const y = (p[at + 8] * scale) / 2;
				const c = Math.cos(roll),
					s = Math.sin(roll);
				this.#rows.set(
					[(f / input.aspect) * x * c, f * x * s, -(f / input.aspect) * y * s, f * y * c],
					row + 4,
				);
				this.#rows.set(
					[
						p[at + 11] * effect.tint[0] * exposure,
						p[at + 12] * effect.tint[1] * exposure,
						p[at + 13] * effect.tint[2] * exposure,
						p[at + 14] * effect.tint[3],
					],
					row + 8,
				);
				const tile = p[at + 10];
				this.#rows.set(
					[
						(tile % tiles[0]) / tiles[0],
						1 - (Math.floor(tile / tiles[0]) + 1) / tiles[1],
						1 / tiles[0],
						1 / tiles[1],
					],
					row + 12,
				);
			}
			if (visible === 0) {
				continue;
			}
			this.#device.queue.writeBuffer(emitter.buffer, 0, this.#rows, 0, visible * ROW_FLOATS);
			if (emitter.depth !== input.depth) {
				emitter.group = this.#device.createBindGroup({
					layout: this.#pipeline.getBindGroupLayout(0),
					entries: [
						{ binding: 0, resource: { buffer: emitter.buffer } },
						{ binding: 1, resource: emitter.texture.createView() },
						{ binding: 2, resource: emitter.sampler },
						{ binding: 3, resource: input.depth },
					],
				});
				emitter.depth = input.depth;
			}
			const pass = encoder.beginRenderPass({
				label: 'photo particles',
				colorAttachments: [{ view: input.target, loadOp: 'load', storeOp: 'store' }],
			});
			pass.setPipeline(this.#pipeline);
			pass.setBindGroup(0, emitter.group);
			pass.draw(4, visible);
			pass.end();
		}
	}

	#release(): void {
		for (const emitter of this.#emitters) {
			emitter.texture.destroy();
			emitter.buffer.destroy();
		}
		this.#emitters = [];
	}

	/** frees selected emitter resources */
	destroy(): void {
		this.#release();
	}
}
