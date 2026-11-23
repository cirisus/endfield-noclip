import type { ReadyTexture } from '@endfield-noclip/package-format/textures';

import type { TextureBinding, TextureStore } from '../render/textures/texture-store.ts';

import type { StreamManager } from './stream-manager.ts';

/** what texture requests ask of the stream */
export type TextureStream = Pick<StreamManager, 'want' | 'markUsed' | 'isReady' | 'discard'>;

/** what texture requests ask of the texture store */
export type RequestedTextures = Pick<TextureStore, 'streamable' | 'integrated' | 'waiting' | 'blendsLevels'>;

/** how a texture is bound */
export type TextureKind = '2d' | 'cube' | '2d-array' | '3d';

/**
 * requests a texture's pieces down to the piece holding `level`, all at once and coarse first, and keeps the
 * integrated ones in use. a piece that arrives before a coarser one waits in the store, so the levels the
 * view needs take one round trip rather than one per piece; a texture's pieces mostly sit side by side in one
 * archive, so they're usually read together too
 */
const requestPieces = (
	stream: TextureStream,
	textures: RequestedTextures,
	id: number,
	entry: ReadyTexture,
	level: number,
	priority: number,
): void => {
	const pieces = entry.pieces;
	const integrated = textures.integrated(id);
	for (let i = 0; i < pieces.length; i++) {
		const piece = pieces[i];
		const blob = piece.blob;
		if (i < integrated) {
			stream.markUsed(blob);
		} else {
			// a piece left over from before a coarser one was evicted lost its levels: fetch it again
			if (stream.isReady(blob) && !textures.waiting(id, i)) {
				stream.discard(blob);
			}
			stream.want(blob, priority / (1 + i));
		}
		if (piece.firstLevel <= level) {
			break;
		}
	}
};

/** mip levels an unseen material's textures stop short of what its size on screen asks for */
const UNSEEN_LEVELS = 2;
/** the largest level an unseen material's textures load, texels a side */
const UNSEEN_TEXELS = 256;
/** `Math.log2(UNSEEN_TEXELS)` */
const UNSEEN_LOG2 = Math.log2(UNSEEN_TEXELS);

/** requests textures of one texture store, deduplicating repeated requests within a frame */
export class TextureRequests {
	#stream: TextureStream;
	#textures: RequestedTextures;
	/** current frame from {@link beginFrame}, or -1 when deduplication is off */
	#frame = -1;
	/** per texture id: cached 2D entry (`undefined` until first asked) */
	#entries: (ReadyTexture | null | undefined)[] = [];
	/** per texture id: cached `Math.log2(Math.max(width, height))` */
	#log2Side = new Float32Array(0);
	/** per texture id: last frame requested, finest level requested, and highest priority requested */
	#reqFrame = new Int32Array(0);
	#reqLevel = new Uint8Array(0);
	#reqPriority = new Float32Array(0);

	/**
	 * @param stream residency
	 * @param textures the texture store the textures integrate into
	 */
	constructor(stream: TextureStream, textures: RequestedTextures) {
		this.#stream = stream;
		this.#textures = textures;
	}

	/**
	 * starts a new frame's deduplication window so textures shared by multiple buckets only touch the stream
	 * when a finer level or higher priority is needed
	 *
	 * @param frame the current frame number
	 */
	beginFrame(frame: number): void {
		this.#frame = frame;
	}

	/** ensures per-texture caches cover `id` */
	#grow(id: number): void {
		const next = Math.max(id + 1, this.#reqFrame.length * 2, 1024);
		const reqFrame = new Int32Array(next).fill(-1);
		reqFrame.set(this.#reqFrame);
		this.#reqFrame = reqFrame;
		const reqLevel = new Uint8Array(next);
		reqLevel.set(this.#reqLevel);
		this.#reqLevel = reqLevel;
		const reqPriority = new Float32Array(next);
		reqPriority.set(this.#reqPriority);
		this.#reqPriority = reqPriority;
		const log2Side = new Float32Array(next);
		log2Side.set(this.#log2Side);
		this.#log2Side = log2Side;
	}

	/** @returns cached 2D streamable entry for `id`, populating `#log2Side[id]` on first lookup */
	#entry2d(id: number): ReadyTexture | null {
		let entry = this.#entries[id];
		if (entry !== undefined) {
			return entry;
		}
		entry = this.#textures.streamable(id, '2d');
		this.#entries[id] = entry;
		if (entry !== null) {
			if (id >= this.#log2Side.length) {
				this.#grow(id);
			}
			this.#log2Side[id] = Math.log2(Math.max(entry.width, entry.height));
		}
		return entry;
	}

	/** dispatches `requestPieces` unless this frame already requested at least as fine a level and priority */
	#request(id: number, entry: ReadyTexture, level: number, priority: number): void {
		const frame = this.#frame;
		if (frame >= 0) {
			if (id >= this.#reqFrame.length) {
				this.#grow(id);
			}
			if (this.#reqFrame[id] === frame) {
				if (level >= this.#reqLevel[id] && priority <= this.#reqPriority[id]) {
					return;
				}
				if (level < this.#reqLevel[id]) {
					this.#reqLevel[id] = level;
				}
				if (priority > this.#reqPriority[id]) {
					this.#reqPriority[id] = priority;
				}
			} else {
				this.#reqFrame[id] = frame;
				this.#reqLevel[id] = level;
				this.#reqPriority[id] = priority;
			}
		}
		requestPieces(this.#stream, this.#textures, id, entry, level, priority);
	}

	/**
	 * requests a 2D texture's pieces coarse to fine, up to the level its largest on-screen use needs: about one
	 * texel per pixel across the object, scaled by how often the UVs tile
	 *
	 * @param id texture id
	 * @param pixels the use's on-screen size, px
	 * @param uvScale how often the UVs tile across the object
	 * @param priority the priority
	 */
	forPixels(id: number, pixels: number, uvScale: number, priority: number): void {
		const entry = this.#entry2d(id);
		if (entry === null) {
			return;
		}
		const texels = Math.max(entry.width, entry.height) * uvScale;
		const level = Math.min(
			entry.mipCount - 1,
			Math.max(0, Math.floor(Math.log2(texels / Math.max(pixels, 1)))),
		);
		this.#request(id, entry, level, priority);
	}

	/**
	 * requests the coarse levels of a 2D texture whose material is drawn but had no pixel read back (hidden
	 * behind something, or about to show): {@link UNSEEN_LEVELS} coarser than {@link forPixels} would, and no
	 * level over {@link UNSEEN_TEXELS} a side, so that what comes into sight isn't a smear while its levels
	 * load
	 *
	 * @param id texture id
	 * @param pixels the use's on-screen size, px
	 * @param uvScale how often the UVs tile across the object
	 * @param priority the priority
	 */
	forUnseen(id: number, pixels: number, uvScale: number, priority: number): void {
		const entry = this.#entry2d(id);
		if (entry === null) {
			return;
		}
		const side = Math.max(entry.width, entry.height);
		const log2Side = this.#log2Side[id];
		const level = Math.min(
			entry.mipCount - 1,
			Math.max(
				0,
				Math.floor(Math.log2((side * uvScale) / Math.max(pixels, 1))) + UNSEEN_LEVELS,
				Math.ceil(log2Side - UNSEEN_LOG2),
			),
		);
		this.#request(id, entry, level, priority);
	}

	/**
	 * requests a 2D texture's pieces coarse to fine, up to the finest level the frames just drawn sampled
	 *
	 * @param id texture id
	 * @param steps how many quarter mip levels below one UV unit per pixel the finest sample's footprint was
	 *   (`MipSteps.steps`)
	 * @param uvScale how often the material tiles the texture across a UV unit
	 * @param bias mip levels coarser than sampled to stop at
	 * @param priority the priority
	 */
	forFootprint(id: number, steps: number, uvScale: number, bias: number, priority: number): void {
		const entry = this.#entry2d(id);
		if (entry === null) {
			return;
		}
		// the level of detail the GPU computes: the footprint in texels of the longer side, which also holds for
		// the shorter
		const lod =
			(uvScale === 1 ? this.#log2Side[id] : Math.log2(Math.max(entry.width, entry.height) * uvScale)) -
			steps * 0.25;
		// a sampler that blends neighbouring levels reads the finer of the two; one that doesn't rounds
		const sampled = Math.floor(this.#textures.blendsLevels(id) ? lod : lod + 0.5);
		const level = Math.min(entry.mipCount - 1, Math.max(0, sampled + Math.ceil(bias)));
		this.#request(id, entry, level, priority);
	}

	/**
	 * requests every level of a texture, as {@link streamWholeTexture} does
	 *
	 * @param id texture id, or `null` for none
	 * @param kind the kind it's bound as
	 * @param priority the priority
	 * @returns the texture, or `null` without a texture streamable as that kind
	 */
	whole(id: number | null, kind: TextureKind, priority: number): ReadyTexture | null {
		if (id === null) {
			return null;
		}
		const entry = this.#textures.streamable(id, kind);
		if (entry !== null) {
			this.#request(id, entry, 0, priority);
		}
		return entry;
	}
}

/** a texture streamed whole by {@link streamWholeTexture} */
export interface StreamedTexture {
	entry: ReadyTexture;
	/** `null` until its tail arrives */
	binding: TextureBinding | null;
}

/**
 * requests every level of a texture (sky and water textures, which aren't picked by screen size).
 *
 * @param request the stream, the texture store, the texture id (or `null` for none), the kind it's bound as
 *   and the priority
 * @returns the texture and its current binding, or `null` without a texture streamable as that kind
 */
export const streamWholeTexture = (request: {
	stream: TextureStream;
	textures: TextureStore;
	id: number | null;
	kind: TextureKind;
	priority: number;
}): StreamedTexture | null => {
	const { stream, textures, id, kind, priority } = request;
	if (id === null) {
		return null;
	}
	const entry = textures.streamable(id, kind);
	if (entry === null) {
		return null;
	}
	requestPieces(stream, textures, id, entry, 0, priority);
	return { entry, binding: textures.binding(id) };
};
