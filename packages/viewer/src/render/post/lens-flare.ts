import type { Vec2 } from '@endfield-noclip/package-format/values';

import { type LensFlareLook, lensFlareTextures } from '../../environment/lens-flare-look.ts';
import { ADD, ALPHA_OVER, PREMULTIPLIED_OVER } from '../../gfx/blend.ts';
import { createUniformBuffer } from '../../gfx/buffers.ts';
import { placeholder } from '../../gfx/placeholders.ts';
import { LINEAR_CLAMP_MIPMAPPED, sampler } from '../../gfx/samplers.ts';
import type { Camera } from '../../scene/camera.ts';
import type { StreamedTexture } from '../../streaming/texture-requests.ts';
import { HDR_FORMAT, type SceneTextures } from '../frame/render-targets.ts';

import { flareQuads } from './lens-flare-layout.ts';
import lensFlareWgsl from './lens-flare.wgsl?raw';

/** byte size of `FlareFrame` in lens-flare.wgsl */
const FRAME_BYTES = 16;
/** floats per quad in the storage buffer */
const QUAD_FLOATS = 16;
/** the most quads a frame draws */
const MAX_QUADS = 256;
/** SRP core's celestial occlusion radius: a multiple of this angle's tangent at the sun's distance */
const CELESTIAL_OCCLUSION = Math.tan(0.0576);

/** per element blend mode: additive, screen, premultiplied, lerp */
const BLENDS: GPUBlendComponent[] = [
	ADD,
	{ srcFactor: 'one', dstFactor: 'one-minus-src', operation: 'add' },
	PREMULTIPLIED_OVER,
	ALPHA_OVER,
];

/** owns the flare's pipelines, quad buffer and texture bindings */
export class LensFlares {
	#device: GPUDevice;
	#frame: GPUBuffer;
	#frameData = new Float32Array(FRAME_BYTES / 4);
	#quads: GPUBuffer;
	#data = new Float32Array(MAX_QUADS * QUAD_FLOATS);
	#sampler: GPUSampler;
	#frameLayout: GPUBindGroupLayout;
	#textureLayout: GPUBindGroupLayout;
	/** group 1 for circles, which sample nothing */
	#blankGroup: GPUBindGroup;
	/** per shape, per blend mode */
	#pipelines: Record<'image' | 'circle', GPURenderPipeline[]>;
	#look: LensFlareLook | null = null;
	/** the texture-table ids the look's images sample */
	#textureIds: number[] = [];
	/** each id's streamed texture, once requested */
	#textures = new Map<number, StreamedTexture>();
	/** per bound view, its group 1; kept for the views in use */
	#textureGroups = new Map<GPUTextureView, GPUBindGroup>();
	/** this frame's draws: each quad's pipeline and group 1 */
	#drawPipelines: GPURenderPipeline[] = [];
	#drawGroups: GPUBindGroup[] = [];
	/** the frame group and the scene the flare draws onto, once sized */
	#sized: { frame: GPUBindGroup; target: GPUTextureView } | null = null;

	/** @param device the device */
	constructor(device: GPUDevice) {
		this.#device = device;
		const module = device.createShaderModule({ label: 'lens flare', code: lensFlareWgsl });
		const visibility = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;
		this.#frameLayout = device.createBindGroupLayout({
			label: 'lens flare frame',
			entries: [
				{ binding: 0, visibility, buffer: { type: 'uniform' } },
				{ binding: 1, visibility, buffer: { type: 'read-only-storage' } },
				{ binding: 2, visibility: GPUShaderStage.VERTEX, texture: { sampleType: 'depth' } },
			],
		});
		this.#textureLayout = device.createBindGroupLayout({
			label: 'lens flare texture',
			entries: [
				{ binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
				{ binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
			],
		});
		const layout = device.createPipelineLayout({
			label: 'lens flare',
			bindGroupLayouts: [this.#frameLayout, this.#textureLayout],
		});
		const pipelines = (shape: 'image' | 'circle'): GPURenderPipeline[] =>
			BLENDS.map((blend, blendMode) =>
				device.createRenderPipeline({
					label: `lens flare ${shape}/${blendMode}`,
					layout,
					vertex: { module, entryPoint: 'vs_flare' },
					fragment: {
						module,
						entryPoint: shape === 'image' ? 'fs_image' : 'fs_circle',
						targets: [
							{
								format: HDR_FORMAT,
								blend: { color: blend, alpha: blend },
								writeMask: GPUColorWrite.RED | GPUColorWrite.GREEN | GPUColorWrite.BLUE,
							},
						],
					},
					primitive: { topology: 'triangle-strip' },
				}),
			);
		this.#pipelines = { image: pipelines('image'), circle: pipelines('circle') };
		this.#frame = createUniformBuffer(device, 'lens flare frame', FRAME_BYTES);
		this.#quads = device.createBuffer({
			label: 'lens flare quads',
			size: this.#data.byteLength,
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
		});
		this.#sampler = sampler(device, LINEAR_CLAMP_MIPMAPPED);
		this.#blankGroup = this.#textureGroup(placeholder(device, 'black', '2d'));
	}

	#textureGroup(view: GPUTextureView): GPUBindGroup {
		return this.#device.createBindGroup({
			label: 'lens flare texture',
			layout: this.#textureLayout,
			entries: [
				{ binding: 0, resource: view },
				{ binding: 1, resource: this.#sampler },
			],
		});
	}

	/** @param look the flare, or `null` for none */
	setLook(look: LensFlareLook | null): void {
		this.#look = look;
		this.#textureIds = lensFlareTextures(look);
		this.#textures.clear();
	}

	/**
	 * binds the image textures as they stream in; an element whose texture isn't resident yet doesn't draw
	 *
	 * @param lookup gives each texture-table id's streamed texture, or `null`
	 */
	setTextures(lookup: (texture: number) => StreamedTexture | null): void {
		const groups = this.#textureGroups;
		let views = 0;
		for (const id of this.#textureIds) {
			const streamed = lookup(id);
			if (streamed === null) {
				this.#textures.delete(id);
				continue;
			}
			this.#textures.set(id, streamed);
			const view = streamed.binding?.view;
			if (view !== undefined) {
				views++;
				if (!groups.has(view)) {
					groups.set(view, this.#textureGroup(view));
				}
			}
		}
		// forget the groups of views no longer bound, once there are more groups than views in use
		if (groups.size > views) {
			const bound = new Set<GPUTextureView | undefined>();
			for (const streamed of this.#textures.values()) {
				bound.add(streamed.binding?.view);
			}
			for (const view of groups.keys()) {
				if (!bound.has(view)) {
					groups.delete(view);
				}
			}
		}
	}

	/**
	 * points the pass at new render targets
	 *
	 * @param input the main pass's textures and the composited scene the flare draws onto
	 */
	resize(input: { scene: SceneTextures; composited: GPUTextureView }): void {
		this.#sized = {
			target: input.composited,
			frame: this.#device.createBindGroup({
				label: 'lens flare frame',
				layout: this.#frameLayout,
				entries: [
					{ binding: 0, resource: { buffer: this.#frame } },
					{ binding: 1, resource: { buffer: this.#quads } },
					{ binding: 2, resource: input.scene.depth },
				],
			}),
		};
	}

	/**
	 * draws this frame's flare onto the composited scene, when the look has one and the sun is in front of the
	 * camera
	 *
	 * @param encoder this frame's encoder, after the light shafts and before temporal antialiasing
	 * @param input the camera (unjittered) and the render size
	 */
	encode(encoder: GPUCommandEncoder, input: { camera: Camera; width: number; height: number }): void {
		const sized = this.#sized;
		if (sized === null) {
			throw new Error('lens flare used before resize()');
		}
		const look = this.#look;
		if (look === null) {
			return;
		}
		const { camera, width, height } = input;
		const aspect = width / height;
		const sun = camera.projectDirection(look.direction, aspect);
		if (sun === null) {
			return;
		}
		const screen: Vec2 = [sun[0] * 2 - 1, sun[1] * 2 - 1];
		if (!look.allowOffScreen && (Math.abs(screen[0]) > 1 || Math.abs(screen[1]) > 1)) {
			return;
		}
		const quads = flareQuads(look, screen, aspect, (id) => {
			const entry = this.#textures.get(id)?.entry;
			return entry === undefined ? 1 : entry.height / entry.width;
		});
		// quads whose image hasn't streamed in yet don't draw
		const f = this.#data;
		let count = 0;
		for (const quad of quads) {
			if (count === MAX_QUADS) {
				break;
			}
			let group: GPUBindGroup | undefined = this.#blankGroup;
			if (quad.texture !== null) {
				const view = this.#textures.get(quad.texture)?.binding?.view;
				group = view === undefined ? undefined : this.#textureGroups.get(view);
			}
			if (group === undefined) {
				continue;
			}
			const o = count * QUAD_FLOATS;
			f.set(quad.data0, o);
			f.set(quad.data2, o + 4);
			f.set(quad.color, o + 8);
			f.set(quad.data3, o + 12);
			const pipelines = this.#pipelines[quad.texture === null ? 'circle' : 'image'];
			this.#drawPipelines[count] = pipelines[quad.blendMode] ?? pipelines[0];
			this.#drawGroups[count] = group;
			count++;
		}
		if (count === 0) {
			return;
		}

		// the occlusion disc's radius, in the viewport units SRP core measures it in
		let radius = 0;
		let samples = 0;
		if (look.occlusion !== null) {
			const up = camera.up();
			const k = CELESTIAL_OCCLUSION * look.occlusion.radius;
			const edge = camera.projectDirection(
				[look.direction[0] + up[0] * k, look.direction[1] + up[1] * k, look.direction[2] + up[2] * k],
				aspect,
			);
			radius = edge === null ? 0 : Math.hypot(edge[0] - sun[0], edge[1] - sun[1]);
			samples = look.occlusion.samples;
		}
		const frame = this.#frameData;
		frame[0] = radius;
		frame[1] = samples;
		frame[2] = look.occlusion === null ? 0 : 1;
		frame[3] = height / width;
		this.#device.queue.writeBuffer(this.#frame, 0, frame);
		this.#device.queue.writeBuffer(this.#quads, 0, f, 0, count * QUAD_FLOATS);

		const render = encoder.beginRenderPass({
			label: 'lens flare',
			colorAttachments: [{ view: sized.target, loadOp: 'load', storeOp: 'store' }],
		});
		render.setBindGroup(0, sized.frame);
		for (let i = 0; i < count; i++) {
			render.setPipeline(this.#drawPipelines[i]);
			render.setBindGroup(1, this.#drawGroups[i]);
			render.draw(4, 1, 0, i);
		}
		render.end();
	}

	/** frees the buffers */
	destroy(): void {
		this.#frame.destroy();
		this.#quads.destroy();
	}
}
