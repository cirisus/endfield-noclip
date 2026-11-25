// middle rain, far rain curtains, and distant rain waves (HGRP/Rain/FarRain).
// needs FRAME_WGSL, postCommonSource(1, 0), and fogSource({ group: 1, binding: 1 }).

@group(1) @binding(2) var lut_sampler: sampler;
@group(1) @binding(3) var scene_depth: texture_depth_2d;

struct WeatherParams {
	// camera-relative (centerX, topRelY, centerZ, 1 / (2 · range))
	occ_origin: vec4f,
	// (1 / height, height, texelWorldSize, active)
	occ_metrics: vec4f,
	// linear RGB + alpha
	color: vec4f,
	// far/mid rain: (uvFlowOffset, lengthScale, intensity01, 0)
	// rain wave:    (offsetX0, offsetY0, offsetX1, offsetY1)
	params0: vec4f,
	// far/mid rain: (st.x, st.y, lightingPercent, occlusionRange)
	// rain wave:    (0, 0, 0, occlusionRange)
	params1: vec4f,
	// (isWave > 0.5, bottomFadeFactor, 0, 0)
	params2: vec4f,
	// rain wave tex0 ST
	params3: vec4f,
	// rain wave noise ST
	params4: vec4f,
	// tilted cylinder basis columns (scaled by radius, height, radius)
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

struct FarRainIn {
	@location(0) pos: vec3f,
	@location(1) uv: vec2f,
}

struct FarRainOut {
	@builtin(position) position: vec4f,
	@location(0) rel: vec3f,
	@location(1) uv: vec2f,
}

@vertex
fn vs_far_rain(in: FarRainIn) -> FarRainOut {
	let rel = weather.basis0.xyz * in.pos.x + weather.basis1.xyz * in.pos.y + weather.basis2.xyz * in.pos.z;
	var out: FarRainOut;
	out.position = frame.view_proj * vec4f(rel, 1.0);
	out.rel = rel;
	out.uv = in.uv;
	return out;
}

@fragment
fn fs_far_rain(in: FarRainOut) -> @location(0) vec4f {
	let dist = length(in.rel);
	let dir = in.rel / max(dist, 1e-5);
	let my_view_z = dot(in.rel, frame.view_forward.xyz);
	let px = vec2i(in.position.xy);
	let scene_d = textureLoad(scene_depth, px, 0);
	let scene_view_z = select(1e6, view_depth(scene_d), scene_d > 0.0);
	let screen_uv = in.position.xy / frame.render_size.xy;

	let occ_uv = vec2f(
		0.5 + (in.rel.x - weather.occ_origin.x) * weather.occ_origin.w,
		0.5 - (in.rel.z - weather.occ_origin.z) * weather.occ_origin.w,
	);
	let occ_z = (weather.occ_origin.y - in.rel.y) * weather.occ_metrics.x;
	var exposed = 1.0;
	if (weather.occ_metrics.w > 0.5 && all(occ_uv > vec2f(0.0)) && all(occ_uv < vec2f(1.0)) && occ_z > 0.0 && occ_z < 1.0) {
		exposed = textureSampleCompareLevel(vertical_occlusion, vertical_occlusion_compare, occ_uv, max(occ_z, 0.00048828125));
	}

	// distant rain wave sheets
	if (weather.params2.x > 0.5) {
		let uv0 = vec2f(abs(fract(in.uv.x + weather.params0.x) - 0.5) * 2.0, in.uv.y) * weather.params3.xy +
			weather.params3.zw + vec2f(0.0, weather.params0.y);
		let uv1 = vec2f(abs(fract(in.uv.x + weather.params0.z) - 0.5) * 2.0, in.uv.y) * weather.params4.xy +
			weather.params4.zw + vec2f(0.0, weather.params0.w);
		let s0 = textureSampleLevel(weather_tex, weather_sampler, uv0, 0.0).x;
		let s1 = textureSampleLevel(weather_tex, weather_sampler, uv1, 0.0).y;
		let top_fade = 1.0 - smoothstep(10.0, 130.0, max(in.rel.y, 0.0));
		let bot_end = mix(129.9, 10.0, weather.params2.y);
		let bot_fade = 1.0 - smoothstep(bot_end, 130.0, max(-in.rel.y, 0.0));
		let wave = s0 * s1 * saturate(top_fade * bot_fade);
		if (wave <= 0.0005) {
			discard;
		}
		let occ_range = max(weather.params1.w, 1.0);
		let xz_dist = max(abs(in.rel.x), abs(in.rel.z));
		let occ_open = mix(exposed, 1.0, smoothstep(0.7 * occ_range, 0.75 * occ_range, xz_dist));
		let depth_fade = saturate(max(scene_view_z - my_view_z, 0.0) * 0.1);
		let alpha = saturate(wave * occ_open * depth_fade * weather.color.a);
		if (alpha <= 0.0005) {
			discard;
		}
		let fog = fog_over(dir, dist, froxels_at(screen_uv, my_view_z));
		let rgb = weather.color.rgb * fog.transmittance + fog.inscatter;
		return vec4f(rgb, alpha);
	}

	// procedural middle / far rain streaks
	let p = in.uv * weather.params1.xy;
	let col_h = fract(floor(p.x) * 0.011);
	let col_t = col_h * (col_h + 7.5);
	let col_rand = fract(col_t * (col_t + col_t));
	let speed_var = 0.5 * col_rand;
	let rows = floor(weather.params1.y * (1.0 + speed_var));
	let scrolled = vec2f(p.x, p.y + (weather.params0.x + 0.5 + speed_var) * rows);
	let cell = floor(scrolled);
	let cell_h = fract(sin(dot(cell - 1024.0 * trunc(cell / 1024.0), vec2f(12.9898, 78.233))) * 43758.546875);
	let jitter = cell_h * (sin(p.y + col_rand * rows) * 0.5 + 0.5);
	let d_center = saturate(abs(vec2f(0.5 + (jitter * 2.0 - 1.0) * 0.3, 0.5) - fract(scrolled)));
	let streak_len = min(weather.params0.y * 0.4 * (0.4 + col_rand * 0.6), 1.0);
	let density_mask = step(mix(0.65, 1.0, 1.0 - weather.params0.z), cell_h) * smoothstep(0.65, 1.0, cell_h);
	let streak_x = 1.0 - smoothstep(0.0, 0.2, d_center.x);
	let streak_y = 1.0 - smoothstep(max(streak_len - 0.2, 0.0), max(streak_len, 0.0005), d_center.y);
	let top_fade = 1.0 - smoothstep(10.0, 130.0, max(in.rel.y, 0.0));
	let streak = density_mask * streak_x * streak_y * top_fade;
	if (streak <= 0.0005) {
		discard;
	}

	let depth_fade = saturate(max((scene_view_z - my_view_z) - jitter * 7.5, 0.0) * 0.1);
	let cov = streak * exposed * depth_fade;
	let alpha = saturate(cov * weather.color.a);
	if (alpha <= 0.0005) {
		discard;
	}

	let lighting_pct = weather.params1.z;
	var rgb = weather.color.rgb;
	if (lighting_pct > 0.001) {
		let n = dir;
		let v = -dir;
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
		rgb = mix(weather.color.rgb, lit, lighting_pct * cov);
	}
	let fog = fog_over(dir, dist, froxels_at(screen_uv, my_view_z));
	return vec4f(rgb * fog.transmittance + fog.inscatter, alpha);
}
