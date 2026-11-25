// composites the deferred-lit scene into the HDR scene: sky radiance with celestial layers on sky pixels,
// and atmosphere fog + two-layer height fog + volumetric fog + drifting flow noise on all pixels. transparent
// things draw over the result, fogging themselves. see docs/game-data/sky-and-fog.md. needs post-common.wgsl,
// atmosphere.wgsl, fog.wgsl and sky.wgsl.

// sky pixels: nebula/planets/clouds (celestial.wgsl); surface pixels: deferred-lit HDR radiance
@group(2) @binding(0) var lit_texture: texture_2d<f32>;
@group(2) @binding(1) var depth_texture: texture_depth_2d;

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

@fragment
fn fs_composite(in: FullscreenOut) -> @location(0) vec4f {
	let px = vec2i(in.position.xy);
	let depth = textureLoad(depth_texture, px, 0);
	let ray = view_ray(in.uv);
	let direction = normalize(ray);
	let lit = textureLoad(lit_texture, px, 0);
	if (depth <= 0.0) {
		// the `clouds` debug view: the raw panorama, unfogged
		if (post.cloud.w > 0.5 && post.cloud_shape.w > 0.5) {
			return vec4f(lit.rgb, 1.0);
		}
		let froxels = froxels_at(in.uv, post.sky_fog.x * dot(direction, post.forward.xyz));
		let sky = sky_radiance(direction) * (1.0 - lit.a) + lit.rgb;
		let fog = fog_over(direction, post.sky_fog.x, froxels);
		return vec4f(sky * fog.transmittance + fog.inscatter, 1.0);
	}
	let color = lit.rgb;
	let eye_depth = view_depth(depth);
	let distance = length(ray * eye_depth);
	let fog = fog_over(direction, distance, froxels_at(in.uv, eye_depth));
	let fogged = drift_fog(color, color * fog.transmittance + fog.inscatter, fog.transmittance,
		post.eye.xyz + ray * eye_depth, distance);
	return vec4f(fogged, 1.0);
}
