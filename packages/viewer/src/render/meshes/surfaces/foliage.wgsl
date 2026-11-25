// a trunk's `_FOLIAGE_TRUNK` (`TrunkRow` in lit-look.ts; zeros on other looks, which change nothing): the vertex
// colour's R darkens the material occlusion, and the albedo ramps toward a colour below a height in its A, by
// the base map's alpha
fn trunk_surface(surface: Surface, look: Look, in: VertexOut, base_a: f32) -> Surface {
	var s = surface;
	s.occlusion *= mix(1.0, in.color.r, look.canopy.z);
	let ramp = look.canopy.w * hermite(look.canopy.x + look.canopy.y, look.canopy.x, in.color.a) * base_a;
	s.albedo = mix(s.albedo, look.canopy_color.rgb, ramp);
	return s;
}

// `HGRP/Foliage/Leaf`'s inputs to the two-sided foliage lighting (`leafParams` in lit-look.ts). the vertex
// colour's R is ambient occlusion and A the height in the canopy; the normal map's alpha (`normal_a`) masks
// transmission and the canopy ramp
fn leaf_surface(surface: Surface, look: Look, in: VertexOut, has_normal: bool, normal_a: f32) -> Surface {
	var s = surface;
	let thin = select(1.0, saturate(1.0 - normal_a), has_normal);
	let ao = saturate(mix(1.0, in.color.r, look.surface2.x));
	s.occlusion = ao;
	let fade_in = vec2f(
		hermite(look.foliage_ao.x, look.foliage_ao.x + look.foliage_ao.y, ao),
		hermite(look.foliage_ao.z, look.foliage_ao.z + look.foliage_ao.w, ao),
	);
	// transmission fades out between 50 and 60 m from the object
	let far = select(1.0, hermite(3600.0, 2500.0, dot(in.origin, in.origin)), look.foliage2.y > 0.5);
	s.transmission = look.surface2.z * thin * far * fade_in.x;
	s.subsurface = look.foliage2.x * fade_in.y;

	let height = select(in.color.a, 1.0 - in.color.a, look.foliage2.w > 0.5);
	let ramp = hermite(look.canopy.x + look.canopy.y, look.canopy.x, height) * thin * look.foliage2.z;
	let tinted = mix(
		saturate(s.albedo * look.canopy_color.rgb * look.canopy.z),
		look.canopy_color.rgb,
		look.canopy.w,
	);
	s.albedo = mix(s.albedo, tinted, ramp);

	// the vertex normal as the mesh stores it (not turned towards the viewer)
	var vertex_normal = s.normal;
	if (dot(in.normal, in.normal) > 1e-6) {
		vertex_normal = normalize(in.normal);
	}
	// `_BLEND_COLOR` (`LeafBlendRow` in lit-look.ts): the albedo times the blend colour, or times the tint again
	// on thick parts whose normal faces up
	let blend = look.mask_albedo[1];
	if (blend.w > 0.5) {
		let up = saturate(mix(s.normal.y, vertex_normal.y, blend.z) + 0.5 + blend.x);
		let keep = saturate(pow(up, blend.y) + 1.0 - saturate(thin * look.mask_albedo[0].w * 10.0));
		s.albedo *= mix(look.mask_albedo[0].rgb, look.tint.rgb, keep);
	}

	// the sun's shadow: the vertex AO, and a fake shadow on the side of the canopy facing away from the sun
	let fake = saturate(1.0 - pow(saturate(dot(s.normal, -frame.sun.xyz) * 0.5 + 0.5), look.foliage.z) * look.foliage.y);
	s.sun_shadow = mix(1.0, in.color.r, look.foliage.x) * fake;
	// the diffuse N·L takes the stored vertex normal
	s.sun_n_dot_l = saturate(dot(mix(s.normal, vertex_normal, look.foliage.w), frame.sun.xyz));
	return s;
}

// `HGRP/Foliage/Grass` and its card LOD (`grassParams` in lit-look.ts, docs/game-data/materials.md#foliage):
// occlusion and a sun mask that rise from a floor at the root to 1 up the blade, by the object-space height
// standing in for the game's; the sun mask's diffuse and transmission parts masked by the normal map's alpha
// (`mask`), and transmission where those agree
fn grass_surface(surface: Surface, look: Look, in: VertexOut, mask: f32) -> Surface {
	var s = surface;
	let height = max(in.object_pos.y, 0.0);
	let ao = look.foliage_ao;
	s.occlusion = 1.0 - ao.z * (1.0 - saturate((height - ao.x) * ao.y));
	let dir = 1.0 - look.foliage2.w * (1.0 - saturate((height - look.foliage2.y) * look.foliage2.z));
	let diffuse = dir * mix(1.0, mask, look.foliage.z);
	let transmitted = dir * mix(1.0, mask, look.foliage.w);
	s.sun_shadow = max(diffuse, transmitted);
	s.transmission = look.surface2.z * (1.0 - abs(diffuse - transmitted));
	s.subsurface = look.foliage2.x;
	return s;
}


// `_DISTORTION_FLOW`'s flowing glow (`FlowGlowRow` in lit-look.ts, docs/game-data/materials.md#glowing-foliage):
// a noise warped by itself, both scrolling, lights the albedo by its brightness. it adds to the emission after
// the exposure's scaling, so it doesn't ignore the post exposure
fn flow_glow(look: Look, albedo: vec3f, vertex_red: f32, uv: vec2f, dx: vec2f, dy: vec2f) -> vec3f {
	let flow = look.parallax_dark;
	let shape = look.parallax_bright;
	let t = frame.eye.w;
	let first_uv = (uv * flow.x + vec2f(0.0, t * flow.z)) * 0.25;
	let n1 = textureSampleGrad(parallax_noise_map, parallax_sampler, first_uv, dx * flow.x * 0.25, dy * flow.x * 0.25).r;
	let second_uv = ((2.0 * n1 - 1.0) * shape.x + uv * flow.y + vec2f(t * flow.w)) * 0.25;
	let n2 = textureSampleGrad(parallax_noise_map, parallax_sampler, second_uv, dx * flow.y * 0.25, dy * flow.y * 0.25).r;
	let brightness = max(1.0 + 10.0 * (dot(albedo, LUMINANCE) - look.parallax_color.w), 0.0);
	let strength = saturate((2.0 * n2 - 1.0) * shape.y + shape.z) * mix(1.0, vertex_red, shape.w);
	return look.parallax_color.rgb * albedo * brightness * strength;
}

