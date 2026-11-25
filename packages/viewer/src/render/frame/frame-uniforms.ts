/**
 * the WGSL every family shares: `frame.wgsl`'s `Frame` struct and lighting helpers, with the TS constants
 * they read. the struct's layout and writer are in `frame-uniform-writer.ts`.
 *
 * @module
 */

import { BLOCK_SLOT_BITS } from '../../content/instance-rows.ts';
import clipmapWgsl from '../lighting/irradiance-clipmap.wgsl?raw';
import { LOCAL_LIGHTS_WGSL } from '../lighting/local-lights.ts';
import gbufferWgsl from '../shaders/common/gbuffer.wgsl?raw';
import luminanceWgsl from '../shaders/common/luminance.wgsl?raw';
import noiseWgsl from '../shaders/common/noise.wgsl?raw';
import octahedralWgsl from '../shaders/common/octahedral.wgsl?raw';
import phaseWgsl from '../shaders/common/phase.wgsl?raw';
import { wgslConst } from '../shaders/wgsl-const.ts';

import brdfWgsl from './brdf.wgsl?raw';
import frameCoreWgsl from './frame-core.wgsl?raw';
import frameLightingWgsl from './frame-lighting.wgsl?raw';

/** WGSL source of the frame uniforms, instance row helpers and G-buffer packing (no lighting) */
export const FRAME_CORE_WGSL = [
	wgslConst('BLOCK_SLOT_BITS', 'u32', BLOCK_SLOT_BITS),
	brdfWgsl,
	noiseWgsl,
	luminanceWgsl,
	octahedralWgsl,
	gbufferWgsl,
	frameCoreWgsl,
].join('\n');

/** WGSL source of {@link FRAME_CORE_WGSL} plus the shared shadow, IBL, irradiance and local-light helpers */
export const FRAME_WGSL = [
	FRAME_CORE_WGSL,
	LOCAL_LIGHTS_WGSL,
	phaseWgsl,
	clipmapWgsl,
	frameLightingWgsl,
].join('\n');
