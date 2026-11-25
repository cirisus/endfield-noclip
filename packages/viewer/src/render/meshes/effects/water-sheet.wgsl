// #region water sheets

// `EffectKind.WaterSheet` (effect-look.ts), in FX_UNFOGGED's y

// rows of a VFXWater look (`WaterSheetRow` in water-sheet.ts, in vec4s)
const WS_FLAGS = 17u;
const WS_DISTURB = 18u;
const WS_DISTURB_USE = 19u;
const WS_DISSOLVE = 20u;
const WS_DISSOLVE_COLOR = 21u;
const WS_SEQUENCE = 22u;
const WS_SEQUENCE_SHAPE = 26u;
const WS_SEQUENCE_TINT = 27u;
const WS_SURFACE = 28u;
const WS_SUBSURFACE = 29u;
const WS_MISC = 30u;
const WS_REFRACT = 32u;
// a soft body's offset minimum and frame count, and its range and rotation packing (`WaterSheetRow.softMin`)

// `WaterSheetFlags`
const WS_DISTURB_ON = 1u;
const WS_DISTURB_NORMAL = 2u;
const WS_MASK = 4u;
const WS_DISSOLVE_ON = 8u;
const WS_SEQUENCE_ON = 16u;
const WS_SEQUENCE_MOTION = 32u;
const WS_SEQUENCE_NORMAL = 64u;
const WS_NORMAL_MAP = 128u;
const WS_MAIN_AS_ALPHA = 256u;
const WS_MASK_AS_ALPHA = 512u;
const WS_VERTEX_OPACITY = 1024u;
const WS_FRESNEL_OPACITY = 2048u;
const WS_VERTEX_COLOR = 4096u;
const WS_REFRACT_ON = 8192u;

// the particle's custom data, for `ws_sample`; the water sheet and six-way smoke set it from their input
var<private> ws_custom: vec4f;

// a slot sampled at its scrolled, rotated, scaled UVs, shifted by the particle's custom data, plus `offset`
fn ws_sample(id: u32, slot: u32, uv: vec2f, offset: vec2f, dx: vec2f, dy: vec2f) -> vec4f {
	let bias = exp2(frame.params.y);
	let at = fx_slot_coords(id, slot, uv + fx_custom_shift(id, slot, ws_custom)) + offset;
	return fx_sample(slot, at, fx_slot_gradient(id, slot, dx) * bias, fx_slot_gradient(id, slot, dy) * bias);
}

// where a flipbook frame's tile starts: frames run along rows from the top, which the UVs reach by wrapping
fn ws_frame_offset(frame: f32, size: vec2f) -> vec2f {
	let count = size.x * size.y;
	let n = frame - count * trunc(frame / count);
	let row = size.y - floor(n / size.x);
	return fract(vec2f((n - row * size.x) / size.x, row / size.y));
}

// VFXWater, the sheets of falling water (`waterSheetLook` in water-sheet.ts,
// docs/game-data/effects.md#waterfalls). sun units follow the viewer's illuminance convention
// (docs/viewer/lighting.md#sun)
fn water_sheet(in: EffectOut, front: bool, dx: vec2f, dy: vec2f, rel_dx: vec3f, rel_dy: vec3f) -> EffectAccumulated {
	let id = in.look;
	ws_custom = in.custom;
	let ws = fx_row(id, WS_FLAGS);
	let flags = u32(ws.x);
	let uv = in.uv.xy;
	let random = fract(dot(mist_origin(in) + frame.eye.xyz, vec3f(1.0)));
	let stretch = random * ws.w;

	// the distortion, and the textures it moves
	var offset = vec2f(0.0);
	if ((flags & WS_DISTURB_ON) != 0u) {
		let d = ws_sample(id, 1u, uv, vec2f(0.0), dx, dy);
		let row = fx_row(id, WS_DISTURB);
		let centred = d.r * (row.x + 1.0) - row.x;
		if ((flags & WS_DISTURB_NORMAL) != 0u) {
			offset = (vec2f(d.a * centred, d.g) * 2.0 - 1.0) * row.y;
		} else {
			offset = centred * row.yz;
		}
	}
	let use_disturb = fx_row(id, WS_DISTURB_USE);
	var main_uv = fx_slot_coords(id, 0u, uv + fx_custom_shift(id, 0u, in.custom));
	main_uv.y *= 1.0 + min(stretch, 0.5);
	main_uv += vec2f(stretch) + offset * use_disturb.x;
	let bias = exp2(frame.params.y);
	var main_tex = fx_sample(0u, main_uv, fx_slot_gradient(id, 0u, dx) * bias, fx_slot_gradient(id, 0u, dy) * bias);
	if ((flags & WS_MAIN_AS_ALPHA) != 0u) {
		main_tex = vec4f(1.0, 1.0, 1.0, main_tex.r);
	}
	var mask = vec4f(1.0);
	if ((flags & WS_MASK) != 0u) {
		mask = ws_sample(id, 2u, uv, offset * use_disturb.y, dx, dy);
		if ((flags & WS_MASK_AS_ALPHA) != 0u) {
			mask = vec4f(1.0, 1.0, 1.0, mask.r);
		}
	}
	let vertex = select(vec4f(1.0), in.color, (flags & WS_VERTEX_COLOR) != 0u);
	let base = fx_row(id, FX_TINT) * vertex * main_tex * mask;
	var color = base.rgb;
	var dissolved = 1.0;
	if ((flags & WS_DISSOLVE_ON) != 0u) {
		let row = fx_row(id, WS_DISSOLVE);
		// a particle's custom data's z adds to the schedule
		let v = ws_sample(id, 3u, uv, offset * use_disturb.w, dx, dy).r - row.x - in.custom.z * 2.02;
		dissolved = saturate(v * row.y);
		let edge = saturate((row.z - v) * row.y);
		color = mix(color, fx_row(id, WS_DISSOLVE_COLOR).rgb * edge, edge);
	}

	// the flipbook: two frames, each pushed along its motion vectors towards the other
	let shape = fx_row(id, WS_SEQUENCE_SHAPE);
	let sequencing = (flags & WS_SEQUENCE_ON) != 0u;
	var frame_a = uv;
	var frame_b = uv;
	var blend = 0.0;
	var sequence = vec4f(0.0);
	if (sequencing) {
		let row = fx_row(id, WS_SEQUENCE);
		let f = (frame.eye.w + random * row.w) * row.z;
		let tile = 1.0 / row.xy;
		frame_a = uv * tile + ws_frame_offset(floor(f), row.xy);
		frame_b = uv * tile + ws_frame_offset(floor(f + 1.0), row.xy);
		blend = fract(f);
		let gx = dx * tile * bias;
		let gy = dy * tile * bias;
		if ((flags & WS_SEQUENCE_MOTION) != 0u) {
			let mv_a = fx_sample(5u, frame_a, gx, gy).xy * 2.0 - 1.0;
			let mv_b = fx_sample(5u, frame_b, gx, gy).xy * 2.0 - 1.0;
			frame_a -= mv_a * blend * shape.x;
			frame_b += mv_b * (1.0 - blend) * shape.x;
		}
		sequence = saturate(mix(fx_sample(4u, frame_a, gx, gy), fx_sample(4u, frame_b, gx, gy), blend) - shape.w);
		color += sequence.rgb * fx_row(id, WS_SEQUENCE_TINT).rgb * sequence.a;
	}

	// opacity
	let depth = dot(in.rel, frame.view_forward.xyz);
	let soft = fx_row(id, FX_SOFT);
	var alpha = base.a * dissolved * fx_near_fade(id, depth);
	if (sequencing) {
		alpha = saturate(alpha * sequence.a * shape.y - shape.z) * shape.y;
	}
	if (soft.x > 0.0) {
		alpha *= saturate((fx_scene_depth(vec2i(in.position.xy)) - depth + soft.y) / soft.x);
	}
	if ((flags & WS_VERTEX_OPACITY) != 0u) {
		alpha *= in.color.a;
	}
	let v = -normalize(in.rel);
	let n_geo = normalize(in.normal);
	let surface = fx_row(id, WS_SURFACE);
	if ((flags & WS_FRESNEL_OPACITY) != 0u) {
		alpha *= pow(abs(dot(n_geo, v)), surface.w);
	}
	alpha = saturate(alpha);
	color = clamp(color, vec3f(0.0), vec3f(1000.0));

	// the normal: the flipbook's or the normal map's, in the frame the UVs make
	var n = n_geo;
	if ((flags & (WS_SEQUENCE_NORMAL | WS_NORMAL_MAP)) != 0u) {
		var s: vec4f;
		if ((flags & WS_SEQUENCE_NORMAL) != 0u) {
			let tile = 1.0 / fx_row(id, WS_SEQUENCE).xy;
			s = mix(fx_sample(6u, frame_a, dx * tile * bias, dy * tile * bias),
				fx_sample(6u, frame_b, dx * tile * bias, dy * tile * bias), blend);
		} else {
			s = ws_sample(id, 6u, uv, offset * use_disturb.z, dx, dy);
		}
		let xy = vec2f(s.a * s.r, s.g) * 2.0 - 1.0;
		let z = max(1e-16, sqrt(1.0 - saturate(dot(xy, xy))));
		let scaled = xy * fx_row(id, WS_SEQUENCE_TINT).w;
		let dp1 = cross(rel_dy, n_geo);
		let dp2 = cross(n_geo, rel_dx);
		var t = dp1 * dx.x + dp2 * dy.x;
		var b = dp1 * dx.y + dp2 * dy.y;
		let scale = inverseSqrt(max(max(dot(t, t), dot(b, b)), 1e-20));
		n = normalize(t * scale * scaled.x + b * scale * scaled.y + n_geo * z);
	}
	n = select(-n, n, front);

	// lighting: the lit share takes the irradiance volume and the sun, the rest stays as it is. only the unlit
	// share takes the game's division by the post exposure (docs/viewer/effects.md#waterfalls)
	let lit = color * ws.z;
	let unlit = color * (1.0 - ws.z) * mix(1.0, frame.ambient.y, soft.z);
	let sss_row = fx_row(id, WS_SUBSURFACE);
	var thickness = 1.0;
	if (sequencing) {
		thickness = sequence.a * shape.y;
	}
	if ((flags & WS_VERTEX_OPACITY) != 0u) {
		thickness *= in.color.r;
	}
	let value = sss_row.z * thickness * lit.x;
	let subsurface = mix(vec3f(1.0), hue(sss_row.x), sss_row.y) * value;
	var indirect = ambient_irradiance(in.rel + frame.eye.xyz, n) * (lit + subsurface * sss_row.w);
	{
		let mean = (indirect.x + indirect.y + indirect.z) / 3.0;
		indirect = mean + (indirect - mean) * fx_row(id, WS_MISC).y;
	}
	let l = frame.sun.xyz;
	let h = normalize(l + v);
	let n_dot_l = saturate(dot(n, l));
	let n_dot_h = saturate(dot(n, h));
	let n_dot_v = saturate(dot(n, v));
	let a = surface.x * surface.x;
	let a2 = a * a;
	let d = (n_dot_h * a2 - n_dot_h) * n_dot_h + 1.0;
	let fresnel = fresnel_schlick(vec3f(0.08 * surface.y), saturate(dot(v, h)));
	let visible = 0.5 / (n_dot_l * sqrt((-n_dot_v * a2 + n_dot_v) * n_dot_v + a2) +
		n_dot_v * sqrt((-n_dot_l * a2 + n_dot_l) * n_dot_l + a2) + 1e-4);
	// divided by the opacity, so the highlight survives the premultiplication
	let specular = clamp(clamp(min(fresnel * (a2 / (d * d)) * visible, vec3f(2048.0)) * frame.sun_color.w, vec3f(0.0),
		vec3f(1000.0)) / max(alpha, 0.01), vec3f(0.0), vec3f(1000.0)) * surface.z;
	let k = saturate(1.0 - value);
	let wrap = saturate(dot(n, l) * (2.0 / 3.0) + 1.0 / 3.0);
	let through = mix(mix(1.0, wrap * sqrt(wrap) * (5.0 / 3.0), k) / (2.0 * PI), 1.0,
		pow(saturate(-dot(v, l)), 12.0) * mix(3.0, 0.1, k));
	// `_directional_shadow_asm_only`: the game shadows the sheet from its cached far map alone
	var visibility: vec3f;
	if (fx_row(id, WS_MISC).z > 0.5) {
		visibility = sun_visibility_far(in.rel, n);
	} else {
		visibility = sun_visibility(in.rel, n, in.position.xy);
	}
	let sun = (specular * n_dot_l + subsurface * through + lit * n_dot_l) * frame.sun_color.rgb * (frame.sun.w / PI) *
		visibility;
	let shaded = indirect + unlit + sun;

	// `VFX_WATER_REFRACT`: refracts the composited scene behind along the refracted view ray, tints it by the
	// opacity, mixes in the fogged premultiplied sheet, and replaces the pixel (`alpha = 1`)
	if ((flags & WS_REFRACT_ON) != 0u) {
		let screen_uv = in.position.xy / frame.render_size.xy;
		let refract_row = fx_row(id, WS_REFRACT);
		let shift = refract(-v, n, fx_row(id, WS_MISC).w) * (refract_row.w * alpha);
		let refract_uv = screen_uv + vec2f(dot(shift, frame.view_right.xyz), dot(shift, frame.view_up.xyz));
		let behind = textureSampleLevel(fx_background, fx_background_samp, refract_uv, 0.0).rgb;
		let tinted = behind * mix(vec3f(1.0), refract_row.rgb, alpha);
		// `_BlendMode` 1 drops fog in-scatter, keeping transmittance on the surface share
		let surface = fog_premultiplied(shaded * alpha, select(alpha, 0.0, ws.y >= 0.5), in.rel, screen_uv);
		return EffectAccumulated(vec4f(mix(tinted, surface, alpha), 1.0));
	}

	// `_BlendMode` 1 adds the layer rather than blending it over
	if (ws.y >= 0.5) {
		return fx_additive(shaded * alpha);
	}
	return fx_accumulate(shaded * alpha, alpha, in.rel, in.position.xy, 0.0);
}

// #endregion
