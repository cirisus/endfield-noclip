// deferred lighting pass: unpacks the G-buffer (emission, gbufferA/B/C), applies rain and wetness-decal
// darkening with per-material porosity, evaluates sun, shadows, local lights, irradiance volume, local
// reflection probes, GTAO (per-channel multi-bounce diffuse + Lagarde specular occlusion), and SSR blending,
// and writes the lit HDR radiance into `lit` (preserving sky pixels written by the celestial pass).
// needs FRAME_WGSL and postCommonSource(1, 0).

@group(2) @binding(0) var gb_emission: texture_2d<f32>;
@group(2) @binding(1) var gb_a: texture_2d<f32>;
@group(2) @binding(2) var gb_b: texture_2d<f32>;
@group(2) @binding(3) var gb_c: texture_2d<f32>;
@group(2) @binding(4) var gb_depth: texture_depth_2d;
@group(2) @binding(5) var ao_texture: texture_2d<f32>;
@group(2) @binding(6) var ssr_texture: texture_2d<f32>;
@group(2) @binding(7) var wetness_texture: texture_2d<f32>;
@group(2) @binding(8) var linear_sampler: sampler;

struct RainWetness {
	// camera-relative (centerX, topRelY, centerZ, 1 / (2 · range))
	occ_origin: vec4f,
	// (1 / height, height, texelWorldSize, active)
	occ_metrics: vec4f,
	// (normalBias, depthBias, noiseScale, hasNoise)
	occ_bias: vec4f,
	// (horizontalJitterLevel, verticalJitterLevel, 0, 0)
	occ_jitter: vec4f,
	// (flowOffset, normalStrength, slopeThreshold, porosity)
	flow_params: vec4f,
	// (scaleX, scaleY, offsetX, offsetY)
	flow_st: vec4f,
	// (rippleTimeOffset, rippleNormalStrength, waveTimeOffset, waveNormalStrength)
	ripple_params: vec4f,
	// (scaleX, scaleY, rowColumnCount, roughnessMaskThreshold)
	ripple_st: vec4f,
}

@group(3) @binding(0) var<uniform> rain_wet: RainWetness;
@group(3) @binding(1) var vertical_occlusion: texture_depth_2d;
@group(3) @binding(2) var vertical_occlusion_compare: sampler_comparison;
@group(3) @binding(3) var rain_occ_noise: texture_3d<f32>;
@group(3) @binding(4) var ripple_texture: texture_2d<f32>;
@group(3) @binding(5) var vertical_flow_texture: texture_2d<f32>;
@group(3) @binding(6) var repeat_sampler: sampler;

// high-quality rain wetness matching HGRP/DeferredLighting: top-down vertical occlusion with 3D jitter,
// biplanar vertical runoff on steep walls, and standing-water ripples + wind waves on flat surfaces
fn apply_rain_wetness(s_in: Surface, rel: vec3f, geo_n: vec3f, surface_porosity: f32) -> Surface {
	let p0 = frame.wetness[0];
	if (p0.x <= 0.0) {
		return s_in;
	}
	let p1 = frame.wetness[1];
	var s = s_in;
	let n = s.normal;
	let world_pos = frame.eye.xyz + rel;
	let down = -n.y;

	// 3D Perlin noise jitter softens the vertical occlusion shadow edge and drives puddle/flow variation
	var noise = 0.0;
	var jitter = vec3f(0.0);
	if (rain_wet.occ_bias.w > 0.5) {
		let an = abs(n);
		let w = an / max(an.x + an.y + an.z, 1e-5);
		noise = textureSampleLevel(rain_occ_noise, repeat_sampler, world_pos * rain_wet.occ_bias.z, 0.0).x;
		let dir = vec3f(0.0, 0.0, 1.0) * w.x + vec3f(0.707106, 0.0, 0.707106) * w.y + vec3f(1.0, 0.0, 0.0) * w.z;
		let jitter_amt = mix(rain_wet.occ_jitter.y, rain_wet.occ_jitter.x, smoothstep(0.7, 0.95, abs(down)));
		jitter = dir * (noise * 2.0 - 1.0) * jitter_amt;
	}

	// vertical occlusion map lookup (1 when exposed to the sky, 0 when sheltered under a roof)
	let bias_scale = (1.0 - clamp(down, 0.0, 0.9)) * clamp(1.0 - smoothstep(0.1, 0.2, down), 0.1, 1.0);
	let sample_rel = rel + (n * (rain_wet.occ_metrics.z * rain_wet.occ_bias.x) + vec3f(0.0, rain_wet.occ_bias.y, 0.0)) * bias_scale + jitter;
	let occ_uv = vec2f(
		0.5 + (sample_rel.x - rain_wet.occ_origin.x) * rain_wet.occ_origin.w,
		0.5 - (sample_rel.z - rain_wet.occ_origin.z) * rain_wet.occ_origin.w,
	);
	let occ_z = (rain_wet.occ_origin.y - sample_rel.y) * rain_wet.occ_metrics.x;
	var exposed = 1.0;
	if (rain_wet.occ_metrics.w > 0.5 && all(occ_uv > vec2f(0.0)) && all(occ_uv < vec2f(1.0)) && occ_z > 0.0 && occ_z < 1.0) {
		exposed = textureSampleCompareLevel(vertical_occlusion, vertical_occlusion_compare, occ_uv, max(occ_z, 0.00048828125));
	}

	let up = saturate(n.y);
	let facing = mix(p1.w, 1.0, up);
	let d = max(abs(rel.x), abs(rel.z));
	let open = mix(facing * exposed, 1.0, smoothstep(0.7 * p0.w, 0.75 * p0.w, d));
	let near_cov = mix(p1.z * facing, 1.0, open);
	let coverage = mix(near_cov, p1.y, smoothstep(p0.w, max(p1.x * p0.w, p0.w + 1e-4), d));

	// geometric flatness from screen-space position derivatives (for flooded normal-map dips and wall runoff)
	let geo_up = saturate((geo_n * inverseSqrt(max(1e-38, dot(geo_n, geo_n)))).y);
	let slope_a = rain_wet.flow_params.z * 0.3;
	let slope_b = slope_a + 0.686;
	let dist_fade = 1.0 - saturate((dot(rel, frame.view_forward.xyz) - 15.0) * 0.015);
	let threshold = rain_wet.ripple_st.w;
	var flat = 0.0;
	if (threshold > 0.0) {
		let up_mask = smoothstep(min(max(slope_b, 0.97), 0.989), 0.99, up);
		let geo_mask = smoothstep(0.991, 1.0, geo_up) * step(s.occlusion, noise * 0.2 + 0.8);
		flat = smoothstep(min(threshold, 0.99), max(threshold, 1e-4), saturate(up_mask + geo_mask));
	}

	// vertical flow streaks on steep exposed walls
	var flow_normal = n;
	var flow_wet = 0.0;
	let wall_mask = (1.0 - smoothstep(slope_b, slope_a + 0.687, geo_up)) * smoothstep(-0.5, -0.1, n.y);
	if (rain_wet.flow_params.y > 0.0005 && wall_mask > 0.0005) {
		let an2 = n * n;
		let bw = an2 / max(an2.x + an2.z, 1e-5);
		let t_vec = normalize(cross(n, vec3f(0.0, 1.0, 0.0)));
		let b_vec = normalize(cross(t_vec, n));
		let cell3 = floor(world_pos * 2.0 + 0.31415927) + 0.5;
		let cell_key = cell3.xz + cell3.yy;
		let h = fract(sin(dot(cell_key - 1024.0 * trunc(cell_key / 1024.0), vec2f(12.9898, 78.233))) * 43758.546875);
		let signs = step(vec2f(0.0), n.zx) * 2.0 - 1.0;
		let wp = vec3f(world_pos.x * signs.x, world_pos.y, world_pos.z * (-signs.y));
		let nh = noise * h;
		let flow_t = vec2f(
			fract(-rain_wet.flow_params.x * ((1.0 - h) * 0.7 + 0.3) + nh * 3.0),
			fract(rain_wet.flow_params.x * -0.3 + nh * 6.0),
		);
		let freq = floor(h * 5.0) + 1.0;
		let y_phase = fract(vec2f(freq, 0.1 * freq) * world_pos.y);
		let pulse = mix(
			max(smoothstep(vec2f(0.8), vec2f(1.0), y_phase - (flow_t - 1.0)), flow_t - y_phase),
			max(smoothstep(vec2f(0.8), vec2f(1.0), y_phase - flow_t), (flow_t + 1.0) - y_phase),
			step(flow_t, y_phase),
		);
		let p_x = smoothstep(0.4, 1.0, pulse.x * pulse.x);
		let p_y = pulse.y * 2.0 - 1.0;
		let uv_off = vec2f(
			noise * 0.1 + 0.01 * p_x * p_y,
			noise * (noise + p_x * 0.01 * p_x * p_y),
		);
		let flow_sample =
			textureSampleLevel(vertical_flow_texture, repeat_sampler, wp.zy * rain_wet.flow_st.xy + uv_off, 0.0) * bw.x +
			textureSampleLevel(vertical_flow_texture, repeat_sampler, wp.xy * rain_wet.flow_st.xy + uv_off, 0.0) * bw.z;
		let f_xy = flow_sample.xy * 2.0 - 1.0;
		let f_w = flow_sample.w;
		let streak = max(
			smoothstep(0.7, 1.0, saturate(pulse.y + (p_x * 2.0 - 1.0) * 0.8) * (1.0 - f_w * 0.5)),
			mix(0.1, 0.6, saturate(p_y * f_w * 0.5 + p_x)),
		);
		let f_z = flow_sample.z;
		let flow_amt =
			mix(0.1, streak * 0.7 + 0.3, step(pow(saturate(1.0 - streak), 5.0), f_z)) *
			f_z * rain_wet.flow_params.y * 0.33 * (p0.x * open * step(0.045, surface_porosity) * dist_fade);
		if (flow_amt > 0.0005) {
			let fn_z = max(0.00048828125, sqrt(1.0 - saturate(dot(f_xy, f_xy))));
			let fn_xy = f_xy * (smoothstep(0.0, 0.1, flow_amt) * rain_wet.flow_params.y);
			let fn_z_blend = mix(mix(0.0, -0.2, smoothstep(1.5, 3.0, rain_wet.flow_params.y)), fn_z, flow_amt);
			let fn_raw = vec3f(fn_xy, fn_z_blend);
			let fn_ts = fn_raw * inverseSqrt(max(1e-20, dot(fn_raw, fn_raw)));
			let fn_ws = t_vec * fn_ts.x + b_vec * fn_ts.y + n * fn_ts.z;
			let mixed_n = mix(n, fn_ws, saturate(flow_amt));
			flow_normal = mixed_n * inverseSqrt(max(1e-20, dot(mixed_n, mixed_n)));
			flow_wet = flow_amt * rain_wet.flow_params.y * 0.33;
		}
	}

	// standing water: 4×4 raindrop ripple flipbook + orthogonal wind waves on flat surfaces
	var out_normal = flow_normal;
	var standing = 0.0;
	if (flat > 0.0005) {
		let uv_base = (-world_pos.xz) * rain_wet.ripple_st.xy;
		let cell = floor(uv_base);
		let cell_uv = fract(uv_base);
		var ripple_xy = vec2f(0.0);
		if (rain_wet.ripple_params.y > 0.0005) {
			let h = fract(sin(dot(cell - 1024.0 * trunc(cell / 1024.0), vec2f(12.9898, 78.233))) * 43758.546875);
			let cols = rain_wet.ripple_st.z;
			let frame_idx = floor(fract(rain_wet.ripple_params.x + h) * (cols * cols));
			let inv_cols = 1.0 / cols;
			let tile_uv = mix(cell_uv, cell_uv.yx, step(h, 0.5));
			let atlas_uv = fract(
				tile_uv * inv_cols +
				vec2f(
					inv_cols * (frame_idx - cols * trunc(frame_idx / cols)),
					inv_cols * ((cols - 1.0) - floor(frame_idx * inv_cols)),
				),
			);
			ripple_xy = (textureSampleLevel(ripple_texture, linear_sampler, atlas_uv, 0.0).xy * 2.0 - 1.0) * rain_wet.ripple_params.y;
		}
		if (rain_wet.ripple_params.w > 0.0005) {
			let w_uv1 = uv_base + vec2f(0.0, rain_wet.ripple_params.z) + vec2f(noise * 0.5 - 0.5, 0.0);
			let w_uv2 = uv_base - vec2f(rain_wet.ripple_params.z, 0.0) - vec2f(0.0, (1.0 - noise) * 0.5 - 0.5);
			let w1 = textureSampleLevel(ripple_texture, repeat_sampler, w_uv1, 0.0).zw;
			let w2 = textureSampleLevel(ripple_texture, repeat_sampler, w_uv2, 0.0).zw;
			ripple_xy += ((w1 * 2.0 - 1.0) + (w2 * 2.0 - 1.0)) * rain_wet.ripple_params.w * noise;
		}
		let level = (noise * 0.7 + s.roughness * 0.3) * saturate((s.roughness - 0.1) * 100.0) * s.occlusion;
		let fill = smoothstep(min(level, 0.99), saturate(level + 0.6), threshold);
		let wet = p0.x * flat;
		let r_z = max(0.00048828125, sqrt(1.0 - saturate(dot(ripple_xy, ripple_xy))));
		let r_n = normalize(vec3f(ripple_xy, r_z)).yzx * vec3f(1.0, 1.0, -1.0);
		out_normal = normalize(mix(n, r_n, saturate(wet * fill * open * dist_fade)));
		let depth = saturate(mix(threshold * (1.0 - noise) * 0.5, 1.0, fill) + smoothstep(0.6, 1.0, threshold) * 0.6);
		standing = max(smoothstep(0.0, max(s.occlusion * 0.2, 1e-4), wet * depth * r_n.y) * open * dist_fade, 0.0);
	}

	let smoothness = 1.0 - s.roughness;
	let porosity = mix(
		saturate(
			saturate(smoothness * p0.z + p0.y) +
			mix(0.0, rain_wet.flow_params.w, flow_wet) +
			standing * 0.1 * s.roughness,
		),
		1.0,
		s.metallic,
	);
	let not_down = 1.0 - smoothstep(0.2, 0.5, down);
	let darken = mix(1.0, 0.25, p0.x * porosity * (1.0 - s.metallic) * not_down);
	let wet_smoothness = clamp(
		saturate(mix(0.9, 0.6, porosity) + mix(-0.6, 0.4, sqrt(smoothness))),
		smoothness,
		0.99,
	);
	let k = p0.x * saturate(2.0 - p0.x) * not_down * coverage;
	let wet_roughness = (1.0 - mix(smoothness, wet_smoothness, k)) * mix(1.0, 0.1, max(standing, smoothstep(0.0, 0.05, flow_wet)));
	s.normal = out_normal;
	s.roughness = mix(s.roughness, wet_roughness, coverage);
	s.albedo *= mix(1.0, darken, coverage);
	return s;
}

// Jimenez et al.'s per-channel multi-bounce AO fit (docs/game-data/lighting.md#ambient)
fn multi_bounce_rgb(ao: f32, albedo: vec3f) -> vec3f {
	let a = 2.0404 * albedo - vec3f(0.3324);
	let b = -4.7951 * albedo + vec3f(0.6417);
	let c = 2.7552 * albedo + vec3f(0.6903);
	return max(vec3f(ao), ((a * ao + b) * ao + c) * ao);
}

@fragment
fn fs_deferred_lighting(in: FullscreenOut) -> @location(0) vec4f {
	let px = vec2i(in.position.xy);
	let depth = textureLoad(gb_depth, px, 0);
	let ray = view_ray(in.uv);
	let rel = ray * view_depth(max(depth, 1e-6));
	// derivatives must be evaluated in uniform control flow, before the sky discard / unlit early return
	let geo_n = cross(dpdxFine(rel), dpdyFine(rel));
	if (depth <= 0.0) {
		// keep the celestial pass's sky pixels untouched
		discard;
	}
	let em = textureLoad(gb_emission, px, 0);
	let ga = textureLoad(gb_a, px, 0);
	let gb = textureLoad(gb_b, px, 0);
	let gc = textureLoad(gb_c, px, 0);
	let unpacked = unpack_gbuffer(em, ga, gb, gc);
	if (unpacked.model == SHADING_UNLIT) {
		return vec4f(em.rgb, 1.0);
	}

	var s = unpacked.surface;
	// rain wetness and wetness decals apply once per pixel before lighting, matching HGRP/DeferredLighting
	s = apply_rain_wetness(s, rel, geo_n, unpacked.porosity);
	let w = textureLoad(wetness_texture, px, 0).r;
	if (w > 0.0) {
		let porosity = unpacked.porosity;
		let w2 = w * w;
		s.albedo *= 1.0 - porosity * w2;
		s.roughness = mix(s.roughness, min(1.0 - porosity * w, s.roughness), w2);
	}

	let n = s.normal;
	let v = -normalize(rel);
	let l = frame.sun.xyz;
	let n_dot_v = clamp(abs(dot(n, v)), 1e-4, 1.0);
	let n_dot_l = clamp(dot(n, l), 0.0, 1.0);
	let roughness = clamp(s.roughness, 0.045, 1.0);
	let a = roughness * roughness;
	let a2 = a * a;
	let diffuse_color = s.albedo * (1.0 - s.metallic);
	let f0 = mix(vec3f(s.f0), s.albedo, s.metallic);

	switch frame.flags.y {
		case 1u: {
			return vec4f(s.albedo, 1.0);
		}
		case 2u: {
			return vec4f(n * 0.5 + 0.5, 1.0);
		}
		case 3u: {
			return vec4f(vec3f(roughness), 1.0);
		}
		case 6u: {
			return vec4f(vec3f(dot(s.albedo, LUMINANCE_ROUNDED)), 1.0);
		}
		default: {}
	}

	let world_pos = frame.eye.xyz + rel;
	let irradiance = ambient_irradiance(world_pos, n);
	let diffuse_ambient = (diffuse_color + s.scatter.rgb * s.scatter_indirect) * irradiance;
	let use_ao = post.ao.w > 0.5;
	let gtao = select(1.0, textureLoad(ao_texture, px, 0).r, use_ao);
	let ao = min(gtao, s.occlusion);
	let diffuse_ao = select(vec3f(s.occlusion), multi_bounce_rgb(ao, diffuse_color), use_ao);
	let specular_occlusion = clamp(pow(n_dot_v + ao, exp2(-16.0 * roughness - 1.0)) - 1.0 + ao, 0.0, 1.0);
	let ssr_weight = environment_brdf(f0, roughness, n_dot_v) * specular_occlusion;
	let r = normalize(mix(reflect(-v, n), n, roughness * roughness));
	let sky_spec = sample_reflection(world_pos, n, r, roughness, irradiance) * (ssr_weight * frame.ambient.x);
	var specular_ambient = sky_spec;
	if (post.reflections.x > 0.5) {
		let ssr = textureSampleLevel(ssr_texture, linear_sampler, in.uv, 0.0);
		specular_ambient = mix(sky_spec, ssr.rgb * ssr_weight, ssr.a);
	}
	let ambient = diffuse_ambient * diffuse_ao + specular_ambient;
	if (frame.flags.y == 4u) {
		return vec4f(ambient, 1.0);
	}

	var direct = vec3f(0.0);
	if (s.foliage) {
		direct = foliage_sun(s, n, v, l, a2, f0, diffuse_color) * frame.sun_color.rgb * frame.sun.w *
			sun_visibility(rel, n, in.position.xy);
	} else {
		let h = normalize(l + v);
		let n_dot_h = clamp(dot(n, h), 0.0, 1.0);
		let v_dot_h = clamp(dot(v, h), 0.0, 1.0);
		let f = fresnel_schlick(f0, v_dot_h);
		let specular = f * (ggx_distribution(n_dot_h, a2) * smith_visibility(n_dot_v, n_dot_l, a2)) * frame.sun_color.w;
		let diffuse = diffuse_color / PI * (vec3f(1.0) - f);
		direct = (diffuse + specular) * n_dot_l;
		let scatters = s.scatter.a > 0.0;
		if (scatters) {
			direct += subsurface_sun(s.scatter, n, v, l) / PI;
		}
		var visibility = vec3f(0.0);
		if (n_dot_l > 0.0 || scatters) {
			visibility = sun_visibility(rel, n, in.position.xy);
		}
		direct *= frame.sun_color.rgb * visibility * frame.sun.w;
	}
	direct += local_lighting(s, v, rel, in.position.xy, diffuse_color, f0, roughness);
	return vec4f(max(direct + ambient + s.emission, vec3f(0.0)), 1.0);
}
