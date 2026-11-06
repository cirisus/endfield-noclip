import {
	type FullscreenPass,
	autoBindGroup,
	encodeFullscreen,
	fullscreenPipeline,
} from '../../gfx/fullscreen-pass.ts';
import { HDR_FORMAT } from '../frame/render-targets.ts';
import { postShaderModule } from '../post/shader-source.ts';

import atmosphereWgsl from './atmosphere.wgsl?raw';

/** group 1 bindings of atmosphere.wgsl and sky.wgsl */
export const SkyBinding = {
	transmittance: 0,
	multiScattering: 1,
	skyView: 2,
	sampler: 3,
	froxels: 5,
} as const;

/** owns the atmosphere's lookup tables (atmosphere.wgsl) and the passes that build them */
export class AtmosphereLuts {
	/** the sky-view LUT, which sky.wgsl samples; rebuilt each frame the sky shows */
	readonly skyView: GPUTextureView;
	#textures: GPUTexture[];
	#passes: Record<'transmittance' | 'multiScattering' | 'skyView', FullscreenPass>;
	/** whether the transmittance and multiple-scattering LUTs hold the current environment */
	#ready = false;

	/**
	 * @param device the device
	 * @param postUniforms the post chain's `Post` uniforms, which hold the atmosphere
	 * @param sampler the bilinear clamping sampler the LUTs are read with
	 */
	constructor(device: GPUDevice, postUniforms: GPUBuffer, sampler: GPUSampler) {
		const lut = (label: string, width: number, height: number): GPUTexture =>
			device.createTexture({
				label,
				size: [width, height],
				format: HDR_FORMAT,
				usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
			});
		const transmittance = lut('transmittance lut', 256, 64);
		const multiScattering = lut('multiple scattering lut', 32, 32);
		const skyView = lut('sky view lut', 192, 108);
		this.#textures = [transmittance, multiScattering, skyView];
		const views = {
			transmittance: transmittance.createView(),
			multiScattering: multiScattering.createView(),
			skyView: skyView.createView(),
		};
		this.skyView = views.skyView;
		const module = postShaderModule(device, 'atmosphere', [atmosphereWgsl]);
		const resources: Record<number, GPUBindingResource> = {
			[SkyBinding.transmittance]: views.transmittance,
			[SkyBinding.multiScattering]: views.multiScattering,
			[SkyBinding.sampler]: sampler,
		};
		const pass = (
			label: string,
			entryPoint: string,
			target: GPUTextureView,
			reads: readonly number[],
		): FullscreenPass => {
			const pipeline = fullscreenPipeline(device, {
				label,
				module,
				entryPoint,
				targets: [{ format: HDR_FORMAT }],
			});
			const groups = [autoBindGroup(device, pipeline, 0, { 0: { buffer: postUniforms } })];
			// an `auto` layout has only the bindings the pass reads
			if (reads.length > 0) {
				groups.push(
					autoBindGroup(
						device,
						pipeline,
						1,
						Object.fromEntries(reads.map((binding) => [binding, resources[binding]])),
					),
				);
			}
			return { label, pipeline, groups, targets: [target] };
		};
		const B = SkyBinding;
		this.#passes = {
			transmittance: pass('transmittance lut', 'fs_transmittance', views.transmittance, []),
			multiScattering: pass('multiple scattering lut', 'fs_multi_scattering', views.multiScattering, [
				B.transmittance,
				B.sampler,
			]),
			skyView: pass('sky view lut', 'fs_sky_view', views.skyView, [
				B.transmittance,
				B.multiScattering,
				B.sampler,
			]),
		};
	}

	/** rebuilds the LUTs on the next {@link encode}, after the atmosphere changed */
	invalidate(): void {
		this.#ready = false;
	}

	/**
	 * encodes the LUTs that are out of date: the transmittance and multiple scattering once per atmosphere, the
	 * sky view each frame the sky shows (it follows the camera's height and the sun)
	 *
	 * @param encoder this frame's encoder, after the post uniforms are written
	 * @param sky whether the sky shows
	 */
	encode(encoder: GPUCommandEncoder, sky: boolean): void {
		if (!this.#ready) {
			encodeFullscreen(encoder, this.#passes.transmittance);
			encodeFullscreen(encoder, this.#passes.multiScattering);
			this.#ready = true;
		}
		// the atmosphere fog is analytic; only the sky reads the LUTs
		if (sky) {
			encodeFullscreen(encoder, this.#passes.skyView);
		}
	}

	/** frees the LUTs */
	destroy(): void {
		for (const texture of this.#textures) {
			texture.destroy();
		}
	}
}
