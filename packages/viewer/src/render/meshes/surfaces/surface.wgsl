// one tri-channel mask channel's blend toward its colour, roughness and metallic
fn blend_mask_channel(s: Surface, w: f32, albedo: vec3f, roughness: f32, metallic: f32) -> Surface {
	var out = s;
	out.albedo = mix(s.albedo, albedo, w);
	out.roughness = mix(s.roughness, roughness, w);
	out.metallic = mix(s.metallic, metallic, w);
	return out;
}

// reoriented normal mapping of a tangent-space normal, its x and y already negated, onto a base normal
fn reorient_normal(base: vec3f, flipped: vec3f) -> vec3f {
	let b = base + vec3f(0.0, 0.0, 1.0);
	return b * dot(b, flipped) / max(1e-5, b.z) - flipped;
}

// #region layer blend
// `_LAYERBLEND_TOP` and `_LAYERBLEND_MASK` (`layerBlendParams` in lit-look.ts, parameters by `LayerBlendRow`,
// which reuses the parallax rows: coverage in `parallax`, height and source in `parallax2`, colour in
// `parallax_color`, blend in `parallax_dark`, normal in `parallax_bright`; and the leaf rows `foliage` and
// `foliage_ao` for `_LAYERBLEND_MOSS`'s fuzzy shading)

// the top layer's coverage before the height blend, from the upward component of the normal
fn top_coverage(look: Look, up: f32) -> f32 {
	let coverage = look.parallax;
	return saturate((up - coverage.y) / coverage.z);
}

// the mask layer's coverage before the height blend, by its source (`LayerSource` in lit-look.ts): the mask
// map's R, the layer bump map's alpha, the base colour's alpha, the normal map's alpha, or everywhere
fn mask_coverage(source: f32, mask_r: f32, bump_a: f32, base_a: f32, normal_a: f32) -> f32 {
	switch (u32(source + 0.5)) {
		case 1u: {
			return mask_r;
		}
		case 2u: {
			return bump_a;
		}
		case 3u: {
			return base_a;
		}
		case 4u: {
			return normal_a;
		}
		default: {
			return 1.0;
		}
	}
}

// how much the layer covers, from its raw coverage and the layer's height (`layer_a`)
fn layer_coverage(look: Look, raw: f32, layer_a: f32) -> f32 {
	let height = look.parallax2;
	let cover = saturate(raw);
	if (height.x == 0.0) {
		return cover;
	}
	// each side's height, weighted by its coverage; the higher one wins within the transition
	let weights = vec2f(1.0 - cover, cover);
	let heights = weights * vec2f(height.z, layer_a);
	let w = (max(vec2f(0.0), heights + height.y - max(heights.x, heights.y)) + 1e-6) * weights;
	return w.y / max(1.175494e-38, w.x + w.y);
}

// `_LAYERBLEND_MOSS`: 1 along the coverage edge the edge shadow offset picks, falling off over its range
fn layer_fuzzy_edge(look: Look, raw: f32) -> f32 {
	let d = raw - look.foliage.w;
	return saturate(1.0 - d * d / look.foliage.z);
}

// the layer's tangent-space normal, reoriented onto the base's by the base normal intensity
fn layer_normal(look: Look, base: vec3f, bump: vec4f) -> vec3f {
	let normal = look.parallax_bright;
	let xy = bump.rg * 2.0 - 1.0;
	let layer = vec3f(xy * normal.x, max(1e-16, sqrt(1.0 - saturate(dot(xy, xy)))));
	let reoriented = reorient_normal(base, layer * vec3f(-1.0, -1.0, 1.0));
	return mix(layer, reoriented, normal.y);
}

// the layer's colour, metallic, roughness (the bump map's B) and occlusion (its A) blended in by `cover`.
// `facing` is 1 − N·V and `edge` the fuzzy edge term, which shade the colour as moss (neutral without
// `_LAYERBLEND_MOSS`)
fn layer_surface(
	surface: Surface,
	look: Look,
	cover: f32,
	layer: vec4f,
	bump: vec4f,
	facing: f32,
	edge: f32,
) -> Surface {
	var s = surface;
	let color = look.parallax_color;
	let blend = look.parallax_dark;
	let normal = look.parallax_bright;
	let fuzzy = look.foliage;
	let fuzzy2 = look.foliage_ao;
	let luma = dot(layer.rgb, LUMINANCE);
	let tinted = mix(vec3f(luma), layer.rgb, color.w) * color.rgb * (1.0 - edge * fuzzy2.x);
	// darker facing the viewer, brighter towards the silhouette, the more so the brighter the moss
	let core = mix(1.0 - fuzzy.x, 1.0, pow(facing, fuzzy2.y));
	let bright = core + fuzzy.y * 2.0 * dot(tinted, vec3f(0.299, 0.587, 0.114));
	let fuzz = mix(core, bright, pow(facing, fuzzy2.z));
	// replace (mode 0) or add (mode 1, scaled by the additive intensity)
	s.albedo = s.albedo * (1.0 - cover * (1.0 - blend.x)) + tinted * fuzz * cover * mix(1.0, blend.y, blend.x);
	s.metallic = mix(s.metallic, select(blend.w, layer.a, blend.z != 0.0), cover);
	s.roughness = mix(s.roughness, bump.b, cover);
	s.occlusion = mix(s.occlusion, select(mix(1.0, bump.a, normal.z), 1.0, normal.w != 0.0), cover);
	return s;
}
// #endregion


// a mask channel of the material's own maps, numbered like `_EmissiveMaskChannel`: 1 the base colour's alpha;
// in the two-basemap layout 2 the normal map's B and 3 its alpha, with an MRO map 2 the base alpha and 3 the
// MRO map's alpha (`mro`: whether the mask slot holds one, `has_mro`). maps still streaming read 0
fn map_channel(flags: u32, mro: bool, channel: f32, base_a: f32, packed: vec4f, mask: vec4f) -> f32 {
	if ((flags & NORMAL_OCCLUSION) != 0u) {
		let has_normal = (flags & NORMAL_MAP) != 0u;
		let b = select(0.0, packed.b, has_normal);
		let a = select(0.0, packed.a, has_normal);
		return mix(mix(base_a, b, saturate(channel - 1.0)), a, saturate(channel - 2.0));
	}
	return mix(base_a, select(0.0, mask.a, mro), saturate(channel - 2.0));
}

// whether the mask slot holds a bound MRO map
fn has_mro(flags: u32) -> bool {
	return (flags & MASK_MAP) != 0u;
}


// `_EMISSIVE_ANIM`'s pulse (`EmissivePulseRow` in lit-look.ts, docs/game-data/materials.md#emission): each cycle
// rises from the minimum brightness to 1 and back over the interval's share of it, then stays at the minimum
fn emissive_pulse(look: Look) -> f32 {
	let x = saturate(fract(frame.eye.w * look.emissive_pulse.x + look.emissive_pulse.y) * look.emissive_pulse.z) * 2.0 - 1.0;
	let low = min(look.emissive_pulse.w, 0.999);
	let x2 = x * x;
	return (2.0 * abs(x2 * x) - 3.0 * x2 + 0.5 + 0.5 * (1.0 + low) / (1.0 - low)) * (1.0 - low);
}

// march the view ray down through the parallax noise map as a height field, refine the hit between the last
// two steps, and return the pattern map's RG at the hit
fn parallax_march(
	look: Look,
	in: VertexOut,
	v: vec3f,
	has_noise: bool,
	uv: vec2f,
	uv0_dx: vec2f,
	uv0_dy: vec2f,
	dx: vec2f,
	dy: vec2f,
) -> vec2f {
	// the view direction in the geometric tangent frame
	let bitangent = cross(in.normal, in.tangent.xyz) * in.tangent.w;
	let vt = normalize(vec3f(dot(v, in.tangent.xyz), dot(v, bitangent), dot(v, in.normal)));
	let steps = look.parallax.y;
	let step = 1.0 / steps;
	let delta = vt.xy / (vt.z + 0.42) / max(vt.z, 0.001) * (-look.parallax.x * step);
	let noise_uv = uv * look.slot_uv[NOISE_SLOT].xy;

	var height = 1.0 - step;
	var offset = delta;
	var previous_offset = vec2f(0.0);
	var previous_sample = 0.0;
	var previous_height = 1.0;
	var hit = -1.0;
	for (var i = 0.0; i < steps + 1.0; i += 1.0) {
		// an empty noise slot is Unity's black default
		let sampled = textureSampleGrad(parallax_noise_map, parallax_sampler, noise_uv + offset, uv0_dx, uv0_dy).x;
		let found = select(0.0, sampled, has_noise);
		if (found > height) {
			hit = found;
			break;
		}
		previous_offset = offset;
		previous_sample = found;
		previous_height = height;
		offset += delta;
		height -= step;
	}
	if (hit < 0.0) {
		hit = previous_sample;
	}
	let denominator = (previous_sample - hit) + height - previous_height;
	let t = (previous_sample - previous_height) / select(denominator, 1e-6, denominator == 0.0);
	let tiling = look.slot_uv[PARALLAX_SLOT].xy;
	return textureSampleGrad(
		parallax_map,
		parallax_sampler,
		(uv + previous_offset + delta * t) * tiling,
		dx * tiling,
		dy * tiling,
	).xy;
}

// Fresnel, pulse, near-player brightening and exposure scaling shared by both `_PARALLAX_MAP` paths
fn parallax_radiance(look: Look, in: VertexOut, v: vec3f, n: vec3f, base_color: vec3f) -> vec3f {
	let fresnel = pow(max(saturate(dot(v, n)), 0.001), look.parallax.z);
	let pulse = cos(frame.eye.w * look.parallax2.x + look.parallax2.y * in.phase) * look.parallax.w + look.parallax2.w;
	// the player stands at the camera. a smoothstep from the outer radius down to the inner one, written out
	// because WGSL's smoothstep wants its edges in ascending order
	let bright = look.parallax_bright;
	let near_t = saturate((length(in.rel) - bright.x) / (bright.y - bright.x));
	let near = near_t * near_t * (3.0 - 2.0 * near_t) * bright.z;
	let color = base_color * fresnel * (pulse + near);
	return clamp(color, vec3f(0.0), vec3f(1000.0)) * mix(1.0, frame.ambient.y, look.parallax2.z);
}

// `_PARALLAX_MAP` (`parallaxParams` in lit-look.ts, docs/game-data/materials.md#lit-layers): march the view
// ray down through the noise map as a height field, refine the hit between the last two steps, and colour it
// from the pattern's G; then the Fresnel power and the pulse, plus the brightening near the player. the result
// is HDR emission before the mask
fn parallax_glow(
	look: Look,
	in: VertexOut,
	v: vec3f,
	n: vec3f,
	has_noise: bool,
	uv: vec2f,
	uv0_dx: vec2f,
	uv0_dy: vec2f,
	dx: vec2f,
	dy: vec2f,
) -> vec3f {
	let pattern = parallax_march(look, in, v, has_noise, uv, uv0_dx, uv0_dy, dx, dy);
	let base_color = mix(look.parallax_dark.rgb, look.parallax_color.rgb, pattern.y);
	return parallax_radiance(look, in, v, n, base_color);
}

// `_PARALLAX_MAP_WORLDSPACE` (`ParallaxWorldRow` in lit-look.ts, docs/game-data/materials.md#lit-layers):
// projects `_ParallaxMaskMap` (in `overlay_mask_map`) over world XZ around `center`, blends between two pattern
// colours past `lerp_schedule`, and adds the optional object-height highlight
fn parallax_world_glow(
	look: Look,
	in: VertexOut,
	flags: u32,
	extra: u32,
	v: vec3f,
	n: vec3f,
	has_noise: bool,
	uv: vec2f,
	uv0_dx: vec2f,
	uv0_dy: vec2f,
	dx: vec2f,
	dy: vec2f,
	base_a: f32,
	packed: vec4f,
) -> vec3f {
	let pattern = parallax_march(look, in, v, has_noise, uv, uv0_dx, uv0_dy, dx, dy);
	let base_color = mix(look.parallax_dark.rgb, look.parallax_color.rgb, pattern.y);
	let base_glow = parallax_radiance(look, in, v, n, base_color);

	let world = in.rel + frame.eye.xyz;
	let wp = look.parallax_world[0];
	let rot = look.parallax_world[1];
	let pat_bright = look.parallax_world[2];
	let pat_dark = look.parallax_world[3];
	let add_col = look.parallax_world[4];

	let delta_xz = world.xz - wp.xy;
	let scaled = delta_xz * wp.z;
	let rotated = vec2f(rot.x * scaled.x + rot.y * scaled.y, -rot.y * scaled.x + rot.x * scaled.y);
	let min_brightness = look.parallax2.w - look.parallax.w;
	let mask_uv = rotated + vec2f(0.5) + pattern * min_brightness;
	let geom_ny = select(0.0, saturate(abs(normalize(in.normal).y)), dot(in.normal, in.normal) > 1e-6);
	let mask_sample = select(
		vec3f(0.0),
		textureSampleLevel(overlay_mask_map, detail_sampler, mask_uv, mix(3.0, 0.0, geom_ny)).rgb,
		(extra & EXTRA_OVERLAY_MASK_MAP) != 0u,
	);
	let tinted = base_glow * base_color * mask_sample;
	let lerp_t = saturate((length(delta_xz) + pattern.x * 20.0) - wp.w);
	let glow = mix(tinted * pat_bright.rgb, tinted * pat_dark.rgb, lerp_t);

	let has_normal = (flags & NORMAL_MAP) != 0u;
	let norm_b = select(0.0, packed.b, has_normal);
	let norm_a = select(0.0, packed.a, has_normal);
	let add_ch = pat_dark.w;
	let add_mask = mix(mix(base_a, norm_b, saturate(add_ch)), norm_a, saturate(add_ch - 1.0));
	let additional = (vec3f(0.3) + glow) * add_col.rgb * saturate(in.object_pos.y - pat_bright.w) * add_mask;
	let height_mask = mix(base_a, saturate(rot.w - world.y), saturate(rot.w));
	return additional + glow * height_mask * rot.z;
}


// `HGRP/LitTransparent`'s `_USE_FRESNEL` (`fresnelParams` in lit-look.ts): returns `(fresnel, mask)` where
// `fresnel` is the flipped view-angle power and `mask` is the channel mask (before vertex-G scaling)
fn transparent_fresnel(
	look: Look,
	in: VertexOut,
	front: bool,
	faceted: vec3f,
	shading_n: vec3f,
	base_a: f32,
	packed: vec4f,
) -> vec2f {
	let ch = look.parallax2.x;
	let sample_ch = mix(mix(base_a, packed.b, saturate(ch)), packed.a, saturate(ch - 1.0));
	let mask = saturate((1.0 - sample_ch) + look.parallax2.y);
	let mesh_n = surface_normal(in.normal, faceted, !front);
	let fn_n = normalize(mix(shading_n, mesh_n, look.parallax2.w));
	let v = normalize(-in.rel);
	let raw = pow(saturate(dot(v, fn_n) + look.parallax.x), look.parallax.y);
	let fresnel = mix(1.0 - raw, raw, look.parallax.z);
	return vec2f(fresnel, mask);
}


struct SurfaceEval {
	surface: Surface,
	unlit: bool,
	unlit_color: vec3f,
}

fn eval_to_gbuffer(ev: SurfaceEval, no_lit_decals: bool, feedback: u32, velocity: vec2f) -> GBufferOut {
	var out: GBufferOut;
	if (ev.unlit) {
		out = pack_gbuffer_unlit(ev.unlit_color, feedback);
	} else {
		out = pack_gbuffer(ev.surface, no_lit_decals, feedback);
	}
	out.velocity = velocity;
	return out;
}

@fragment
fn fs_opaque(in: VertexOut, @builtin(front_facing) front_facing: bool) -> GBufferOut {
	let look = look_slot(draws[in.draw]);
	let feedback = pack_mip_feedback(look, in.uv, in.rel, frame.params.y);
	let ev = eval_surface(in, false, is_front_face(front_facing, in.mirrored));
	return eval_to_gbuffer(ev, looks[look].detail2.w > 0.5, feedback, dynamic_velocity(in.rel, in.prev_rel));
}

// alpha-tested surfaces that don't write depth (`HGRP/Lit` `_ZWRITE_OFF`, e.g. floor/wall mesh decals):
// they skip the prepass and discard here against the opaque/cutout depth buffer
@fragment
fn fs_cutout_overlay(in: VertexOut, @builtin(front_facing) front_facing: bool) -> GBufferOut {
	if (fade_discard(in.fade, in.position.xy)) {
		discard;
	}
	let draw = draws[in.draw];
	let flags = bitcast<u32>(draw.offset.w);
	let id = look_slot(draw);
	let look = looks[id];
	let gradient_scale = exp2(frame.params.y);
	let uv0_dx = dpdx(in.uv.xy) * gradient_scale;
	let uv0_dy = dpdy(in.uv.xy) * gradient_scale;
	let uv1_dx = dpdx(in.uv.zw) * gradient_scale;
	let uv1_dy = dpdy(in.uv.zw) * gradient_scale;
	var texel: vec4f;
	if ((flags & ALPHA_NORMAL) != 0u) {
		texel = sample_slot(normal_map, detail_sampler, id, in.uv, uv0_dx, uv0_dy, uv1_dx, uv1_dy, flags, NORMAL_SLOT);
	} else {
		texel = sample_slot(base_map, base_sampler, id, in.uv, uv0_dx, uv0_dy, uv1_dx, uv1_dy, flags, BASE_SLOT);
	}
	if (texel.a < look.tint.w) {
		discard;
	}
	let feedback = pack_mip_feedback(id, in.uv, in.rel, frame.params.y);
	let ev = eval_surface(in, false, is_front_face(front_facing, in.mirrored));
	return eval_to_gbuffer(ev, look.detail2.w > 0.5, feedback, dynamic_velocity(in.rel, in.prev_rel));
}


fn eval_surface(in: VertexOut, transparent: bool, front: bool) -> SurfaceEval {
	var ev: SurfaceEval;
	ev.unlit = false;
	ev.unlit_color = vec3f(0.0);
	let draw = draws[in.draw];
	let flags = bitcast<u32>(draw.offset.w);
	let extra = extra_flags(draw);
	let id = look_slot(draw);
	let look = looks[id];
	// derivatives (and implicit-LOD sampling) must happen in uniform control flow
	let rel_dx = dpdx(in.rel);
	let rel_dy = dpdy(in.rel);
	// screen +Y is down, so dpdx × dpdy faces the viewer in left-handed space
	let faceted = cross(rel_dx, rel_dy);
	let bias = frame.params.y;
	let base = textureSampleBias(base_map, base_sampler, slot_uv(id, in.uv, flags, BASE_SLOT), bias);
	let packed = textureSampleBias(normal_map, detail_sampler, slot_uv(id, in.uv, flags, NORMAL_SLOT), bias);
	let mask = textureSampleBias(mask_map, detail_sampler, slot_uv(id, in.uv, flags, MASK_SLOT), bias);
	let glow = textureSampleBias(emissive_map, base_sampler, slot_uv(id, in.uv, flags, EMISSIVE_SLOT), bias);
	let detail = textureSampleBias(detail_map, detail_sampler, slot_uv(id, in.uv, flags, DETAIL_SLOT), bias);
	let tri_mask = textureSampleBias(
		tri_mask_map,
		detail_sampler,
		extra_slot_uv(id, in.uv, extra, EXTRA_TRI_MASK_SLOT),
		bias,
	);
	let overlay_mask = textureSampleBias(
		overlay_mask_map,
		detail_sampler,
		extra_slot_uv(id, in.uv, extra, EXTRA_OVERLAY_MASK_SLOT),
		bias,
	);
	let gradient_scale = exp2(bias);
	let uv0_dx = dpdx(in.uv.xy) * gradient_scale;
	let uv0_dy = dpdy(in.uv.xy) * gradient_scale;
	let uv1_dx = dpdx(in.uv.zw) * gradient_scale;
	let uv1_dy = dpdy(in.uv.zw) * gradient_scale;

	// the gaps view (`DEBUG_VIEWS` in debug-views.ts): a material drawn without something the game draws
	// (`GAPS_FLOAT` in look.ts) shows amber and black stripes, 25 cm wide in world space, over its base map's
	// brightness
	if (frame.flags.y == 6u && look.misc.x > 0.5) {
		let world = in.rel + frame.eye.xyz;
		let stripe = fract((world.x + world.y + world.z) * 2.0) < 0.5;
		let shape = select(1.0, dot(base.rgb, LUMINANCE_ROUNDED), (flags & BASE_MAP) != 0u);
		ev.unlit = true;
		ev.unlit_color = select(vec3f(0.02), vec3f(1.0, 0.5, 0.0), stripe) * (0.5 + 0.5 * shape);
		return ev;
	}
	if ((flags & UNLIT) != 0u) {
		// matte paintings (`mattePaintingLook` in special-looks.ts): the tinted texture brightened above a threshold,
		// in pre-exposed units unless it ignores the post exposure
		var c = look.tint.rgb;
		if ((flags & BASE_MAP) != 0u) {
			c *= base.rgb;
		}
		c *= dither_vertex_color(look, flags, in.color);
		// VFXDitherAlphaNoLighting writes its colour times the alpha before the mask and the power
		// (`DitherFlags.AlphaColor`)
		let bits = dither_bits(look, flags);
		if ((bits & DITHER_ALPHA_COLOR) != 0u) {
			let texel = select(base, packed, (flags & ALPHA_NORMAL) != 0u);
			c *= saturate(dither_alpha(look, bits, texel, in.color.a, 1.0 / in.position.w));
		}
		// materials the viewer can't draw (`unsupportedLook` in material-looks.ts): a world-space checker of the tint
		// and black
		if (look.surface.z > 0.0) {
			let cell = vec3i(floor((in.rel + frame.eye.xyz) / look.surface.z));
			if (((cell.x + cell.y + cell.z) & 1) != 0) {
				c = vec3f(0.0);
			}
		}
		c += max(c - vec3f(look.surface.x), vec3f(0.0)) * look.surface.y;
		ev.unlit = true;
		ev.unlit_color = clamp(c * mix(1.0, frame.ambient.y, look.emissive2.z), vec3f(0.0), vec3f(1000.0));
		return ev;
	}
	if ((flags & EROSION) != 0u) {
		var s: Surface;
		if (look.emissive2.w > 1.5) {
			s = sludge_surface(look, in, flags, faceted, front, uv0_dx, uv0_dy);
		} else if (look.emissive2.w > 0.5) {
			s = erosion_dynamic_surface(look, in, flags, faceted, front, packed, mask, uv0_dx, uv0_dy);
		} else {
			s = erosion_surface(look, in, flags, faceted, front, packed, mask, detail, uv0_dx, uv0_dy);
		}
		ev.surface = s;
		return ev;
	}

	var albedo = clamp(base.rgb * look.tint.rgb * look.surface2.w, vec3f(0.0), vec3f(1.0));
	if ((flags & BASE_MAP) == 0u) {
		albedo = vec3f(1.0);
	}
	albedo = mix(albedo, look.tint.rgb, look.emissive.w);
	if ((dither_bits(look, flags) & DITHER_SURFACE) != 0u) {
		// VFXDitherAlpha's albedo saturates only after the tint, the texture and the vertex colour multiply
		let texel = select(vec3f(1.0), base.rgb, (flags & BASE_MAP) != 0u && look.emissive.w < 0.5);
		albedo = saturate(look.tint.rgb * texel * dither_vertex_color(look, flags, in.color));
	}
	let base_a = select(0.0, base.a, (flags & BASE_MAP) != 0u);
	let has_normal = (flags & NORMAL_MAP) != 0u;

	// the detail map's weight: a mask channel (`_DetailMaskMode`: none, the detail's alpha, the base colour's
	// alpha, the normal map's B or A) fading out with view depth
	let has_detail = (flags & DETAIL_MAP) != 0u;
	var detail_weight = 0.0;
	if (has_detail) {
		let mode = look.detail.y;
		let own = mix(mix(base_a, packed.b, saturate(mode - 2.0)), packed.a, saturate(mode - 3.0));
		let depth = abs(dot(in.rel, frame.view_forward.xyz));
		let span = look.detail2.y - look.detail2.x;
		let fade = saturate((look.detail2.y - depth) / select(span, 1e-6, span == 0.0));
		detail_weight = mix(mix(1.0, detail.a, saturate(mode)), own, saturate(mode - 1.0)) * fade;
		// colour mode: the overlay, where the detail's B is dark
		let overlay = mix(
			clamp(albedo * look.detail_overlay.rgb * look.detail2.z, vec3f(0.0), vec3f(1.0)),
			look.detail_overlay.rgb,
			look.detail_overlay.a,
		);
		albedo = mix(albedo, overlay, detail_weight * (1.0 - look.detail.x) * (1.0 - detail.b));
	}
	let detail_pbr = look.detail.w * detail_weight;

	// two-sided materials show both faces: flip the shading normal on back faces by winding, matching the game's
	// `gl_FrontFacing` check. leaves and grass without `_TwoSidedNormal` keep their mesh normals on both faces
	// (canopy-shaped normals on trees, ground-up normals on grass blades)
	let grass = (flags & (FOLIAGE | FOLIAGE_LEAF)) == FOLIAGE;
	let keep_back_normal = ((flags & FOLIAGE_LEAF) != 0u && look.canopy_color.w < 0.5) ||
		(grass && look.foliage_ao.w < 0.5);
	let flip_back = !front && !keep_back_normal;
	var n = surface_normal(in.normal, faceted, flip_back);

	// the layer, once both its maps are bound; the parallax glow can't share the slots
	let layer_maps = PARALLAX_MAP | PARALLAX_NOISE_MAP;
	let layered = (flags & LAYER_BLEND) != 0u && (flags & layer_maps) == layer_maps;
	let cover_source = look.parallax2.w;
	let top_layer = layered && cover_source == LAYER_SOURCE_TOP;
	var layer = vec4f(0.0);
	var layer_bump = vec4f(0.0);
	if (layered) {
		// the layer's coordinates: UV set 0, world XZ, or UV set 2, which the viewer reads as set 0
		// (`layerBlendParams` in lit-look.ts)
		let world_xz = look.parallax.w > 0.5 && look.parallax.w < 1.5;
		let layer_source = select(in.uv.xy, (in.rel + frame.eye.xyz).xz, world_xz);
		let layer_t = look.slot_uv[LAYER_SLOT];
		let layer_uv = layer_source * layer_t.xy + layer_t.zw;
		let layer_dx = select(uv0_dx, rel_dx.xz * gradient_scale, world_xz) * layer_t.xy;
		let layer_dy = select(uv0_dy, rel_dy.xz * gradient_scale, world_xz) * layer_t.xy;
		layer = textureSampleGrad(parallax_map, parallax_sampler, layer_uv, layer_dx, layer_dy);
		layer_bump = textureSampleGrad(parallax_noise_map, parallax_sampler, layer_uv, layer_dx, layer_dy);
	}
	// the layer's coverage before the height blend (the fuzzy edge reads it), and after
	var raw_cover = 0.0;
	var cover = 0.0;
	if (layered && !top_layer) {
		let mask_r = select(0.0, overlay_mask.r, (extra & EXTRA_OVERLAY_MASK_MAP) != 0u);
		let normal_a = select(0.0, packed.a, has_normal);
		raw_cover = mask_coverage(cover_source, mask_r, layer_bump.a, base_a, normal_a);
		cover = layer_coverage(look, raw_cover, layer.a);
	}

	var roughness = look.surface.y;
	if ((has_normal || layered) && in.tangent.w != 0.0) {
		var tn = vec3f(0.0, 0.0, 1.0);
		if (has_normal) {
			var rg = packed.rg;
			if ((flags & NORMAL_RAG) != 0u) {
				rg.x = packed.r * packed.a;
			}
			var xy = unpack_normal_xy(rg);
			if (grass) {
				// `_BendNormalUpward`: towards the blade's up (tangent-space +Y), before the normal scale
				xy = mix(xy, vec2f(0.0, 1.0), look.foliage.x);
			}
			tn = vec3f(xy * look.surface.w, normal_z(xy));
			if (has_detail) {
				// reoriented normal mapping of the detail onto the base normal
				let dxy = unpack_normal_xy(detail.rg);
				let d = vec3f(dxy * (detail_weight * look.detail.z), normal_z(dxy)) * vec3f(-1.0, -1.0, 1.0);
				tn = reorient_normal(tn, d);
			}
		}
		var t = normalize(in.tangent.xyz - n * dot(in.tangent.xyz, n));
		var b = cross(in.normal, in.tangent.xyz) * in.tangent.w;
		// grass with `_TwoSidedNormal` flips only the surface normal on its back faces, so its bent normal keeps
		// pointing up the blade
		if (flip_back && !grass) {
			b = -b;
		}
		b = normalize(b - n * dot(b, n));
		if (top_layer) {
			let bumped = normalize(t * tn.x + b * tn.y + n * tn.z);
			raw_cover = top_coverage(look, mix(n.y, bumped.y, look.parallax.x));
			cover = layer_coverage(look, raw_cover, layer.a);
		}
		if (layered) {
			tn = mix(tn, layer_normal(look, tn, layer_bump), cover);
		}
		n = normalize(t * tn.x + b * tn.y + n * tn.z);
	} else if (top_layer) {
		raw_cover = top_coverage(look, n.y);
		cover = layer_coverage(look, raw_cover, layer.a);
	}
	// read whether or not the mesh has tangents: tangentless meshes lose only the normal's bump
	if (has_normal && (flags & NORMAL_ROUGHNESS) != 0u) {
		roughness = mix(look.surface.x, look.surface.y, packed.b);
	}
	// `_LAYERBLEND_MOSS` (neutral without it): the fuzzy shading faces the blended normal to the view, and
	// the coverage edge tips the normal down
	var layer_facing = 0.0;
	var layer_edge = 0.0;
	if (layered) {
		layer_facing = 1.0 - saturate(dot(n, normalize(-in.rel)));
		layer_edge = layer_fuzzy_edge(look, raw_cover);
		n = normalize(n - vec3f(0.0, layer_edge * look.foliage_ao.w, 0.0));
	}

	var s = default_surface(albedo, n);
	s.roughness = roughness;
	s.metallic = look.surface.z;
	s.f0 = look.surface2.y;
	if ((flags & METALLIC_BASE_ALPHA) != 0u) {
		// dielectric until the base colour streams in
		s.metallic = base_a;
	}
	if ((flags & (NORMAL_MAP | NORMAL_OCCLUSION)) == (NORMAL_MAP | NORMAL_OCCLUSION)) {
		s.occlusion = mix(1.0, packed.a, look.surface2.x);
	}
	let mro = has_mro(flags);
	if (mro) {
		s.metallic = mask.r;
		s.roughness = mix(look.surface.x, look.surface.y, mask.g);
		s.occlusion = mix(1.0, mask.b, look.surface2.x);
	}
	if (has_detail) {
		// PBR mode: roughness toward the detail's B, occlusion times its alpha; colour mode: roughness toward its
		// alpha only
		s.roughness = mix(s.roughness, mix(detail.a, detail.b, look.detail.x), detail_pbr);
		s.occlusion *= mix(1.0, mix(1.0, detail.a, look.detail.x), detail_pbr);
	}
	if ((flags & TRI_CHANNEL_MASK) != 0u && (extra & EXTRA_TRI_MASK_MAP) != 0u) {
		// each channel, remapped by its contrast and offset, blends toward its own surface, B first and R last
		let scale = look.mask_scale.xyz;
		let w = saturate(scale * 0.5 + mix(-scale, vec3f(1.0), tri_mask.rgb + look.mask_offset.xyz)) *
			vec3f(look.mask_albedo[0].w, look.mask_albedo[1].w, look.mask_albedo[2].w);
		let roughnesses = look.mask_roughness;
		let metallics = look.mask_metallic;
		s = blend_mask_channel(s, w.z, look.mask_albedo[2].rgb, roughnesses.z, metallics.z);
		s = blend_mask_channel(s, w.y, look.mask_albedo[1].rgb, roughnesses.y, metallics.y);
		s = blend_mask_channel(s, w.x, look.mask_albedo[0].rgb, roughnesses.x, metallics.x);
	}
	if (layered) {
		s = layer_surface(s, look, cover, layer, layer_bump, layer_facing, layer_edge);
	}

	var emission = vec3f(0.0);
	let has_fresnel = transparent && look.parallax_bright.x > 0.5;
	var emissive_color = look.emissive.rgb;
	if (look.emissive_pulse_strength.y > 0.0) {
		emissive_color *= mix(
			1.0,
			cos(frame.eye.w * look.emissive_pulse_strength.y * 6.2831853) * 0.5 + 0.5,
			look.emissive_pulse_strength.z,
		);
	}
	// the emission's strength: the map's R or the remapped mask channel
	var strength = 0.0;
	if ((flags & EMISSIVE_MAP) != 0u) {
		// R scales the emissive colour; G, B and A add colours of their own (zero unless `_EmissiveType` is set)
		let channels = look.emissive_channels;
		strength = glow.r;
		emission = emissive_color * glow.r + channels[0].rgb * glow.g + channels[1].rgb * glow.b
			+ channels[2].rgb * glow.a;
	}
	if ((flags & EMISSIVE_MASK) != 0u) {
		strength = saturate((map_channel(flags, mro, look.emissive2.y, base_a, packed, mask) - 0.05) / 0.9);
		emission = emissive_color * strength;
	}
	// a per-draw albedo tint darkens or tints the emitting parts, and so the emission that follows the albedo
	let tinted = look.emissive_albedo.w * step(0.1, strength);
	s.albedo *= vec3f(1.0 - tinted) + look.emissive_albedo.rgb * tinted;
	// emission is in the light's pre-exposed units already; emitters that ignore the post exposure divide it out
	// (docs/game-data/materials.md#emission)
	let tint = mix(s.albedo, vec3f(1.0), look.emissive2.x);
	s.emission = emission * tint * mix(1.0, frame.ambient.y, look.emissive2.z);
	if (look.emissive_pulse.z > 0.0) {
		s.emission *= mix(1.0, emissive_pulse(look), look.emissive_pulse_strength.x);
	}

	// `HGRP/Foliage/Glow`'s flowing glow: the noise map alone in the parallax slots
	let parallax_users = PARALLAX_MAP | PARALLAX_NOISE_MAP | LAYER_BLEND | VERTEX_OFFSET;
	if ((flags & parallax_users) == PARALLAX_NOISE_MAP) {
		let noise_uv1 = (flags & (1u << (UV1_SHIFT + NOISE_SLOT))) != 0u;
		let noise_uv = select(in.uv.xy, in.uv.zw, noise_uv1);
		let noise_dx = select(uv0_dx, uv1_dx, noise_uv1);
		let noise_dy = select(uv0_dy, uv1_dy, noise_uv1);
		s.emission += flow_glow(look, s.albedo, in.color.r, noise_uv, noise_dx, noise_dy);
	}

	// the glow needs its pattern; without a noise map it marches a flat height field
	if ((flags & (PARALLAX_MAP | LAYER_BLEND | VERTEX_OFFSET)) == PARALLAX_MAP && in.tangent.w != 0.0) {
		let world_parallax = look.parallax_world[4].w > 0.5;
		// the glow's mask uses the same channel numbering as the emission mask, one lower
		let glow_mask = map_channel(flags, mro, look.parallax_color.w + 1.0, base_a, packed, mask);
		if (world_parallax || glow_mask > 0.01) {
			let v = normalize(-in.rel);
			let has_noise = (flags & PARALLAX_NOISE_MAP) != 0u;
			let p_uv1 = (flags & (1u << (UV1_SHIFT + PARALLAX_SLOT))) != 0u;
			let parallax_uv = select(in.uv.xy, in.uv.zw, p_uv1);
			let parallax_dx = select(uv0_dx, uv1_dx, p_uv1);
			let parallax_dy = select(uv0_dy, uv1_dy, p_uv1);
			if (world_parallax) {
				s.emission += parallax_world_glow(
					look,
					in,
					flags,
					extra,
					v,
					n,
					has_noise,
					parallax_uv,
					uv0_dx,
					uv0_dy,
					parallax_dx,
					parallax_dy,
					base_a,
					packed,
				);
			} else {
				s.emission += parallax_glow(look, in, v, n, has_noise, parallax_uv, uv0_dx, uv0_dy, parallax_dx, parallax_dy) *
					(glow_mask * glow_mask);
			}
		}
	}

	if ((flags & FOLIAGE) != 0u) {
		s.foliage = true;
		s.transmission = look.surface2.z;
		if ((flags & FOLIAGE_LEAF) != 0u) {
			s = leaf_surface(s, look, in, has_normal, packed.a);
		} else {
			s = grass_surface(s, look, in, select(1.0, packed.a, has_normal));
		}
	} else if ((flags & TRUNK) != 0u) {
		s = trunk_surface(s, look, in, base_a);
	} else if ((flags & LAYER_BLEND) == 0u) {
		// VFXWaterDitherAlpha's and LitTransparent's `_SUBSURFACE`; zero on other looks
		s.scatter = look.foliage;
		s.scatter_indirect = look.foliage_ao.x;
	}
	// `HGRP/LitTransparent`'s `_USE_FRESNEL` (`transparent` is true only in `fs_transparent`)
	if (has_fresnel) {
		let f = transparent_fresnel(
			look,
			in,
			front,
			faceted,
			s.normal,
			select(1.0, base.a, (flags & BASE_MAP) != 0u),
			packed,
		);
		let vg = select(1.0, in.color.g, (flags & HAS_COLORS) != 0u);
		let fresnel_mask = f.y * mix(1.0, vg, look.parallax2.z);
		s.emission += mix(s.albedo, look.parallax_color.rgb, look.parallax_color.a * f.x) * fresnel_mask;
	}
	ev.surface = s;
	return ev;
}

