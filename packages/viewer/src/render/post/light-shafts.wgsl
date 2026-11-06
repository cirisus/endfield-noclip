// the game's screen-space sun shafts (HGRP/PostProcessing/LightShaft, Unreal's light shaft bloom): the bright,
// far parts of the composited scene near the sun are kept at a reduced size, blurred towards the sun's position
// on screen over a few passes, and added back onto the scene. needs post-common.wgsl and
// shaders/common/luminance.wgsl.

struct Shafts {
	// 1 / occlusion depth range (per m), bloom scale, occlusion mask darkness (unused here), bloom max brightness
	params: vec4f,
	// bloom tint (raw), w = bloom threshold
	tint: vec4f,
	// the sun on screen (uv, 0 at the top-left), samples per blur pass, blur intensity
	sun: vec4f,
}

@group(0) @binding(1) var<uniform> shafts: Shafts;
@group(0) @binding(2) var bilinear: sampler;

@group(1) @binding(0) var scene_texture: texture_2d<f32>;
@group(1) @binding(1) var depth_texture: texture_depth_2d;

// the bloom source at the reduced size: what's brighter than the threshold, rescaled to keep its colour, faded
// towards the screen's edges and away from the sun, and only where the scene is farther than half the
// occlusion depth range
@fragment
fn fs_downsample(in: FullscreenOut) -> @location(0) vec4f {
	let uv = in.uv;
	let color = max(textureSampleLevel(scene_texture, bilinear, uv, 0.0).rgb, vec3f(0.0));
	let edge = 1.0 - uv.x * (1.0 - uv.x) * uv.y * (1.0 - uv.y) * 8.0;
	let edge2 = edge * edge;
	// the game's own luminance weights, kept off zero
	let luma = max(dot(color, LUMINANCE), 6.1035156e-5);
	let toward_sun = 1.0 - clamp(length(shafts.sun.xy - uv) * 2.0, 0.0, 1.0);
	let size = vec2f(textureDimensions(depth_texture));
	let texel = vec2i(clamp(uv * size, vec2f(0.0), size - 1.0));
	let depth = view_depth(textureLoad(depth_texture, texel, 0));
	let far = clamp((depth - 0.5 / shafts.params.x) * shafts.params.x, 0.0, 1.0);
	let bloom = color * shafts.params.y / luma * clamp(luma - shafts.tint.w, 0.0, shafts.params.w) * 2.0 *
		shafts.tint.rgb;
	return vec4f(bloom * far * (1.0 - edge2 * edge2) * toward_sun * toward_sun, 1.0);
}

// x = this blur pass's index; each pass reaches further towards the sun
@group(1) @binding(2) var<uniform> blur_pass: vec4f;
@group(1) @binding(3) var blur_source: texture_2d<f32>;

// one radial blur pass: the mean of evenly spaced samples on the way to the sun
@fragment
fn fs_blur(in: FullscreenOut) -> @location(0) vec4f {
	let samples = shafts.sun.z;
	let reach = min(shafts.sun.w * 0.1 * pow(0.4 * samples, blur_pass.x), 1.0);
	let step = (shafts.sun.xy - in.uv) * reach / samples;
	var sum = vec3f(0.0);
	for (var i = 0.0; i < samples; i += 1.0) {
		sum += textureSampleLevel(blur_source, bilinear, in.uv + step * i, 0.0).rgb;
	}
	return vec4f(sum / samples, 1.0);
}

// the blurred shafts, added onto the scene by the pipeline's blend
@fragment
fn fs_apply(in: FullscreenOut) -> @location(0) vec4f {
	return vec4f(textureSampleLevel(blur_source, bilinear, in.uv, 0.0).rgb, 0.0);
}
