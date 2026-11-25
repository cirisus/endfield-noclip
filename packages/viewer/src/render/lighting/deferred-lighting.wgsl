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

	let ray = view_ray(in.uv);
	let rel = ray * view_depth(depth);
	var s = unpacked.surface;
	// rain wetness and wetness decals apply once per pixel before lighting, matching HGRP/DeferredLighting
	s = rain_wet_surface(s, rel);
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
