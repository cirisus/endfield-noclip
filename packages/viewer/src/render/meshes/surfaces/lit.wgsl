// lean G-buffer path for plain opaque Lit looks (base + normal only, no mask/emissive/detail/layer/parallax/
// foliage/erosion/unlit/dither/gaps); keeps VGPRs low for the ~86% of opaque materials that need nothing else
@fragment
fn fs_opaque_lit(in: VertexOut, @builtin(front_facing) front_facing: bool) -> GBufferOut {
	let draw = draws[in.draw];
	let flags = bitcast<u32>(draw.offset.w);
	let id = look_slot(draw);
	let look = looks[id];
	let feedback = pack_mip_feedback(id, in.uv, in.rel, frame.params.y);
	// screen +Y is down, so dpdx × dpdy faces the viewer in left-handed space
	let faceted = cross(dpdx(in.rel), dpdy(in.rel));
	let bias = frame.params.y;
	let base = textureSampleBias(base_map, base_sampler, slot_uv(id, in.uv, flags, BASE_SLOT), bias);
	let packed = textureSampleBias(normal_map, detail_sampler, slot_uv(id, in.uv, flags, NORMAL_SLOT), bias);

	var albedo = clamp(base.rgb * look.tint.rgb * look.surface2.w, vec3f(0.0), vec3f(1.0));
	if ((flags & BASE_MAP) == 0u) {
		albedo = vec3f(1.0);
	}
	albedo = mix(albedo, look.tint.rgb, look.emissive.w);
	let has_normal = (flags & NORMAL_MAP) != 0u;

	let front = is_front_face(front_facing, in.mirrored);
	var n = surface_normal(in.normal, faceted, !front);
	if (has_normal && in.tangent.w != 0.0) {
		var rg = packed.rg;
		if ((flags & NORMAL_RAG) != 0u) {
			rg.x = packed.r * packed.a;
		}
		let xy = unpack_normal_xy(rg);
		let tn = vec3f(xy * look.surface.w, normal_z(xy));
		let t = normalize(in.tangent.xyz - n * dot(in.tangent.xyz, n));
		var b = cross(in.normal, in.tangent.xyz) * in.tangent.w;
		if (!front) {
			b = -b;
		}
		b = normalize(b - n * dot(b, n));
		n = normalize(t * tn.x + b * tn.y + n * tn.z);
	}

	var s = default_surface(albedo, n);
	s.roughness = look.surface.y;
	if (has_normal && (flags & NORMAL_ROUGHNESS) != 0u) {
		s.roughness = mix(look.surface.x, look.surface.y, packed.b);
	}
	s.metallic = look.surface.z;
	if ((flags & METALLIC_BASE_ALPHA) != 0u) {
		s.metallic = select(0.0, base.a, (flags & BASE_MAP) != 0u);
	}
	s.f0 = look.surface2.y;
	if ((flags & (NORMAL_MAP | NORMAL_OCCLUSION)) == (NORMAL_MAP | NORMAL_OCCLUSION)) {
		s.occlusion = mix(1.0, packed.a, look.surface2.x);
	}
	var out = pack_gbuffer(s, look.detail2.w > 0.5, feedback);
	out.velocity = dynamic_velocity(in.rel, in.prev_rel);
	return out;
}

