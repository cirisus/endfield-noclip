// #region water foam

// rows of a WaterDecal look (`WaterFoamRow` in water-foam.ts, in vec4s)
const WF_TINT = 17u;
const WF_DISTURB = 18u;
const WF_USE = 19u;
const WF_SOURCES = 20u;
const WF_MASK_MATRIX = 21u;
const WF_DISSOLVE = 22u;
const WF_DISSOLVE_COLOR = 23u;
const WF_BOX_UV = 24u;
const WF_FADE = 25u;
const WF_MIP = 26u;
const WF_EROSION = 27u;
const WF_EROSION_EDGE = 28u;
const WF_EROSION_LAYERS = 32u;
const WF_BUBBLE = 35u;
const WF_BUBBLE_COLOR = 36u;
const WF_FLOATING = 37u;
const WF_FLOATING_COLOR = 38u;
const WF_FLOATING_COLOR_DARK = 39u;
const WF_BASE2_TINT = 40u;
const WF_BASE2 = 41u;

// `WaterFoamFlags`
const WF_DISTURB_ON = 1u;
const WF_MASK_ON = 2u;
const WF_DISSOLVE_ON = 4u;
const WF_EDGE_FADE = 8u;
const WF_CLIP_TO_BOX = 16u;
const WF_SOFT = 32u;
const WF_EROSION_ON = 64u;
const WF_BUBBLE_ON = 128u;
const WF_FLOATING0_ON = 256u;
const WF_FLOATING1_ON = 512u;
const WF_BASE2_ON = 1024u;

// `EROSION_SLOTS`, `BUBBLE_SLOT`, `BASE2_SLOT` and `FLOATING_SLOTS` in water-foam.ts
const WF_SLOT_FLOW = 1u;
const WF_SLOT_FLOW_NOISE = 2u;
const WF_SLOT_GRADIENT = 3u;
const WF_SLOT_LAYERS = 4u;
const WF_SLOT_BUBBLE = 4u;
const WF_SLOT_BASE2 = 4u;
const WF_SLOT_FLOATING0 = 5u;
const WF_SLOT_FLOATING1 = 6u;

// the layers' noises are read three mip levels finer, as the game's bias of −3
const WF_LAYER_GRADIENT_SCALE = 0.125;

// the flowmap and the gradient through the game's clamping sampler: the slots' samplers repeat, so the UVs stop
// half a texel inside the edges
fn wf_sample_clamped(slot: u32, uv: vec2f, dx: vec2f, dy: vec2f) -> vec4f {
	var size: vec2u;
	if (slot == WF_SLOT_FLOW) {
		size = textureDimensions(fx_tex1);
	} else {
		size = textureDimensions(fx_tex3);
	}
	let half_texel = 0.5 / vec2f(size);
	return fx_sample(slot, clamp(uv, half_texel, 1.0 - half_texel), dx, dy);
}

// `_USE_WATER_EROSION`, the red tide's flowing front (docs/game-data/water.md#water-erosion), over the foam's
// colour, from the mesh's UV0 and its gradients
fn wf_erosion(id: u32, color: vec3f, uv: vec2f, dx: vec2f, dy: vec2f, t: f32) -> vec3f {
	let row = fx_row(id, WF_EROSION);
	// the noise: its `_ST`, then its scroll
	let noise_st = fx_row(id, FX_UV + WF_SLOT_FLOW_NOISE);
	let noise_uv = uv * noise_st.xy + noise_st.zw + fx_row(id, FX_ANIM + WF_SLOT_FLOW_NOISE).xy * t;
	let noise = fx_sample(WF_SLOT_FLOW_NOISE, noise_uv, dx * noise_st.xy, dy * noise_st.xy).r * row.x;
	// the flowmap: its `_ST`, its u shifted by the noise
	let flow_st = fx_row(id, FX_UV + WF_SLOT_FLOW);
	var flow_uv = uv * flow_st.xy + flow_st.zw;
	flow_uv.x += noise * row.y;
	let flow = wf_sample_clamped(WF_SLOT_FLOW, flow_uv, dx * flow_st.xy, dy * flow_st.xy);
	let front = saturate(flow * row.z + noise + row.w);
	// the gradient: u from the front's position along UV0's u, v from UV0's v. its gradients leave out the noise's
	// and the clamps' share
	let gradient_st = fx_row(id, FX_UV + WF_SLOT_GRADIENT);
	let along = saturate(uv.x * row.z + noise + row.w);
	let gradient_uv = vec2f(saturate(along * gradient_st.x + gradient_st.z), uv.y * gradient_st.y);
	let gradient_scale = vec2f(gradient_st.x * row.z, gradient_st.y);
	let gradient = wf_sample_clamped(WF_SLOT_GRADIENT, gradient_uv, dx * gradient_scale, dy * gradient_scale);
	// each layer's colour where its flow channel passes its threshold, broken up by its noise and kept to the
	// gradient's alpha
	var layers: array<vec3f, 3>;
	for (var i = 0u; i < 3u; i++) {
		let slot = WF_SLOT_LAYERS + i;
		let st = fx_row(id, FX_UV + slot);
		let layer_uv = uv * st.xy + st.zw + fx_row(id, FX_ANIM + slot).xy * t;
		let scale = st.xy * WF_LAYER_GRADIENT_SCALE;
		let layer_noise = saturate(fx_sample(slot, layer_uv, dx * scale, dy * scale).rgb);
		let layer = fx_row(id, WF_EROSION_LAYERS + i);
		layers[i] = layer.rgb * saturate(front[i + 1u] - layer.w) * layer_noise * gradient.a;
	}
	// the flowmap's colour darkens the foam, the second and third layers cover it, then the first
	var c = color * (1.0 - length(flow.rgb));
	c = mix(c, layers[1], saturate(length(layers[1])));
	c = mix(c, layers[2], saturate(length(layers[2])));
	c = mix(c, layers[0], saturate(length(layers[0])));
	return c + gradient.rgb * fx_row(id, WF_EROSION_EDGE).rgb * flow.r;
}

// a UV source picked by the game's switch value (`WaterFoamSource` in package-format): the box, polar, the world
// over 10 m, UV set 0, with fractional values blending between neighbours
fn wf_pick(s: f32, a: vec2f, b: vec2f, c: vec2f, d: vec2f) -> vec2f {
	return mix(mix(mix(a, b, s), c, saturate(s - 1.0)), d, saturate(s - 2.0));
}

// WaterDecal boxes (`waterFoamLook`): each covered pixel finds the water surface along its view ray (the water
// pass's depth in `fx_depth`) and writes the foam the box projects there, down its y. the water pass then lights
// it as its foam (docs/viewer/water.md#foam-boxes). rgb is the premultiplied foam, alpha how much of what's
// there it covers (0 with `_BlendMode` 1), clamped as the game's 8-bit target clamps it
@fragment
fn fs_water_foam(in: EffectOut) -> @location(0) vec4f {
	let id = in.look;
	let px = vec2i(in.position.xy);
	let water_device = textureLoad(fx_depth, px, 0);
	let water_depth = select(1e9, frame.local_lights.w / water_device, water_device > 0.0);
	let rel = in.rel * (water_depth / dot(in.rel, frame.view_forward.xyz));
	let p = vec4f(rel, 1.0);
	let object_p = vec3f(dot(in.to_object0, p), dot(in.to_object1, p), dot(in.to_object2, p));
	let box_uv_row = fx_row(id, WF_BOX_UV);
	let box = (object_p.xz + 0.5) * box_uv_row.xy + box_uv_row.zw;
	let centred = box - 0.5;
	let polar = fx_polar(centred);
	let world = (rel.xz + frame.eye.xz) * 0.1;
	let mesh = in.uv.xy;
	// gradients before anything branches; the polar angle's wraps at its seam
	let bias = exp2(frame.params.y);
	// the material's own mip bias, as scaled gradients
	let mip = fx_row(id, WF_MIP);
	let base_bias = bias * exp2(mip.x);
	let mask_bias = bias * exp2(mip.y);
	var polar_dx = dpdx(polar);
	var polar_dy = dpdy(polar);
	polar_dx.x -= round(polar_dx.x);
	polar_dy.x -= round(polar_dy.x);
	let box_dx = dpdx(box);
	let box_dy = dpdy(box);
	let world_dx = dpdx(world);
	let world_dy = dpdy(world);
	let mesh_dx = dpdx(mesh);
	let mesh_dy = dpdy(mesh);
	let sources = fx_row(id, WF_SOURCES);
	let base_src = wf_pick(sources.x, box, polar, world, mesh);
	let base_dx = wf_pick(sources.x, box_dx, polar_dx, world_dx, mesh_dx) * base_bias;
	let base_dy = wf_pick(sources.x, box_dy, polar_dy, world_dy, mesh_dy) * base_bias;
	let disturb_src = wf_pick(sources.y, box, polar, world, mesh);
	let disturb_dx = wf_pick(sources.y, box_dx, polar_dx, world_dx, mesh_dx) * bias;
	let disturb_dy = wf_pick(sources.y, box_dy, polar_dy, world_dy, mesh_dy) * bias;
	let mask_src = wf_pick(sources.z, box, polar, world, mesh);
	let mask_dx = wf_pick(sources.z, box_dx, polar_dx, world_dx, mesh_dx) * mask_bias;
	let mask_dy = wf_pick(sources.z, box_dy, polar_dy, world_dy, mesh_dy) * mask_bias;
	let dissolve_src = wf_pick(sources.w, box, polar, world, mesh);

	let tint = fx_row(id, WF_TINT);
	let flags = u32(tint.w);
	if (water_device <= 0.0 || ((flags & WF_CLIP_TO_BOX) != 0u && any(abs(object_p) >= vec3f(0.5)))) {
		return vec4f(0.0);
	}
	let t = frame.eye.w;
	let use_disturb = fx_row(id, WF_USE);
	let disturb_row = fx_row(id, WF_DISTURB);

	// the distortion: scrolled, then the disturb texture's `_ST`
	var offset = vec2f(0.0);
	if ((flags & WF_DISTURB_ON) != 0u) {
		let st = fx_row(id, FX_UV + 1u);
		let uv = (disturb_src + fx_row(id, FX_ANIM + 1u).xy * t) * st.xy + st.zw;
		let d = fx_sample(1u, uv, disturb_dx * st.xy, disturb_dy * st.xy).r * (disturb_row.x + 1.0) - disturb_row.x;
		offset = d * disturb_row.yz;
	}
	// the base colour: its `_ST`, then its scroll
	var base = vec4f(1.0);
	{
		let st = fx_row(id, FX_UV);
		let uv = (base_src + offset * use_disturb.x) * st.xy + st.zw + fx_row(id, FX_ANIM).xy * t;
		base = fx_sample(0u, uv, base_dx * st.xy, base_dy * st.xy);
	}
	let base_alpha = mix(1.0, base.a, use_disturb.w);
	var color = fx_row(id, FX_TINT).rgb + base.rgb * base_alpha * tint.rgb;
	var cover = 1.0 + base_alpha;
	if ((flags & WF_BASE2_ON) != 0u) {
		let b2 = fx_row(id, WF_BASE2);
		let b2_tint = fx_row(id, WF_BASE2_TINT);
		let st = fx_row(id, FX_UV + WF_SLOT_BASE2);
		let b2_bias = bias * exp2(b2.z);
		let b2_src = wf_pick(b2.x, box, polar, world, mesh);
		let b2_dx = wf_pick(b2.x, box_dx, polar_dx, world_dx, mesh_dx) * b2_bias;
		let b2_dy = wf_pick(b2.x, box_dy, polar_dy, world_dy, mesh_dy) * b2_bias;
		let uv = (b2_src + offset * b2.y) * st.xy + st.zw + fx_row(id, FX_ANIM + WF_SLOT_BASE2).xy * t;
		let sample2 = fx_sample(WF_SLOT_BASE2, uv, b2_dx * st.xy, b2_dy * st.xy);
		let alpha2 = mix(1.0, sample2.a, b2_tint.w);
		color += sample2.rgb * alpha2 * b2_tint.rgb;
		cover += alpha2;
	}
	// the dissolve, read at a fixed mip level as the game does: scrolled, then its `_ST`
	if ((flags & WF_DISSOLVE_ON) != 0u) {
		let st = fx_row(id, FX_UV + 3u);
		let row = fx_row(id, WF_DISSOLVE);
		let uv = (dissolve_src + offset * use_disturb.z + fx_row(id, FX_ANIM + 3u).xy * t) * st.xy + st.zw;
		let v = fx_sample_level(3u, uv, mip.z).r - row.x;
		let kept = saturate(v * row.y);
		let edge = saturate((row.z - v) * row.y);
		color = mix(color, fx_row(id, WF_DISSOLVE_COLOR).rgb * edge, edge) * kept;
		cover *= kept;
	}
	// the mask: turned about its centre, then its `_ST`, then its scroll
	if ((flags & WF_MASK_ON) != 0u) {
		let st = fx_row(id, FX_UV + 2u);
		let m = fx_row(id, WF_MASK_MATRIX);
		let turn = mat2x2f(m.xy, m.zw);
		let uv = (turn * (mask_src - 0.5) + 0.5 + offset * use_disturb.y) * st.xy + st.zw + fx_row(id, FX_ANIM + 2u).xy * t;
		let mask = fx_sample(2u, uv, (turn * mask_dx) * st.xy, (turn * mask_dy) * st.xy);
		color *= mask.rgb;
		color = mix(color, color * mask.a, fx_row(id, WF_DISSOLVE).w);
	}
	if ((flags & WF_EROSION_ON) != 0u) {
		color = wf_erosion(id, color, mesh, mesh_dx * bias, mesh_dy * bias, t);
	}
	if ((flags & WF_BUBBLE_ON) != 0u) {
		let st = fx_row(id, FX_UV + WF_SLOT_BUBBLE);
		let b = fx_row(id, WF_BUBBLE);
		let bc = fx_row(id, WF_BUBBLE_COLOR);
		let acid = fx_sample(WF_SLOT_BUBBLE, world * st.xy, world_dx * st.xy, world_dy * st.xy);
		let phase = fract(t * b.y + b.z * acid.y + b.w * acid.x);
		let peak = clamp(bc.w, 1e-4, 1.0 - 1e-4);
		let dist = abs(phase - peak);
		let pulse = step(peak, phase) * dist / (1.0 - peak) + step(phase, peak) * dist / peak;
		color += bc.rgb * (pulse * b.x * acid.x * 10.0);
	}
	if ((flags & (WF_FLOATING0_ON | WF_FLOATING1_ON)) != 0u) {
		let fl = fx_row(id, WF_FLOATING);
		let fc0 = fx_row(id, WF_FLOATING_COLOR);
		let fc1 = fx_row(id, WF_FLOATING_COLOR_DARK);
		let view = normalize(-rel);
		let n = vec3f(0.0, 1.0, 0.0);
		let vt_raw = vec3f(view.x, 0.0, dot(view, n));
		let vt = vt_raw * inverseSqrt(max(1.175494e-38, dot(vt_raw, vt_raw)));
		let view_off = (vt.xy / max(0.001, vt.z + 0.42)) / max(vt.z, 0.001);
		let t0 = t * 0.05;
		let f0 = fract(t0 * fl.w);
		let f1 = fract((t0 + fl.y) * fl.w);
		let fl_src = wf_pick(fl.x, box, polar, world, mesh);
		let fl_dx = wf_pick(fl.x, box_dx, polar_dx, world_dx, mesh_dx) * bias;
		let fl_dy = wf_pick(fl.x, box_dy, polar_dy, world_dy, mesh_dy) * bias;
		let du = vec2f(offset.x);
		let p_uv = mix(fl_src, fl_src + du, fc0.w);
		var layers = vec3f(0.0);
		if ((flags & WF_FLOATING0_ON) != 0u) {
			let uv0 = p_uv + view_off * (-(1.0 - f0) * fl.z) * 0.5;
			let st0 = fx_row(id, FX_UV + WF_SLOT_FLOATING0);
			let s0 = fx_sample(WF_SLOT_FLOATING0, mix(uv0, uv0 + du, fc0.w) * st0.xy + st0.zw, fl_dx * st0.xy, fl_dy * st0.xy).rgb;
			layers += s0 * (0.5 - abs(0.5 - f0)) * fc0.rgb;
		}
		if ((flags & WF_FLOATING1_ON) != 0u) {
			let uv1 = p_uv + view_off * (-(1.0 - f1) * fl.z) * 0.5;
			let st1 = fx_row(id, FX_UV + WF_SLOT_FLOATING1);
			let s1 = fx_sample(WF_SLOT_FLOATING1, mix(uv1, uv1 + du, fc0.w) * st1.xy + st1.zw, fl_dx * st1.xy, fl_dy * st1.xy).rgb;
			layers += s1 * (0.5 - abs(0.5 - f1)) * fc1.rgb;
		}
		color += layers * saturate(dot(view, n));
	}
	let fade = fx_row(id, WF_FADE);
	var edge_fade = 1.0;
	if ((flags & WF_EDGE_FADE) != 0u) {
		edge_fade = saturate(1.0 - length(abs(centred) + fade.xy) * 1.4142);
	}
	// the soft blend, in reversed-Z device depth like the game's: the box's face against the water's surface
	var soft = 1.0;
	if ((flags & WF_SOFT) != 0u) {
		soft = saturate((saturate(water_device - in.position.z) + fade.z) / fade.w);
	}
	let out_color = max(color, vec3f(0.0)) * soft * cover * edge_fade * fx_row(id, FX_TINT).w;
	return vec4f(out_color, saturate(cover * (1.0 - disturb_row.w)));
}

// #endregion
