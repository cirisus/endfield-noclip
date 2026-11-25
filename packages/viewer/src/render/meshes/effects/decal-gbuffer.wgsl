// #region lit decals

// `EffectKind.LitDecal` (effect-look.ts)
const FX_KIND_LIT_DECAL = 2.0;
// rows of a lit decal look (`DecalLitRow` in lit-decal.ts, in vec4s)
const LD_SURFACE = 17u;
const LD_WRITES = 18u;
const LD_PBR = 19u;
const LD_CHANNELS = 20u;
const LD_WATER = 21u;
const LD_FLOW = 22u;
const LD_FLOW_FADE = 23u;
const LD_EMISSIVE = 24u;
const LD_EMISSIVE_MASK = 25u;
const LD_PBR_PLACED = 26u;
const LD_WET_MASK = 27u;
const LD_SLUDGE = 32u;
// the sludge texture's slot, whose UV row holds its scale
const LD_SLUDGE_SLOT = 2u;

// one of four map channels by `_MetallicChannel`/`_OcclusionChannel`'s numbering, as the game blends them:
// `offset` 1 for the occlusion's (R at 1, … A at 4) and 0 for the metallic's (R at 2, … A at 5)
fn ld_channel(p: vec4f, channel: f32, offset: f32) -> f32 {
	let c = channel + offset;
	return mix(mix(p.x, p.y, saturate(c - 2.0)), mix(p.z, p.w, saturate(c - 4.0)), saturate(c - 3.0));
}

// a decoded tangent-space normal map texel, unit length
fn ld_tangent_normal(rg: vec2f) -> vec3f {
	let xy = unpack_normal_xy(rg);
	return vec3f(xy, normal_z(xy));
}

// what a lit decal makes of the surface beneath at one pixel
struct LitDecal {
	// how much of it shows, 0 to 1
	alpha: f32,
	// the decal's colour, which only laid-over decals use
	albedo: vec3f,
	normal: vec3f,
	roughness: f32,
	// metallic and occlusion where the decal writes them (`writes_metallic`, `writes_occlusion`)
	metallic: f32,
	occlusion: f32,
	writes_metallic: bool,
	writes_occlusion: bool,
	// `_BLEND_EMISSIVE`'s light, in pre-exposed units like the surface's own; zero without it
	emission: vec3f,
}

// `HGRP/DecalLit` boxes (`litDecalLook` in lit-decal.ts, docs/game-data/materials.md#decals) over a surface of
// normal `n` and roughness `roughness` at camera-relative `rel` (with its screen gradients): where the
// material's colour masks let it, the decal's roughness, normal, metallic and occlusion replace the surface's.
// `local` is the point in the box (±0.5) and `uv` its `local.xz + 0.5` with its screen gradients; the
// placement's colour and UV transform are its row's
fn ld_decal(in: EffectOut, rel: vec3f, rel_dx: vec3f, rel_dy: vec3f, local: vec3f, uv: vec2f, dx: vec2f, dy: vec2f,
	n: vec3f, roughness: f32) -> LitDecal {
	let id = in.look;
	let base_t = in.placement_uv;
	let base = textureSampleGrad(fx_tex0, fx_samp0, uv * base_t.xy + base_t.zw, dx * base_t.xy, dy * base_t.xy);
	// the PBR map's own transform, or the placement's
	let pbr_t = select(fx_row(id, FX_UV + 1u), in.placement_uv, fx_row(id, LD_PBR_PLACED).x > 0.5);
	// the placement's colour, its alpha times the opacity
	let tint = in.placement_color * fx_row(id, FX_TINT);
	let surface_row = fx_row(id, LD_SURFACE);
	let writes = fx_row(id, LD_WRITES);
	let pbr_row = fx_row(id, LD_PBR);
	let channels = fx_row(id, LD_CHANNELS);
	let water = fx_row(id, LD_WATER);
	// with `_BaseTexChannel` the base map is the PBR map, and the colour the placement's alone
	let pbr_base = channels.x > 0.5;

	var d: LitDecal;
	d.albedo = tint.rgb * select(base.rgb, vec3f(1.0), pbr_base);
	d.normal = n;
	d.roughness = roughness;
	d.metallic = 0.0;
	d.occlusion = 1.0;
	d.writes_metallic = false;
	d.writes_occlusion = false;
	d.emission = vec3f(0.0);
	var alpha = base.a * tint.a;
	if (surface_row.w > 0.0) {
		alpha *= pow(max(saturate(dot(in.up, n)), 5.96e-8), surface_row.w);
	}
	let sludge = fx_row(id, LD_SLUDGE);
	if (sludge.x > 0.5) {
		// `_BLEND_SLUDGE_EROSION`: surfaces facing the world's x and z take the sludge texture, untinted, at the
		// box's local zy and xy; the weights are the surface normal's squared world components, as the game's
		let st = fx_row(id, FX_UV + LD_SLUDGE_SLOT).xy;
		let local_dx = vec3f(dot(in.to_object0.xyz, rel_dx), dot(in.to_object1.xyz, rel_dx), dot(in.to_object2.xyz, rel_dx));
		let local_dy = vec3f(dot(in.to_object0.xyz, rel_dy), dot(in.to_object1.xyz, rel_dy), dot(in.to_object2.xyz, rel_dy));
		let side_x = textureSampleGrad(fx_tex2, fx_samp2, local.zy * st, local_dx.zy * st, local_dy.zy * st);
		let side_z = textureSampleGrad(fx_tex2, fx_samp2, local.xy * st, local_dx.xy * st, local_dy.xy * st);
		let w = n * n;
		d.albedo = d.albedo * w.y + side_x.rgb * w.x + side_z.rgb * w.z;
		// the alpha stays the base map's, scaled, and fades out above the box's centre
		alpha *= sludge.y * saturate(1.0 - local.y * sludge.z);
	}

	var tangent_n: vec3f;
	var pbr: vec4f;
	if (water.x > 0.5) {
		let flow = fx_row(id, LD_FLOW);
		let steep = pow(max(abs(1.0 - abs(n.y)), 5.96e-8), fx_row(id, LD_FLOW_FADE).x);
		alpha *= steep;
		let n2 = n * n;
		let w = n2.xz / max(n2.x + n2.z, 1e-5);
		let push = vec2f(0.0, steep * water.w);
		let world = frame.eye.xyz + rel;
		let scroll = vec2f(0.0, frame.eye.w);
		let zy = world.zy * pbr_t.xy;
		let xy = world.xy * pbr_t.xy;
		let zy_dx = rel_dx.zy * pbr_t.xy;
		let zy_dy = rel_dy.zy * pbr_t.xy;
		let xy_dx = rel_dx.xy * pbr_t.xy;
		let xy_dy = rel_dy.xy * pbr_t.xy;
		let a_zy = textureSampleGrad(fx_tex1, fx_samp1, zy * flow.z + scroll * flow.x + push, zy_dx * flow.z, zy_dy * flow.z);
		let a_xy = textureSampleGrad(fx_tex1, fx_samp1, xy * flow.z + scroll * flow.x + push, xy_dx * flow.z, xy_dy * flow.z);
		let b_zy = textureSampleGrad(fx_tex1, fx_samp1, zy * flow.w + scroll * flow.y + push, zy_dx * flow.w, zy_dy * flow.w);
		let b_xy = textureSampleGrad(fx_tex1, fx_samp1, xy * flow.w + scroll * flow.y + push, xy_dx * flow.w, xy_dy * flow.w);
		let t = (ld_tangent_normal(a_zy.rg) + ld_tangent_normal(b_zy.rg)) * w.x +
			(ld_tangent_normal(a_xy.rg) + ld_tangent_normal(b_xy.rg)) * w.y;
		tangent_n = vec3f(t.xy * water.y, t.z);
		pbr = vec4f(0.0, 0.0, (a_zy.b + a_xy.b) * 0.5, 0.0);
		if (writes.y > 0.5) {
			d.roughness = water.z * pbr.b;
		}
	} else {
		let sampled = textureSampleGrad(fx_tex1, fx_samp1, uv * pbr_t.xy + pbr_t.zw, dx * pbr_t.xy, dy * pbr_t.xy);
		pbr = select(sampled, base, pbr_base);
		let t = ld_tangent_normal(pbr.rg);
		tangent_n = vec3f(t.xy * surface_row.z, t.z);
		if (writes.y > 0.5) {
			d.roughness = mix(surface_row.x, surface_row.y, pbr.b);
		}
		let emissive = fx_row(id, LD_EMISSIVE);
		if (emissive.w > 0.5) {
			// the channel blends R → G → B → A → the base map's alpha as it rises from 0 to 4, from `_SampleTex1`
			// itself even when the base map stands in for the PBR map
			let mask = fx_row(id, LD_EMISSIVE_MASK);
			let c = mask.x;
			let rgba = mix(mix(sampled.r, sampled.g, saturate(c)), mix(sampled.b, sampled.a, saturate(c - 2.0)), saturate(c - 1.0));
			let strength = mix(rgba, base.a, saturate(c - 3.0));
			d.emission = emissive.rgb * strength * mix(d.albedo, vec3f(1.0), mask.y) * mix(1.0, frame.ambient.y, mask.z);
		}
	}
	d.alpha = saturate(alpha);
	if (writes.x > 0.5) {
		// the box's frame (x tangent, y normal), or the surface's by `_BlendSceneNormal`; the bitangent's sign is
		// the game's −1. the result turns from the surface's normal by `_AffectNormal`
		let t = normalize(in.to_object0.xyz);
		let frame_n = normalize(mix(in.up, n, writes.z));
		let b = -mix(cross(in.up, t), cross(n, t), writes.z);
		let decal_n = normalize(t * tangent_n.x + b * tangent_n.y + frame_n * tangent_n.z);
		d.normal = normalize(mix(n, decal_n, channels.w));
	}
	if (pbr_row.x > 0.5) {
		d.writes_metallic = true;
		d.metallic = mix(pbr_row.z * saturate(channels.y), ld_channel(pbr, channels.y, 0.0), saturate(channels.y - 1.0));
	}
	if (pbr_row.y > 0.5) {
		d.writes_occlusion = true;
		let occlusion = mix(1.0, ld_channel(pbr, channels.z, 1.0), saturate(channels.z));
		d.occlusion = (1.0 - pbr_row.w) + occlusion * pbr_row.w;
	}
	return d;
}

// `HGRP/DecalLit` outputs directly into the G-buffer (emission, gbufferA, gbufferB, gbufferC)
struct DecalGBufferOut {
	@location(0) emission: vec4f,
	@location(1) gbuffer_a: vec4f,
	@location(2) gbuffer_b: vec4f,
	@location(3) gbuffer_c: vec4f,
}

// `HGRP/WetnessDecal`'s wetness (0 to 1) at the point `local` in its box (docs/game-data/materials.md#wetness-decals):
// the placement's alpha times the opacity, fading out with the camera's distance and, with a mask, times its red
// projected along the box axis the surface faces most, fading towards the box's faces on that axis. `local_dx` and
// `local_dy` are `local`'s screen gradients, `row` the look's `LD_WET_MASK`
fn wd_wetness(in: EffectOut, rel: vec3f, rel_dx: vec3f, rel_dy: vec3f, local: vec3f, local_dx: vec3f,
	local_dy: vec3f, row: vec4f) -> f32 {
	var wet = in.placement_color.a * fx_row(in.look, FX_TINT).a * (1.0 - saturate(length(rel) * row.w));
	if (row.y < 0.5) {
		return wet;
	}
	// the geometric normal in the box's frame, each axis weighed by the box's size along it as the game's
	// object-to-world rotation does: to_object rows are the box's axes over their lengths
	let geometric = cross(rel_dy, rel_dx);
	let axis_n = abs(vec3f(
		dot(in.to_object0.xyz, geometric) / dot(in.to_object0.xyz, in.to_object0.xyz),
		dot(in.to_object1.xyz, geometric) / dot(in.to_object1.xyz, in.to_object1.xyz),
		dot(in.to_object2.xyz, geometric) / dot(in.to_object2.xyz, in.to_object2.xyz),
	));
	let lead = axis_n.xy - max(axis_n.yz, axis_n.zx);
	// project along that axis: `p.xy` are the UVs, `p.z` the depth along it
	var p = local.xzy;
	var p_dx = local_dx.xzy;
	var p_dy = local_dy.xzy;
	if (lead.x > 0.0) {
		p = local.yzx;
		p_dx = local_dx.yzx;
		p_dy = local_dy.yzx;
	} else if (lead.y <= 0.0) {
		p = local;
		p_dx = local_dx;
		p_dy = local_dy;
	}
	let placed = in.placement_uv;
	let st = fx_row(in.look, FX_UV);
	let scale = placed.xy * st.xy;
	let uv = ((p.xy + 0.5) * placed.xy + placed.zw) * st.xy + st.zw;
	let mask = textureSampleGrad(fx_tex0, fx_samp0, uv, p_dx.xy * scale, p_dy.xy * scale).r;
	return wet * mask * saturate(1.0 - abs(p.z) * 2.0 + row.z);
}

// `HGRP/DecalLit` blended directly into the G-buffer before deferred lighting:
// - emission adds `d.emission * d.alpha`
// - gbuffer_a and gbuffer_b blend against copies in linear / 3D normal space, keeping unwritten channels intact
// - gbuffer_c uses hardware premultiplied-over blending (`PREMULTIPLIED_OVER`) so both regular albedo decals
//   and `_BLEND_WETNESS` darkening composite properly over overlapping decals without copying gbuffer_c
@fragment
fn fs_decal_gbuffer(in: EffectOut) -> DecalGBufferOut {
	let px = vec2i(in.position.xy);
	let scene_depth = fx_scene_depth(px);
	let rel = in.rel * (scene_depth / dot(in.rel, frame.view_forward.xyz));
	let p = vec4f(rel, 1.0);
	let object_p = vec3f(dot(in.to_object0, p), dot(in.to_object1, p), dot(in.to_object2, p));
	let uv = object_p.xz + 0.5;
	let object_dx = dpdx(object_p);
	let object_dy = dpdy(object_p);
	let dx = object_dx.xz;
	let dy = object_dy.xz;
	let rel_dx = dpdx(rel);
	let rel_dy = dpdy(rel);
	let prev_gb = textureLoad(fx_surface, px, 0);
	if (any(abs(object_p) >= vec3f(0.5)) || scene_depth >= 1e9 || !gbuffer_b_valid(prev_gb) || gbuffer_b_no_lit_decals(prev_gb)) {
		discard;
	}
	let prev_n = gbuffer_b_normal(prev_gb);
	let prev_r = prev_gb.b;
	let d = ld_decal(in, rel, rel_dx, rel_dy, object_p, uv, dx, dy, prev_n, prev_r);
	if (d.alpha <= 0.0) {
		discard;
	}
	let prev_ga = textureLoad(fx_gbuffer_a, px, 0);
	let writes_albedo = fx_row(in.look, LD_WRITES).w > 0.5;
	let wet = fx_row(in.look, LD_PBR_PLACED);
	var out: DecalGBufferOut;
	out.emission = vec4f(d.emission * d.alpha, 0.0);
	let blended_n = normalize(mix(prev_n, d.normal, d.alpha));
	let blended_r = mix(prev_r, d.roughness, d.alpha);
	out.gbuffer_b = pack_gbuffer_b(blended_n, blended_r, gbuffer_b_flags(prev_gb));
	var ga = prev_ga;
	if (wet.y > 0.5) {
		// `_BLEND_WETNESS`: normal/roughness use `d.alpha`, albedo darkens by `wet.z * d.alpha` and blends
		// decal albedo/occlusion by `covered = d.alpha * wet.w`
		let covered = d.alpha * wet.w;
		if (d.writes_occlusion && gbuffer_shading_model(prev_ga) == SHADING_LIT) {
			ga.g = mix(prev_ga.g, d.occlusion, covered);
		}
		out.gbuffer_a = ga;
		let keep = (1.0 - wet.z * d.alpha) * (1.0 - covered);
		out.gbuffer_c = vec4f(saturate(d.albedo) * covered, 1.0 - keep);
	} else {
		if (gbuffer_shading_model(prev_ga) == SHADING_LIT) {
			if (d.writes_metallic) {
				ga.r = mix(prev_ga.r, d.metallic, d.alpha);
			}
			if (d.writes_occlusion) {
				ga.g = mix(prev_ga.g, d.occlusion, d.alpha);
			}
		}
		out.gbuffer_a = ga;
		if (writes_albedo) {
			out.gbuffer_c = vec4f(saturate(d.albedo) * d.alpha, d.alpha);
		} else {
			out.gbuffer_c = vec4f(0.0, 0.0, 0.0, 0.0);
		}
	}
	return out;
}

// `HGRP/WetnessDecal`: writes wetness into the `rg8unorm` wetness mask with `max` blending, matching the game's
// `WetnessDecal` pass so overlapping boxes never double-wet and deferred lighting applies per-material porosity
@fragment
fn fs_wetness_decal(in: EffectOut) -> @location(0) vec4f {
	let px = vec2i(in.position.xy);
	let scene_depth = fx_scene_depth(px);
	let rel = in.rel * (scene_depth / dot(in.rel, frame.view_forward.xyz));
	let p = vec4f(rel, 1.0);
	let object_p = vec3f(dot(in.to_object0, p), dot(in.to_object1, p), dot(in.to_object2, p));
	let object_dx = dpdx(object_p);
	let object_dy = dpdy(object_p);
	let rel_dx = dpdx(rel);
	let rel_dy = dpdy(rel);
	let prev_gb = textureLoad(fx_surface, px, 0);
	if (any(abs(object_p) >= vec3f(0.5)) || scene_depth >= 1e9 || !gbuffer_b_valid(prev_gb) || gbuffer_b_no_lit_decals(prev_gb)) {
		discard;
	}
	let w = wd_wetness(in, rel, rel_dx, rel_dy, object_p, object_dx, object_dy, fx_row(in.look, LD_WET_MASK));
	if (w <= 0.0) {
		discard;
	}
	return vec4f(w, w, 0.0, 0.0);
}

// #endregion
