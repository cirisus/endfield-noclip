import type { ColorGradingConfig, VignetteSettings } from './environment.ts';

/** a separately exported photo library; scene package versions are unchanged */
export interface PhotoFilters {
	/** separate from the scene package contract */
	format: 'endfield-noclip.photo-filters';
	/** incompatible photo-library changes increment this version */
	version: 1;
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
