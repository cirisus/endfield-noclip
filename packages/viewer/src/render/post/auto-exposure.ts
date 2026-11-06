import {
	type AutoExposureSettings,
	BINS,
	easeExposure,
	meteredExposure,
	targetExposure,
} from '../../environment/exposure.ts';
import { BindGroupCache } from '../../gfx/bind-group-cache.ts';
import { createUniformBuffer } from '../../gfx/buffers.ts';
import type { PipelineCache } from '../../gfx/pipeline-cache.ts';
import luminanceWgsl from '../shaders/common/luminance.wgsl?raw';

import autoExposureWgsl from './auto-exposure.wgsl?raw';

/** pixels between samples along each axis; one workgroup of 8 × 8 threads covers 128² pixels */
const STRIDE = 16;
const WORKGROUP_PIXELS = 8 * STRIDE;
/** fixed-point scale of the weights the shader accumulates; matches `WEIGHT_SCALE` in auto-exposure.wgsl */
const WEIGHT_SCALE = 1024;
/** the game's centre weight under centre metering */
const CENTRE_WEIGHT = 0.75;
/** the exposure counts as settled once within this many EV of its target */
const SETTLED_EV = 0.01;
const PIPELINE_KEY = 'auto exposure histogram';

/** the histogram pass, its readback and the exposure it drives */
export class AutoExposure {
	/** the post exposure (linear) the scene is shown at, before the viewer's exposure option */
	exposure = 1;
	#device: GPUDevice;
	#pipelines: PipelineCache;
	#uniforms: GPUBuffer;
	#bins: GPUBuffer;
	/** readback buffers not waiting on a map */
	#idle: GPUBuffer[];
	/** the readback buffer this frame's histogram was copied into, mapped after submit, and its settings */
	#pending: { buffer: GPUBuffer; settings: AutoExposureSettings } | null = null;
	/** the histogram's group, over the scene view it reads */
	#group = new BindGroupCache<string>();
	#metered: number | null = null;
	/** jump straight to the next metered exposure instead of easing (a new level or a fresh start) */
	#snap = true;
	/** whether new histograms may move the target; see {@link update} */
	#metering = true;

	/**
	 * @param device the device
	 * @param pipelines the pipeline cache, which compiles the histogram pass
	 */
	constructor(device: GPUDevice, pipelines: PipelineCache) {
		this.#device = device;
		this.#pipelines = pipelines;
		void pipelines.prepareCompute(PIPELINE_KEY, () => ({
			layout: 'auto',
			compute: {
				module: pipelines.module('auto exposure', luminanceWgsl + '\n' + autoExposureWgsl),
				entryPoint: 'cs_histogram',
			},
		}));
		this.#uniforms = createUniformBuffer(device, 'auto exposure params', 32);
		this.#bins = device.createBuffer({
			label: 'auto exposure bins',
			size: BINS * 4,
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
		});
		this.#idle = [0, 1].map(() =>
			device.createBuffer({
				label: 'auto exposure readback',
				size: BINS * 4,
				usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
			}),
		);
	}

	/** forgets the metered exposure, so the next histogram is taken at once rather than eased towards */
	reset(): void {
		this.#metered = null;
		this.#snap = true;
	}

	/**
	 * encodes the histogram of this frame's scene, unless its pipeline is compiling or both readback buffers
	 * are still in flight.
	 *
	 * @param encoder this frame's encoder
	 * @param scene the lit scene before bloom and tonemapping, and its size in pixels
	 * @param settings the exposure settings
	 */
	encode(
		encoder: GPUCommandEncoder,
		scene: { view: GPUTextureView; width: number; height: number },
		settings: AutoExposureSettings,
	): void {
		if (settings.mode === 'manual' || (!this.#metering && this.#metered !== null)) {
			return;
		}
		const pipeline = this.#pipelines.getCompute(PIPELINE_KEY);
		if (pipeline === undefined) {
			return;
		}
		const readback = this.#idle.pop();
		if (readback === undefined) {
			return;
		}
		const { view, width, height } = scene;
		const params = new ArrayBuffer(32);
		new Uint32Array(params, 0, 3).set([width, height, STRIDE]);
		new Float32Array(params, 12, 3).set([
			settings.centerWeighted ? CENTRE_WEIGHT : 0,
			settings.meteringRange[0],
			settings.meteringRange[1],
		]);
		this.#device.queue.writeBuffer(this.#uniforms, 0, params);
		const group = this.#group.get(PIPELINE_KEY, [view], () =>
			this.#device.createBindGroup({
				layout: pipeline.getBindGroupLayout(0),
				entries: [
					{ binding: 0, resource: view },
					{ binding: 1, resource: { buffer: this.#uniforms } },
					{ binding: 2, resource: { buffer: this.#bins } },
				],
			}),
		);
		encoder.clearBuffer(this.#bins);
		const pass = encoder.beginComputePass({ label: 'auto exposure histogram' });
		pass.setPipeline(pipeline);
		pass.setBindGroup(0, group);
		pass.dispatchWorkgroups(Math.ceil(width / WORKGROUP_PIXELS), Math.ceil(height / WORKGROUP_PIXELS));
		pass.end();
		encoder.copyBufferToBuffer(this.#bins, 0, readback, 0, BINS * 4);
		this.#pending = { buffer: readback, settings };
	}

	/** starts reading back the histogram {@link encode} recorded; call after submitting */
	afterSubmit(): void {
		const pending = this.#pending;
		if (pending === null) {
			return;
		}
		this.#pending = null;
		const { buffer, settings } = pending;
		buffer
			.mapAsync(GPUMapMode.READ)
			.then(() => {
				const words = new Uint32Array(buffer.getMappedRange());
				const bins = Array.from(words, (w) => w / WEIGHT_SCALE);
				buffer.unmap();
				this.#idle.push(buffer);
				this.#metered = meteredExposure(bins, settings);
			})
			.catch(() => {});
	}

	/**
	 * moves the exposure towards its target.
	 *
	 * @param settings the exposure settings, or `null` to show the scene at exposure 1
	 * @param dt seconds since the last step
	 * @param options.metering whether this frame's histogram may move the target. off, the exposure eases to
	 *   the target it has, so it settles even while animated content keeps changing what it would meter
	 * @returns whether the exposure is still moving or waiting on its first histogram, so the caller keeps
	 *   rendering
	 */
	update(settings: AutoExposureSettings | null, dt: number, { metering }: { metering: boolean }): boolean {
		this.#metering = metering;
		if (settings === null) {
			this.exposure = 1;
			this.reset();
			return false;
		}
		if (settings.mode === 'auto' && this.#metered === null) {
			return true;
		}
		const target = targetExposure(this.#metered, settings);
		if (this.#snap) {
			this.#snap = false;
			this.exposure = target;
			return false;
		}
		if (Math.abs(Math.log2(this.exposure / target)) < SETTLED_EV) {
			this.exposure = target;
			return false;
		}
		this.exposure = easeExposure(this.exposure, target, settings, dt);
		return true;
	}

	/** frees the GPU resources */
	destroy(): void {
		this.#uniforms.destroy();
		this.#bins.destroy();
		for (const buffer of this.#idle) {
			buffer.destroy();
		}
		this.#pending?.buffer.destroy();
	}
}
