import { BLOCK_SLOT_BITS } from '../../content/instance-rows.ts';
import type { PipelineCache } from '../../gfx/pipeline-cache.ts';
import {
	BUCKET_WORDS,
	COUNTER_WORDS,
	type GpuCullWork,
	INDIRECT_WORDS,
	ITEM_WORDS,
	ItemFlags,
	NO_BUCKET,
	SLOT_WORDS,
	STATS_WORDS,
	SlotFlags,
	VIEW_FLOATS,
	ViewWord,
} from '../../streaming/gpu-cull-work.ts';
import { wgslConst } from '../shaders/wgsl-const.ts';
import { SHADOW_LAYERS } from '../shadows/shadow-map.ts';

import cullWgsl from './instance-cull.wgsl?raw';

/** floats of `View` in instance-cull.wgsl past the selection's part: last frame's camera and the pyramid */
const OCCLUSION_FLOATS = 24;

/** workgroups along x of a dispatch at most (WebGPU's default limit) */
const MAX_GROUPS_X = 65_535;
const KEYS = { write: 'instance cull/write', arguments: 'instance cull/arguments' };
/** where a bucket's draw index and submesh range start among its words, past its regions */
const BUCKET_DRAW = 2 * (1 + SHADOW_LAYERS);

/** the buffers the culler reads and writes besides its own */
export interface CullTargets {
	/** the instance rows; replaced when they grow, which {@link rowsVersion} counts */
	rows: GPUBuffer;
	rowsVersion: number;
	/** the block origins, rebased to the eye */
	blocks: GPUBuffer;
	/** the visible list */
	list: GPUBuffer;
	/** each visible list entry's draw */
	drawIds: GPUBuffer;
}

/** what rows in view are tested against: last frame's depth pyramid and the camera it was drawn with */
export interface Occlusion {
	/** the pyramid, its first level's size and its levels */
	pyramid: { view: GPUTextureView; width: number; height: number; levels: number };
	/** last frame's camera-relative view-projection, column-major */
	previous: Float32Array;
	/** this frame's eye minus last frame's */
	eyeDelta: readonly [number, number, number];
	/** the camera's near plane, m */
	near: number;
}

/** where a GPU-culled bucket's rows go and how it draws, for {@link InstanceCuller.setBucket} */
export interface CulledBucket {
	/** where its rows in view start in the visible list, and how many fit */
	first: number;
	room: number;
	/** per shadow layer, where its casters start, and how many fit */
	layerFirst: number[];
	layerRoom: number[];
	/** its draw's index into the draw parameters */
	draw: number;
	indexCount: number;
	firstIndex: number;
	baseVertex: number;
}

/**
 * culls the rows the mesh selection leaves to the GPU (gpu-cull-work.ts) and writes their visible list
 * entries and the buckets' indirect draw arguments, {@link INDIRECT_WORDS} per bucket by its GPU index
 */
export class InstanceCuller {
	/** in-view instances and triangles the GPU drew, as last read back */
	instances = 0;
	triangles = 0;

	#device: GPUDevice;
	#pipelines: PipelineCache;
	#layout: GPUBindGroupLayout;
	#view: GPUBuffer;
	#viewData = new Float32Array(VIEW_FLOATS + OCCLUSION_FLOATS);
	#viewWords = new Uint32Array(this.#viewData.buffer);
	#work: GPUBuffer;
	#counters: GPUBuffer;
	#indirect: GPUBuffer;
	#statsRead: GPUBuffer;
	/** the stats were copied for reading in an encoded frame, not yet mapped */
	#statsCopied = false;
	#statsMapping = false;
	#buckets = new Uint32Array(1024 * BUCKET_WORDS);
	#bucketCount = 0;
	#itemCount = 0;
	/** whether work was committed since the last encode */
	#pending = false;
	#group: GPUBindGroup | null = null;
	/** bound in place of a pyramid while rows aren't tested against one */
	#noPyramid: GPUTexture;
	#noPyramidView: GPUTextureView;
	/** what {@link #group} binds */
	#bound: {
		rowsVersion: number;
		rows: GPUBuffer | null;
		work: GPUBuffer | null;
		counters: GPUBuffer | null;
		pyramid: GPUTextureView | null;
	} = { rowsVersion: -1, rows: null, work: null, counters: null, pyramid: null };
	#targets: () => CullTargets;

	/**
	 * @param device the device
	 * @param pipelines compiles the culling passes
	 * @param targets the buffers it reads and writes, asked for on every encode
	 */
	constructor(device: GPUDevice, pipelines: PipelineCache, targets: () => CullTargets) {
		this.#device = device;
		this.#pipelines = pipelines;
		this.#targets = targets;
		const compute = GPUShaderStage.COMPUTE;
		const storage = (binding: number, type: GPUBufferBindingType): GPUBindGroupLayoutEntry => ({
			binding,
			visibility: compute,
			buffer: { type },
		});
		this.#layout = device.createBindGroupLayout({
			label: 'instance cull',
			entries: [
				{ binding: 0, visibility: compute, buffer: { type: 'uniform' } },
				storage(1, 'read-only-storage'),
				storage(2, 'read-only-storage'),
				storage(3, 'read-only-storage'),
				storage(4, 'storage'),
				storage(5, 'storage'),
				storage(6, 'storage'),
				storage(7, 'storage'),
				{ binding: 8, visibility: compute, texture: { sampleType: 'unfilterable-float' } },
			],
		});
		this.#noPyramid = device.createTexture({
			label: 'no depth pyramid',
			size: [1, 1],
			format: 'r32float',
			usage: GPUTextureUsage.TEXTURE_BINDING,
		});
		this.#noPyramidView = this.#noPyramid.createView();
		this.#view = device.createBuffer({
			label: 'instance cull view',
			size: this.#viewData.byteLength,
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
		});
		this.#work = this.#workBuffer(64 * 1024);
		this.#counters = this.#counterBuffer(1024);
		this.#indirect = this.#indirectBuffer(1024);
		this.#statsRead = device.createBuffer({
			label: 'instance cull stats',
			size: STATS_WORDS * 4,
			usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
		});
		const code = [
			wgslConst('ITEM_WORDS', 'u32', ITEM_WORDS),
			wgslConst('SLOT_WORDS', 'u32', SLOT_WORDS),
			wgslConst('BUCKET_WORDS', 'u32', BUCKET_WORDS),
			wgslConst('BUCKET_DRAW', 'u32', BUCKET_DRAW),
			wgslConst('COUNTER_WORDS', 'u32', COUNTER_WORDS),
			wgslConst('INDIRECT_WORDS', 'u32', INDIRECT_WORDS),
			wgslConst('STATS_WORDS', 'u32', STATS_WORDS),
			wgslConst('SHADOW_LAYERS', 'u32', SHADOW_LAYERS),
			wgslConst('BLOCK_SLOT_BITS', 'u32', BLOCK_SLOT_BITS),
			wgslConst('NO_BUCKET', 'u32', NO_BUCKET),
			wgslConst('ITEM_INSIDE', 'u32', ItemFlags.Inside),
			wgslConst('SLOT_CASTS', 'u32', SlotFlags.Casts),
			wgslConst('SLOT_SHADOW_ONLY', 'u32', SlotFlags.ShadowOnly),
			wgslConst('SLOT_REALTIME', 'u32', SlotFlags.Realtime),
			wgslConst('SLOT_STATIC', 'u32', SlotFlags.Static),
			wgslConst('MAX_GROUPS_X', 'u32', MAX_GROUPS_X),
			cullWgsl,
		].join('\n');
		const module = pipelines.module('instance cull', code);
		const layout = device.createPipelineLayout({ bindGroupLayouts: [this.#layout] });
		for (const [key, entryPoint] of [
			[KEYS.write, 'cs_write'],
			[KEYS.arguments, 'cs_arguments'],
		] as const) {
			void pipelines.prepareCompute(key, () => ({ layout, compute: { module, entryPoint } }));
		}
	}

	/** @returns whether the passes compiled; until they have, the GPU culls nothing */
	get ready(): boolean {
		return Object.values(KEYS).every((key) => this.#pipelines.getCompute(key) !== undefined);
	}

	/** @returns the buckets' indirect draw arguments, {@link INDIRECT_WORDS} each by GPU index */
	get indirect(): GPUBuffer {
		return this.#indirect;
	}

	/** @returns bytes of the GPU allocations */
	get bytes(): number {
		return (
			this.#view.size + this.#work.size + this.#counters.size + this.#indirect.size + this.#statsRead.size
		);
	}

	/** destroys the GPU allocations; the culler can't be used after */
	destroy(): void {
		for (const buffer of [this.#view, this.#work, this.#counters, this.#indirect, this.#statsRead]) {
			buffer.destroy();
		}
		this.#noPyramid.destroy();
	}

	/**
	 * starts a frame's buckets: each draws nothing until {@link setBucket} gives it room
	 *
	 * @param count the frame's GPU-culled buckets
	 */
	begin(count: number): void {
		if (this.#buckets.length < count * BUCKET_WORDS) {
			this.#buckets = new Uint32Array(
				Math.max(count, (this.#buckets.length / BUCKET_WORDS) * 2) * BUCKET_WORDS,
			);
		}
		this.#buckets.fill(0, 0, count * BUCKET_WORDS);
		this.#bucketCount = count;
	}

	/**
	 * @param index the bucket's GPU index
	 * @param bucket where its rows go and how it draws
	 */
	setBucket(index: number, bucket: CulledBucket): void {
		const data = this.#buckets;
		const at = index * BUCKET_WORDS;
		data[at] = bucket.first;
		data[at + 1] = bucket.room;
		for (let layer = 0; layer < SHADOW_LAYERS; layer++) {
			data[at + 2 + layer * 2] = bucket.layerFirst[layer];
			data[at + 3 + layer * 2] = bucket.layerRoom[layer];
		}
		data[at + BUCKET_DRAW] = bucket.draw;
		data[at + BUCKET_DRAW + 1] = bucket.indexCount;
		data[at + BUCKET_DRAW + 2] = bucket.firstIndex;
		data[at + BUCKET_DRAW + 3] = bucket.baseVertex;
	}

	/**
	 * uploads the frame's work and buckets, culled at the next {@link encode}
	 *
	 * @param work the selection's work; its buckets were {@link begin}-counted and {@link setBucket}-placed
	 */
	commit(work: GpuCullWork): void {
		this.#itemCount = work.itemCount;
		if (work.itemCount === 0 || this.#bucketCount === 0) {
			this.#pending = false;
			return;
		}
		const itemWords = work.itemCount * ITEM_WORDS;
		const slotWords = work.slotCount * SLOT_WORDS;
		const bucketWords = this.#bucketCount * BUCKET_WORDS;
		const words = itemWords + slotWords + bucketWords;
		if (this.#work.size < words * 4) {
			this.#work.destroy();
			this.#work = this.#workBuffer(Math.max(words, (this.#work.size / 4) * 2));
		}
		const room = this.#indirect.size / 4 / INDIRECT_WORDS;
		if (room < this.#bucketCount) {
			const buckets = Math.max(this.#bucketCount, room * 2);
			this.#counters.destroy();
			this.#counters = this.#counterBuffer(buckets);
			this.#indirect.destroy();
			this.#indirect = this.#indirectBuffer(buckets);
		}
		const queue = this.#device.queue;
		queue.writeBuffer(this.#work, 0, work.items, 0, itemWords);
		queue.writeBuffer(this.#work, itemWords * 4, work.slots, 0, slotWords);
		queue.writeBuffer(this.#work, (itemWords + slotWords) * 4, this.#buckets, 0, bucketWords);
		this.#viewData.set(work.view);
		const viewWords = this.#viewWords;
		viewWords[ViewWord.itemCount] = work.itemCount;
		viewWords[ViewWord.bucketCount] = this.#bucketCount;
		viewWords[ViewWord.slotsAt] = itemWords;
		viewWords[ViewWord.bucketsAt] = itemWords + slotWords;
		queue.writeBuffer(this.#view, 0, this.#viewData);
		this.#pending = true;
	}

	/** @returns whether work was committed since the last {@link encode} */
	get pending(): boolean {
		return this.#pending;
	}

	/**
	 * culls the committed work, if any; encode before anything draws meshes
	 *
	 * @param encoder the frame's encoder
	 * @param occlusion what rows in view are tested against, or `null` to draw every row in view
	 */
	encode(encoder: GPUCommandEncoder, occlusion: Occlusion | null): void {
		this.#readStats();
		const write = this.#pipelines.getCompute(KEYS.write);
		const args = this.#pipelines.getCompute(KEYS.arguments);
		if (!this.#pending || write === undefined || args === undefined) {
			return;
		}
		this.#pending = false;
		{
			const data = this.#viewData;
			const words = this.#viewWords;
			const at = VIEW_FLOATS;
			data.fill(0, at);
			if (occlusion !== null) {
				data.set(occlusion.previous, at);
				data.set(occlusion.eyeDelta, at + 16);
				words[at + 19] = 1;
				data[at + 20] = occlusion.pyramid.width;
				data[at + 21] = occlusion.pyramid.height;
				words[at + 22] = occlusion.pyramid.levels;
				data[at + 23] = occlusion.near;
			}
			this.#device.queue.writeBuffer(this.#view, at * 4, data, at, OCCLUSION_FLOATS);
		}
		encoder.clearBuffer(this.#counters, 0, (STATS_WORDS + this.#bucketCount * COUNTER_WORDS) * 4);
		const pass = encoder.beginComputePass({ label: 'instance cull' });
		pass.setBindGroup(0, this.#bindGroup(occlusion?.pyramid.view ?? this.#noPyramidView));
		const x = Math.min(this.#itemCount, MAX_GROUPS_X);
		const y = Math.ceil(this.#itemCount / MAX_GROUPS_X);
		pass.setPipeline(write);
		pass.dispatchWorkgroups(x, y);
		pass.setPipeline(args);
		pass.dispatchWorkgroups(Math.ceil(this.#bucketCount / 64));
		pass.end();
		if (!this.#statsCopied && !this.#statsMapping) {
			encoder.copyBufferToBuffer(this.#counters, 0, this.#statsRead, 0, STATS_WORDS * 4);
			this.#statsCopied = true;
		}
	}

	/** maps the stats copied in an earlier frame, which has been submitted since */
	#readStats(): void {
		if (!this.#statsCopied || this.#statsMapping) {
			return;
		}
		this.#statsCopied = false;
		this.#statsMapping = true;
		const buffer = this.#statsRead;
		buffer
			.mapAsync(GPUMapMode.READ)
			.then(() => {
				const stats = new Uint32Array(buffer.getMappedRange());
				this.instances = stats[0];
				this.triangles = stats[1];
				buffer.unmap();
			})
			.catch(() => {})
			.finally(() => {
				this.#statsMapping = false;
			});
	}

	#bindGroup(pyramid: GPUTextureView): GPUBindGroup {
		const targets = this.#targets();
		const bound = this.#bound;
		if (
			this.#group === null ||
			bound.pyramid !== pyramid ||
			bound.rowsVersion !== targets.rowsVersion ||
			bound.rows !== targets.rows ||
			bound.work !== this.#work ||
			bound.counters !== this.#counters
		) {
			bound.rowsVersion = targets.rowsVersion;
			bound.rows = targets.rows;
			bound.work = this.#work;
			bound.counters = this.#counters;
			bound.pyramid = pyramid;
			this.#group = this.#device.createBindGroup({
				label: 'instance cull',
				layout: this.#layout,
				entries: [
					{ binding: 0, resource: { buffer: this.#view } },
					{ binding: 1, resource: { buffer: targets.rows } },
					{ binding: 2, resource: { buffer: targets.blocks } },
					{ binding: 3, resource: { buffer: this.#work } },
					{ binding: 4, resource: { buffer: this.#counters } },
					{ binding: 5, resource: { buffer: targets.list } },
					{ binding: 6, resource: { buffer: targets.drawIds } },
					{ binding: 7, resource: { buffer: this.#indirect } },
					{ binding: 8, resource: pyramid },
				],
			});
		}
		return this.#group;
	}

	#workBuffer(words: number): GPUBuffer {
		return this.#device.createBuffer({
			label: 'instance cull work',
			size: words * 4,
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
		});
	}

	#counterBuffer(buckets: number): GPUBuffer {
		return this.#device.createBuffer({
			label: 'instance cull counters',
			size: (STATS_WORDS + buckets * COUNTER_WORDS) * 4,
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
		});
	}

	#indirectBuffer(buckets: number): GPUBuffer {
		return this.#device.createBuffer({
			label: 'mesh indirect draws',
			size: buckets * INDIRECT_WORDS * 4,
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT,
		});
	}
}
