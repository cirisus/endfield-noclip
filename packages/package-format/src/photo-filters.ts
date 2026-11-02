import type { BloomSettings, ColorGradingConfig, VignetteSettings } from './environment.ts';
import type { ParticleSystemInfo } from './particles.ts';
import type { TextureSampler } from './textures.ts';

/** a separately exported photo library; scene package versions are unchanged */
export interface PhotoFilters {
	/** separate from the scene package contract */
	format: 'endfield-noclip.photo-filters';
	/** incompatible photo-library changes increment this version */
	version: 2;
	/** table order, with names resolved from the install */
	filters: PhotoFilter[];
}

/** one authored photo look; game content is supplied by the local extractor */
export interface PhotoFilter {
	/** the install's snapshot filter id */
	id: string;
	/** localized display name, falling back to id */
	name: string;
	/** unsupported parts are reported even when the colour look can be previewed */
	unsupported: string[];
	/** replaces the scene's grading when present */
	grading: ColorGradingConfig | null;
	/** only the SRP fields whose override flag is set */
	vignette: Partial<VignetteSettings> | null;
	/** only overridden high-quality bloom parameters; absent in older exports */
	bloom?: Partial<
		Pick<
			BloomSettings,
			| 'resolutionHighQuality'
			| 'thresholdHighQuality'
			| 'intensityHighQuality'
			| 'scatterHighQuality'
			| 'tint'
			| 'blendMode'
		>
	> | null;
	/** stationary effects spawned at the camera when this look is first selected */
	effects?: PhotoEffect[];
	/** external colour cube; absent when the authored look has no lookup */
	lut: {
		/** WebGPU sampling format, without automatic sRGB decoding */
		format: 'bc7-rgba-unorm';
		/** cube edge; the strip is size² × size, red along x, green along y, blue across slices */
		size: number;
		/** base64 of the GPU-ready top mip, without a container */
		data: string;
		/** authored blend weight in display-colour space, 0–1 */
		contribution: number;
	} | null;
}

/** a simple additive, view-aligned particle emitter, evaluated by the shared particle kernel */
export interface PhotoEffect {
	/** prefab renderer name, for deterministic random seeds */
	name: string;
	/** emitter-to-prefab transform, column-major */
	matrix: number[];
	/** current scene particle settings; only free motion without gravity or clamping is supported */
	particles: ParticleSystemInfo;
	/** linear HDR tint including intensity; alpha includes the material's opacity */
	tint: [number, number, number, number];
	/** cancels post exposure for emission, as the source material requests */
	ignorePostExposure: boolean;
	/** mip chain passed to WebGPU without transcoding; each level is base64 encoded */
	texture: {
		width: number;
		height: number;
		format: 'bc7-rgba-unorm' | 'bc7-rgba-unorm-srgb';
		sampler: TextureSampler;
		levels: string[];
	};
}
