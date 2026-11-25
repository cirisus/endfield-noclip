// falling snow flakes with wind flutter and vertical-occlusion ground collision
// (HGRP/Rain/SceneEffectRain with SNOW_FLAKE + SNOW_COLLISION).
// needs FRAME_WGSL and postCommonSource(1, 0).

struct WeatherParams {
	// camera-relative (centerX, topRelY, centerZ, 1 / (2 · range))
	occ_origin: vec4f,
	// (1 / height, height, texelWorldSize, active)
	occ_metrics: vec4f,
	// linear RGB + alpha
	color: vec4f,
	// (0, sizeMin, sizeMax, intensity01)
	params0: vec4f,
	// (snowDirX, snowDirY, snowDirZ, jitterLevel)
	params1: vec4f,
	// (layerRange, maxHeight, lightingPercent, collisionFadeRate)
	params2: vec4f,
	// snowTexST (scaleX, scaleY, bias, contrast)
	params3: vec4f,
	// (offsetX, offsetY, offsetZ, lengthStretch)
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

struct SnowIn {
	@location(0) center: vec3f,
	@location(1) corner: vec2f,
	@location(2) rand: vec3f,
}

struct SnowOut {
	@builtin(position) position: vec4f,
	@location(0) rel: vec3f,
	@location(1) uv: vec4f,
	@location(2) fade: vec2f,
	@location(3) normal: vec3f,
	@location(4) tangent: vec3f,
}

@vertex
fn vs_snow(in: SnowIn) -> SnowOut {
	var out: SnowOut;
	if (in.rand.y > weather.params0.w) {
		out.position = vec4f(0.0, 0.0, 2.0, 1.0);
		return out;
	}
	let range = weather.params2.x;
	let max_h = weather.params2.y;
	let span = vec3f(range * 2.0, max_h * 2.0, range * 2.0);
	let half_span = vec3f(range, max_h, range);
	let eye = frame.eye.xyz;
	let grid = floor(eye / span) * span;
	let eye_in_cell = eye - grid;

	let r = in.rand * 2.0 - 1.0;
	let dir_mod = saturate(vec3f(1.0) - ((sin(fract(weather.params4.y + r) * 6.28318548) * 0.2 + 0.6) * 0.5) * weather.params1.w);
	let snow_dir = normalize(vec3f(weather.params1.x * dir_mod.x, weather.params1.y, weather.params1.z * dir_mod.y));
	let fall_axis = -snow_dir;

	let wrapped = (fract(in.center * 0.5 + 0.5 + weather.params4.xyz) * 2.0 - 1.0) * half_span;
	let world_y = wrapped.y + step(wrapped.y + max_h, eye_in_cell.y) * span.y + grid.y;
	let world_xz = wrapped.xz + step(wrapped.xz + range, eye_in_cell.xz) * span.xz + grid.xz;
	var flake_rel = vec3f(world_xz.x - eye.x, world_y - eye.y, world_xz.y - eye.z);

	// sample raw depth from vertical occlusion map to collide snowflakes with roofs/ground
	let occ_uv = vec2f(
		0.5 + (flake_rel.x - weather.occ_origin.x) * weather.occ_origin.w,
		0.5 - (flake_rel.z - weather.occ_origin.z) * weather.occ_origin.w,
	);
	var surface_rel_y = flake_rel.y - 100.0;
	if (weather.occ_metrics.w > 0.5 && all(occ_uv > vec2f(0.0)) && all(occ_uv < vec2f(1.0))) {
		let raw_depth = textureSampleLevel(vertical_occlusion, vertical_occlusion_raw, occ_uv, 0);
		if (raw_depth < 0.9999) {
			surface_rel_y = weather.occ_origin.y - raw_depth * weather.occ_metrics.y;
		}
	}

	let above = flake_rel.y - surface_rel_y;
	let air_k = saturate(above * 2.0);
	let above_jitter = above * (1.0 + r.x * 0.2);
	let landed = step(above_jitter, 1.0);
	let flying = 1.0 - landed;
	let clamped_y = max(surface_rel_y + weather.params0.z * 0.5, flake_rel.y);
	flake_rel.y = clamped_y;

	let up_axis = normalize(mix(vec3f(0.0, 1.0, 0.0), fall_axis, air_k));
	let ref_v = select(vec3f(1.0, 0.0, 0.0), vec3f(0.0, 0.0, 1.0), abs(up_axis.x) > 0.99);
	let u_axis = normalize(cross(ref_v, up_axis));
	let v_axis = cross(u_axis, up_axis);

	let world_h = clamped_y + eye.y;
	let ph1 = 6.28318548 * fract(world_h * 0.0175 + r.x);
	let ph2 = 6.28318548 * fract(world_h * 0.007 + r.z);
	let amp = weather.params1.w * dot(vec3f(1.0), abs(r)) * flying;
	let pos_rel = flake_rel +
		(v_axis * (cos(ph1) - cos(ph2)) + u_axis * (sin(ph1) - sin(ph2))) * amp;

	let to_cam = -normalize(pos_rel);
	let size = mix(weather.params0.y, weather.params0.z, in.rand.x);
	let right = normalize(cross(to_cam, up_axis));
	let up = cross(right, to_cam);
	let stretch = mix(0.0, weather.params4.w, air_k) * (1.0 - abs(dot(to_cam, up_axis)));

	let vert_rel = pos_rel + right * (in.corner.x * size) + up * (in.corner.y * (size + stretch));
	let quad_uv = saturate(in.corner);
	let near_fade = smoothstep(0.5, 1.5, length(pos_rel));
	let collision_fade =
		(1.0 - saturate(-above * 0.2 * weather.params2.w)) *
		saturate(abs(above_jitter - 1.0) * 10.0 - 0.1);

	out.position = frame.view_proj * vec4f(vert_rel, 1.0);
	out.rel = vert_rel;
	out.uv = vec4f(quad_uv, quad_uv + vec2f(r.x, r.y) * 2.0);
	out.fade = vec2f(near_fade, collision_fade);
	out.normal = to_cam;
	out.tangent = -right;
	return out;
}

@fragment
fn fs_snow(in: SnowOut) -> @location(0) vec4f {
	let tex = textureSample(weather_tex, weather_sampler, in.uv.zw * weather.params3.xy);
	let radial = 1.0 - smoothstep(0.0, 0.4, length(vec2f(0.5) - in.uv.xy));

	let occ_uv = vec2f(
		0.5 + (in.rel.x - weather.occ_origin.x) * weather.occ_origin.w,
		0.5 - (in.rel.z - weather.occ_origin.z) * weather.occ_origin.w,
	);
	let occ_z = (weather.occ_origin.y - in.rel.y) * weather.occ_metrics.x;
	var exposed = 1.0;
	if (weather.occ_metrics.w > 0.5 && all(occ_uv > vec2f(0.0)) && all(occ_uv < vec2f(1.0)) && occ_z > 0.0 && occ_z < 1.0) {
		exposed = textureSampleCompareLevel(vertical_occlusion, vertical_occlusion_compare, occ_uv, max(occ_z, 0.00048828125));
	}

	let mask = (weather.params3.z + weather.params3.w * (tex.x * 2.0 - 1.0)) * (exposed * radial * in.fade.x);
	if (mask <= 0.0005 || in.fade.y <= 0.0005) {
		discard;
	}

	let lighting_pct = weather.params2.z;
	var rgb = weather.color.rgb;
	var alpha = mask;
	if (lighting_pct > 0.001) {
		let angle = abs(in.uv.x - 0.5) * PI;
		let ts_n = normalize(vec3f(sin(angle + tex.x), 0.01, cos(angle + tex.y)));
		let bitangent = cross(in.normal, in.tangent);
		let n = normalize(in.tangent * ts_n.x + bitangent * ts_n.y + in.normal * ts_n.z);
		let world_pos = frame.eye.xyz + in.rel;
		let v = -normalize(in.rel);
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
		let radial_cube = radial * radial * radial;
		let lit_alpha = dot(vec3f(0.299, 0.587, 0.114), lit) * radial_cube * radial_cube * mask;
		rgb = mix(weather.color.rgb, lit, lighting_pct);
		alpha = mix(mask, lit_alpha, lighting_pct);
	}
	return vec4f(rgb, saturate(alpha * weather.color.a * in.fade.y));
}
