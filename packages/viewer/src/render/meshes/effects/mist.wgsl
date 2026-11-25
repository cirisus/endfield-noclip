// #region mist

// rows of a mist look (`MistRow` in mist.ts, in vec4s)
const MIST_COLOR = 0u;
const MIST_CARD = 8u;
const MIST_WIND = 9u;
const MIST_LIGHT = 10u;
const MIST_INDIRECT = 11u;
const MIST_FADE = 12u;
const MIST_TOP = 13u;
const MIST_VOLUME = 14u;
// cards' Fresnel term, in the volumes' row
const MIST_FRESNEL = 14u;
const MIST_VOLUME_HEIGHT = 15u;
const MIST_VOLUME_FADE = 16u;
const MIST_MISC = 17u;
const MIST_VOLUME_NOISE = 18u;
const MIST_VOLUME_NOISE_FLOW = 19u;
const MIST_VOLUME_NOISE_MIX = 20u;

// a mist card over the scene at camera-relative `rel`: additive ones add, premultiplied ones blend like other
// layers
fn mist_card_accumulate(id: u32, premultiplied: vec3f, alpha: f32, rel: vec3f, position: vec2f) -> EffectAccumulated {
	if (fx_row(id, MIST_INDIRECT).w != 0.0) {
		return fx_additive(premultiplied);
	}
	return fx_accumulate(premultiplied, alpha, rel, position, 0.0);
}

// a fade between two view depths: in from x to y (or out, when y < x)
fn mist_fade(range: vec2f, depth: f32) -> f32 {
	return saturate((depth - range.x) / (range.y - range.x));
}

// `HGRP/FogSimple` mist cards (docs/game-data/effects.md#mist): the main texture's red broken up by the noise
// texture, the wind and a Fresnel term, in the flat colour or lit by the sun; faded by view depth, towards the
// card's top and where it nears what lies behind it
@fragment
fn fs_mist_card(in: EffectOut) -> EffectAccumulated {
	let id = in.look;
	let uv = in.uv.xy;
	let dx = dpdx(uv);
	let dy = dpdy(uv);
	let bias = exp2(frame.params.y);
	let card = fx_row(id, MIST_CARD);
	let wind = fx_row(id, MIST_WIND);
	let light = fx_row(id, MIST_LIGHT);
	let main_st = fx_row(id, FX_UV);
	let noise_st = fx_row(id, FX_UV + 1u);
	let main = textureSampleGrad(fx_tex0, fx_samp0, uv * main_st.xy + main_st.zw, dx * main_st.xy * bias, dy * main_st.xy * bias);
	let noise = textureSampleGrad(fx_tex1, fx_samp1, uv * noise_st.xy + noise_st.zw, dx * noise_st.xy * bias, dy * noise_st.xy * bias);
	let wind_uv = uv * wind.yz + vec2f(-light.x, light.y) * (frame.eye.w * wind.w);
	let gust = textureSampleGrad(fx_tex1, fx_samp1, wind_uv, dx * wind.yz * bias, dy * wind.yz * bias).x;
	let base = fx_row(id, MIST_COLOR);
	var alpha = ((1.0 - card.y) + noise.x * card.y) * main.x * base.a;
	var color = base.rgb;
	if (light.z != 0.0) {
		// convert the viewer's sun illuminance to diffuse radiance (docs/viewer/lighting.md#sun)
		let n = normalize(in.normal) * select(-1.0, 1.0, dot(in.normal, -in.rel) >= 0.0);
		let lit = (1.0 - light.w) + max(dot(n, frame.sun.xyz), 0.0) * light.w;
		let sun = frame.sun_color.rgb * (frame.sun.w / PI);
		color = mix(fx_row(id, MIST_INDIRECT).rgb, base.rgb * sun, lit);
	}
	let windy = (1.0 - card.z) + ((1.0 - card.w) + saturate(mix(-wind.x, wind.x + 1.0, gust)) * card.w) * card.z;
	color *= windy;
	alpha *= windy;
	let fresnel = fx_row(id, MIST_FRESNEL);
	if (fresnel.x != 0.0) {
		let facing = saturate(abs(dot(normalize(-in.rel), normalize(in.normal))));
		let f = mix(1.0, pow(max(abs(mix(1.0 - facing, facing, fresnel.w)), 0.00048828125), fresnel.z), fresnel.y);
		color *= f;
		alpha *= f;
	}

	let depth = dot(in.rel, frame.view_forward.xyz);
	let fade = fx_row(id, MIST_FADE);
	let top = fx_row(id, MIST_TOP);
	// the top fade runs by the world height below the origin, in units of the object's y scale, not along the
	// object's y axis: an upside-down card still fades towards the sky
	let basis = mist_basis(in);
	let origin = -(basis * vec3f(in.to_object0.w, in.to_object1.w, in.to_object2.w));
	let below = (origin.y - in.rel.y) / max(length(basis[1]), 1e-6);
	var soft = 1.0;
	if (top.z > 0.0) {
		soft = saturate((fx_scene_depth(vec2i(in.position.xy)) - depth) / top.z);
	}
	alpha = saturate(
		alpha * mist_fade(fade.xy, depth) * mist_fade(fade.zw, depth) * saturate(below * top.x + top.y) * soft * card.x,
	);
	return mist_card_accumulate(id, max(color, vec3f(0.0)) * alpha, alpha, in.rel, in.position.xy);
}

// `HGRP/Effect/VFXFakeVolumeFog` boxes (docs/game-data/effects.md#mist), drawn by their back faces without a
// depth test like the decals: the fog's thickness from the nearer of the surface behind and the back face,
// along the ray towards the camera through the unit cube (or up to the camera inside it), then the box's fades
@fragment
fn fs_mist_volume(in: EffectOut) -> EffectAccumulated {
	let id = in.look;
	let px = vec2i(in.position.xy);
	let face = dot(in.rel, frame.view_forward.xyz);
	// the game's boxes read the scene's depth with the water in it, so fog over water ends at its surface
	var scene = fx_scene_depth(px);
	let water = textureLoad(fx_water_depth, px, 0);
	if (water > 0.0) {
		scene = min(scene, frame.local_lights.w / water);
	}
	let depth = min(scene, face);
	let rel = in.rel * (depth / face);
	let p = vec4f(rel, 1.0);
	let object_p = vec3f(dot(in.to_object0, p), dot(in.to_object1, p), dot(in.to_object2, p));
	let to_camera = vec3f(dot(in.to_object0.xyz, -rel), dot(in.to_object1.xyz, -rel), dot(in.to_object2.xyz, -rel));
	let reach = length(to_camera);
	let dir = to_camera / reach;
	let exits = max((vec3f(-0.5) - object_p) / dir, (vec3f(0.5) - object_p) / dir);
	let object_length = min(min(min(exits.x, exits.y), exits.z), reach);
	// back to metres: the object-space ray's length per world metre
	let thickness = object_length * (length(rel) / reach);

	let volume = fx_row(id, MIST_VOLUME);
	let height = fx_row(id, MIST_VOLUME_HEIGHT);
	let base = fx_row(id, MIST_COLOR);
	var alpha = base.a * (1.0 - exp2(-thickness * volume.x)) * volume.y;
	alpha *= saturate(1.0 - length(cross(object_p, dir)) / volume.z);
	alpha *= 1.0 - saturate((object_p.y - height.x) * height.y);
	if (height.w > height.z) {
		alpha *= 1.0 - smoothstep(height.z - 0.5, height.w - 0.5, object_p.y);
	}
	let noise_mix = fx_row(id, MIST_VOLUME_NOISE_MIX);
	if (noise_mix.w != 0.0) {
		// scrolling 3D noise thins the fog where it's high, by an intensity that moves from the near value to
		// the far one over distance; negative intensities thin it further
		let noise_at = fx_row(id, MIST_VOLUME_NOISE);
		let at = select(object_p, frame.eye.xyz + rel, noise_at.w != 0.0);
		let uvw = at * noise_at.xyz + fx_row(id, MIST_VOLUME_NOISE_FLOW).xyz * frame.eye.w;
		let n = textureSampleLevel(fx_volume, fx_volume_samp, uvw, 0.0).r;
		let intensity = mix(noise_mix.y, noise_mix.x, 1.0 - saturate(length(rel) * noise_mix.z));
		alpha *= saturate(1.0 - n + intensity * n);
	}
	if (volume.w > 0.0) {
		alpha *= saturate(thickness / volume.w);
	}
	let fade = fx_row(id, MIST_VOLUME_FADE);
	let to_point = length(rel);
	let distance = mix(to_point, length(mist_origin(in)), fade.y);
	alpha = saturate(alpha) * (1.0 - saturate(distance / fade.x));
	if (fade.z > 0.0) {
		alpha *= smoothstep(min(fade.w, 0.99), 1.0, saturate(to_point / fade.z));
	}
	let color = base.rgb * mix(1.0, frame.ambient.y, fx_row(id, MIST_MISC).x);
	// only additive boxes are packed
	return fx_additive(color * alpha);
}

// #endregion
