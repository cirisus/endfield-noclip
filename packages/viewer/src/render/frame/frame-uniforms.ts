/**
 * the WGSL every family shares: `frame.wgsl`'s `Frame` struct and lighting helpers, with the TS constants
 * they read. the struct's layout and writer are in `frame-uniform-writer.ts`.
 *
 * @module
 */

import { BLOCK_SLOT_BITS } from '../../content/instance-rows.ts';
import clipmapWgsl from '../lighting/irradiance-clipmap.wgsl?raw';
import { LOCAL_LIGHTS_WGSL } from '../lighting/local-lights.ts';
import luminanceWgsl from '../shaders/common/luminance.wgsl?raw';
import noiseWgsl from '../shaders/common/noise.wgsl?raw';
import octahedralWgsl from '../shaders/common/octahedral.wgsl?raw';
import phaseWgsl from '../shaders/common/phase.wgsl?raw';
import reflectionSurfaceWgsl from '../shaders/common/reflection-surface.wgsl?raw';
import { wgslConst } from '../shaders/wgsl-const.ts';

import brdfWgsl from './brdf.wgsl?raw';
import frameWgsl from './frame.wgsl?raw';

/** the TS constants frame.wgsl reads */
const CONSTANTS_WGSL = [LOCAL_LIGHTS_WGSL, wgslConst('BLOCK_SLOT_BITS', 'u32', BLOCK_SLOT_BITS)].join('\n');

/** WGSL source of the frame uniforms and shared lighting helpers, prepended to every family */
export const FRAME_WGSL = [
	CONSTANTS_WGSL,
	brdfWgsl,
	noiseWgsl,
	luminanceWgsl,
	phaseWgsl,
	octahedralWgsl,
	reflectionSurfaceWgsl,
	clipmapWgsl,
	frameWgsl,
].join('\n');
