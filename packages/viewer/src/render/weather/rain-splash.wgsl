// ground rain splashes projected onto exposed surfaces via the vertical occlusion depth map
// (HGRP/Rain/RainSplash).
// needs FRAME_WGSL and postCommonSource(1, 0).

struct WeatherParams {
	// camera-relative (centerX, topRelY, centerZ, 1 / (2 · range))
	occ_origin: vec4f,
	// (1 / height, height, texelWorldSize, active)
	occ_metrics: vec4f,
	// linear RGB + alpha
	color: vec4f,
	// (splashRange, splashTime, sizeMin, sizeMax)
	params0: vec4f,
	// (cols, 1 / cols, yBias, countNorm)
	params1: vec4f,
	// (lightingPercent, 0, 0, 0)
	params2: vec4f,
	params3: vec4f,
	params4: vec4f,
	basis0: vec4f,
	basis1: vec4f,
	basis2: vec4f,
	pad0: vec4f,
	pad1: vec4f,
	pad2: vec4f,
	pad3: vec4f,
	pad4: vec4f,
}

@group(2) @binding(0) var<uniform> weather: WeatherParams;
@group(2) @binding(1) var vertical_occlusion: texture_depth_2d;
@group(2) @binding(2) var vertical_occlusion_compare: sampler_comparison;
@group(2) @binding(3) var vertical_occlusion_raw: sampler;
@group(2) @binding(4) var weather_tex: texture_2d<f32>;
@group(2) @binding(5) var weather_sampler: sampler;

struct SplashIn {
	@location(0) center: vec2f,
	@location(1) corner: vec2f,
	@location(2) rand: vec2f,
}

struct SplashOut {
	@builtin(position) position: vec4f,
	@location(0) rel: vec3f,
	@location(1) uv: vec2f,
	@location(2) info: vec2f,
}

@vertex
fn vs_splash(in: SplashIn) -> SplashOut {
	var out: SplashOut;
	if (in.rand.x > weather.params1.w || weather.occ_metrics.w < 0.5) {
		out.position = vec4f(0.0, 0.0, 2.0, 1.0);
		return out;
	}
	let range = weather.params0.x;
	let span = range * 2.0;
	let t = (weather.params0.y + fract(in.rand.x * 32.0)) * (1.0 + (fract(in.rand.y * 128.0) * 2.0 - 1.0) * 0.3);
	let cycle = fract(floor(t) * 0.1);
	let jitter_xz = (in.center * 2.0 + (in.rand.y * 2.0 - 1.0) * 0.2 +
		(vec2f(fract(cycle + in.rand.x), fract(cycle - in.rand.x)) * 2.0 - 1.0) * 0.2) * range;

	let eye_xz = frame.eye.xz;
	let grid = floor(eye_xz / span) * span;
	let wrap_xz = jitter_xz + step(jitter_xz + range, eye_xz - grid) * span + grid;
	let rel_xz = wrap_xz - eye_xz;

	let occ_uv = vec2f(
		0.5 + (rel_xz.x - weather.occ_origin.x) * weather.occ_origin.w,
		0.5 - (rel_xz.y - weather.occ_origin.z) * weather.occ_origin.w,
	);
	if (any(occ_uv <= vec2f(0.0)) || any(occ_uv >= vec2f(1.0))) {
		out.position = vec4f(0.0, 0.0, 2.0, 1.0);
		return out;
	}
	let raw_depth = textureSampleLevel(vertical_occlusion, vertical_occlusion_raw, occ_uv, 0.0);
	if (raw_depth >= 0.9999) {
		out.position = vec4f(0.0, 0.0, 2.0, 1.0);
		return out;
	}
	let size = mix(weather.params0.z, weather.params0.w, in.rand.x);
	let surface_rel_y = weather.occ_origin.y - raw_depth * weather.occ_metrics.y + weather.params1.z * size;
	let splash_rel = vec3f(rel_xz.x, surface_rel_y, rel_xz.y);

	let cols = weather.params1.x;
	let inv_cols = weather.params1.y;
	let total_frames = cols * cols;
	let frame_idx = floor(fract(t) * total_frames);
	let f_col = frame_idx - cols * trunc(frame_idx / cols);
	let f_row = (cols - 1.0) - floor(frame_idx * inv_cols);

	var fwd = vec3f(frame.view_forward.x, 0.0, frame.view_forward.z);
	fwd = fwd * inverseSqrt(max(1e-20, dot(fwd, fwd)));
	let right = cross(fwd, vec3f(0.0, 1.0, 0.0));
	let vert_rel = splash_rel + right * (in.corner.x * size) + vec3f(0.0, in.corner.y * size, 0.0);

	let norm_d = splash_rel / range;
	let dist_fade = max(1.0 - saturate(dot(norm_d, norm_d)), 0.5);

	out.position = frame.view_proj * vec4f(vert_rel, 1.0);
	out.rel = vert_rel;
	out.uv = saturate(in.corner) * inv_cols + vec2f(f_col * inv_cols, f_row * inv_cols);
	out.info = vec2f(dist_fade, fract(in.rand.x + cycle));
	return out;
}

@fragment
fn fs_splash(in: SplashOut) -> @location(0) vec4f {
	let tex = textureSampleLevel(weather_tex, weather_sampler, in.uv, 0.0);
	let ch = in.info.y * 3.0;
	let shape = mix(mix(tex.r, tex.g, step(1.0, ch)), tex.b, step(2.0, ch));
	let base_alpha = weather.color.a * shape * in.info.x;
	if (base_alpha <= 0.0005) {
		discard;
	}

	let lighting_pct = weather.params2.x;
	var rgb = weather.color.rgb;
	var alpha = base_alpha;
	if (lighting_pct > 0.001) {
		let n = -normalize(in.rel);
		let v = n;
		let world_pos = frame.eye.xyz + in.rel;
		let irradiance = ambient_irradiance(world_pos, n);
		let r = reflect(-v, n);
		let refl = sample_reflection(world_pos, n, r, 1.0, irradiance) * (frame.ambient.x * 0.015696);
		let n_dot_l = saturate(dot(n, frame.sun.xyz));
		let sun_direct = (weather.color.rgb / PI) * n_dot_l * frame.sun_color.rgb * sun_visibility_far(in.rel, n) * frame.sun.w;
		var s: Surface;
		s.albedo = weather.color.rgb;
		s.normal = n;
		s.roughness = 1.0;
		s.metallic = 0.0;
		s.f0 = 0.04;
		s.occlusion = 1.0;
		s.emission = vec3f(0.0);
		s.scatter = vec4f(0.0);
		s.scatter_indirect = 0.0;
		s.foliage = false;
		s.transmission = 0.0;
		s.subsurface = 0.0;
		s.sun_shadow = 1.0;
		s.sun_n_dot_l = -1.0;
		let local_direct = local_lighting(s, v, in.rel, in.position.xy, weather.color.rgb, vec3f(0.04), 1.0);
		let lit = irradiance * weather.color.rgb + refl + sun_direct + local_direct;
		rgb = mix(weather.color.rgb, lit, lighting_pct * base_alpha);
		alpha = mix(base_alpha, dot(vec3f(0.299, 0.587, 0.114), lit) * base_alpha, lighting_pct);
	}
	return vec4f(rgb, saturate(alpha));
}
