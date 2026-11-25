// the texture stack: the distortion and weight run through the slots in order, then the main texture, its mask,
// the blend layer and the dissolve, whose threshold the particle's custom data's z adds to as the schedule.
// `vertex_color` scales the blend tint where the look says so. a decal's parallax (`cracked`) shifts the main
// texture by `parallax` and adds its cracks before the dissolve. returns the colour (before exposure) and alpha
// `unmasked` receives the alpha before the mask scales it
fn fx_combine(
	id: u32,
	bases: FxBases,
	tint: vec4f,
	custom: vec4f,
	vertex_color: vec4f,
	cracked: bool,
	parallax: vec2f,
	unmasked: ptr<function, f32>,
) -> vec4f {
	let weight_row = fx_row(id, FX_WEIGHT);
	let disturb = fx_row(id, FX_DISTURB);
	let flags = fx_row(id, FX_STACK_FLAGS);
	let distorting = fx_row(id, FX_MISC).w != 0.0;
	let dissolve = fx_row(id, FX_DISSOLVE);
	let dissolve_color = fx_row(id, FX_DISSOLVE_COLOR);
	let bias = exp2(frame.params.y);
	// `_UseParticleDisturb`: the custom data's w scales the distortion (`EffectRow.particleDisturb`)
	let disturb_scale = select(1.0, custom.w, fx_row(id, FX_EDGE_ALPHA).y != 0.0);
	var offset = vec2f(0.0);
	var weight = vec4f(1.0 - weight_row.w);
	var mask = vec4f(1.0 - dissolve_color.w);
	var blend = vec4f(0.0);
	var dissolved = 0.0;
	for (var slot = 1u; slot < 7u; slot++) {
		let bits = fx_slot_bits(id, slot);
		let role = bits & 7u;
		if (role == ROLE_NONE) {
			continue;
		}
		let base = fx_slot_base(bases, bits);
		let uv = fx_slot_coords(id, slot, base[0] + fx_custom_shift(id, slot, custom)) + offset * slot_disturb(bits);
		var t = fx_sample(
			slot,
			uv,
			fx_slot_gradient(id, slot, base[1]) * bias,
			fx_slot_gradient(id, slot, base[2]) * bias,
		);
		if ((bits & SLOT_RED_ALPHA) != 0u) {
			t = vec4f(1.0, 1.0, 1.0, t.r);
		}
		let centred = t.r * (weight_row.x + 1.0) - weight_row.x;
		switch role {
			case ROLE_DISTURB1: {
				// VFXAdvance's `_DisturbTex1Normal` reads it as a normal, scaled by its u strength alone
				var shift = centred * disturb.xy;
				if (flags.z != 0.0) {
					shift = (vec2f(t.a * centred, t.g) * 2.0 - 1.0) * disturb.x;
				}
				offset += select(vec2f(0.0), shift * disturb_scale, distorting);
			}
			case ROLE_DISTURB2: {
				offset += select(vec2f(0.0), centred * disturb.zw * disturb_scale, distorting);
			}
			case ROLE_WEIGHT: {
				weight += t;
				offset *= (1.0 - weight_row.y) + weight.x * weight_row.y;
			}
			case ROLE_MASK: {
				mask += t;
			}
			case ROLE_BLEND: {
				blend += t;
			}
			case ROLE_DISSOLVE: {
				dissolved = t.r;
			}
			default: {}
		}
	}
	let bits = fx_slot_bits(id, 0u);
	let base = fx_slot_base(bases, bits);
	let main_uv = fx_slot_coords(id, 0u, base[0] + fx_custom_shift(id, 0u, custom));
	let main_dx = fx_slot_gradient(id, 0u, base[1]) * bias;
	let main_dy = fx_slot_gradient(id, 0u, base[2]) * bias;
	var main_sample = fx_sample(0u, main_uv + offset * slot_disturb(bits) + parallax, main_dx, main_dy);
	if ((bits & SLOT_RED_ALPHA) != 0u) {
		main_sample = vec4f(1.0, 1.0, 1.0, main_sample.r);
	}
	// VFXDitherAlpha's mask scales only the alpha (`EffectRow.maskAlphaOnly`)
	if (fx_row(id, FX_CAMERA_PULL).z != 0.0) {
		mask = vec4f(1.0, 1.0, 1.0, mask.a);
	}
	*unmasked = tint.a * main_sample.a;
	let c = tint * main_sample * mask;
	let blend_tint = fx_row(id, FX_BLEND_TINT) * select(vec4f(1.0), vertex_color, flags.w != 0.0);
	var color = blend.rgb * saturate((c.a + blend.a) * blend_tint.w) * blend_tint.rgb + c.rgb;
	var alpha = c.a;
	// VFXDitherAlpha's `_USE_MAIN2`: a second colour texture multiplied into or added to the main colour
	// before the dissolve, without changing the alpha
	let main2_slot = u32(fx_row(id, FX_NORMAL_MAP).w);
	if (main2_slot != 0u) {
		let m2_bits = fx_slot_bits(id, main2_slot);
		let m2_base = fx_slot_base(bases, m2_bits);
		let m2_uv = fx_slot_coords(id, main2_slot, m2_base[0] + fx_custom_shift(id, main2_slot, custom)) +
			offset * slot_disturb(m2_bits);
		var m2 = fx_sample(
			main2_slot,
			m2_uv,
			fx_slot_gradient(id, main2_slot, m2_base[1]) * bias,
			fx_slot_gradient(id, main2_slot, m2_base[2]) * bias,
		);
		if ((m2_bits & SLOT_RED_ALPHA) != 0u) {
			m2 = vec4f(1.0, 1.0, 1.0, m2.r);
		}
		let main2 = fx_row(id, FX_MAIN2);
		let m2_rgb = m2.rgb * main2.rgb;
		color = mix(color * m2_rgb, color + m2_rgb, main2.w);
	}
	if (cracked) {
		color += fx_decal_cracks(id, bases, main_uv + parallax, main_dx, main_dy, offset, parallax);
	}
	if (dissolve.w != 0.0) {
		let threshold = mix(-1.0, dissolve.x + custom.z * 2.02, (1.0 - weight_row.z) + weight.x * weight_row.z);
		let v = dissolved - threshold;
		let edge = saturate((dissolve.z - v) * dissolve.y);
		alpha *= saturate(v * dissolve.y);
		color = mix(color, dissolve_color.rgb * edge, edge);
	}
	return vec4f(color, alpha);
}


// the UV sources of a pixel of a texture-stack layer. the look's screen-UV flags shape the screen UVs: 4 takes
// them about the object's origin (`_LocalPivortSpace`), 2 takes v from the world height, 1 scales them by the
// object's view depth past the near plane. call in uniform control flow
fn fx_layer_bases(in: EffectOut) -> FxBases {
	let kind = fx_row(in.look, FX_UNFOGGED);
	let size = frame.render_size.xy;
	let q = floor(in.position.xy);
	let screen_flags = u32(kind.w);
	var screen = vec2f(2.0 * q.x / size.x - 1.0, (2.0 * q.y / size.y - 1.0) * size.y / size.x);
	if ((screen_flags & 4u) != 0u) {
		let from_origin = in.rel - in.origin.xyz;
		screen = vec2f(dot(from_origin, frame.view_right.xyz), dot(from_origin, frame.view_up.xyz));
	}
	screen.y = select(screen.y, frame.eye.y + in.rel.y, (screen_flags & 2u) != 0u);
	screen *= select(1.0, max(1.0, in.origin.w - frame.local_lights.w), (screen_flags & 1u) != 0u);
	return fx_bases(in.uv.xy, in.uv.zw, fx_polar(in.uv.xy - 0.5), screen);
}

// VFXBaseV2 surfaces: the texture stack tinted by the vertex colour, brightened above a threshold, faded by the
// Fresnel term, where the surface nears what lies behind it (soft blend), and by the near camera fade. VFXWater
// sheets branch off to `water_sheet`
@fragment
fn fs_effect(in: EffectOut, @builtin(front_facing) front: bool) -> EffectAccumulated {
	let id = in.look;
	let dx = dpdx(in.uv);
	let dy = dpdy(in.uv);
	let rel_dx = dpdx(in.rel);
	let rel_dy = dpdy(in.rel);
	let kind = fx_row(id, FX_UNFOGGED);
	let bases = fx_layer_bases(in);
	if (kind.y == FX_KIND_WATER_SHEET) {
		return water_sheet(in, front, dx.xy, dy.xy, rel_dx, rel_dy);
	}
	if (kind.y == FX_KIND_BEAM) {
		return light_beam(in);
	}
	if (kind.y == FX_KIND_SIX_WAY) {
		return six_way_smoke(in, bases);
	}
	let layer = fx_stack_layer(in, bases, front);
	let color = layer.rgb;
	let alpha = layer.a;
	if (fx_below_water_blend(in)) {
		return fx_accumulate(fx_unsupported_checker(in), 1.0, in.rel, in.position.xy, kind.x);
	}
	// `_BlendMode` 1 adds the layer rather than blending it over
	if (kind.z >= 0.5) {
		return fx_additive(color * alpha);
	}
	return fx_accumulate(color * alpha, alpha, in.rel, in.position.xy, kind.x);
}

// below its `_USE_WATER_BLEND` height the game absorbs and scatters a layer's colour, which isn't drawn
fn fx_below_water_blend(in: EffectOut) -> bool {
	return in.rel.y + frame.eye.y < fx_row(in.look, FX_DECAL).z;
}

// what fragments the viewer can't draw show: a world-space magenta and black checker (as `unsupportedLook` in
// material-looks.ts)
fn fx_unsupported_checker(in: EffectOut) -> vec3f {
	let cell = vec3i(floor((in.rel + frame.eye.xyz) / 0.5));
	return select(vec3f(1.0, 0.0, 1.0), vec3f(0.0), ((cell.x + cell.y + cell.z) & 1) != 0);
}

// opaque VFXBaseV2 layers (`Blend One Zero`), shaded in the main pass: the colour times the alpha covers what's
// behind, as the game writes it. written as unlit into the G-buffer
@fragment
fn fs_effect_opaque(in: EffectOut, @builtin(front_facing) front: bool) -> GBufferOut {
	let layer = fx_stack_layer(in, fx_layer_bases(in), front);
	if (fx_below_water_blend(in)) {
		return pack_gbuffer_unlit(fx_unsupported_checker(in), 0u);
	}
	return pack_gbuffer_unlit(layer.rgb * layer.a, 0u);
}

// `_BlendMode` 2 VFXBaseV2 layers, drawn over the composited scene with a blend that multiplies it by the output:
// `lerp(1, colour, alpha)`
@fragment
fn fs_effect_multiply(in: EffectOut, @builtin(front_facing) front: bool) -> @location(0) vec4f {
	let layer = fx_stack_layer(in, fx_layer_bases(in), front);
	return vec4f(mix(vec3f(1.0), layer.rgb, layer.a), 1.0);
}


// the reveal edge's hash of a lattice point, its coordinates wrapped to 1024 first
fn fx_appear_hash(p: vec2f) -> f32 {
	let q = p - 1024.0 * trunc(p / 1024.0);
	return fract(sin(dot(q, vec2f(12.9898, 78.233))) * 43758.5453);
}

// the reveal edge's value noise in 0…1, smoothly interpolated between lattice hashes
fn fx_appear_noise(p: vec2f) -> f32 {
	let i = floor(p);
	let f = fract(p);
	let a = fx_appear_hash(i);
	let b = fx_appear_hash(i + vec2f(1.0, 0.0));
	let c = fx_appear_hash(i + vec2f(0.0, 1.0));
	let d = fx_appear_hash(i + vec2f(1.0));
	let u = f * f * (3.0 - 2.0 * f);
	return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
}

// VFXAdvance's and VFXDitherAlpha's reveal around the player (`EffectAppear`,
// docs/game-data/effects.md#invisible-bridges), the camera standing in for the player; the global radii are
// `frame.render_size.zw`. returns the tint
fn fx_appear(in: EffectOut, bases: FxBases, tint: vec4f) -> vec4f {
	let id = in.look;
	let appear = fx_row(id, FX_APPEAR);
	let noise = fx_row(id, FX_APPEAR_NOISE);
	let flags = fx_row(id, FX_STACK_FLAGS);
	let global = select(vec2f(0.0), frame.render_size.zw, flags.y != 0.0);
	let inner = appear.x + global.x;
	let outer = appear.y + global.y;
	let d = length(in.rel - vec3f(0.0, noise.z, 0.0));
	var bright = fx_row(id, FX_APPEAR_BRIGHT) * hermite(outer, inner, d);
	bright.a *= select(1.0, in.color.a, flags.x != 0.0);
	var revealed = tint + bright;
	// the noise runs over the main texture's UVs, before the distortion
	let base = fx_slot_base(bases, fx_slot_bits(id, 0u));
	let uv = fx_slot_coords(id, 0u, base[0] + fx_custom_shift(id, 0u, in.custom));
	let n = fx_appear_noise(uv * noise.x + frame.eye.w * noise.y) * 2.0 - 1.0;
	let fade = hermite(outer, inner, d + appear.w * n);
	revealed.a = saturate(mix(revealed.a, revealed.a * appear.z, fade));
	return revealed;
}

// a slot without a role sampled through its own UVs, undistorted
fn fx_slot_sample(id: u32, slot: u32, bases: FxBases) -> vec4f {
	let base = fx_slot_base(bases, fx_slot_bits(id, slot));
	let bias = exp2(frame.params.y);
	return fx_sample(
		slot,
		fx_slot_coords(id, slot, base[0]),
		fx_slot_gradient(id, slot, base[1]) * bias,
		fx_slot_gradient(id, slot, base[2]) * bias,
	);
}

// the normal the stack's Fresnel term reads: VFXAdvance's normal map bends it (x from alpha times red, as Unity
// unpacks it), and VFXAdvance reverses it on back faces (`EffectRow.normalMap`)
fn fx_fresnel_normal(in: EffectOut, bases: FxBases, front: bool) -> vec3f {
	let id = in.look;
	let row = fx_row(id, FX_NORMAL_MAP);
	var n = normalize(in.normal);
	if (row.x > 0.0 && in.tangent.w != 0.0) {
		let texel = fx_slot_sample(id, u32(row.x), bases);
		let xy = vec2f(texel.a * texel.r, texel.g) * 2.0 - 1.0;
		let z = max(1e-16, sqrt(1.0 - saturate(dot(xy, xy))));
		let tangent_n = normalize(vec3f(xy * row.y, z));
		let t = normalize(in.tangent.xyz - n * dot(in.tangent.xyz, n));
		let b = cross(n, t) * in.tangent.w;
		n = normalize(t * tangent_n.x + b * tangent_n.y + n * tangent_n.z);
	}
	return select(n, select(-n, n, front), row.z != 0.0);
}

// a texture-stack layer's colour (exposed, unpremultiplied) and alpha
fn fx_stack_layer(in: EffectOut, bases: FxBases, front: bool) -> vec4f {
	let id = in.look;
	let soft = fx_row(id, FX_SOFT);
	let misc = fx_row(id, FX_MISC);
	var tint = fx_row(id, FX_TINT) * select(vec4f(1.0), in.color, soft.w != 0.0);
	// `_USE_ANIM_BREATHING` pulses the tint's alpha (FX_DECAL_FADE holds it for stack layers, which decals don't
	// draw through)
	let breathing = fx_row(id, FX_DECAL_FADE);
	if (breathing.w > 0.0) {
		let wave = saturate(pow(cos(frame.eye.w * breathing.y) * 0.5 + 0.5, breathing.z));
		tint.a *= mix(breathing.x, 1.0, wave);
	}
	if (fx_row(id, FX_APPEAR_NOISE).w > 0.0) {
		tint = fx_appear(in, bases, tint);
	}
	var unmasked = 0.0;
	var combined = fx_combine(id, bases, tint, in.custom, in.color, false, vec2f(0.0), &unmasked);
	let depth = dot(in.rel, frame.view_forward.xyz);
	// the Fresnel term mixes the colour towards the Fresnel colour and fades the clamped alpha, before
	// `_USE_EDGECOLOR` and brightening (as VFXBaseV2 orders them)
	let fresnel_row = fx_row(id, FX_FRESNEL);
	if (fresnel_row.x > 0.0) {
		let n = fx_fresnel_normal(in, bases, front);
		let f = pow(saturate(dot(normalize(-in.rel), n) + fresnel_row.y), fresnel_row.x);
		let fresnel = mix(1.0 - f, f, fresnel_row.z);
		let fresnel_color = fx_row(id, FX_FRESNEL_COLOR);
		combined = vec4f(
			mix(combined.rgb, fresnel_color.rgb, fresnel_color.w * fresnel),
			saturate(combined.a) * mix(1.0, fresnel, fresnel_row.w),
		);
	}
	// `_USE_EDGECOLOR` marks where the surface nears what lies behind it: mode 1 adds the edge colour and the tint
	// alpha by its strength, 0 multiplies the colour by the edge colour and the alpha by the strength
	let edge_row = fx_row(id, FX_EDGE);
	if (edge_row.w > 0.0) {
		let edge_color = fx_row(id, FX_EDGE_COLOR);
		let gap = max(fx_scene_depth(vec2i(in.position.xy)) - depth, 0.001);
		let e = edge_color.w * saturate(edge_row.x / gap - edge_row.y);
		let added = combined + vec4f(edge_color.rgb, fx_row(id, FX_EDGE_ALPHA).x) * e;
		let multiplied = combined * vec4f(edge_color.rgb, e);
		combined = mix(multiplied, added, edge_row.z);
	}
	var color = combined.rgb;
	color += max(color - vec3f(misc.y), vec3f(0.0)) * misc.z;
	// VFXAdvance's `_EMISSION` adds its texture times its colour
	let emission = fx_row(id, FX_EMISSION);
	if (emission.w > 0.0) {
		color += fx_slot_sample(id, u32(emission.w), bases).rgb * emission.rgb;
	}
	// `_IgnorePostExposure` divides out the post exposure, before the lighting when the colour is an albedo
	color = clamp(color * mix(1.0, frame.ambient.y, soft.z), vec3f(0.0), vec3f(1000.0));
	let lighting = fx_row(id, FX_OFFSET_MODE);
	if (lighting.z > 0.0) {
		// `_USE_LIGHTING`: the colour is an albedo, lit by the irradiance volume and the sun at the surface's normal
		// turned towards the camera, or at the world's up, shadowed from the cached far map alone
		var n = normalize(in.normal);
		n = select(-n, n, dot(n, in.rel) <= 0.0);
		n = select(n, vec3f(0.0, 1.0, 0.0), lighting.w > 0.0);
		let sun = frame.sun_color.rgb * (frame.sun.w / PI) * saturate(dot(n, frame.sun.xyz)) *
			sun_visibility_far_cloudless(in.rel, n);
		color *= ambient_irradiance(in.rel + frame.eye.xyz, n) + sun;
	}
	// VFXDitherAlphaNoLighting's colour pass writes its colour times the alpha before the mask and the power
	// (`EffectRow.colorTimesAlpha`)
	if (fx_row(id, FX_CAMERA_PULL).w != 0.0) {
		color *= saturate(unmasked * fx_near_fade(id, depth));
	}
	var soft_fade = 1.0;
	if (soft.x > 0.0) {
		soft_fade = saturate((fx_scene_depth(vec2i(in.position.xy)) - depth + soft.y) / soft.x);
	}
	let alpha = saturate(saturate(combined.a) * soft_fade * fx_near_fade(id, depth));
	// VFXDitherAlpha's `_DitherAlphaExp`; 1 for the other stack looks
	return vec4f(color, pow(alpha, fx_row(id, FX_DECAL).w));
}


// VFXDecal's `_USE_PARALLAX` (docs/game-data/effects.md#vfxdecal): the main texture's UV shift where the view
// ray (`view`, towards the camera) meets the depth texture's red (1 at the top), stepped down in 30 layers and
// interpolated between the last layer above the surface and the first below
fn fx_decal_parallax(id: u32, in: EffectOut, bases: FxBases, view: vec3f) -> vec2f {
	let row = fx_row(id, FX_PARALLAX);
	let depth_slot = u32(row.y);
	let v = vec3f(
		dot(view, normalize(in.to_object0.xyz)),
		dot(view, normalize(in.to_object2.xyz)),
		dot(view, in.up),
	);
	let step = v.xy / v.z * row.x;
	let bits = fx_slot_bits(id, 0u);
	let base = fx_slot_base(bases, bits);
	let bias = exp2(frame.params.y);
	let uv = fx_slot_coords(id, 0u, base[0]);
	let dx = fx_slot_gradient(id, 0u, base[1]) * bias;
	let dy = fx_slot_gradient(id, 0u, base[2]) * bias;
	var shift = step;
	var previous = vec2f(0.0);
	var layer = 29.0 / 30.0;
	var height = 0.0;
	var previous_layer = 1.0;
	var previous_height = 0.0;
	for (var i = 0; i < 31; i++) {
		height = fx_sample(depth_slot, uv + shift, dx, dy).r;
		if (height > layer) {
			break;
		}
		previous = shift;
		previous_layer = layer;
		previous_height = height;
		shift += step;
		layer -= 1.0 / 30.0;
	}
	let t = (previous_height - previous_layer) / ((previous_height - height) + layer - previous_layer);
	return previous + step * t;
}

// a decal's cracks at the parallax-shifted main UVs: the crack colour weighed against the crack noise by the
// crack mask's red. the noise takes its own UVs, the distortion's share and the parallax shift
fn fx_decal_cracks(id: u32, bases: FxBases, uv: vec2f, dx: vec2f, dy: vec2f, offset: vec2f, parallax: vec2f)
	-> vec3f {
	let row = fx_row(id, FX_PARALLAX);
	let crack_row = fx_row(id, FX_CRACK);
	let crack = fx_sample(u32(row.z), uv, dx, dy).r;
	let noise_slot = u32(row.w);
	let bits = fx_slot_bits(id, noise_slot);
	let base = fx_slot_base(bases, bits);
	let bias = exp2(frame.params.y);
	let noise_uv = fx_slot_coords(id, noise_slot, base[0]) + offset * crack_row.w + parallax;
	let noise = fx_sample(
		noise_slot,
		noise_uv,
		fx_slot_gradient(id, noise_slot, base[1]) * bias,
		fx_slot_gradient(id, noise_slot, base[2]) * bias,
	);
	return mix(crack_row.rgb * crack, noise.rgb * fx_row(id, FX_CRACK_NOISE).rgb, crack);
}

// VFXDecal boxes, drawn by their back faces without a depth test: each covered pixel finds the main pass's
// surface along its view ray, and the texture stack projects onto it down the box's y, faded towards the
// box's sides and top and bottom, on surfaces facing away from the projection, and near the camera
@fragment
fn fs_effect_decal(in: EffectOut) -> EffectAccumulated {
	let id = in.look;
	let px = vec2i(in.position.xy);
	let scene_depth = fx_scene_depth(px);
	let rel = in.rel * (scene_depth / dot(in.rel, frame.view_forward.xyz));
	let p = vec4f(rel, 1.0);
	let object_p = vec3f(dot(in.to_object0, p), dot(in.to_object1, p), dot(in.to_object2, p));
	let uv = object_p.xz + 0.5;
	// the decal's screen UVs are the pixel's position over the width, unlike VFXBaseV2's
	let screen = floor(in.position.xy) / frame.render_size.x;
	let bases = fx_bases(uv, uv, fx_polar(object_p.xz), screen);
	let rel_dx = dpdx(rel);
	let rel_dy = dpdy(rel);
	if (any(abs(object_p) >= vec3f(0.5)) || scene_depth >= 1e9) {
		return fx_nothing();
	}
	// VFXDecal's stencil test against the bit surfaces keeping decals off write (`DECAL_COVERS`): 1 skips
	// them, 2 covers only them
	let covers = fx_row(id, FX_DECAL).z;
	if (covers > 0.5 && fx_keeps_lit_decals_off(px) != (covers > 1.5)) {
		return fx_nothing();
	}
	let cracked = fx_row(id, FX_PARALLAX).y != 0.0;
	var parallax = vec2f(0.0);
	if (cracked) {
		parallax = fx_decal_parallax(id, in, bases, normalize(-rel));
	}
	var unmasked = 0.0;
	let combined = fx_combine(id, bases, fx_row(id, FX_TINT), in.custom, in.color, cracked, parallax, &unmasked);
	let soft = fx_row(id, FX_SOFT);
	let color = clamp(combined.rgb, vec3f(0.0), vec3f(1000.0)) * mix(1.0, frame.ambient.y, soft.z);

	let fade = fx_row(id, FX_DECAL_FADE);
	let decal = fx_row(id, FX_DECAL);
	let height = saturate(((0.5 + abs(decal.x)) - abs(object_p.y + decal.x)) / fade.w * 2.0);
	let edge_x = smoothstep(0.5 - fade.x + fade.z, 0.5 - fade.x, abs(object_p.x));
	let edge_z = smoothstep(0.5 - fade.y + fade.z, 0.5 - fade.y, abs(object_p.z));
	var angle = 1.0;
	if (decal.y > 0.0) {
		let n = fx_surface_normal(px);
		if (any(n != vec3f(0.0))) {
			angle = pow(saturate(dot(in.up, n)), decal.y);
		}
	}
	let alpha = saturate(combined.a * fx_near_fade(id, scene_depth) * height * edge_x * edge_z) * angle;
	// the game's decal premultiplies its colour by the alpha twice
	if (fx_row(id, FX_UNFOGGED).z >= 0.5) {
		return fx_additive(color * alpha * alpha);
	}
	return fx_accumulate(color * alpha * alpha, alpha, rel, in.position.xy, fx_row(id, FX_UNFOGGED).x);
}

