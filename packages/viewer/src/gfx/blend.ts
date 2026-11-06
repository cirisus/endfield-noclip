/**
 * blend components and states the pipelines share
 *
 * @module
 */

/** source plus destination */
export const ADD: GPUBlendComponent = { srcFactor: 'one', dstFactor: 'one', operation: 'add' };

/** the destination as it is: for a channel a pass leaves alone while blending the others */
export const KEEP: GPUBlendComponent = { srcFactor: 'zero', dstFactor: 'one', operation: 'add' };

/** premultiplied source over the destination */
export const PREMULTIPLIED_OVER: GPUBlendComponent = {
	srcFactor: 'one',
	dstFactor: 'one-minus-src-alpha',
	operation: 'add',
};

/** straight-alpha source over the destination */
export const ALPHA_OVER: GPUBlendComponent = {
	srcFactor: 'src-alpha',
	dstFactor: 'one-minus-src-alpha',
	operation: 'add',
};

/** {@link ADD} on every channel */
export const ADDITIVE: GPUBlendState = { color: ADD, alpha: ADD };
