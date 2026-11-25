// alpha-blended materials (`transparent` / `transparentDepthWrite` in look.ts), shaded like opaque ones and
// fogged at their own depth, drawn far to near over the composited scene (`TRANSPARENT_TARGETS` in
// render-targets.ts): premultiplied colour and the opacity, the alpha the alpha test would read times
// `_BaseColor.a` (and optional vertex colour R / Fresnel opacity modulation)
@fragment
fn fs_transparent(in: VertexOut, @builtin(front_facing) front_facing: bool) -> @location(0) vec4f {
	let draw = draws[in.draw];
	let flags = bitcast<u32>(draw.offset.w);
	let id = look_slot(draw);
	let look = looks[id];
	let gradient_scale = exp2(frame.params.y);
	let uv0_dx = dpdx(in.uv.xy) * gradient_scale;
	let uv0_dy = dpdy(in.uv.xy) * gradient_scale;
	let uv1_dx = dpdx(in.uv.zw) * gradient_scale;
	let uv1_dy = dpdy(in.uv.zw) * gradient_scale;
	let front = is_front_face(front_facing, in.mirrored);
	let faceted = cross(dpdx(in.rel), dpdy(in.rel));
	// evaluate surface before any conditional discard so implicit-LOD samples stay in uniform control flow
	let ev = eval_surface(in, true, front);
	let radiance = select(shade_surface_forward(ev.surface, in.rel, in.position.xy), ev.unlit_color, ev.unlit);
	// a map still streaming leaves the tint's alpha alone
	var alpha = 1.0;
	if ((flags & ALPHA_NORMAL) != 0u) {
		if ((flags & NORMAL_MAP) != 0u) {
			alpha = sample_slot(normal_map, detail_sampler, id, in.uv, uv0_dx, uv0_dy, uv1_dx, uv1_dy, flags, NORMAL_SLOT).a;
		}
	} else if ((flags & BASE_MAP) != 0u) {
		alpha = sample_slot(base_map, base_sampler, id, in.uv, uv0_dx, uv0_dy, uv1_dx, uv1_dy, flags, BASE_SLOT).a;
	}
	alpha = saturate(alpha * look.emissive2.w);
	if (look.parallax_bright.y > 0.5 && (flags & HAS_COLORS) != 0u) {
		alpha *= in.color.r;
	}
	let premul = look.misc.z > 0.5;
	// discard zero-opacity fragments so depth-writing transparents (`_Zwrite`) don't leave invisible occluders
	if (!premul && alpha < 0.01) {
		discard;
	}
	if (look.parallax_bright.x > 0.5) {
		let mesh_n = surface_normal(in.normal, faceted, !front);
		let f = transparent_fresnel(look, in, front, faceted, mesh_n, 1.0, vec4f(0.0));
		alpha *= (1.0 - look.parallax.w) + f.x * look.parallax.w;
	}
	alpha *= fade_opacity(in.fade);
	// premultiplied glass (meta.z) adds its whole radiance and lets its opacity only dim what's behind
	let color = radiance * select(alpha, 1.0, premul);
	let uv = in.position.xy / frame.render_size.xy;
	return vec4f(fog_premultiplied(color, alpha, in.rel, uv), alpha);
}

