// #region six-way smoke

// `EffectKind.SixWaySmoke` (effect-look.ts), in FX_UNFOGGED's y
const FX_KIND_SIX_WAY = 6.0;

// rows of a six-way smoke look (`SixWayRow` in six-way-smoke.ts, in vec4s)
const SW_FLAGS = 17u;
const SW_DISTURB = 18u;
const SW_DISTURB_USE = 19u;
const SW_DISSOLVE = 20u;
const SW_DISSOLVE_COLOR = 21u;
const SW_BLEND_TINT = 22u;

// `SixWayFlags`
const SW_DISTURB1 = 1u;
const SW_DISTURB2 = 2u;
const SW_DISTURB1_NORMAL = 4u;
const SW_DISTURB2_NORMAL = 8u;
const SW_MASK = 16u;
const SW_MASK_RED_ALPHA = 32u;
const SW_BLEND = 64u;
const SW_DISSOLVE_ON = 128u;
const SW_VERTEX_COLOR = 256u;

// `SIX_WAY_SCREEN_DEPTH` in six-way-smoke.ts: the slot's screen UVs scale by the object's view depth
const SW_SLOT_SCREEN_DEPTH = 8u;

// a six-way slot's base UV and its gradients: UV0, polar or screen UVs by its bits (`*SwitchUV`), the screen
// ones times `depth` where its bit asks (`*ScreenDepthUV`)
fn sw_base(id: u32, slot: u32, bases: FxBases, depth: f32) -> array<vec2f, 3> {
	let bits = fx_slot_bits(id, slot);
	let b = fx_slot_base(bases, bits);
	let s = select(1.0, depth, (bits & SW_SLOT_SCREEN_DEPTH) != 0u);
	return array(b[0] * s, b[1] * s, b[2] * s);
}

// one distortion texture's offset: its red remapped by `_Bi_Disturb` times the u and v strengths, or with a
// normal its (a·r, g) remapped to [-1, 1] times the u strength
fn sw_disturb(id: u32, slot: u32, base: array<vec2f, 3>, strength: vec2f, normal: bool) -> vec2f {
	let t = ws_sample(id, slot, base[0], vec2f(0.0), base[1], base[2]);
	let bias = fx_row(id, SW_FLAGS).y;
	let centred = t.r * (bias + 1.0) - bias;
	if (normal) {
		return (vec2f(t.a * centred, t.g) * 2.0 - 1.0) * strength.x;
	}
	return centred * strength;
}

// the light a lightmap value lets through once the smoke absorbs `exponent`'s colour: Unity's six-way
// absorption, the value raised per channel within `range`
fn sw_absorb(t: f32, exponent: vec3f, range: f32) -> vec3f {
	return min(vec3f(range), pow(vec3f(saturate(t / range)), exponent) * range);
}

// six-way lit smoke (`sixWaySmokeLook` in six-way-smoke.ts, docs/game-data/effects.md#six-way-smoke): the
// texture stack makes the colour the smoke absorbs and its opacity; the two lightmaps hold how much light
// passes from each axis of the particle's frame. sun units follow the viewer's convention for the game's
// light colour (docs/viewer/lighting.md#sun)
fn six_way_smoke(in: EffectOut, bases: FxBases) -> EffectAccumulated {
	let id = in.look;
	ws_custom = in.custom;
	let row = fx_row(id, SW_FLAGS);
	let flags = u32(row.x);
	let bias = exp2(frame.params.y);
	// what scales screen UVs by depth: the object origin's view depth past the near plane
	let depth_scale = max(0.0, in.origin.w - frame.local_lights.w);

	var offset = vec2f(0.0);
	let strength = fx_row(id, SW_DISTURB);
	if ((flags & SW_DISTURB1) != 0u) {
		let base = sw_base(id, 1u, bases, depth_scale);
		offset += sw_disturb(id, 1u, base, strength.xy, (flags & SW_DISTURB1_NORMAL) != 0u);
	}
	if ((flags & SW_DISTURB2) != 0u) {
		let base = sw_base(id, 2u, bases, depth_scale);
		offset += sw_disturb(id, 2u, base, strength.zw, (flags & SW_DISTURB2_NORMAL) != 0u);
	}
	let use_disturb = fx_row(id, SW_DISTURB_USE);

	// the lightmaps share slot 0's UVs
	let lightmap = sw_base(id, 0u, bases, depth_scale);
	let lightmap_uv =
		fx_slot_coords(id, 0u, lightmap[0] + fx_custom_shift(id, 0u, in.custom)) + offset * use_disturb.x;
	let gx = fx_slot_gradient(id, 0u, lightmap[1]) * bias;
	let gy = fx_slot_gradient(id, 0u, lightmap[2]) * bias;
	let positive = fx_sample(0u, lightmap_uv, gx, gy);
	let negative = fx_sample(6u, lightmap_uv, gx, gy).rgb;

	var mask = vec4f(1.0);
	if ((flags & SW_MASK) != 0u) {
		let base = sw_base(id, 3u, bases, depth_scale);
		mask = ws_sample(id, 3u, base[0], offset * use_disturb.y, base[1], base[2]);
		if ((flags & SW_MASK_RED_ALPHA) != 0u) {
			mask = vec4f(1.0, 1.0, 1.0, mask.r);
		}
	}
	let tint = fx_row(id, FX_TINT) * select(vec4f(1.0), in.color, (flags & SW_VERTEX_COLOR) != 0u);
	let c = tint * mask;
	var color = c.rgb;
	if ((flags & SW_BLEND) != 0u) {
		// the game applies the blend texture's `_ST` again after the distortion; its tint takes the vertex colour
		// whatever `_DisableVertColor` says
		let st = fx_row(id, FX_UV + 4u);
		let base = sw_base(id, 4u, bases, depth_scale);
		let blend_uv =
			(fx_slot_coords(id, 4u, base[0] + fx_custom_shift(id, 4u, in.custom)) + offset * use_disturb.z) * st.xy +
			st.zw;
		let blend = fx_sample(4u, blend_uv, fx_slot_gradient(id, 4u, base[1]) * st.xy * bias,
			fx_slot_gradient(id, 4u, base[2]) * st.xy * bias);
		let blend_tint = fx_row(id, SW_BLEND_TINT) * in.color;
		color += blend.rgb * saturate((c.a + blend.a) * blend_tint.a) * blend_tint.rgb;
	}
	var alpha = c.a;
	if ((flags & SW_DISSOLVE_ON) != 0u) {
		let dissolve = fx_row(id, SW_DISSOLVE);
		// a particle's custom data's z adds to the schedule
		let base = sw_base(id, 5u, bases, depth_scale);
		let v = ws_sample(id, 5u, base[0], offset * use_disturb.w, base[1], base[2]).r - dissolve.x -
			in.custom.z * 2.02;
		let edge = saturate((dissolve.z - v) * dissolve.y);
		alpha *= saturate(v * dissolve.y);
		color = mix(color, fx_row(id, SW_DISSOLVE_COLOR).rgb * edge, edge);
	}
	let depth = dot(in.rel, frame.view_forward.xyz);
	let soft = fx_row(id, FX_SOFT);
	if (soft.x > 0.0) {
		alpha *= saturate((fx_scene_depth(vec2i(in.position.xy)) - depth + soft.y) / soft.x);
	}
	alpha = positive.a * saturate(alpha * fx_near_fade(id, depth));
	let misc = fx_row(id, FX_MISC);
	color = clamp(color + max(color - vec3f(misc.y), vec3f(0.0)) * misc.z, vec3f(0.0), vec3f(1000.0));

	// the colour sets how strongly each channel is absorbed: 1 − log2(colour) / log2(0.2)
	let exponent = 1.0 + log2(max(color, vec3f(1e-5))) * -0.43067657;
	let range = row.z;

	// the particle's frame: right (its x axis, made square to the normal), up, and away from the camera
	var n = normalize(in.normal);
	n = select(-n, n, dot(n, in.rel) <= 0.0);
	let away = -n;
	let x_axis = normalize(in.to_object0.xyz);
	let right = normalize(x_axis - away * dot(x_axis, away));
	let up = cross(away, right);

	let world = in.rel + frame.eye.xyz;
	let all_axes = sw_absorb(positive.r, exponent, range) + sw_absorb(positive.g, exponent, range) +
		sw_absorb(positive.b, exponent, range) + sw_absorb(negative.r, exponent, range) +
		sw_absorb(negative.g, exponent, range) + sw_absorb(negative.b, exponent, range);
	var ambient = ambient_irradiance(world, n) * all_axes;
	{
		let grey = dot(ambient, LUMINANCE);
		ambient = mix(vec3f(grey), ambient, row.w);
	}
	let l = frame.sun.xyz;
	let lt = vec3f(dot(l, right), dot(l, up), dot(l, away));
	let through = dot(lt * lt, select(negative, positive.rgb, lt >= vec3f(0.0)));
	let sun = frame.sun_color.rgb * (frame.sun.w / PI) * sw_absorb(through, exponent, range) *
		sun_visibility(in.rel, n, in.position.xy);
	let shaded = ambient + sun;
	return fx_accumulate(shaded * alpha, alpha, in.rel, in.position.xy, fx_row(id, FX_UNFOGGED).x);
}

// #endregion
