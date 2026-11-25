// screen-space camera lens raindrops (HGRP/Rain/ScreenRainDropFX).
// needs FRAME_WGSL and postCommonSource(1, 0).

struct ScreenDropParams {
	// camera-relative (centerX, topRelY, centerZ, 1 / (2 · range))
	occ_origin: vec4f,
	// (1 / height, height, texelWorldSize, active)
	occ_metrics: vec4f,
	// linear RGB + alpha
	color: vec4f,
	// (shadingSize, noiseLevel, centroidFadeMin, centroidFadeMax)
	params: vec4f,
	// (0, activeCount, edgeSharpness, 0)
	edge: vec4f,
	// noise texture ST
	noise_st: vec4f,
	// per-drop (ndcX, ndcY, lifeAlpha, size)
	drops: array<vec4f, 30>,
}

@group(2) @binding(0) var<uniform> drop_data: ScreenDropParams;
@group(2) @binding(1) var vertical_occlusion: texture_depth_2d;
@group(2) @binding(2) var vertical_occlusion_compare: sampler_comparison;
@group(2) @binding(3) var vertical_occlusion_raw: sampler;
@group(2) @binding(4) var noise_tex: texture_2d<f32>;
@group(2) @binding(5) var noise_sampler: sampler;

struct DropOut {
	@builtin(position) position: vec4f,
	@location(0) uv: vec2f,
	@location(1) screen_uv: vec2f,
	@location(2) life_alpha: f32,
}

const QUAD_VERTS = array<vec2f, 6>(
	vec2f(-0.5, -0.5),
	vec2f(0.5, -0.5),
	vec2f(0.5, 0.5),
	vec2f(-0.5, -0.5),
	vec2f(0.5, 0.5),
	vec2f(-0.5, 0.5),
);

@vertex
fn vs_screen_drop(@builtin(vertex_index) vid: u32, @builtin(instance_index) iid: u32) -> DropOut {
	let drop = drop_data.drops[iid];
	var quad = QUAD_VERTS;
	let corner = quad[vid];
	let aspect = frame.render_size.x / max(frame.render_size.y, 1.0);
	let ndc = drop.xy + vec2f(corner.x, corner.y * aspect) * drop.w;
	let suv = vec2f(ndc.x * 0.5 + 0.5, (ndc.y * 0.5 + 0.5) / max(aspect, 0.01));

	var out: DropOut;
	out.position = vec4f(ndc, 0.0, 1.0);
	out.uv = corner + vec2f(0.5);
	out.screen_uv = suv;
	out.life_alpha = drop.z;
	return out;
}

@fragment
fn fs_screen_drop(in: DropOut) -> @location(0) vec4f {
	let occ_uv = vec2f(
		0.5 - drop_data.occ_origin.x * drop_data.occ_origin.w,
		0.5 + drop_data.occ_origin.z * drop_data.occ_origin.w,
	);
	let occ_z = drop_data.occ_origin.y * drop_data.occ_metrics.x;
	var exposed = 1.0;
	if (drop_data.occ_metrics.w > 0.5 && all(occ_uv > vec2f(0.0)) && all(occ_uv < vec2f(1.0)) && occ_z > 0.0 && occ_z < 1.0) {
		exposed = textureSampleCompareLevel(vertical_occlusion, vertical_occlusion_compare, occ_uv, max(occ_z, 0.00048828125));
	}
	if (exposed <= 0.0005) {
		discard;
	}
	let noise = textureSampleLevel(
		noise_tex,
		noise_sampler,
		in.screen_uv * drop_data.noise_st.xy + drop_data.noise_st.zw,
		0.0,
	).x;
	let radius = max(drop_data.params.x * (1.0 + (noise * 2.0 - 1.0) * drop_data.params.y), 1e-4);
	let fade_lo = drop_data.params.z;
	let fade_hi = max(drop_data.params.w, fade_lo + 1e-4);
	let edge_mask = smoothstep(fade_lo, fade_hi, length(in.screen_uv - vec2f(0.5)));
	let sharp = min(drop_data.edge.z, 0.99);
	let drop_mask = 1.0 - smoothstep(radius * sharp, radius, length(in.uv - vec2f(0.5)));
	let alpha = saturate(edge_mask * drop_mask * drop_data.color.a * saturate(in.life_alpha) * noise * exposed);
	if (alpha <= 0.0005) {
		discard;
	}
	return vec4f(drop_data.color.rgb, alpha);
}
