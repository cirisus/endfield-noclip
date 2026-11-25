import type { RainConfig, RainPresetting } from '@endfield-noclip/package-format/environment';

import { createUniformBuffer } from '../../gfx/buffers.ts';
import type { PipelineCache } from '../../gfx/pipeline-cache.ts';
import { placeholder } from '../../gfx/placeholders.ts';
import { LINEAR_CLAMP, LINEAR_REPEAT, sampler } from '../../gfx/samplers.ts';
import { FRAME_WGSL } from '../frame/frame-uniforms.ts';
import { HDR_FORMAT, type SceneTextures } from '../frame/render-targets.ts';
import { postCommonSource } from '../post/shader-source.ts';
import type { TextureBinding } from '../textures/texture-store.ts';
import type { VerticalOcclusionMap } from '../weather/vertical-occlusion.ts';

import deferredLightingWgsl from './deferred-lighting.wgsl?raw';

/** 8 vec4f uniforms for high-quality rain wetness (occlusion, jitter, vertical flow, ripples) */
const RAIN_WETNESS_BYTES = 128;
const RAIN_WETNESS_FLOATS = RAIN_WETNESS_BYTES / 4;

const PIPELINE_KEY = 'deferred lighting';

/**
 * deferred lighting pass (deferred-lighting.wgsl): unpacks the G-buffer and writes lit HDR radiance into
 * `scene.lit` with `loadOp: 'load'`, leaving the celestial pass's sky pixels intact
 */
export class DeferredLighting {
	#device: GPUDevice;
	#pipelines: PipelineCache;
	#postGroup: GPUBindGroup;
	#inputsLayout: GPUBindGroupLayout;
	#wetnessLayout: GPUBindGroupLayout;
	#wetnessUniforms: GPUBuffer;
	#wetnessData = new Float32Array(RAIN_WETNESS_FLOATS);
	#wetnessGroup: GPUBindGroup;
	#verticalOcclusion: VerticalOcclusionMap;
	#noiseView: GPUTextureView;
	#rippleView: GPUTextureView;
	#flowView: GPUTextureView;
	#hasNoise = false;
	#hasRipple = false;
	#hasFlow = false;
	#sampler: GPUSampler;
	#repeatSampler: GPUSampler;
	#sized: { inputs: GPUBindGroup; target: GPUTextureView } | null = null;

	/**
	 * @param device the device
	 * @param pipelines the pipeline cache
	 * @param layouts group 0 (`frame`) and group 1 (`post` uniforms) layouts
	 * @param postUniforms the post chain's `Post` uniforms buffer
	 * @param verticalOcclusion the top-down vertical occlusion depth map for rain sheltering
	 */
	constructor(
		device: GPUDevice,
		pipelines: PipelineCache,
		layouts: { frame: GPUBindGroupLayout; postUniforms: GPUBindGroupLayout },
		postUniforms: GPUBuffer,
		verticalOcclusion: VerticalOcclusionMap,
	) {
		this.#device = device;
		this.#pipelines = pipelines;
		this.#verticalOcclusion = verticalOcclusion;
		this.#sampler = sampler(device, LINEAR_CLAMP);
		this.#repeatSampler = sampler(device, LINEAR_REPEAT);
		this.#wetnessUniforms = createUniformBuffer(device, 'rain wetness uniforms', RAIN_WETNESS_BYTES);
		const frag = GPUShaderStage.FRAGMENT;
		const tex = (
			binding: number,
			sampleType: GPUTextureSampleType = 'float',
			viewDimension: GPUTextureViewDimension = '2d',
		): GPUBindGroupLayoutEntry => ({
			binding,
			visibility: frag,
			texture: { sampleType, viewDimension },
		});
		this.#inputsLayout = device.createBindGroupLayout({
			label: 'deferred lighting inputs',
			entries: [
				tex(0),
				tex(1),
				tex(2),
				tex(3),
				tex(4, 'depth'),
				tex(5),
				tex(6),
				tex(7),
				{ binding: 8, visibility: frag, sampler: { type: 'filtering' } },
			],
		});
		this.#wetnessLayout = device.createBindGroupLayout({
			label: 'deferred lighting wetness',
			entries: [
				{ binding: 0, visibility: frag, buffer: { type: 'uniform' } },
				tex(1, 'depth'),
				{ binding: 2, visibility: frag, sampler: { type: 'comparison' } },
				tex(3, 'float', '3d'),
				tex(4, 'float', '2d'),
				tex(5, 'float', '2d'),
				{ binding: 6, visibility: frag, sampler: { type: 'filtering' } },
			],
		});
		const module = pipelines.module(
			'deferred lighting',
			[FRAME_WGSL, postCommonSource(1, 0), deferredLightingWgsl].join('\n'),
		);
		void pipelines.prepare(PIPELINE_KEY, () => ({
			label: 'deferred lighting',
			layout: device.createPipelineLayout({
				label: 'deferred lighting',
				bindGroupLayouts: [layouts.frame, layouts.postUniforms, this.#inputsLayout, this.#wetnessLayout],
			}),
			vertex: { module, entryPoint: 'vs_fullscreen' },
			fragment: { module, entryPoint: 'fs_deferred_lighting', targets: [{ format: HDR_FORMAT }] },
			primitive: { topology: 'triangle-list' },
		}));
		this.#postGroup = device.createBindGroup({
			label: 'deferred lighting post',
			layout: layouts.postUniforms,
			entries: [{ binding: 0, resource: { buffer: postUniforms } }],
		});
		this.#noiseView = placeholder(device, 'black', '3d');
		this.#rippleView = placeholder(device, 'black', '2d');
		this.#flowView = placeholder(device, 'black', '2d');
		this.#wetnessGroup = this.#buildWetnessGroup();
	}

	#buildWetnessGroup(): GPUBindGroup {
		return this.#device.createBindGroup({
			label: 'deferred lighting wetness',
			layout: this.#wetnessLayout,
			entries: [
				{ binding: 0, resource: { buffer: this.#wetnessUniforms } },
				{ binding: 1, resource: this.#verticalOcclusion.view },
				{ binding: 2, resource: this.#verticalOcclusion.compareSampler },
				{ binding: 3, resource: this.#noiseView },
				{ binding: 4, resource: this.#rippleView },
				{ binding: 5, resource: this.#flowView },
				{ binding: 6, resource: this.#repeatSampler },
			],
		});
	}

	/**
	 * binds the streamed wetness textures (3D occlusion jitter noise, standing-water ripple flipbook, wall
	 * vertical-flow normal map); missing textures fall back to placeholders and disable their sub-effect
	 *
	 * @param textures the wetness textures, `null` when not resident
	 */
	setWetnessTextures(textures: {
		noise: TextureBinding | null;
		ripple: TextureBinding | null;
		flow: TextureBinding | null;
	}): void {
		const noiseView = textures.noise?.view ?? placeholder(this.#device, 'black', '3d');
		const rippleView = textures.ripple?.view ?? placeholder(this.#device, 'black', '2d');
		const flowView = textures.flow?.view ?? placeholder(this.#device, 'black', '2d');
		this.#hasNoise = textures.noise !== null;
		this.#hasRipple = textures.ripple !== null;
		this.#hasFlow = textures.flow !== null;
		if (noiseView === this.#noiseView && rippleView === this.#rippleView && flowView === this.#flowView) {
			return;
		}
		this.#noiseView = noiseView;
		this.#rippleView = rippleView;
		this.#flowView = flowView;
		this.#wetnessGroup = this.#buildWetnessGroup();
	}

	/**
	 * uploads this frame's high-quality rain wetness uniforms
	 *
	 * @param rain the blended rain config, or `null` when dry
	 * @param presetting the package's rain presetting asset, or `null` when absent
	 * @param occlusion the vertical occlusion map as fitted for this frame
	 * @param time the viewer's animation clock, s
	 */
	updateWetness(
		rain: RainConfig | null,
		presetting: RainPresetting | null,
		occlusion: VerticalOcclusionMap,
		time: number,
	): void {
		const d = this.#wetnessData;
		d.fill(0);
		if (rain === null || !rain.enableWetness || rain.wetness <= 0) {
			this.#device.queue.writeBuffer(this.#wetnessUniforms, 0, d);
			return;
		}
		const normalBias = presetting?.rainOcclusionSampleNormalBias ?? 1.8;
		const depthBias = presetting?.rainOcclusionSampleDepthBias ?? 0;
		const noiseScale = presetting?.rainOcclusionSampleNoiseScale ?? 0.15;
		const hJitter = presetting?.rainOcclusionSampleHorizontalJitterLevel ?? 1.2;
		const vJitter = presetting?.rainOcclusionSampleVerticalJitterLevel ?? 0.5;
		const flowSt = presetting?.verticalFlowTextureST ?? [0.5, 0.5, 0, 0];
		const rippleSt = presetting?.rippleTextureST ?? [1, 1, 0, 0];
		const rippleCols = Math.max(1, presetting?.rippleRowColumnCount ?? 4);

		// occ_origin: camera-relative (centerX, topRelY, centerZ, 1 / (2 · range))
		d.set(occlusion.originAndInvSpan, 0);
		// occ_metrics: (1 / height, height, texelWorldSize, active)
		d.set(occlusion.metrics, 4);
		// occ_bias: (normalBias, depthBias, noiseScale, hasNoise)
		d[8] = normalBias;
		d[9] = depthBias;
		d[10] = noiseScale;
		d[11] = this.#hasNoise ? 1 : 0;
		// occ_jitter: (horizontalJitterLevel, verticalJitterLevel, 0, 0)
		d[12] = hJitter;
		d[13] = vJitter;
		// flow_params: (flowOffset, normalStrength, slopeThreshold, porosity)
		d[16] = (time * (rain.verticalFlowSpeed ?? 0) * 0.07) % 1000;
		d[17] = this.#hasFlow ? (rain.verticalFlowNormalStrength ?? 0) : 0;
		d[18] = rain.verticalFlowSurfaceThreshold ?? 0.3;
		d[19] = rain.verticalFlowPorosityBias ?? 0.4;
		// flow_st: (scaleX, scaleY, offsetX, offsetY)
		d.set(flowSt, 20);
		// ripple_params: (rippleTimeOffset, rippleNormalStrength, waveTimeOffset, waveNormalStrength)
		const rippleT = time * (rain.rippleFrequency ?? 0);
		const waveT = time * (rain.rippleWaveSpeed ?? 0);
		d[24] = rippleT - Math.floor(rippleT);
		d[25] = this.#hasRipple ? (rain.rippleNormalStrength ?? 0) : 0;
		d[26] = waveT - Math.floor(waveT);
		d[27] = this.#hasRipple ? (rain.rippleWaveNormalStrength ?? 0) : 0;
		// ripple_st: (scaleX, scaleY, rowColumnCount, roughnessMaskThreshold)
		d[28] = rippleSt[0];
		d[29] = rippleSt[1];
		d[30] = rippleCols;
		d[31] = Math.max(0, rain.rippleRoughnessMaskThreshold);
		this.#device.queue.writeBuffer(this.#wetnessUniforms, 0, d);
	}

	/**
	 * rebinds the G-buffer, AO, SSR and wetness mask after a resize.
	 *
	 * @param input the main pass's G-buffer, blurred AO and resolved SSR
	 */
	resize(input: { scene: SceneTextures; ao: GPUTextureView; reflections: GPUTextureView }): void {
		const { scene } = input;
		this.#sized = {
			target: scene.lit,
			inputs: this.#device.createBindGroup({
				label: 'deferred lighting inputs',
				layout: this.#inputsLayout,
				entries: [
					{ binding: 0, resource: scene.emission },
					{ binding: 1, resource: scene.gbufferA },
					{ binding: 2, resource: scene.gbufferB },
					{ binding: 3, resource: scene.gbufferC },
					{ binding: 4, resource: scene.depth },
					{ binding: 5, resource: input.ao },
					{ binding: 6, resource: input.reflections },
					{ binding: 7, resource: scene.wetnessMask },
					{ binding: 8, resource: this.#sampler },
				],
			}),
		};
	}

	/**
	 * encodes the deferred lighting pass into `scene.lit`, preserving sky pixels written by the celestial pass.
	 *
	 * @param encoder this frame's encoder
	 * @param frameGroup group 0 (`frame`) and its dynamic uniform offset
	 */
	encode(encoder: GPUCommandEncoder, frameGroup: { group: GPUBindGroup; offset: number }): void {
		const sized = this.#sized;
		if (sized === null) {
			throw new Error('deferred lighting used before resize()');
		}
		const pipeline = this.#pipelines.get(PIPELINE_KEY);
		if (pipeline === undefined) {
			return;
		}
		const pass = encoder.beginRenderPass({
			label: 'deferred lighting',
			colorAttachments: [{ view: sized.target, loadOp: 'load', storeOp: 'store' }],
		});
		pass.setPipeline(pipeline);
		pass.setBindGroup(0, frameGroup.group, [frameGroup.offset]);
		pass.setBindGroup(1, this.#postGroup);
		pass.setBindGroup(2, sized.inputs);
		pass.setBindGroup(3, this.#wetnessGroup);
		pass.draw(3);
		pass.end();
	}

	/** frees the pass's uniform buffer */
	destroy(): void {
		this.#wetnessUniforms.destroy();
	}
}
