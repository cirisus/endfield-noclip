import type { GeometryEntry } from '@endfield-noclip/package-format/geometry';
import type { WaterConfig, WaterTable } from '@endfield-noclip/package-format/water';

import {
	HDR_FORMAT,
	type SceneTextures,
	WATER_DEPTH_FORMAT,
	WATER_FOAM_FORMAT,
} from '../gfx/render-targets.ts';
import { type Plane, type Vec3, boxInFrustum } from '../scene/camera.ts';
import { streamWholeTexture } from '../streaming/mesh-selection.ts';
import type { ResidentGeometry, StreamManager } from '../streaming/stream-manager.ts';

import { FRAME_WGSL } from './frame-uniforms.ts';
import atmosphereWgsl from './shaders/atmosphere.wgsl?raw';
import commonWgsl from './shaders/post-common.wgsl?raw';
import skyWgsl from './shaders/sky.wgsl?raw';
import ssrTraceWgsl from './shaders/ssr-trace.wgsl?raw';
import waterWgsl from './shaders/water.wgsl?raw';
import { type TextureBinding, type TextureStore, placeholderView } from './texture-store.ts';

/** floats of `Surface` in water.wgsl */
const SURFACE_FLOATS = 20;
/** floats of `Config` in water.wgsl */
const CONFIG_FLOATS = 56;
/** floats of the `water` uniform in water.wgsl */
const PARAM_FLOATS = 12;
const MAX_SURFACES = 4096;
/** priority of the surfaces' geometry at 1 m, and of their textures */
const PRIORITY = 1e5;

/** the layouts of the groups the water pass shares with other passes */
export interface WaterLayouts {
	/** the main pass's frame group (group 0) */
	frame: GPUBindGroupLayout;
	/** the post uniforms (group 3) */
	uniforms: GPUBindGroupLayout;
	/** the sky's reads (group 1) */
	sky: GPUBindGroupLayout;
}

/** what the water pass reads from the main pass and the post chain */
export interface WaterContext {
	scene: SceneTextures;
	/** a copy of the composited scene, which the pass refracts and reflects */
	background: GPUTextureView;
	/** the main pass's frame group and its uniforms' dynamic offset */
	frame: { group: GPUBindGroup; offset: number };
	/** groups of {@link WaterLayouts.uniforms} and {@link WaterLayouts.sky} */
	postUniforms: GPUBindGroup;
	sky: GPUBindGroup;
	/** bumped whenever the scene textures change */
	version: number;
	/** the main pass's size, px */
	width: number;
	height: number;
	/**
	 * draws the WaterDecal boxes into `target` (cleared to (0, 0, 0, 1) by the callee) over the water surface's
	 * depth, or `null` when there are none this frame
	 */
	foam:
		| ((encoder: GPUCommandEncoder, input: { waterDepth: GPUTextureView; target: GPUTextureView }) => void)
		| null;
}

/**
 * @returns the water shader: the frame's lighting at group 0, then the post passes' helpers with their
 *   uniforms moved to group 3
 */
const waterShaderSource = (): string => {
	const binding = '@group(0) @binding(0) var<uniform> post';
	if (!commonWgsl.includes(binding)) {
		throw new Error(`post-common.wgsl no longer declares \`${binding}\``);
	}
	const common = commonWgsl.replace(binding, '@group(3) @binding(0) var<uniform> post');
	return [FRAME_WGSL, common, atmosphereWgsl, skyWgsl, ssrTraceWgsl, waterWgsl].join('\n');
};

/** the foam the boxes leave on the water surface */
interface FoamTargets {
	/** the scene textures' version they were made at */
	version: number;
	foam: GPUTexture;
	foamView: GPUTextureView;
}

interface Draw {
	geometry: ResidentGeometry;
	slot: number;
}

/** packs one config the way `Config` in water.wgsl reads it */
const packConfig = (c: WaterConfig, out: Float32Array, at: number): void => {
	const rows = [
		c.waterRayleighScatteringMeter,
		c.waterRayleighAbsorptionMeter,
		c.waterRayleighAbsorptionMeter2,
		[c.safeFullAbsorpDistance, c.envLightIntensity, c.distanceEdgeBlendFactor, c.rayleighMieLerpFactor],
		[c.roughness, c.specular, c.waterIOR, c.envLightSpecularIntensity],
		[c.flowSpeed, c.normalTilling, c.normalScale, c.flowFullCycle],
		[c.largeWaveSignedSpeed, c.largeWaveNormalTilling, c.largeWaveNormalScale, c.flowFullCycleLarge],
		[...c.flowDirectionVector2, c.useFlowMap ? 1 : 0, c.flowMapCoverage ? 1 : 0],
		[c.smallWaveNormalType, c.largeWaveNormalType, c.dirSpecNormalScaler, c.sceneColorEnvInfluence],
		[c.distanceFade, c.distanceNormalMinStrength, c.normalMipBias, c.foamRoughness],
		// colours go in as authored, as the game copies them
		[c.foamColorG[0], c.foamColorG[1], c.foamColorG[2], c.foamOpacity],
		[c.foamShapeOffset, c.foamFadeRate, c.waterBaseColorSubsurfaceScaler, c.emissiveStrength],
		[c.causticTilling, c.causticOpacity, c.causticDistort, c.causticSpeed],
		[c.causticStartDepth, c.causticEndDepth, 0, 0],
	];
	rows.forEach((row, i) => out.set(row, at + i * 4));
};

/** owns the water pipeline, its buffers and the per-frame surface list */
export class WaterRenderer {
	#device: GPUDevice;
	#layout: GPUBindGroupLayout;
	#pipeline: GPURenderPipeline;
	/** lays down the nearest water surface's depth (`SceneTextures.waterDepth`) */
	#depthPipeline: GPURenderPipeline;
	/** the foam the boxes leave on the surface, at the main pass's size */
	#foamTargets: FoamTargets | null = null;
	/** bound in place of the water's depth while the depth pass draws into it */
	#noWaterDepth: GPUTexture;
	#noWaterDepthView: GPUTextureView;
	/** bound in place of the foam while there are no foam targets */
	#noFoam: GPUTextureView;
	#surfaces: GPUBuffer;
	#surfaceData = new Float32Array(MAX_SURFACES * SURFACE_FLOATS);
	#surfaceWords = new Uint32Array(this.#surfaceData.buffer);
	#configs: GPUBuffer | null = null;
	#params: GPUBuffer;
	#paramData = new Float32Array(PARAM_FLOATS);
	#repeat: GPUSampler;
	#noNormals: GPUTextureView;
	#noFlow: GPUTextureView;
	#table: WaterTable | null = null;
	#draws: Draw[] = [];
	#normals: TextureBinding | null = null;
	#flow: TextureBinding | null = null;
	#caustics: TextureBinding | null = null;
	/** group 2, per water depth view bound: the depth pass's placeholder or the scene's */
	#groups = new Map<GPUTextureView, { group: GPUBindGroup; key: unknown[] }>();

	/**
	 * @param device the device
	 * @param layouts the shared groups' layouts
	 */
	constructor(device: GPUDevice, layouts: WaterLayouts) {
		this.#device = device;
		const module = device.createShaderModule({ label: 'water', code: waterShaderSource() });
		const fragment = GPUShaderStage.FRAGMENT;
		const texture = (
			binding: number,
			sampleType: GPUTextureSampleType,
			viewDimension: GPUTextureViewDimension = '2d',
		): GPUBindGroupLayoutEntry => ({ binding, visibility: fragment, texture: { sampleType, viewDimension } });
		this.#layout = device.createBindGroupLayout({
			label: 'water',
			entries: [
				{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
				{ binding: 1, visibility: fragment, buffer: { type: 'read-only-storage' } },
				texture(2, 'unfilterable-float'),
				texture(3, 'depth'),
				texture(4, 'float', '2d-array'),
				texture(5, 'float'),
				{ binding: 6, visibility: fragment, sampler: { type: 'filtering' } },
				{ binding: 7, visibility: fragment, buffer: { type: 'uniform' } },
				texture(8, 'float'),
				texture(9, 'unfilterable-float'),
				texture(10, 'float'),
				texture(11, 'float'),
				texture(12, 'float'),
				texture(13, 'float'),
				texture(14, 'depth'),
			],
		});
		const layout = device.createPipelineLayout({
			label: 'water',
			bindGroupLayouts: [layouts.frame, layouts.sky, this.#layout, layouts.uniforms],
		});
		const vertex: GPUVertexState = {
			module,
			entryPoint: 'vs_water',
			buffers: [
				{ arrayStride: 8, attributes: [{ shaderLocation: 0, offset: 0, format: 'unorm16x4' }] },
				// octahedral normals; meshes without them bind their positions here, which the shader ignores
				{ arrayStride: 4, attributes: [{ shaderLocation: 1, offset: 0, format: 'snorm16x2' }] },
			],
		};
		// seen from below too
		const primitive: GPUPrimitiveState = { topology: 'triangle-list', cullMode: 'none' };
		this.#pipeline = device.createRenderPipeline({
			label: 'water',
			layout,
			vertex,
			fragment: { module, entryPoint: 'fs_water', targets: [{ format: HDR_FORMAT }] },
			primitive,
		});
		this.#depthPipeline = device.createRenderPipeline({
			label: 'water depth',
			layout,
			vertex,
			fragment: { module, entryPoint: 'fs_water_depth', targets: [] },
			primitive,
			depthStencil: { format: WATER_DEPTH_FORMAT, depthWriteEnabled: true, depthCompare: 'greater' },
		});

		this.#surfaces = device.createBuffer({
			label: 'water surfaces',
			size: this.#surfaceData.byteLength,
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
		});
		this.#params = device.createBuffer({
			label: 'water params',
			size: this.#paramData.byteLength,
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
		});
		this.#repeat = device.createSampler({
			label: 'water repeat',
			addressModeU: 'repeat',
			addressModeV: 'repeat',
			magFilter: 'linear',
			minFilter: 'linear',
			mipmapFilter: 'linear',
			maxAnisotropy: 4,
		});
		this.#noFlow = placeholderView(device, { label: 'no water flow map', dimension: '2d' });
		this.#noNormals = placeholderView(device, { label: 'no water normals', dimension: '2d-array' });
		this.#noFoam = placeholderView(device, { label: 'no water foam', dimension: '2d' });
		this.#noWaterDepth = device.createTexture({
			label: 'no water depth',
			size: [1, 1],
			format: WATER_DEPTH_FORMAT,
			usage: GPUTextureUsage.TEXTURE_BINDING,
		});
		this.#noWaterDepthView = this.#noWaterDepth.createView();
	}

	/** @param table the package's water, or `null` */
	setTable(table: WaterTable | null): void {
		this.#table = table;
		this.#configs?.destroy();
		this.#configs = null;
		this.#groups.clear();
		this.clear();
		if (table === null || table.configs.length === 0) {
			return;
		}
		const data = new Float32Array(table.configs.length * CONFIG_FLOATS);
		table.configs.forEach((config, i) => packConfig(config.values, data, i * CONFIG_FLOATS));
		this.#configs = this.#device.createBuffer({
			label: 'water configs',
			size: data.byteLength,
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
		});
		this.#device.queue.writeBuffer(this.#configs, 0, data);
	}

	#groupsShown: readonly boolean[] = [];

	/** @param shown per visibility group of the package, whether its content shows; others aren't drawn */
	setGroupsShown(shown: readonly boolean[]): void {
		this.#groupsShown = shown;
	}

	/** draws nothing until the next {@link prepare} */
	clear(): void {
		this.#draws.length = 0;
	}

	/**
	 * picks this frame's surfaces and streams what they need.
	 *
	 * @param input the camera, the stream and tables
	 */
	prepare(input: {
		eye: Vec3;
		planes: readonly Plane[];
		stream: StreamManager;
		geometries: readonly GeometryEntry[];
		textures: TextureStore;
		/** the sun as the water column takes it: `Environment.sunRaw` */
		sun: Vec3;
		/** per water volume, metres its surface sits above where it was packed */
		volumeOffsets: Float32Array;
	}): void {
		const { eye, planes, stream, geometries, textures, sun, volumeOffsets } = input;
		const table = this.#table;
		this.clear();
		if (table === null) {
			return;
		}
		const data = this.#surfaceData;
		const words = this.#surfaceWords;
		let slot = 0;
		for (const surface of table.surfaces) {
			if (!(this.#groupsShown[surface.group] ?? false)) {
				continue;
			}
			const entry = geometries[surface.geometry];
			if (entry?.status !== 'ready') {
				continue;
			}
			// a water volume's surface rises and falls with its fill
			const lift = surface.kind === 'volume' ? (volumeOffsets[surface.volume] ?? 0) : 0;
			const { min: packedMin, max: packedMax } = surface.bounds;
			const min: Vec3 = [packedMin[0], packedMin[1] + lift, packedMin[2]];
			const max: Vec3 = [packedMax[0], packedMax[1] + lift, packedMax[2]];
			const dx = Math.max(min[0] - eye[0], 0, eye[0] - max[0]);
			const dz = Math.max(min[2] - eye[2], 0, eye[2] - max[2]);
			const item = stream.want(entry.blob, PRIORITY / (1 + Math.hypot(dx, dz)));
			const resident = item?.resident;
			if (resident?.kind !== 'geometry' || slot >= MAX_SURFACES || !boxInFrustum(planes, min, max, eye)) {
				continue;
			}
			const t = surface.transform;
			const at = slot * SURFACE_FLOATS;
			for (let r = 0; r < 3; r++) {
				data[at + r * 4] = t[r * 4];
				data[at + r * 4 + 1] = t[r * 4 + 1];
				data[at + r * 4 + 2] = t[r * 4 + 2];
				data[at + r * 4 + 3] = t[r * 4 + 3] + (r === 1 ? lift : 0) - eye[r];
			}
			data.set(resident.positionOffset, at + 12);
			words[at + 15] = surface.config;
			data.set(resident.positionScale, at + 16);
			data[at + 19] = surface.meshNormals && resident.normalOffset !== null ? 1 : 0;
			this.#draws.push({ geometry: resident, slot });
			slot++;
		}
		if (slot === 0) {
			return;
		}
		this.#device.queue.writeBuffer(this.#surfaces, 0, data, 0, slot * SURFACE_FLOATS);

		const global = table.global;
		const streamBinding = (id: number | null, kind: '2d' | '2d-array'): TextureBinding | null =>
			streamWholeTexture({ stream, textures, id, kind, priority: PRIORITY })?.binding ?? null;
		this.#normals = streamBinding(global?.normalMaps ?? null, '2d-array');
		this.#flow = streamBinding(global?.flowMap ?? null, '2d');
		this.#caustics = streamBinding(global?.causticMap ?? null, '2d');
		const params = this.#paramData;
		params[0] = this.#normals === null ? 0 : 1;
		params[1] = this.#flow === null ? 0 : 1;
		params[2] = global?.mapSize ?? 1;
		params[3] = this.#caustics === null ? 0 : 1;
		params[4] = global?.center[0] ?? 0;
		params[5] = global?.center[1] ?? 0;
		params.set(sun, 8);
		this.#device.queue.writeBuffer(this.#params, 0, params);
	}

	/**
	 * @param context what the pass reads
	 * @param waterDepth bound as the water's depth: the scene's, or a placeholder while drawing into it
	 */
	#bindGroup(context: WaterContext, waterDepth: GPUTextureView): GPUBindGroup | null {
		if (this.#configs === null) {
			return null;
		}
		const foam = this.#foamTargets?.foamView ?? this.#noFoam;
		const key = [context.version, context.background, this.#normals, this.#flow, this.#caustics, foam];
		const cached = this.#groups.get(waterDepth);
		if (cached !== undefined && key.every((part, i) => part === cached.key[i])) {
			return cached.group;
		}
		const scene = context.scene;
		const group = this.#device.createBindGroup({
			label: 'water',
			layout: this.#layout,
			entries: [
				{ binding: 0, resource: { buffer: this.#surfaces } },
				{ binding: 1, resource: { buffer: this.#configs } },
				{ binding: 2, resource: context.background },
				{ binding: 3, resource: context.scene.depth },
				{ binding: 4, resource: this.#normals?.view ?? this.#noNormals },
				{ binding: 5, resource: this.#flow?.view ?? this.#noFlow },
				{ binding: 6, resource: this.#repeat },
				{ binding: 7, resource: { buffer: this.#params } },
				// the flow map's placeholder stands in; the shader skips caustics without the map
				{ binding: 8, resource: this.#caustics?.view ?? this.#noFlow },
				{ binding: 9, resource: context.scene.glow },
				{ binding: 10, resource: foam },
				{ binding: 11, resource: scene.transparent },
				{ binding: 12, resource: scene.revealage },
				{ binding: 13, resource: scene.layerDistance },
				{ binding: 14, resource: waterDepth },
			],
		});
		this.#groups.set(waterDepth, { group, key });
		return group;
	}

	/** @returns whether there's anything to draw this frame */
	get active(): boolean {
		return this.#draws.length > 0 && this.#configs !== null;
	}

	/**
	 * clears the nearest water surface's depth (`SceneTextures.waterDepth`) and, when there's water to draw,
	 * draws it. call before the composite, which reads it, whenever {@link encode} follows; otherwise
	 * {@link clearDepth}.
	 *
	 * @param encoder this frame's encoder
	 * @param context what the pass reads
	 */
	encodeDepth(encoder: GPUCommandEncoder, context: WaterContext): void {
		const pass = WaterRenderer.#beginDepthPass(encoder, context.scene.waterDepth);
		const group = this.#draws.length > 0 ? this.#bindGroup(context, this.#noWaterDepthView) : null;
		if (group !== null) {
			this.#drawSurfaces(pass, this.#depthPipeline, group, context);
		}
		pass.end();
	}

	/**
	 * clears the nearest water surface's depth to none, for frames that draw no water.
	 *
	 * @param encoder this frame's encoder
	 * @param scene the scene textures
	 */
	clearDepth(encoder: GPUCommandEncoder, scene: SceneTextures): void {
		WaterRenderer.#beginDepthPass(encoder, scene.waterDepth).end();
	}

	static #beginDepthPass(encoder: GPUCommandEncoder, view: GPUTextureView): GPURenderPassEncoder {
		return encoder.beginRenderPass({
			label: 'water depth',
			colorAttachments: [],
			depthStencilAttachment: { view, depthClearValue: 0, depthLoadOp: 'clear', depthStoreOp: 'store' },
		});
	}

	/**
	 * draws this frame's surfaces into the scene, after {@link encodeDepth}, and lays the transparent layers the
	 * composite kept back over them.
	 *
	 * @param encoder this frame's encoder
	 * @param target the composited HDR scene, drawn over
	 * @param context what the pass reads
	 */
	encode(encoder: GPUCommandEncoder, target: GPUTextureView, context: WaterContext): void {
		if (this.#configs === null || this.#draws.length === 0) {
			return;
		}
		// the foam boxes project onto the water's own depth
		const foamed = context.foam !== null;
		if (context.foam !== null) {
			const targets = this.#ensureFoamTargets(context);
			context.foam(encoder, { waterDepth: context.scene.waterDepth, target: targets.foamView });
		}
		if (this.#paramData[6] !== (foamed ? 1 : 0)) {
			this.#paramData[6] = foamed ? 1 : 0;
			this.#device.queue.writeBuffer(this.#params, 0, this.#paramData);
		}
		const group = this.#bindGroup(context, context.scene.waterDepth);
		if (group === null) {
			return;
		}
		const pass = encoder.beginRenderPass({
			label: 'water',
			colorAttachments: [{ view: target, loadOp: 'load', storeOp: 'store' }],
		});
		this.#drawSurfaces(pass, this.#pipeline, group, context);
		pass.end();
	}

	/** the foam targets at the main pass's size, made again when the scene textures change */
	#ensureFoamTargets(context: WaterContext): FoamTargets {
		const current = this.#foamTargets;
		if (current !== null && current.version === context.version) {
			return current;
		}
		current?.foam.destroy();
		const size = [context.width, context.height];
		const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
		const foam = this.#device.createTexture({ label: 'water foam', size, format: WATER_FOAM_FORMAT, usage });
		this.#foamTargets = {
			version: context.version,
			foam,
			foamView: foam.createView(),
		};
		return this.#foamTargets;
	}

	#drawSurfaces(
		pass: GPURenderPassEncoder,
		pipeline: GPURenderPipeline,
		group: GPUBindGroup,
		context: WaterContext,
	): void {
		pass.setPipeline(pipeline);
		pass.setBindGroup(0, context.frame.group, [context.frame.offset]);
		pass.setBindGroup(1, context.sky);
		pass.setBindGroup(2, group);
		pass.setBindGroup(3, context.postUniforms);
		this.#draw(pass);
		pass.end();
	}

	/**
	 * records the nearest visible water surface for photography. opaque occluders remain in the scene depth and
	 * are combined with this target by the focus pass; no water lighting is evaluated here.
	 *
	 * @param encoder this frame's encoder
	 * @param target a depth32float view at the render size; cleared even when there is no water
	 * @param context the same frame and uniforms used to draw water colour
	 */
	encodeDepth(encoder: GPUCommandEncoder, target: GPUTextureView, context: WaterContext): void {
		const pass = encoder.beginRenderPass({
			label: 'water photography depth',
			colorAttachments: [],
			depthStencilAttachment: {
				view: target,
				depthClearValue: 0,
				depthLoadOp: 'clear',
				depthStoreOp: 'store',
			},
		});
		const group = this.#bindGroup(context);
		if (group !== null && this.#draws.length > 0) {
			pass.setPipeline(this.#depthPipeline);
			pass.setBindGroup(0, context.frame.group, [context.frame.offset]);
			pass.setBindGroup(1, context.sky);
			pass.setBindGroup(2, group);
			pass.setBindGroup(3, context.postUniforms);
			this.#draw(pass);
		}
		pass.end();
	}

	#draw(pass: GPURenderPassEncoder): void {
		for (const { geometry, slot } of this.#draws) {
			pass.setVertexBuffer(0, geometry.vertices, 0, geometry.positionBytes);
			pass.setVertexBuffer(1, geometry.vertices, geometry.normalOffset ?? 0);
			pass.setIndexBuffer(geometry.indices, geometry.indexFormat);
			for (const submesh of geometry.submeshes) {
				pass.drawIndexed(submesh.indexCount, 1, submesh.firstIndex, submesh.baseVertex, slot);
			}
		}
	}

	/** frees the buffers */
	destroy(): void {
		this.#surfaces.destroy();
		this.#configs?.destroy();
		this.#params.destroy();
		this.#foamTargets?.foam.destroy();
		this.#noWaterDepth.destroy();
	}
}
