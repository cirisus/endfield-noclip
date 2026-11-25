// per-pass uniforms and the lighting shared by every family (group 0). positions are camera-relative Unity
// coordinates. light is pre-exposed: the sun's illuminance and the ambient probe are already multiplied by
// the level's exposure, so shaded values land around 0–2 before tonemapping.

struct Frame {
	// #region camera
	// camera-relative view-projection: reversed-Z, infinite far plane
	view_proj: mat4x4f,
	// camera world position (f32, for world-space lookups only), w = time (s)
	eye: vec4f,
	// the camera's unit forward, right and up vectors, w unused
	view_forward: vec4f,
	view_right: vec4f,
	view_up: vec4f,
	// output width, height (px), pixel factor (output px per metre at 1 m), minimum projected instance size (px)
	viewport: vec4f,
	// render width, height (px), then the inner and outer radius (m) the player's fire seed adds to every global
	// reveal (`FireSeedInfo.radii`, the game's `_VFXParams3.xy`)
	render_size: vec4f,
	// #endregion
	// #region lighting
	// direction towards the sun, w = 1 when the sun casts light
	sun: vec4f,
	// sun illuminance (pre-exposed lux, linear rgb), w = specular intensity
	sun_color: vec4f,
	// the ambient probe in Unity's shader form: SHAr, SHAg, SHAb, SHBr, SHBg, SHBb, SHC
	sh: array<vec4f, 7>,
	// x = indirect specular factor, y = 1 / post exposure (scales emission that ignores it), z = 1 with a reflection cubemap, w = its last mip level (mip count − 1)
	ambient: vec4f,
	// world position of each irradiance clipmap level's centre (0.5 m, 2 m, 8 m probes), w = 1 once filled
	irradiance: array<vec4f, 3>,
	// this frame's local lights (local-lights.ts): count, screen tiles across and down, near plane (m)
	local_lights: vec4f,
	// #endregion
	// #region terrain and debug
	// terrain: zero-sample height relative to the eye, metres per height unit, hole bit (u32 bits), 0
	terrain: vec4f,
	// x = wireframe, y = debug view (0 lit, 1 albedo, 2 normals, 3 roughness, 4 ambient only; 5, the raw
	// cloud panorama, is lit here and shown by the post chain; 6 gaps: grey surfaces, striped where a mesh's
	// material is drawn with something missing), z, w reserved
	flags: vec4u,
	// boxes larger than x metres (max half extent) draw as outlines only; y = material texture mip bias (log2 of
	// the render scale, so upsampled frames sample at the output's density); z = `indirectDiffuseFactor`, the
	// game's scale on all diffuse ambient, applied here to the irradiance volume (`sh` already carries it); w =
	// this frame's place in the temporal antialiasing's jitter cycle (0 without one)
	params: vec4f,
	// #endregion
	// #region shadows
	// camera-relative position → shadow map [0, 1]² × depth, per layer: three sharp cascades, then the far layer
	shadow_matrices: array<mat4x4f, 4>,
	// x = the sharp cascades' reach squared (m²), y = 1 / (reach² − fade start²), z reserved, w = 1 when shadows are on
	shadow_fade: vec4f,
	// xyz = each sharp cascade's filter radius (shadow map uv), w reserved
	shadow_penumbra: vec4f,
	// each layer's bounding sphere: camera-relative centre, w = radius squared
	shadow_spheres: array<vec4f, 4>,
	// x = strength, y = how far the shadow is replaced by z (a fixed attenuation), w = 1 with a penumbra ramp
	shadow_look: vec4f,
	// #endregion
	// #region weather
	// the cloud shadow (`Environment.cloudShadow`): [0] = centre (world), w = 1 when on; [1] = switch start (m),
	// switch end (m), repeats per metre, 0; [2] = flow per second, alpha, far scale; [3] = projection, 0
	cloud_shadow: array<vec4f, 4>,
	// the rain wetness (wetness.ts): [0] = wetness (0: dry), base porosity, porosity factor, occlusion range (m);
	// [1] = far distance factor, far wetness, sheltered wetness, vertical wetness; [2] = x: the standing water's
	// mask threshold (0: none), yzw unused
	wetness: array<vec4f, 3>,
	// the wind (`_WindGlobalParams0`, wind.ts): x = the wind clock, y = the main intensity, zw = the unit XZ
	// direction it blows toward
	wind: vec4f,
	// the irradiance volume's default L1 SH (`_IVDefaultSHAr/g/b`), pre-scaled by `skyDirectIntensity` and
	// `indirectDiffuseFactor`
	iv_default_sh: array<vec4f, 3>,
	// luminance L1 SH of `skyAmbientSH` (`_ReflectionProbeGlobalParam3`), unscaled by `indirectDiffuseFactor`
	reflection_probe_sh: vec4f,
	// local reflection probes: x = active count (0..32), y = cube-array max mip level, zw unused
	reflection_probes: vec4f,
	// #endregion
}

@group(0) @binding(0) var<uniform> frame: Frame;

// G-buffer outputs of the main geometry pass (`MAIN_TARGETS` in render-targets.ts, 24 bytes/sample):
// emission (`rgba16float`), gbuffer_a (`rgb10a2unorm`), gbuffer_b (`rgb10a2unorm`), gbuffer_c (`rgba8unorm-srgb`)
// and mip_feedback (`r32uint`)
struct GBufferOut {
	@location(0) emission: vec4f,
	@location(1) gbuffer_a: vec4f,
	@location(2) gbuffer_b: vec4f,
	@location(3) gbuffer_c: vec4f,
	@location(4) mip_feedback: u32,
}

// a mesh pixel's report to the texture streaming (`MipFeedback`, mip-feedback.wgsl): the material's slot in the
// look table (bits 0–16), then per UV set (bits 17–23 and 24–30) how many quarter mip levels below one UV unit
// per pixel its footprint is, rounded towards finer and at most `MIP_FEEDBACK_STEPS`, and bit 31 to tell a
// report from none. `uv` holds UV sets 0 and 1 as the textures are sampled with, before their slots'
// transforms, `rel` the surface's position and `bias` the mip bias the textures are sampled with. call in
// uniform control flow
const MIP_FEEDBACK_STEPS = 126.0;
// a UV unit spread over more surface than this, m, is a face pinned to a texel or two of a colour swatch,
// which looks the same at any level; no mesh spreads a texture that far (the largest backdrops span a few km)
const MIP_FEEDBACK_SWATCH_METRES = 32768.0;
fn pack_mip_feedback(look: u32, uv: vec4f, rel: vec3f, bias: f32) -> u32 {
	let dx = dpdx(uv);
	let dy = dpdy(uv);
	let px = dpdx(rel);
	let py = dpdy(rel);
	// the longer axis of a pixel's footprint, as the mip level is picked by
	let squared = vec2f(max(dot(dx.xy, dx.xy), dot(dy.xy, dy.xy)), max(dot(dx.zw, dx.zw), dot(dy.zw, dy.zw)));
	let metres_squared = max(dot(px, px), dot(py, py));
	// −log2 of the footprint, in quarter levels
	let levels = -(0.5 * log2(max(squared, vec2f(1e-30))) + bias);
	let steps = vec2u(clamp(ceil(levels * 4.0), vec2f(0.0), vec2f(MIP_FEEDBACK_STEPS)));
	// a swatch asks for nothing
	let swatch = squared * (MIP_FEEDBACK_SWATCH_METRES * MIP_FEEDBACK_SWATCH_METRES) <= vec2f(metres_squared);
	let q = select(steps, vec2u(0u), swatch);
	return 0x80000000u | (look & 0x1ffffu) | (q.x << 17u) | (q.y << 24u);
}

// what a material family hands to the lighting
struct Surface {
	albedo: vec3f,
	// world-space unit normal facing the viewer's side
	normal: vec3f,
	// perceptual roughness
	roughness: f32,
	metallic: f32,
	// the dielectric reflectance at normal incidence (0.04 for most materials)
	f0: f32,
	// baked material occlusion
	occlusion: f32,
	emission: vec3f,
	// foliage: light passing through the leaf
	transmission: f32,
	// lit with the game's two-sided foliage model (`foliage_sun` below)
	foliage: bool,
	// foliage: light wrapped around the leaf's terminator
	subsurface: f32,
	// foliage: the material's own shadow on the sun's diffuse, specular and transmission
	sun_shadow: f32,
	// foliage: the N·L of the sun's diffuse, or negative to take the shading normal's
	sun_n_dot_l: f32,
	// the game's subsurface model (`subsurface_sun` below): the colour of the light scattered inside the surface,
	// times its amount (rgb), and the amount (a). zero without it
	scatter: vec4f,
	// how much of the scattered colour the ambient light adds
	scatter_indirect: f32,
	// wetness porosity in [0, 1], or negative to derive Lit's default `saturate(0.2 * roughness + 0.4)`
	porosity: f32,
}

fn default_surface(albedo: vec3f, normal: vec3f) -> Surface {
	var s: Surface;
	s.albedo = albedo;
	s.normal = normal;
	s.roughness = 0.85;
	s.metallic = 0.0;
	s.f0 = 0.04;
	s.occlusion = 1.0;
	s.emission = vec3f(0.0);
	s.transmission = 0.0;
	s.foliage = false;
	s.subsurface = 0.0;
	s.sun_shadow = 1.0;
	s.sun_n_dot_l = -1.0;
	s.scatter = vec4f(0.0);
	s.scatter_indirect = 0.0;
	s.porosity = -1.0;
	return s;
}

// packs a lit surface into the G-buffer (`GBufferOut`, 24 bytes/sample)
fn pack_gbuffer(s: Surface, no_lit_decals: bool, mip_feedback: u32) -> GBufferOut {
	var out: GBufferOut;
	let flags = GBUFFER_VALID | select(0u, GBUFFER_NO_LIT_DECALS, no_lit_decals);
	out.gbuffer_b = pack_gbuffer_b(s.normal, s.roughness, flags);
	out.mip_feedback = mip_feedback;
	if (s.foliage) {
		let sub = round(clamp(s.subsurface, 0.0, 1.0) * 127.0);
		let f0_code = round(clamp(s.f0 / 0.16, 0.0, 1.0) * 15.0);
		out.emission = vec4f(s.emission, sub + f0_code * 128.0);
		let nl = select(0.0, (clamp(s.sun_n_dot_l, 0.0, 1.0) * 1022.0 + 1.0) / 1023.0, s.sun_n_dot_l >= 0.0);
		out.gbuffer_a = vec4f(
			clamp(s.transmission, 0.0, 1.0),
			clamp(s.sun_shadow, 0.0, 1.0),
			nl,
			f32(SHADING_FOLIAGE) / 3.0,
		);
		out.gbuffer_c = vec4f(clamp(s.albedo, vec3f(0.0), vec3f(1.0)), clamp(s.occlusion, 0.0, 1.0));
	} else if (s.scatter.a > 0.0) {
		out.emission = vec4f(s.emission, s.scatter_indirect);
		out.gbuffer_a = vec4f(clamp(s.scatter.rgb, vec3f(0.0), vec3f(1.0)), f32(SHADING_SUBSURFACE) / 3.0);
		out.gbuffer_c = vec4f(clamp(s.albedo, vec3f(0.0), vec3f(1.0)), clamp(s.scatter.a, 0.0, 1.0));
	} else {
		let porosity = select(s.porosity, saturate(0.2 * s.roughness + 0.4), s.porosity < 0.0);
		out.emission = vec4f(s.emission, s.f0);
		out.gbuffer_a = vec4f(
			clamp(s.metallic, 0.0, 1.0),
			clamp(s.occlusion, 0.0, 1.0),
			clamp(porosity, 0.0, 1.0),
			f32(SHADING_LIT) / 3.0,
		);
		out.gbuffer_c = vec4f(clamp(s.albedo, vec3f(0.0), vec3f(1.0)), 1.0);
	}
	return out;
}

// packs an unlit colour (matte paintings, debug overlays, opaque effects) into the G-buffer
fn pack_gbuffer_unlit(color: vec3f, mip_feedback: u32) -> GBufferOut {
	var out: GBufferOut;
	out.emission = vec4f(color, 0.0);
	out.gbuffer_a = vec4f(0.0, 0.0, 0.0, f32(SHADING_UNLIT) / 3.0);
	out.gbuffer_b = vec4f(0.0);
	out.gbuffer_c = vec4f(0.0);
	out.mip_feedback = mip_feedback;
	return out;
}

struct UnpackedGBuffer {
	model: u32,
	surface: Surface,
	porosity: f32,
}

fn unpack_gbuffer(em: vec4f, ga: vec4f, gb: vec4f, gc: vec4f) -> UnpackedGBuffer {
	var out: UnpackedGBuffer;
	let model = gbuffer_shading_model(ga);
	out.model = model;
	var s = default_surface(gc.rgb, gbuffer_b_normal(gb));
	s.roughness = gb.b;
	s.emission = em.rgb;
	out.porosity = saturate(0.2 * s.roughness + 0.4);
	switch model {
		case SHADING_FOLIAGE: {
			s.foliage = true;
			s.transmission = ga.r;
			s.sun_shadow = ga.g;
			let nl_code = round(ga.b * 1023.0);
			s.sun_n_dot_l = select(-1.0, (nl_code - 1.0) / 1022.0, nl_code >= 1.0);
			let packed = u32(max(round(em.a), 0.0));
			s.subsurface = f32(packed & 127u) / 127.0;
			s.f0 = f32((packed >> 7u) & 15u) * (0.16 / 15.0);
			s.occlusion = gc.a;
		}
		case SHADING_SUBSURFACE: {
			s.scatter = vec4f(ga.rgb, gc.a);
			s.scatter_indirect = em.a;
		}
		case SHADING_LIT: {
			s.metallic = ga.r;
			s.occlusion = ga.g;
			out.porosity = ga.b;
			s.f0 = em.a;
		}
		default: {}
	}
	out.surface = s;
	return out;
}

// smoothstep that also runs downhill (`low` > `high`), matching HLSL/GLSL
fn hermite(low: f32, high: f32, x: f32) -> f32 {
	let span = high - low;
	let t = saturate((x - low) / select(span, 1e-6, span == 0.0));
	return t * t * (3.0 - 2.0 * t);
}

fn hue(h: f32) -> vec3f {
	let k = vec3f(0.0, 2.0 / 3.0, 1.0 / 3.0);
	return clamp(abs(fract(vec3f(h) + k) * 6.0 - 3.0) - 1.0, vec3f(0.0), vec3f(1.0));
}

// an instance row (`ROW_WORDS` and `RowWord` in instance-rows.ts): its transform's rows (w: translation from
// the block origin), its bounds' centre and half extents, its block word, info word (`RowKind`, `RowBillboard`),
// texture sheet word (`rowSheet`), colour (RGBA8, multiplying the mesh's vertex colours) and a particle's custom
// data (two f16 pairs)
struct InstanceRow {
	t0: vec4f,
	t1: vec4f,
	t2: vec4f,
	center: vec3f,
	block: u32,
	extent: vec3f,
	info: u32,
	sheet: u32,
	color: u32,
	custom: vec2u,
}

// a mesh's UV sets (xy: UV0, zw: UV1) flipped by bits 26–27 (U, V) and remapped into the tile of an instance
// row's texture sheet word (`rowSheet` in instance-rows.ts). tiles count from the sheet's top-left; UV (0, 0)
// is its bottom-left
fn sheet_uv(sheet: u32, uv: vec4f) -> vec4f {
	let flip = vec2<bool>((sheet & (1u << 26u)) != 0u, (sheet & (1u << 27u)) != 0u);
	let u0 = select(uv.xy, 1.0 - uv.xy, flip);
	let u1 = select(uv.zw, 1.0 - uv.zw, flip);
	let tiles = vec2u((sheet & 63u) + 1u, ((sheet >> 6u) & 63u) + 1u);
	let tile = (sheet >> 12u) & 4095u;
	let size = 1.0 / vec2f(tiles);
	let corner = vec2f(f32(tile % tiles.x), f32(tiles.y - 1u - min(tile / tiles.x, tiles.y - 1u))) * size;
	let uv0 = select(u0, u0 * size + corner, (sheet & (1u << 24u)) != 0u);
	let uv1 = select(u1, u1 * size + corner, (sheet & (1u << 25u)) != 0u);
	return vec4f(uv0, uv1);
}

// a particle row's custom data (`ParticleSystemInfo.customData`), zero for other rows
fn row_custom(row: InstanceRow) -> vec4f {
	return vec4f(unpack2x16float(row.custom.x), unpack2x16float(row.custom.y));
}

// an instance row's block slot, from its block word (`BLOCK_SLOT_BITS` from instance-rows.ts)
fn row_block(word: u32) -> u32 {
	return word & ((1u << BLOCK_SLOT_BITS) - 1u);
}

// an instance row's decal placement index in its block plus 1, or 0 for a row without one, from its block word
fn row_placement(word: u32) -> u32 {
	return word >> BLOCK_SLOT_BITS;
}

// visible-list entries pack a 24-bit global row index in the low bits and an 8-bit transition fade code in
// the top bits: 0 = opaque, 1..127 = fading in (code / 128), 129..255 = fading out ((code - 128) / 128).
// fading-in and fading-out ranges use complementary noise thresholds so HLOD/detail cross-fades leave no holes
const LIST_ROW_MASK = 0x00ffffffu;

fn list_row(entry: u32) -> u32 {
	return entry & LIST_ROW_MASK;
}

fn list_fade(entry: u32) -> u32 {
	return entry >> 24u;
}

fn fade_opacity(code: u32) -> f32 {
	if (code == 0u) {
		return 1.0;
	}
	return f32(select(code, code - 128u, code >= 128u)) / 128.0;
}

fn fade_discard(code: u32, px: vec2f) -> bool {
	if (code == 0u) {
		return false;
	}
	let n = gradient_noise(px + frame.params.w);
	if (code < 128u) {
		return n >= f32(code) / 128.0;
	}
	return n < 1.0 - f32(code - 128u) / 128.0;
}

// the 3×3 part of an instance row's transform (rows t0–t2). a billboard row's (`RowBillboard` in
// instance-rows.ts, info bits 30–31) is relative to the camera's rotation (1), or to its heading about the
// vertical (2), so it turns to face the camera about its origin
fn row_basis(t0: vec4f, t1: vec4f, t2: vec4f, info: u32) -> mat3x3f {
	let m = mat3x3f(vec3f(t0.x, t1.x, t2.x), vec3f(t0.y, t1.y, t2.y), vec3f(t0.z, t1.z, t2.z));
	switch (info >> 30u) {
		case 1u: {
			return mat3x3f(frame.view_right.xyz, frame.view_up.xyz, frame.view_forward.xyz) * m;
		}
		case 2u: {
			// the camera's right stays level and defined even looking straight down; Unity's forward is right × up
			let right = normalize(vec3f(frame.view_right.x, 0.0, frame.view_right.z));
			let up = vec3f(0.0, 1.0, 0.0);
			return mat3x3f(right, up, cross(right, up)) * m;
		}
		default: {
			return m;
		}
	}
}
