// a point in the beam's own frame, with the direction's skew taken out
fn beam_unskew(id: u32, p: vec3f) -> vec3f {
	let dir = fx_row(id, BM_DIRECTION);
	return vec3f(p.xy - dir.xy * (p.z / dir.z), p.z);
}

// a volumetric light beam (docs/game-data/lighting.md#light-beams): the product of the side, attenuation and
// fade terms listed there. the mesh holds the inside and outside faces (UV0's v) and a start cap (u)
fn light_beam(in: EffectOut) -> EffectAccumulated {
	let id = in.look;
	let color = fx_row(id, BM_COLOR);
	let cone = fx_row(id, BM_CONE);
	let dir = fx_row(id, BM_DIRECTION);
	let falloff = fx_row(id, BM_FALLOFF);
	let alpha = fx_row(id, BM_ALPHA);
	let glare = fx_row(id, BM_GLARE);
	let fade = fx_row(id, BM_FADE);
	let clip = fx_row(id, BM_CLIP);
	let tilt = fx_row(id, BM_TILT);
	let cap = in.uv.x;
	let outside = in.uv.y;

	let scale = beam_scale(id);
	let to_object = vec3f(in.to_object0.w, in.to_object1.w, in.to_object2.w);
	let object = vec3f(
		dot(in.to_object0.xyz, in.rel),
		dot(in.to_object1.xyz, in.rel),
		dot(in.to_object2.xyz, in.rel),
	) + to_object;
	let skewed = object * scale;
	let local = beam_unskew(id, skewed);
	let camera = beam_unskew(id, to_object * scale);
	let view_dir = normalize(local - camera);
	let depth = dot(in.rel, frame.view_forward.xyz);
	let near = frame.local_lights.w;
	let along = abs(skewed.z) + skewed.x * tilt.x + skewed.y * tilt.y;

	var visible = 1.0;
	if (clip.w != 0.0) {
		let plane = fx_row(id, BM_PLANE);
		let side = saturate((dot(plane.xyz, in.rel + frame.eye.xyz) + plane.w) / tilt.z);
		visible = mix(1.0, side, clip.w);
	}
	if (clip.y > 0.0) {
		let apex_share = saturate(abs(skewed.z) / clip.y);
		let distance = mix(clip.y, clip.y * apex_share, clip.z);
		var blend = 1.0;
		if (distance > 0.0) {
			let scene = fx_scene_depth(vec2i(in.position.xy));
			blend = saturate((max(0.0, scene - near) - max(0.0, depth - near)) / distance);
		}
		visible *= mix(1.0, blend, saturate(apex_share * 100.0));
	}
	visible *= smoothstep(0.0, 1.0, saturate((abs(depth) - near) / max(clip.x, 1e-4)));
	visible *= select(0.0, 1.0, cap - 1e-5 <= dir.w) * (1.0 - outside * cap);

	// the side's normal, flipped on the inside faces, against the view: across the axis when looking across the
	// beam, straight at the camera when looking along it
	let radial = select(vec2f(0.0), normalize(local.xy), dot(local.xy, local.xy) > 0.0);
	let normal = vec3f(radial * cone.z, -cone.w) * (outside * 2.0 - 1.0);
	let to_camera = -view_dir;
	let from_apex = normalize(local + vec3f(0.0, 0.0, glare.z));
	let align = abs(dot(view_dir, dir.xyz));
	let across = to_camera - from_apex * dot(to_camera, from_apex);
	let across_dir = select(vec3f(0.0), normalize(across), dot(across, across) > 0.0);
	let f = smoothstep(0.0, 1.0, mix(dot(normal, across_dir), dot(normal, to_camera), align));
	let power = mix(alpha.w, min(alpha.w, 1.5 * (1.0 - mix(glare.x, glare.y, outside))), align);
	let fresnel = select(0.0, pow(f, power), f > 0.0);
	let surface = mix(mix(fresnel, 1.001, cap), fresnel, outside);

	let origin_distance = abs(in.origin.w);
	let distance_fade = saturate((origin_distance - fade.x) / (fade.y - fade.x)) *
		saturate((origin_distance - fade.z) / (fade.w - fade.z));
	var t = select(0.0, 1.0, along >= falloff.x);
	if (falloff.y != falloff.x) {
		t = saturate((along - falloff.x) / (falloff.y - falloff.x));
	}
	let linear = smoothstep(0.0, 1.0, 1.0 - t);
	let quadratic = 1.0 / (1.0 + 25.0 * t * t) * (1.0 - smoothstep(0.8, 1.0, t));
	let attenuation = mix(linear, quadratic, alpha.z);
	let start_fade = mix(select(1.0, saturate(along / falloff.w), falloff.w > 0.0), 1.0, cap);
	let facing_back = saturate(1.0 - smoothstep(-1.0, 1.0, view_dir.z));
	let facing = mix(facing_back, 1.0 - facing_back, outside);

	let intensity = visible * surface * distance_fade * attenuation * start_fade * facing;
	let opacity = color.a * mix(alpha.x, alpha.y, outside);
	// `_BlendMode` 1 adds the light
	if (glare.w >= 0.5) {
		return fx_additive(color.rgb * opacity * intensity);
	}
	let a = saturate(opacity * intensity);
	return fx_accumulate(color.rgb * a, a, in.rel, in.position.xy, fx_row(id, FX_UNFOGGED).x);
}

// #endregion
