// `HGRP/Erosion` (`erosionLook` in special-looks.ts, parameters by `ErosionRow`): base and metal colours mixed by the
// metal map, plus a parallax-offset noise layer and a flow band along the object's height. `packed` is the base
// normal map, `mask` the metal map and `detail` the detail normal map; textures still streaming read as the
// game's defaults (white, flat normals, the ramp's grey-blue)
fn erosion_surface(
	look: Look,
	in: VertexOut,
	flags: u32,
	faceted: vec3f,
	front: bool,
	packed_in: vec4f,
	mask_in: vec4f,
	detail_in: vec4f,
	uv0_dx: vec2f,
	uv0_dy: vec2f,
) -> Surface {
	let flat_normal = vec4f(0.5, 0.5, 1.0, 1.0);
	let packed = select(flat_normal, packed_in, (flags & NORMAL_MAP) != 0u);
	let metal_map = select(vec4f(1.0), mask_in, (flags & MASK_MAP) != 0u);
	let detail = select(flat_normal, detail_in, (flags & DETAIL_MAP) != 0u);
	let base_color = look.tint.rgb;
	let roughness = look.surface.x;
	let roughness_cover = look.surface.y;
	let metallic = look.surface.z;
	let normal_scale = look.surface.w;
	let occlusion_strength = look.surface2.x;
	let metallic_offset = look.surface2.z;
	let detail_scale = look.surface2.w;
	let noise_emissive = look.emissive.x;
	let flow_strength = look.emissive.y;
	let flow_emissive = look.emissive.z;
	let distance_blend = look.emissive.w;
	let metal_color = look.mask_albedo[0].rgb;
	let noise_depth = look.mask_albedo[0].w;
	let noise_tint = look.mask_albedo[1].rgb;
	let noise_min = look.mask_albedo[1].w;
	let noise_alpha_tint = look.mask_albedo[2].rgb;
	let flow_offset = look.mask_albedo[2].w;
	let flow_top = look.mask_roughness.rgb;
	let flow_roughness = look.mask_roughness.w;
	let flow_bottom = look.mask_metallic.rgb;
	let flow = look.mask_scale;

	var n = surface_normal(in.normal, faceted, !front);
	let v = normalize(-in.rel);
	// 1 where metal
	let metal = saturate(1.0 - metal_map.r);
	let has_tangent = in.tangent.w != 0.0;
	var b = vec3f(0.0);
	if (has_tangent) {
		b = cross(in.normal, in.tangent.xyz) * in.tangent.w;
	}

	// the noise layer: one parallax step into the noise map as a height field, then a tinted lookup at the hit,
	// fading with distance
	var noise_offset = vec2f(0.0);
	if (has_tangent && (flags & PARALLAX_NOISE_MAP) != 0u) {
		let vt = normalize(vec3f(dot(v, in.tangent.xyz), dot(v, b), dot(v, in.normal)));
		let delta = vt.xy / (vt.z + 0.42) / max(vt.z, 0.001) * -noise_depth;
		let hit = textureSampleGrad(parallax_noise_map, parallax_sampler, in.uv.xy + delta, uv0_dx, uv0_dy).x;
		// the hit refined between the surface (height 1) and the step (height 0)
		noise_offset = delta / (1.0 + max(hit, 0.0));
	}
	var noise_rgb = vec3f(1.0);
	if ((flags & PARALLAX_MAP) != 0u) {
		let tiling = look.slot_uv[PARALLAX_SLOT].xy;
		noise_rgb = textureSampleGrad(
			parallax_map,
			parallax_sampler,
			(in.uv.xy + noise_offset) * tiling,
			uv0_dx * tiling,
			uv0_dy * tiling,
		).rgb;
	}
	let fade = max(0.001, 1.0 - saturate(length(in.rel) / distance_blend));
	let noise = noise_rgb * noise_tint * packed.a * max(dot(n, v), noise_min) * fade;

	// the flow band: the ramp read along the object's height, offset by the metal map's G and a scroll, coloured
	// from the bottom colour below the offset height to the top colour above it
	let flow_u = in.object_pos.y * flow.x + metal_map.g * flow.y + frame.eye.w * flow.z + flow.w;
	var ramp = vec3f(0.5, 0.5, 1.0);
	if ((flags & EMISSIVE_MAP) != 0u) {
		ramp = textureSampleLevel(emissive_map, base_sampler, vec2f(flow_u, 0.5), 0.0).rgb;
	}
	var below = select(0.0, 1.0, flow_offset >= 0.0);
	if (in.object_pos.y != 0.0) {
		below = saturate(flow_offset / in.object_pos.y);
	}
	below = below * below * (3.0 - 2.0 * below);
	let flow_color = ramp * mix(flow_bottom, flow_top, 1.0 - below);

	var albedo = mix(base_color + noise + noise_alpha_tint * metal, metal_color, metal);
	albedo += flow_color * flow_strength * metal_map.b;

	// the base and detail normals summed; metal flattens the bitangent component
	if (has_tangent) {
		let base_xy = packed.rg * 2.0 - 1.0;
		let detail_xy = vec2f(detail.r * detail.a, detail.g) * 2.0 - 1.0;
		var tn = normalize(
			vec3f(base_xy * normal_scale, normal_z(base_xy)) + vec3f(detail_xy * detail_scale, normal_z(detail_xy)),
		);
		tn.y = mix(tn.y, 0.0, metal);
		let t = normalize(in.tangent.xyz - n * dot(in.tangent.xyz, n));
		var bt = select(-b, b, front);
		bt = normalize(bt - n * dot(bt, n));
		n = normalize(t * tn.x + bt * tn.y + n * tn.z);
	}

	var s = default_surface(clamp(albedo, vec3f(0.0), vec3f(1.0)), n);
	s.roughness = saturate(
		mix(mix(roughness * metal_map.a, detail.a, roughness_cover), 0.01, metal) - length(flow_color) * flow_roughness,
	);
	s.metallic = saturate(metallic * (metal - metallic_offset));
	s.f0 = look.surface2.y;
	s.occlusion = 1.0 - occlusion_strength + metal_map.g * occlusion_strength;
	s.emission = noise * noise_emissive + flow_color * flow_emissive * saturate(1.0 - metal_map.b);
	return s;
}

// one concentric ripple ring of `HGRP/ErosionDynamic` around `cfg.xyz` with radius `cfg.w`: returns
// `(ring, fade)`
fn erosion_ripple_ring(
	obj_pos: vec3f,
	cfg: vec4f,
	time_speed: f32,
	noise: f32,
	period: f32,
	inner: f32,
	band: f32,
) -> vec2f {
	if (period <= 1e-5 || cfg.w <= 1e-5) {
		return vec2f(0.0, 0.0);
	}
	let d = length(cfg.xyz - obj_pos) * 0.5;
	let norm_d = d / cfg.w;
	let fade = 1.0 - saturate(norm_d);
	let t = time_speed + noise * norm_d;
	let phase = period - (t - floor(t / period) * period);
	let wrapped = d - floor((d - phase) / period) * period;
	let w = abs(((saturate(wrapped - inner) - phase) - inner) - band * 0.5) / band;
	return vec2f(w * w * w, fade);
}

// `HGRP/ErosionDynamic` (`erosionDynamicLook` in special-looks.ts, parameters by `ErosionDynamicRow`):
// clearable blight patches with a colour LUT, matcap normal, animated ripples and flowing bands
fn erosion_dynamic_surface(
	look: Look,
	in: VertexOut,
	flags: u32,
	faceted: vec3f,
	front: bool,
	packed_in: vec4f,
	mask_in: vec4f,
	uv0_dx: vec2f,
	uv0_dy: vec2f,
) -> Surface {
	let flat_normal = vec4f(0.5, 0.5, 1.0, 1.0);
	let packed = select(flat_normal, packed_in, (flags & NORMAL_MAP) != 0u);
	let metal_map = select(vec4f(1.0), mask_in, (flags & MASK_MAP) != 0u);
	let base_color = look.tint.rgb;
	let roughness = look.surface.x;
	let roughness_cover = look.surface.y;
	let metallic = look.surface.z;
	let normal_scale = look.surface.w;
	let occlusion_strength = look.surface2.x;
	let metallic_offset = look.surface2.z;
	let detail_scale = look.surface2.w;
	let noise_emissive = look.emissive.x;
	let flow_strength = look.emissive.y;
	let detail_scroll = look.emissive.z;
	let distance_blend = look.emissive.w;
	let noise_color_mode = look.emissive2.x;
	let flow_roughness_offset = look.emissive2.y;
	let matcap_area_offset = look.emissive2.z;
	let noise_tint = look.mask_albedo[0].rgb;
	let noise_min = look.mask_albedo[0].w;
	let noise_depth = look.mask_albedo[1].x;
	let matcap_tiling = look.mask_albedo[1].y;
	let matcap_strength = look.mask_albedo[1].z;
	let flow_offset = look.mask_albedo[1].w;
	let flow_top = look.mask_roughness.rgb;
	let flow_roughness = look.mask_roughness.w;
	let flow_bottom = look.mask_metallic.rgb;
	let flow = look.mask_scale;
	let ripple_top = look.parallax.rgb;
	let ripple_width = look.parallax.w;
	let ripple_bottom = look.parallax2.rgb;
	let ring_ratio = look.parallax2.w;
	let ripple_speed = look.parallax_color.x;
	let ripple_noise_strength = look.parallax_color.y;
	let ripple_color_offset = look.parallax_color.z;

	let time = frame.eye.w;
	var n = surface_normal(in.normal, faceted, !front);
	let v = normalize(-in.rel);
	let rock = metal_map.r;
	let metal = saturate(1.0 - rock);
	let has_tangent = in.tangent.w != 0.0;
	var b = vec3f(0.0);
	if (has_tangent) {
		b = cross(in.normal, in.tangent.xyz) * in.tangent.w;
	}

	// noise layer: one parallax step into `_NoisePatternMap`, then a tinted lookup fading with distance
	var noise_offset = vec2f(0.0);
	if (has_tangent && (flags & PARALLAX_MAP) != 0u) {
		let vt = normalize(vec3f(dot(v, in.tangent.xyz), dot(v, b), dot(v, in.normal)));
		let delta = vt.xy / (vt.z + 0.42) / max(vt.z, 0.001) * -noise_depth;
		let hit = textureSampleGrad(parallax_map, parallax_sampler, in.uv.xy + delta, uv0_dx, uv0_dy).x;
		noise_offset = delta / (1.0 + max(hit, 0.0));
	}
	var noise_rgb = vec3f(1.0);
	if ((flags & PARALLAX_MAP) != 0u) {
		let tiling = look.slot_uv[PARALLAX_SLOT].xy;
		noise_rgb = textureSampleGrad(
			parallax_map,
			parallax_sampler,
			(in.uv.xy + noise_offset) * tiling,
			uv0_dx * tiling,
			uv0_dy * tiling,
		).rgb;
	}
	let noise_grey = vec3f((noise_rgb.r + noise_rgb.g + noise_rgb.b) * (1.0 / 3.0));
	let noise_c = mix(noise_rgb, noise_grey + (noise_rgb - noise_grey) * metal, noise_color_mode);
	let fade = max(0.001, 1.0 - saturate(length(in.rel) / distance_blend));
	let noise = mix(noise_c * noise_tint, noise_c, metal) * max(dot(n, v), noise_min) * fade;
	let nm = rock - 0.2;
	let noise_mask = saturate(nm * nm * nm);

	// three object-space concentric ripples
	let ripple_noise = metal_map.g * ripple_noise_strength;
	let period = ripple_width * 2.0;
	let inner = ripple_width * (1.0 - ring_ratio);
	let band = max(0.01, period - inner);
	let r0 = erosion_ripple_ring(in.object_pos, look.detail, time * ripple_speed, ripple_noise, period, inner, band);
	let r1 = erosion_ripple_ring(in.object_pos, look.detail2, time * ripple_speed, ripple_noise, period, inner, band);
	let r2 = erosion_ripple_ring(in.object_pos, look.detail_overlay, time * ripple_speed, ripple_noise, period, inner, band);
	let ripple_color =
		mix(ripple_top, ripple_bottom, r0.y + ripple_color_offset) * (r0.x * r0.y) +
		mix(ripple_top, ripple_bottom, r1.y + ripple_color_offset) * (r1.x * r1.y) +
		mix(ripple_top, ripple_bottom, r2.y + ripple_color_offset) * (r2.x * r2.y);
	let n_eps = n * 0.01;
	let d0 = look.detail.xyz - in.object_pos;
	let d1 = look.detail2.xyz - in.object_pos;
	let d2 = look.detail_overlay.xyz - in.object_pos;
	let ripple_n = normalize(
		mix(n, normalize((d0 - n * dot(d0, n)) * r0.x + n_eps), r0.y) +
		mix(n, normalize((d1 - n * dot(d1, n)) * r1.x + n_eps), r1.y) +
		mix(n, normalize((d2 - n * dot(d2, n)) * r2.x + n_eps), r2.y),
	);

	// flow band along object height + ripple shift
	let h = in.object_pos.y + ripple_color.r * 0.2;
	let flow_u = h * flow.x + metal_map.a * flow.y - time * flow.z + flow.w;
	var ramp = vec3f(0.5, 0.5, 1.0);
	if ((flags & EMISSIVE_MAP) != 0u) {
		ramp = textureSampleLevel(emissive_map, base_sampler, vec2f(flow_u, 0.5), 0.0).rgb;
	}
	var below = select(0.0, 1.0, flow_offset >= 0.0);
	if (h != 0.0) {
		below = saturate(flow_offset / h);
	}
	below = below * below * (3.0 - 2.0 * below);
	let ramp_grey = vec3f((ramp.r + ramp.g + ramp.b) * (1.0 / 3.0));
	let flow_color = mix(ramp_grey, ramp, below) * mix(flow_bottom, flow_top, 1.0 - below);

	// colour LUT in the base slot
	var lut = vec3f(1.0);
	if ((flags & BASE_MAP) != 0u) {
		lut = textureSampleLevel(base_map, base_sampler, vec2f(metal, 0.5), 0.0).rgb;
	}
	let ripple_mask = metal_map.b;
	let ripple_scale = max(0.1, ripple_mask);
	let albedo =
		lut * base_color +
		noise * noise_mask +
		clamp(ripple_color * ripple_scale, vec3f(0.0), vec3f(1.0)) * ripple_mask +
		flow_color * flow_strength * packed.a;

	// matcap normal (view space) and scrolling detail normal
	var matcap = flat_normal;
	if ((flags & PARALLAX_NOISE_MAP) != 0u) {
		let view_n = vec2f(dot(ripple_n, frame.view_right.xyz), dot(ripple_n, frame.view_up.xyz));
		let matcap_uv = (view_n * 0.5 + 0.5) * matcap_tiling;
		matcap = textureSampleLevel(parallax_noise_map, noise_sampler, matcap_uv, 0.0);
	}
	var detail = flat_normal;
	if ((flags & DETAIL_MAP) != 0u) {
		let tiling = look.slot_uv[DETAIL_SLOT].xy;
		let detail_uv = in.uv.xy * tiling + vec2f(detail_scroll * time) + ripple_color.xz + ripple_n.xz * 0.1;
		detail = textureSampleGrad(detail_map, detail_sampler, detail_uv, uv0_dx * tiling, uv0_dy * tiling);
	}

	if (has_tangent) {
		let base_n = packed.rgb * 2.0 - 1.0;
		let base_tn = vec3f(base_n.xy * (normal_scale * rock), base_n.z);
		let matcap_xy = vec2f(matcap.r * matcap.a, matcap.g) * 2.0 - 1.0;
		let matcap_w = saturate(metal + matcap_area_offset) * matcap_strength * (rock + 0.1) * saturate(metal - 0.1);
		let matcap_tn = vec3f(matcap_xy * matcap_w, normal_z(matcap_xy));
		let detail_xy = vec2f(detail.r * detail.a, detail.g) * 2.0 - 1.0;
		let detail_w = saturate(1.0 - metal - matcap_area_offset) * detail_scale * 5.0;
		let detail_tn = vec3f(detail_xy * detail_w, normal_z(detail_xy));
		let tn = normalize(base_tn + matcap_tn + detail_tn);
		let t = normalize(in.tangent.xyz - n * dot(in.tangent.xyz, n));
		var bt = select(-b, b, front);
		bt = normalize(bt - n * dot(bt, n));
		n = normalize(t * tn.x + bt * tn.y + n * tn.z);
	}

	var s = default_surface(clamp(albedo, vec3f(0.0), vec3f(1.0)), n);
	let rough0 = saturate(
		roughness +
		rock * (1.0 - roughness) +
		ripple_color.r * ripple_scale * ripple_mask -
		length(flow_color) * flow_roughness * saturate(packed.a + flow_roughness_offset),
	);
	s.roughness = mix(rough0, rough0 * detail.a, roughness_cover);
	s.metallic = mix(0.0, metallic, saturate(metal + metallic_offset));
	s.f0 = look.surface2.y;
	s.occlusion = 1.0 - occlusion_strength + metal_map.g * occlusion_strength;
	s.emission = noise * noise_emissive * noise_mask * 10.0;
	return s;
}


// `HGRP/SludgeV2` fragment shading (`sludgeLook` in special-looks.ts, parameters by `SludgeRow`)
fn sludge_surface(
	look: Look,
	in: VertexOut,
	flags: u32,
	faceted: vec3f,
	front: bool,
	uv0_dx: vec2f,
	uv0_dy: vec2f,
) -> Surface {
	let time = frame.eye.w;
	let uv = in.uv.xy;
	let delta = uv - vec2f(0.5);
	let rad = length(delta) * 2.0;
	let ang = atan2(delta.x, delta.y) + 3.14159265;
	let polar_uv = vec2f(ang * 0.15915494, rad);

	let cov2 = in.color.r * 2.0;
	let t1 = saturate(cov2);
	let t2 = saturate(cov2 - 1.0);
	let wave_ao = in.color.g;

	let st0 = look.slot_uv[BASE_SLOT];
	let st1 = look.slot_uv[NORMAL_SLOT];
	let st2 = look.slot_uv[MASK_SLOT];
	let st3 = look.slot_uv[EMISSIVE_SLOT];
	let st4 = look.slot_uv[DETAIL_SLOT];
	let sp0 = look.detail.xy;
	let sp1 = look.detail.zw;
	let sp2 = look.detail2.xy;
	let sp3 = look.detail2.zw;
	let sp4 = look.detail_overlay.xy;

	let uv_m1 = (uv + sp0 * time) * st0.xy + st0.zw;
	let uv_m2 = (uv + sp1 * time) * st1.xy + st1.zw;
	let m1 = select(
		vec4f(1.0),
		textureSampleGrad(base_map, base_sampler, uv_m1, uv0_dx * st0.xy, uv0_dy * st0.xy),
		(flags & BASE_MAP) != 0u,
	);
	let m2 = select(
		vec4f(1.0),
		textureSampleGrad(normal_map, detail_sampler, uv_m2, uv0_dx * st1.xy, uv0_dy * st1.xy),
		(flags & NORMAL_MAP) != 0u,
	);
	let uv_m3 = (uv + sp2 * time) * st2.xy + st2.zw + m1.xy * 0.1 * look.surface2.w;
	let m3 = select(
		vec4f(1.0),
		textureSampleGrad(mask_map, detail_sampler, uv_m3, uv0_dx * st2.xy, uv0_dy * st2.xy),
		(flags & MASK_MAP) != 0u,
	);
	let uv_line = (polar_uv + sp3 * time) * st3.xy + st3.zw + m1.xx * 0.1;
	let line_tex = select(
		vec4f(1.0),
		textureSampleLevel(emissive_map, base_sampler, uv_line, 0.0),
		(flags & EMISSIVE_MAP) != 0u,
	);
	let uv_edge = (polar_uv + sp4 * time) * st4.xy + st4.zw + m3.xy * 0.1;
	let edge_tex = select(
		vec4f(1.0),
		textureSampleLevel(detail_map, detail_sampler, uv_edge, 0.0),
		(flags & DETAIL_MAP) != 0u,
	);

	let base_c = mix(look.tint.rgb, look.mask_albedo[0].rgb, t1);
	let line_col = look.mask_albedo[1];
	let edge_col = look.mask_albedo[2];
	let line_range = look.mask_roughness.x * (sin(ang * 4.7746482 + time) * 0.2 + 0.8);
	let ld = saturate(line_range - t1) / max(line_range, 1e-4);
	let ld2 = ld * ld;
	let line_out = look.mask_roughness.y * (sin(ang * 19.098593 + time * 1.5) * 0.11 + 0.9);
	let line_w = (line_tex.a * line_col.a) * (ld2 * ld2 * saturate(t1 - line_out) * saturate((rad - look.mask_roughness.z) * 5.0) * 5.0);
	let c1 = mix(base_c * m3.rgb, line_tex.rgb * line_col.rgb * m3.rgb, line_w);

	let edge_range = max(look.mask_roughness.w, 1e-4);
	let ed = saturate(edge_range - t1) / edge_range;
	let ew = t1 * ed * ed * look.mask_metallic.x;
	let edge_c = saturate(edge_col.rgb * (m2.r + 0.3) * edge_tex.rgb * ew * (m2.r + 0.1));
	let c2 = mix(c1, edge_c, saturate(ew * edge_col.a));
	let c3 = mix(c2, look.emissive.rgb * m3.rgb * wave_ao, t2 * t2);

	var n = surface_normal(in.normal, faceted, !front);
	if (in.tangent.w != 0.0) {
		let tn_xy = m1.xy * 0.2 + m2.xy * 0.2 - m3.xy * 0.4 + line_tex.xy * 0.1;
		let tn = normalize(vec3f(tn_xy, 1.0));
		let t = normalize(in.tangent.xyz - n * dot(in.tangent.xyz, n));
		var b = cross(in.normal, in.tangent.xyz) * in.tangent.w;
		b = select(-b, b, front);
		b = normalize(b - n * dot(b, n));
		n = normalize(t * tn.x + b * tn.y + n * tn.z);
	}

	let rough = mix(look.surface.x, look.surface.y, m3.r);
	var s = default_surface(clamp(c3 * look.surface2.x, vec3f(0.0), vec3f(1.0)), n);
	s.roughness = rough;
	s.metallic = saturate(rough + look.surface.z);
	s.f0 = 0.04;
	s.occlusion = look.surface.w;
	s.emission = c3 * look.surface2.y;
	return s;
}

