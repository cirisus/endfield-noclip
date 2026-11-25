// #region refraction

// `EffectKind.Refract` (effect-look.ts), in FX_UNFOGGED's y
const FX_KIND_REFRACT = 4.0;

// rows of a VFXRefract look (`RefractRow` in refract.ts, in vec4s)
const RF_REFRACT = 17u;
const RF_REFRACT2 = 18u;
const RF_RB = 19u;
const RF_RB_MAIN = 20u;
const RF_RB_FIRST = 21u;
const RF_RB_SECOND = 22u;
const RF_DISSOLVE = 26u;
const RF_SPREAD = 28u;
const RF_BLEND_COLOR = 32u;
const RF_BLEND = 33u;

// a refraction slot sampled at its UVs, shifted by `shift`
fn rf_sample(id: u32, slot: u32, bases: FxBases, custom: vec4f, shift: vec2f) -> vec4f {
	let bias = exp2(frame.params.y);
	let bits = fx_slot_bits(id, slot);
	let base = fx_slot_base(bases, bits);
	var t = fx_sample(
		slot,
		fx_slot_coords(id, slot, base[0] + fx_custom_shift(id, slot, custom)) + shift,
		fx_slot_gradient(id, slot, base[1]) * bias,
		fx_slot_gradient(id, slot, base[2]) * bias,
	);
	if ((bits & SLOT_RED_ALPHA) != 0u) {
		t = vec4f(1.0, 1.0, 1.0, t.r);
	}
	return t;
}

// VFXRefract (docs/game-data/effects.md#refraction): the composited scene seen at an offset in screen UVs,
// tinted by the mask's and blend layer's colours, and blended over by their alpha times the spread's band
@fragment
fn fs_refract(in: EffectOut) -> @location(0) vec4f {
	let id = in.look;
	let bases = fx_bases(in.uv.xy, in.uv.zw, fx_polar(in.uv.xy - 0.5), vec2f(0.0));
	let bias = exp2(frame.params.y);
	let row = fx_row(id, RF_REFRACT);
	let row2 = fx_row(id, RF_REFRACT2);
	var offset = vec2f(0.0);
	// what scales the colour offsets when `_UseMainTexAsMask` is set: the remapped red, or the normal's offset
	var amount = 0.0;
	{
		let bits = fx_slot_bits(id, 0u);
		let base = fx_slot_base(bases, bits);
		let t = fx_sample(
			0u,
			fx_slot_coords(id, 0u, base[0] + fx_custom_shift(id, 0u, in.custom)),
			fx_slot_gradient(id, 0u, base[1]) * bias,
			fx_slot_gradient(id, 0u, base[2]) * bias,
		);
		let centred = t.r * (1.0 + row.w) - row.w;
		let strength = row.z * in.color.a;
		let normal = (vec2f(t.a * centred, t.g) * 2.0 - 1.0) * row.xy * strength;
		offset = select(row.xy * centred * strength, normal, row2.x != 0.0);
		amount = select(centred, length(normal), row2.x != 0.0);
	}
	// the dissolve scales the offset (not the colour offsets' further shift), and the alpha by its share
	let dissolve_row = fx_row(id, RF_DISSOLVE);
	var dissolved = 1.0;
	if (dissolve_row.w != 0.0) {
		let bits = fx_slot_bits(id, 2u);
		let base = fx_slot_base(bases, bits);
		let t = fx_sample(
			2u,
			fx_slot_coords(id, 2u, base[0]),
			fx_slot_gradient(id, 2u, base[1]) * bias,
			fx_slot_gradient(id, 2u, base[2]) * bias,
		);
		// a particle's custom data's z adds to the schedule
		dissolved = saturate((t.r - dissolve_row.x - in.custom.z * 2.02) * dissolve_row.y);
		offset *= dissolved;
	}
	// the spread: a band `range` wide around the schedule (plus the custom data's w), stretched so it starts and
	// ends off the texture, covers where the spread texture's red (flipped) falls inside it
	var cover = 1.0;
	let spread = fx_row(id, RF_SPREAD);
	if (spread.y > 0.0) {
		let s = rf_sample(id, 4u, bases, in.custom, vec2f(0.0)).r;
		let at = (spread.x + in.custom.w) * (1.0 + 2.0 * spread.y) - spread.y;
		let level = spread.z + s - 2.0 * s * spread.z;
		cover = saturate(1.0 - abs(at - level) / spread.y) * spread.w;
	}
	var mask = vec4f(1.0);
	if (row2.z != 0.0) {
		mask = rf_sample(id, 1u, bases, in.custom, offset * row2.y);
	}
	// the blend layer tints by `_BlendColor.a` and covers by its alpha
	let blend_row = fx_row(id, RF_BLEND);
	var tint = mask;
	if (blend_row.x != 0.0) {
		let blend = rf_sample(id, 3u, bases, in.custom, offset * blend_row.y);
		let blend_color = fx_row(id, RF_BLEND_COLOR);
		tint *= vec4f((1.0 - blend_color.a) + blend.rgb * blend_color.rgb * blend_color.a, blend.a);
	}
	let uv = in.position.xy / frame.render_size.xy + offset;
	var behind = textureSampleLevel(fx_background, fx_background_samp, uv, 0.0).rgb;
	let main = fx_row(id, RF_RB_MAIN);
	if (main.w != 0.0) {
		let rb = fx_row(id, RF_RB);
		let first = fx_row(id, RF_RB_FIRST);
		let second = fx_row(id, RF_RB_SECOND);
		let shift = rb.xy * in.color.a * mix(1.0, amount, first.w);
		var split = max(
			behind * main.rgb,
			textureSampleLevel(fx_background, fx_background_samp, uv + shift, 0.0).rgb * first.rgb,
		);
		if (second.w != 0.0) {
			split = max(
				split,
				textureSampleLevel(fx_background, fx_background_samp, uv + shift * rb.z, 0.0).rgb * second.rgb,
			);
		}
		behind = max(mix(behind, split, rb.w), vec3f(0.0));
	}
	let depth = dot(in.rel, frame.view_forward.xyz);
	let soft = fx_row(id, FX_SOFT);
	var soft_fade = 1.0;
	if (soft.x > 0.0) {
		soft_fade = saturate((fx_scene_depth(vec2i(in.position.xy)) - depth) / soft.x);
	}
	let alpha = saturate(
		cover * tint.a * soft_fade * fx_near_fade(id, depth) * mix(1.0, dissolved, dissolve_row.z),
	);
	return vec4f(clamp(behind * tint.rgb, vec3f(0.0), vec3f(1000.0)), alpha);
}

// #endregion

// #region radial blur

// `EffectKind.RadialBlur` (effect-look.ts), in FX_UNFOGGED's y
const FX_KIND_RADIAL_BLUR = 7.0;

// rows of a VFXRadialBlur look (`RadialBlurRow` in radial-blur.ts, in vec4s)
const RB_BLUR = 17u;
const RB_OPTIONS = 18u;
const RB_CENTER = 19u;

// VFXRadialBlur (docs/game-data/effects.md#radial-blur): a 5-tap blur of the composited scene radially from
// the projected object/particle centre or along a screen direction, optionally masked and faded
@fragment
fn fs_radial_blur(in: EffectOut) -> @location(0) vec4f {
	let id = in.look;
	let bases = fx_bases(in.uv.xy, in.uv.zw, fx_polar(in.uv.xy - 0.5), vec2f(0.0));
	let blur = fx_row(id, RB_BLUR);
	let opts = fx_row(id, RB_OPTIONS);
	let center_dir = fx_row(id, RB_CENTER);
	let screen_uv = in.position.xy / frame.render_size.xy;
	var dir = center_dir.zw;
	if (opts.z == 0.0) {
		let clip = frame.view_proj * vec4f(in.origin.xyz, 1.0);
		let w = select(clip.w, 1e-6, abs(clip.w) < 1e-6);
		let ndc = clip.xy / w;
		let center_uv = vec2f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
		let v = center_uv * 2.0 - 1.0;
		let unit_v = normalize(select(v, vec2f(1.0, 0.0), dot(v, v) < 1e-12));
		// matches the game's compiled check `sqrt(v.x^2 + 2*v.y) > 1.414` without taking a negative root
		let clamped = select(
			clamp(center_uv, vec2f(0.0), vec2f(1.0)),
			(vec2f(1.0) + unit_v) * 0.5,
			v.x * v.x + v.y + v.y > 1.999396,
		);
		dir = screen_uv - (clamped + center_dir.xy);
	}
	let denom = select(1.0, max(0.01, in.origin.w - frame.local_lights.w), opts.x != 0.0);
	let step = dir * pow(max(abs(dir), vec2f(1e-6)), vec2f(blur.y / denom));
	let intensity = blur.x * select(1.0, in.color.a, blur.w != 0.0);
	var accum = textureSampleLevel(fx_background, fx_background_samp, screen_uv, 0.0).rgb;
	for (var i = 1; i < 3; i++) {
		let fi = f32(i);
		let a = textureSampleLevel(fx_background, fx_background_samp, screen_uv - step * fi * intensity, 0.0).rgb;
		let b = textureSampleLevel(
			fx_background,
			fx_background_samp,
			screen_uv - step * (fi - 0.5) * intensity,
			0.0,
		).rgb;
		accum += (a + b) * 0.5;
	}
	var color = accum * (1.0 / 3.0);
	var alpha = blur.z;
	if (opts.y != 0.0) {
		let bias = exp2(frame.params.y);
		let bits = fx_slot_bits(id, 0u);
		let base = fx_slot_base(bases, bits);
		let custom_shift = fx_row(id, FX_CUSTOM_SCROLL).xy * in.custom.w;
		var mask = fx_sample(
			0u,
			fx_slot_coords(id, 0u, base[0] + custom_shift),
			fx_slot_gradient(id, 0u, base[1]) * bias,
			fx_slot_gradient(id, 0u, base[2]) * bias,
		);
		if ((bits & SLOT_RED_ALPHA) != 0u) {
			mask = vec4f(1.0, 1.0, 1.0, mask.r);
		}
		color *= mask.rgb;
		alpha *= mask.a;
	}
	let depth = dot(in.rel, frame.view_forward.xyz);
	let soft = fx_row(id, FX_SOFT);
	var soft_fade = 1.0;
	if (soft.x > 0.0) {
		soft_fade = saturate((fx_scene_depth(vec2i(in.position.xy)) - depth) / soft.x);
	}
	alpha = saturate(alpha * soft_fade * fx_near_fade(id, depth));
	return vec4f(clamp(color, vec3f(0.0), vec3f(1000.0)), alpha);
}

// #endregion
