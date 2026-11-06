// composites the main pass into the HDR scene: screen-space reflections, ambient occlusion on the ambient
// part, the sky where nothing was drawn with the nebula and planets beyond it, the transparent layers, the
// atmosphere fog and the two-layer height fog, then the transparent pass's glow. see
// docs/game-data/sky-and-fog.md. needs post-common.wgsl, atmosphere.wgsl and sky.wgsl.

@group(2) @binding(0) var radiance_texture: texture_2d<f32>;
@group(2) @binding(1) var ambient_texture: texture_2d<f32>;
@group(2) @binding(2) var ao_texture: texture_2d<f32>;
@group(2) @binding(3) var depth_texture: texture_depth_2d;
// what the screen-space reflections change in the radiance (ssr.wgsl)
@group(2) @binding(6) var ssr_texture: texture_2d<f32>;
// the transparent pass's weighted sum and revealage (`TRANSPARENT_TARGETS` in render-targets.ts)
@group(2) @binding(7) var transparent_texture: texture_2d<f32>;
@group(2) @binding(8) var revealage_texture: texture_2d<f32>;
// the transparent pass's additive light, added after the fog: the game's additive effects fog themselves, if
// at all, at their own distance, which the composite doesn't know. alpha holds the weight of the unfogged
// layers in the weighted sum
@group(2) @binding(10) var glow_texture: texture_2d<f32>;
// the sky planets, cloud panorama, nebula and stars over the sky: s · (1 − a) + rgb (celestial.wgsl)
@group(2) @binding(9) var celestial_texture: texture_2d<f32>;

// Jimenez et al.'s multi-bounce fit: occluded light that bounces off a bright surface comes back, so bright
// surfaces darken less than `ao`. per channel in the game; here from the albedo's luminance
fn multi_bounce(ao: f32, albedo: f32) -> f32 {
	let a = 2.0404 * albedo - 0.3324;
	let b = -4.7951 * albedo + 0.6417;
	let c = 2.7552 * albedo + 0.6903;
	return max(ao, ((a * ao + b) * ao + c) * ao);
}

// the transparent layers' weighted, compressed distances (`layer_distance_code` in frame.wgsl)
@group(2) @binding(11) var layer_distance_texture: texture_2d<f32>;
// the nearest water surface's depth in front of the scene, 0 where there's none (`fs_water_depth` in water.wgsl)
@group(2) @binding(12) var water_depth_texture: texture_depth_2d;

// the transparent layers to lay over the scene here: none where there's water, which lays them over itself
fn layers_at(px: vec2i) -> Layers {
	let layers = resolve_layers(textureLoad(transparent_texture, px, 0), textureLoad(revealage_texture, px, 0).r,
		textureLoad(glow_texture, px, 0).a, textureLoad(layer_distance_texture, px, 0).r);
	if (water_takes_layers(layers, textureLoad(water_depth_texture, px, 0))) {
		return NO_LAYERS;
	}
	return layers;
}

// the height fog's flow noise (one channel, in red) and its repeating sampler
@group(3) @binding(0) var flow_noise_texture: texture_3d<f32>;
@group(3) @binding(1) var flow_noise_sampler: sampler;

// the game's drifting fog on surfaces: scrolling noise at the surface's world position sways how much of the
// fog it gets, from none to up to twice as much, less with distance. `transmittance` is what the fog lets
// through of the surface, which bounds how far past the fogged colour the mix may go
fn drift_fog(unfogged: vec3f, fogged: vec3f, transmittance: vec3f, position: vec3f, distance: f32) -> vec3f {
	let strength = post.flow_noise.w * clamp(1.0 - distance * post.flow_noise_scale.y, 0.0, 1.0);
	if (strength <= 0.0) {
		return fogged;
	}
	let noise = textureSampleLevel(flow_noise_texture, flow_noise_sampler,
		position * post.flow_noise_scale.x + post.flow_noise.xyz, 0.0).r;
	let amount = min(1.0 - strength + 2.0 * noise * strength, 1.0 + dot(transmittance, vec3f(1.0 / 3.0)));
	return mix(unfogged, fogged, amount);
}

fn glow(px: vec2i) -> vec3f {
	return max(textureLoad(glow_texture, px, 0).rgb, vec3f(0.0));
}

// the reflections' change to the radiance, upsampled bilinearly from their smaller size
fn reflection_change(px: vec2i) -> vec3f {
	let size = vec2i(textureDimensions(ssr_texture));
	let at = (vec2f(px) + 0.5) * vec2f(size) / post.viewport.xy - 0.5;
	let base = vec2i(floor(at));
	let f = at - floor(at);
	let edge = size - 1;
	let a = textureLoad(ssr_texture, clamp(base, vec2i(0), edge), 0).rgb;
	let b = textureLoad(ssr_texture, clamp(base + vec2i(1, 0), vec2i(0), edge), 0).rgb;
	let c = textureLoad(ssr_texture, clamp(base + vec2i(0, 1), vec2i(0), edge), 0).rgb;
	let d = textureLoad(ssr_texture, clamp(base + vec2i(1, 1), vec2i(0), edge), 0).rgb;
	return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

@fragment
fn fs_composite(in: FullscreenOut) -> @location(0) vec4f {
	let px = vec2i(in.position.xy);
	let depth = textureLoad(depth_texture, px, 0);
	let ray = view_ray(in.uv);
	let direction = normalize(ray);
	let layers = layers_at(px);
	if (depth <= 0.0) {
		let celestial = textureLoad(celestial_texture, px, 0);
		// the `clouds` debug view: the raw panorama, unfogged
		if (post.cloud.w > 0.5 && post.cloud_shape.w > 0.5) {
			return vec4f(mix(celestial.rgb, layers.mean, layers.coverage) + glow(px), 1.0);
		}
		let froxels = froxels_at(in.uv, post.sky_fog.x * dot(direction, post.forward.xyz));
		let sky = sky_radiance(direction) * (1.0 - celestial.a) + celestial.rgb;
		let fog = fog_over(direction, post.sky_fog.x, froxels);
		return vec4f(over_layers(sky * fog.transmittance + fog.inscatter, layers, in.uv, direction) + glow(px), 1.0);
	}
	let radiance = textureLoad(radiance_texture, px, 0);
	var color = max(radiance.rgb + reflection_change(px), vec3f(0.0));
	// the AO passes don't run while it's off, and the radiance then keeps the material occlusion alone
	if (post.ao.w > 0.5) {
		let ambient = textureLoad(ambient_texture, px, 0);
		let ao = min(textureLoad(ao_texture, px, 0).r, ambient.a);
		color = max(color + ambient.rgb * (multi_bounce(ao, radiance.a) - ambient.a), vec3f(0.0));
	}
	let eye_depth = view_depth(depth);
	let distance = length(ray * eye_depth);
	let fog = fog_over(direction, distance, froxels_at(in.uv, eye_depth));
	let fogged = drift_fog(color, color * fog.transmittance + fog.inscatter, fog.transmittance,
		post.eye.xyz + ray * eye_depth, distance);
	return vec4f(over_layers(fogged, layers, in.uv, direction) + glow(px), 1.0);
}
