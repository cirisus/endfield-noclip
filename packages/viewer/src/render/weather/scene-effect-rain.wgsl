// near-camera falling rain streaks (HGRP/Rain/SceneEffectRain).
// needs FRAME_WGSL and postCommonSource(1, 0).

struct WeatherParams {
	// camera-relative (centerX, topRelY, centerZ, 1 / (2 · range))
	occ_origin: vec4f,
	// (1 / height, height, texelWorldSize, active)
	occ_metrics: vec4f,
	// linear RGB + alpha
	color: vec4f,
	// (layerOffset, widthScale, streakLength, intensity01)
	params0: vec4f,
	// (dirRelX, dirRelY, dirRelZ, jitterLevel)
	params1: vec4f,
	// (layerRange, maxHeight, lightingPercent, taauFixFactor)
	params2: vec4f,
	// rainTexST (scaleX, scaleY, bias, contrast)
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

struct RainIn {
	@location(0) center: vec3f,
	@location(1) corner: vec2f,
	@location(2) rand: vec3f,
}

struct RainOut {
	@builtin(position) position: vec4f,
	@location(0) rel: vec3f,
	@location(1) uv: vec4f,
	@location(2) fade: f32,
	@location(3) normal: vec3f,
	@location(4) tangent: vec3f,
}

@vertex
fn vs_rain(in: RainIn) -> RainOut {
	var out: RainOut;
	if (in.rand.y > weather.params0.w) {
		out.position = vec4f(0.0, 0.0, 2.0, 1.0);
		return out;
	}
	let range = weather.params2.x;
	let span = range * 2.0;
	let eye_xz = frame.eye.xz;
	let grid = floor(eye_xz / span) * span;
	let local_xz = in.center.xz * range;
	let wrap_xz = local_xz + step(local_xz + range, eye_xz - grid) * span + grid;
	let base_rel = vec3f(wrap_xz.x - eye_xz.x, 0.0, wrap_xz.y - eye_xz.y);

	let to_top = weather.params1.xyz - base_rel;
	let dist_top = length(to_top);
	let half_travel = dist_top * 0.8;
	let axis = to_top / max(dist_top, 1e-5);
	let ref_v = select(vec3f(1.0, 0.0, 0.0), vec3f(0.0, 0.0, 1.0), abs(axis.x) > 0.99);
	let u_axis = normalize(cross(ref_v, axis));
	let v_axis = cross(u_axis, axis);

	let t_fall = fract(in.center.y - weather.params0.x);
	let t_phase = weather.params0.x + in.center.y;
	let r = in.rand * 2.0 - 1.0;
	let jitter_amp = weather.params1.w * r.y * range;
	let a1 = 6.28318548 * (t_phase * 0.5 + r.x);
	let a2 = 6.28318548 * (t_phase * 0.2 + r.z);
	let c1 = cos(a1) * r.x;
	let s1 = sin(a1) * r.x;
	let c2 = cos(a2) * r.z;
	let s2 = sin(a2) * r.z;

	let drop_rel = base_rel +
		v_axis * ((c1 + s1) * jitter_amp) +
		u_axis * ((s2 + c2) * jitter_amp * 2.0) +
		axis * ((t_fall * 2.0 - 1.0) * half_travel);

	let vel = v_axis * ((-3.1415927 * s1 + 3.1415927 * c1) * jitter_amp) +
		u_axis * ((1.2566371 * c2 - 1.2566371 * s2) * jitter_amp) +
		axis * (-1.6 * dist_top * t_fall);
	let vel_dir = vel * inverseSqrt(max(1e-20, dot(vel, vel)));

	let d_cam = length(drop_rel);
	let px_width = (d_cam / max(frame.viewport.z, 1.0)) * (3.0 + weather.params2.w) * 0.5;
	let min_w = max(px_width, weather.params0.y);
	let near_k = 1.0 - saturate(d_cam);
	let w = mix(min_w, min_w * 15.0, near_k);
	let h = mix(weather.params0.z, weather.params0.z * 7.5, near_k);

	let base_dir = base_rel * inverseSqrt(max(1e-20, dot(base_rel, base_rel)));
	let cam_fwd = vec3f(frame.view_forward.x, 0.0, frame.view_forward.z);
	var face_dir = mix(cam_fwd, base_dir, smoothstep(0.4 * range, range, d_cam));
	face_dir.y = 0.0;
	face_dir = face_dir * inverseSqrt(max(1e-20, dot(face_dir, face_dir)));
	let right = normalize(cross(face_dir, vel_dir));
	let normal = cross(vel_dir, right);

	let vert_rel = drop_rel + right * (in.corner.x * w) + vel_dir * (in.corner.y * h);
	let quad_uv = saturate(in.corner);
	out.position = frame.view_proj * vec4f(vert_rel, 1.0);
	out.rel = vert_rel;
	out.uv = vec4f(quad_uv, quad_uv * vec2f(w * 2.0, h) - vec2f(r.x, (t_fall + r.y) * half_travel));
	out.fade = smoothstep(0.5, 1.5, d_cam);
	out.normal = normal;
	out.tangent = -right;
	return out;
}

@fragment
fn fs_rain(in: RainOut) -> @location(0) vec4f {
	let tex = textureSample(weather_tex, weather_sampler, in.uv.zw * weather.params3.xy);
	let edge2 = saturate((vec2f(0.5) - abs(vec2f(0.5) - in.uv.xy)) * 2.0);
	let edge = edge2.x * edge2.y;

	let occ_uv = vec2f(
		0.5 + (in.rel.x - weather.occ_origin.x) * weather.occ_origin.w,
		0.5 - (in.rel.z - weather.occ_origin.z) * weather.occ_origin.w,
	);
	let occ_z = (weather.occ_origin.y - in.rel.y) * weather.occ_metrics.x;
	var exposed = 1.0;
	if (weather.occ_metrics.w > 0.5 && all(occ_uv > vec2f(0.0)) && all(occ_uv < vec2f(1.0)) && occ_z > 0.0 && occ_z < 1.0) {
		exposed = textureSampleCompareLevel(vertical_occlusion, vertical_occlusion_compare, occ_uv, max(occ_z, 0.00048828125));
	}

	let mask = (weather.params3.z + weather.params3.w * (tex.x * 2.0 - 1.0)) * (exposed * edge * in.fade);
	if (mask <= 0.0005) {
		discard;
	}

	let angle = abs(in.uv.x - 0.5) * PI;
	let ts_n = normalize(vec3f(sin(angle + tex.x), 0.01, cos(angle + tex.y)));
	let bitangent = cross(in.normal, in.tangent);
	let n = normalize(in.tangent * ts_n.x + bitangent * ts_n.y + in.normal * ts_n.z);

	let lighting_pct = weather.params2.z;
	var rgb = weather.color.rgb;
	var alpha = mask;
	if (lighting_pct > 0.001) {
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
		let edge_cube = edge * edge * edge;
		let lit_alpha = dot(vec3f(0.299, 0.587, 0.114), lit) * edge_cube * edge_cube * mask;
		rgb = mix(weather.color.rgb, lit, lighting_pct);
		alpha = mix(mask, lit_alpha, lighting_pct);
	}
	return vec4f(rgb, saturate(alpha * weather.color.a));
}
