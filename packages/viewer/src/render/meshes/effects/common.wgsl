// scene effect meshes (looks/effects/, docs/game-data/effects.md), accumulated into the transparent pass's
// targets like alpha-blended meshes: VFXBaseV2 surfaces and VFXWater sheets (`fs_effect`), VFXDecal boxes
// (`fs_effect_decal`), FogSimple mist cards (`fs_mist_card`) and VFXFakeVolumeFog boxes (`fs_mist_volume`); lit
// decals that only change the surface add to the main pass's radiance instead (`fs_decal_relight`).
// instances, draws and vertex streams are laid out as in mesh.wgsl; group 3 is this family's own.

@group(1) @binding(0) var<storage, read> effect_rows: array<InstanceRow>;
// each block's origin (xyz) and where its decal placements start, less 1 (w)
@group(1) @binding(1) var<storage, read> effect_blocks: array<vec4f>;
@group(1) @binding(2) var<storage, read> effect_list: array<u32>;
// rect decal placements (`DecalPlacements` in package-format): colour, then UV scale and offset
@group(1) @binding(3) var<storage, read> effect_placements: array<array<vec4f, 2>>;
// mesh.wgsl's `Draw`: dequantization, flags and look slot (4 vec4s)
@group(2) @binding(0) var<storage, read> effect_draws: array<array<vec4f, 4>>;
@group(2) @binding(1) var<storage, read> effect_draw_ids: array<u32>;
// mesh.wgsl's `looks`: the look's 48 rows (`EffectRow`, `WaterSheetRow` or `MistRow` in mist.ts)
@group(2) @binding(5) var<storage, read> effect_looks: array<array<vec4f, 48>>;
@group(3) @binding(0) var fx_tex0: texture_2d<f32>;
@group(3) @binding(1) var fx_tex1: texture_2d<f32>;
@group(3) @binding(2) var fx_tex2: texture_2d<f32>;
@group(3) @binding(3) var fx_tex3: texture_2d<f32>;
@group(3) @binding(4) var fx_tex4: texture_2d<f32>;
@group(3) @binding(5) var fx_tex5: texture_2d<f32>;
@group(3) @binding(6) var fx_tex6: texture_2d<f32>;
@group(3) @binding(7) var fx_samp0: sampler;
@group(3) @binding(8) var fx_samp1: sampler;
@group(3) @binding(9) var fx_samp2: sampler;
@group(3) @binding(10) var fx_samp3: sampler;
@group(3) @binding(11) var fx_samp4: sampler;
@group(3) @binding(12) var fx_samp5: sampler;
@group(3) @binding(13) var fx_samp6: sampler;
// the main pass's depth (read-only in this pass) and G-buffer B (normal, roughness, flags)
@group(3) @binding(14) var fx_depth: texture_depth_2d;
@group(3) @binding(15) var fx_surface: texture_2d<f32>;
// G-buffer A (metallic, occlusion, porosity, shading model; copied during the G-buffer decal pass)
@group(3) @binding(16) var fx_gbuffer_a: texture_2d<f32>;
// the look's 3D texture (`volumeTexture`: the mist boxes' noise), a zeroed placeholder without one
@group(3) @binding(17) var fx_volume: texture_3d<f32>;
@group(3) @binding(18) var fx_volume_samp: sampler;
// a copy of the composited scene, which refraction samples (`fs_refract`); a white placeholder in other passes
@group(3) @binding(19) var fx_background: texture_2d<f32>;
@group(3) @binding(20) var fx_background_samp: sampler;
// the nearest water surface's depth (reversed-Z), 0 where there's none
@group(3) @binding(21) var fx_water_depth: texture_depth_2d;

// rows of the look (`EffectRow` in effect-look.ts, in vec4s)
const FX_TINT = 0u;
const FX_UV = 1u;
const FX_ANIM = 8u;
const FX_SLOT_BITS = 15u;
const FX_BLEND_TINT = 17u;
const FX_DISTURB = 18u;
const FX_WEIGHT = 19u;
const FX_DISSOLVE = 20u;
const FX_DISSOLVE_COLOR = 21u;
const FX_FRESNEL = 22u;
const FX_SOFT = 23u;
const FX_NEAR = 24u;
const FX_MISC = 25u;
const FX_DECAL_FADE = 26u;
const FX_DECAL = 27u;
const FX_OFFSET_DIR = 28u;
const FX_OFFSET = 29u;
const FX_OFFSET_MODE = 30u;
const FX_UNFOGGED = 31u;
const FX_EDGE_COLOR = 32u;
const FX_EDGE = 33u;
// z, w: the vertex offset mask's slot and strength (`EffectRow.offsetMask`)
const FX_EDGE_ALPHA = 34u;
// the pull towards the camera's most (m), 1 when it pulls (`EffectRow.cameraPull`); z, w: 1 when the mask
// scales only the alpha (`EffectRow.maskAlphaOnly`), 1 when the colour is times the unmasked alpha
// (`EffectRow.colorTimesAlpha`)
const FX_CAMERA_PULL = 35u;
// the texture stack's per-slot custom data shifts (u, v), from row 36 on (`EffectRow.customScroll` in
// effect-look.ts)
const FX_CUSTOM_SCROLL = 36u;
// the texture stack's reveal around the player (`EffectRow.appear*`): radii, alpha factor and edge; noise
// scale, speed, centre height and 1 with a reveal; brightening colour
const FX_APPEAR = 40u;
const FX_APPEAR_NOISE = 41u;
const FX_APPEAR_BRIGHT = 42u;
// the Fresnel colour (rgb, cover); the normal map's slot, scale, 1 to reverse back faces' normals, and
// VFXDitherAlpha's `_USE_MAIN2` slot; the emission's colour and slot; `_USE_MAIN2`'s colour and blend mode
// (`EffectRow.fresnelColor`, `normalMap`, `emission`, `main2`)
const FX_FRESNEL_COLOR = 44u;
const FX_NORMAL_MAP = 45u;
const FX_EMISSION = 46u;
const FX_MAIN2 = 47u;
// the texture stack's switches: the vertex alpha scales the reveal's brightening, the global radii add to the
// reveal's, the first disturb texture holds a normal, the vertex colour scales the blend tint
const FX_STACK_FLAGS = 43u;
// a decal's parallax (`EffectRow.parallax`), crack colour and crack noise colour, in the reveal's rows
const FX_PARALLAX = 40u;
const FX_CRACK = 41u;
const FX_CRACK_NOISE = 42u;
// the slot of the vertex offset's texture (`OFFSET_SLOT` in stack.ts)
const FX_OFFSET_SLOT = 6u;
// how the vertex stage moves vertices (`VertexMotion` in stack.ts)
const FX_MOTION_OFFSET = 1.0;
const FX_MOTION_SOFT_BODY = 2.0;

// texture roles (`EffectRole` in effect-look.ts)
const ROLE_DISTURB1 = 0u;
const ROLE_DISTURB2 = 1u;
const ROLE_WEIGHT = 2u;
const ROLE_MASK = 3u;
const ROLE_BLEND = 4u;
const ROLE_DISSOLVE = 5u;
const ROLE_NONE = 7u;
const SLOT_RED_ALPHA = 16u;
// two bits of `SlotSource` (effect-look.ts): UV0, UV1, polar, screen
const SLOT_SOURCE_SHIFT = 5u;
const SLOT_NO_BASE = 128u;

// the share of the distortion a slot's UVs take, in 1/1024ths above the low byte (`slotDisturb` in
// stack.ts)
fn slot_disturb(bits: u32) -> f32 {
	return f32(bits >> 8u) / 1024.0;
}

const FX_HAS_TANGENTS = 1024u;
const FX_HAS_COLORS = 67108864u;

struct EffectIn {
	@location(0) position: vec4f,
	@location(1) normal: vec2f,
	@location(2) uv0: vec2f,
	@location(4) uv1: vec2f,
	@location(3) tangent: vec4f,
	@location(5) color: vec4f,
}

struct EffectOut {
	@builtin(position) position: vec4f,
	@location(0) rel: vec3f,
	@location(1) normal: vec3f,
	@location(2) uv: vec4f,
	@location(3) color: vec4f,
	// the draw's look slot, which `fx_row` reads
	@location(4) @interpolate(flat) look: u32,
	// camera-relative world → object space, by rows (w: translation)
	@location(5) @interpolate(flat) to_object0: vec4f,
	@location(6) @interpolate(flat) to_object1: vec4f,
	@location(7) @interpolate(flat) to_object2: vec4f,
	// the object's unit y axis in world space: the decal's projection direction, reversed
	@location(8) @interpolate(flat) up: vec3f,
	// the object origin, camera-relative, and its view depth (w), which scales VFXBaseV2's screen UVs
	@location(9) @interpolate(flat) origin: vec4f,
	// a rect decal row's placement: its colour, and its UV scale and offset; white and the identity elsewhere
	@location(10) @interpolate(flat) placement_color: vec4f,
	@location(11) @interpolate(flat) placement_uv: vec4f,
	// the row's extras: a particle's custom data
	@location(12) @interpolate(flat) custom: vec4f,
	// w = bitangent sign, 0 without a tangent
	@location(13) tangent: vec4f,
}

// the transparent pass's output (`TRANSPARENT_TARGETS` in render-targets.ts), as in mesh.wgsl: premultiplied
// colour and the opacity it hides the scene behind by, 0 for additive light
struct EffectAccumulated {
	@location(0) color: vec4f,
}

// row `r` of the look in slot `id` of `effect_looks`
fn fx_row(id: u32, r: u32) -> vec4f {
	return effect_looks[id][r];
}

fn fx_slot_bits(id: u32, slot: u32) -> u32 {
	return u32(fx_row(id, FX_SLOT_BITS + slot / 4u)[slot % 4u]);
}

fn inverse3(m: mat3x3f) -> mat3x3f {
	let a = cross(m[1], m[2]);
	let b = cross(m[2], m[0]);
	let c = cross(m[0], m[1]);
	let det = dot(m[0], a);
	return transpose(mat3x3f(a, b, c)) * (1.0 / det);
}

// the vertex offset of VFXBaseV2 and VFXDitherAlpha: along a direction (object or world space, or the
// normal), by the offset texture's red channel remapped by `_Bi_Offset`; VFXBaseV2's is optionally weighted by
// the vertex alpha
fn fx_vertex_offset(id: u32, m: mat3x3f, normal: vec3f, uv: vec4f, vertex_alpha: f32) -> vec3f {
	let dir_row = fx_row(id, FX_OFFSET_DIR);
	let params = fx_row(id, FX_OFFSET);
	var dir = m * dir_row.xyz;
	if (dir_row.w == 1.0) {
		dir = dir_row.xyz;
	} else if (dir_row.w == 2.0) {
		dir = m * normal;
	}
	let st = fx_row(id, FX_UV + FX_OFFSET_SLOT);
	let speed = fx_row(id, FX_ANIM + FX_OFFSET_SLOT).xy;
	let base = select(uv.xy, uv.zw, fx_row(id, FX_OFFSET_MODE).y != 0.0);
	let t = textureSampleLevel(fx_tex6, fx_samp6, base * st.xy + st.zw + speed * frame.eye.w, 0.0).r;
	var weight = (1.0 - params.z) + vertex_alpha * params.z;
	// `_USE_VERTOFFSETMASK`: the mask's red at the same UVs, through its own `_ST` and scroll
	let mask = fx_row(id, FX_EDGE_ALPHA).zw;
	if (mask.y != 0.0) {
		let slot = u32(mask.x);
		let mask_st = fx_row(id, FX_UV + slot);
		let mask_speed = fx_row(id, FX_ANIM + slot).xy;
		let r = fx_sample_level(slot, base * mask_st.xy + mask_st.zw + mask_speed * frame.eye.w, 0.0).r;
		weight *= 1.0 - mask.y * (1.0 - r);
	}
	return dir * params.x * (t * (1.0 + params.y) - params.y) * weight;
}

// a stack slot sampled at one mip level, which the vertex stage needs
fn fx_sample_level(slot: u32, uv: vec2f, level: f32) -> vec4f {
	switch slot {
		case 0u: {
			return textureSampleLevel(fx_tex0, fx_samp0, uv, level);
		}
		case 1u: {
			return textureSampleLevel(fx_tex1, fx_samp1, uv, level);
		}
		case 2u: {
			return textureSampleLevel(fx_tex2, fx_samp2, uv, level);
		}
		case 3u: {
			return textureSampleLevel(fx_tex3, fx_samp3, uv, level);
		}
		case 4u: {
			return textureSampleLevel(fx_tex4, fx_samp4, uv, level);
		}
		case 5u: {
			return textureSampleLevel(fx_tex5, fx_samp5, uv, level);
		}
		default: {
			return textureSampleLevel(fx_tex6, fx_samp6, uv, level);
		}
	}
}

// VFXBaseV2's pull towards the camera: up to `pull` metres past the first, plus 1 mm. `rel` is the vertex's
// camera-relative position, the camera at the origin
fn fx_camera_pull(rel: vec3f, pull: f32) -> vec3f {
	let camera_distance = length(rel);
	return -rel / max(camera_distance, 1e-6) * (min(max(0.0, camera_distance - 1.0), pull) + 0.001);
}

// where a soft-body animation's textures hold a vertex (`VertexMotion.SoftBody` in stack.ts): UV1's column
// and the current frame's row, of `frames`
fn fx_soft_body_at(id: u32, frames: f32, uv1: vec2f) -> vec2f {
	let scale = fx_row(id, FX_UV + FX_OFFSET_SLOT).xy;
	let play = fx_row(id, FX_ANIM + FX_OFFSET_SLOT).xy;
	let n = max(frames, 1.0);
	let current = floor(fract(frame.eye.w * play.x + play.y) * n);
	return vec2f(uv1.x * scale.x, 1.0 - scale.y * ((1.0 - uv1.y) + current / n));
}

// the soft body's object-space position: moved by the position texture's texel at `at`, scaled into `range`
// from `low`. vertices with UV1's v at most 0.1 collapse to the object's origin, as the game's do
fn fx_soft_body(low: vec3f, range: vec3f, at: vec2f, p: vec3f, uv1: vec2f) -> vec3f {
	let texel = textureSampleLevel(fx_tex6, fx_samp6, at, 0.0).xyz;
	return select(p + range * texel + low, vec3f(0.0), uv1.y <= 0.1);
}

// a water sheet's soft-body normal: +y turned by the rotation texture's quaternion at `at`, stored as
// `q / 2 + 0.5` (`packing` 1) or as it is
fn fx_soft_body_normal(at: vec2f, packing: f32) -> vec3f {
	var q = textureSampleLevel(fx_tex5, fx_samp5, at, 0.0);
	if (packing == 1.0) {
		q = q * 2.0 - 1.0;
	}
	let up = vec3f(0.0, 1.0, 0.0);
	return normalize(up + 2.0 * cross(q.xyz, q.w * up + cross(q.xyz, up)));
}

@vertex
fn vs_effect(v: EffectIn, @builtin(instance_index) ii: u32) -> EffectOut {
	let entry = effect_list[ii];
	let row = effect_rows[list_row(entry)];
	let draw_id = effect_draw_ids[ii];
	let offset = effect_draws[draw_id][0];
	let scale = effect_draws[draw_id][1];
	let uv0 = effect_draws[draw_id][2];
	let uv1 = effect_draws[draw_id][3];
	let id = bitcast<u32>(scale.w);
	var p = offset.xyz + v.position.xyz * scale.xyz;
	if (fx_row(id, FX_UNFOGGED).y == FX_KIND_BEAM) {
		p = beam_vertex(id, p);
	}
	let origin = vec3f(row.t0.w, row.t1.w, row.t2.w) + effect_blocks[row_block(row.block)].xyz;
	let m = row_basis(row.t0, row.t1, row.t2, row.info);
	let inverse = transpose(inverse3(m));
	let flags = bitcast<u32>(offset.w);
	let uv = sheet_uv(row.sheet, vec4f(v.uv0 * uv0.xy + uv0.zw, v.uv1 * uv1.xy + uv1.zw));
	var color = select(vec4f(1.0), v.color, (flags & FX_HAS_COLORS) != 0u) * unpack4x8unorm(row.color);
	color.a *= fade_opacity(list_fade(entry));
	var normal = oct_decode(v.normal);
	let motion = fx_row(id, FX_OFFSET_MODE).x;
	if (motion == FX_MOTION_SOFT_BODY) {
		// a water sheet keeps the stack's two rows for its own values, and turns its normals too
		let sheet = fx_row(id, FX_UNFOGGED).y == FX_KIND_WATER_SHEET;
		let low = fx_row(id, select(FX_OFFSET_DIR, WS_SOFT_MIN, sheet));
		let range = fx_row(id, select(FX_OFFSET, WS_SOFT_RANGE, sheet));
		let body_uv = v.uv1 * uv1.xy + uv1.zw;
		let at = fx_soft_body_at(id, low.w, body_uv);
		p = fx_soft_body(low.xyz, range.xyz, at, p, body_uv);
		if (sheet) {
			normal = fx_soft_body_normal(at, range.w);
		}
	}
	var rel = m * p + origin;
	let pull = fx_row(id, FX_CAMERA_PULL).xy;
	// the pull is measured from the position before the offset, and added beside it
	let pulled = select(vec3f(0.0), fx_camera_pull(rel, pull.x), pull.y != 0.0);
	if (motion == FX_MOTION_OFFSET) {
		rel += fx_vertex_offset(id, m, normal, uv, color.a);
	}
	rel += pulled;
	var out: EffectOut;
	out.position = frame.view_proj * vec4f(rel, 1.0);
	out.rel = rel;
	out.normal = m * normal;
	out.tangent = vec4f(0.0);
	if ((flags & FX_HAS_TANGENTS) != 0u) {
		let sign = select(-1.0, 1.0, v.tangent.z >= 0.0) * select(-1.0, 1.0, determinant(m) >= 0.0);
		out.tangent = vec4f(m * oct_decode(v.tangent.xy), sign);
	}
	out.uv = uv;
	out.color = color;
	out.look = id;
	out.to_object0 = vec4f(inverse[0], -dot(inverse[0], origin));
	out.to_object1 = vec4f(inverse[1], -dot(inverse[1], origin));
	out.to_object2 = vec4f(inverse[2], -dot(inverse[2], origin));
	out.up = normalize(m[1]);
	out.origin = vec4f(origin, dot(origin, frame.view_forward.xyz));
	out.placement_color = vec4f(1.0);
	out.placement_uv = vec4f(1.0, 1.0, 0.0, 0.0);
	out.custom = row_custom(row);
	let placement = row_placement(row.block);
	if (placement != 0u) {
		let at = u32(i32(effect_blocks[row_block(row.block)].w) + i32(placement));
		out.placement_color = effect_placements[at][0];
		out.placement_uv = effect_placements[at][1];
	}
	return out;
}

// polar UVs of a point about the centre: the angle from +y as a fraction of a turn, and twice the distance
fn fx_polar(centred: vec2f) -> vec2f {
	return vec2f((atan2(centred.x, centred.y) + PI) / (2.0 * PI), 2.0 * length(centred));
}

// the UVs a texture slot can start from (`SlotSource` in effect-look.ts), with their screen gradients
struct FxBases {
	uv: array<vec2f, 4>,
	dx: array<vec2f, 4>,
	dy: array<vec2f, 4>,
}

// call in uniform control flow. the polar angle's gradient wraps, so its seam doesn't read as a whole turn and
// pick the smallest mip
fn fx_bases(uv0: vec2f, uv1: vec2f, polar: vec2f, screen: vec2f) -> FxBases {
	var pdx = dpdx(polar);
	var pdy = dpdy(polar);
	pdx.x -= round(pdx.x);
	pdy.x -= round(pdy.x);
	var b: FxBases;
	b.uv = array(uv0, uv1, polar, screen);
	b.dx = array(dpdx(uv0), dpdx(uv1), pdx, dpdx(screen));
	b.dy = array(dpdy(uv0), dpdy(uv1), pdy, dpdy(screen));
	return b;
}

// a slot's base UV and its gradients by its bits, zero when its source isn't computed
fn fx_slot_base(bases: FxBases, bits: u32) -> array<vec2f, 3> {
	if ((bits & SLOT_NO_BASE) != 0u) {
		return array(vec2f(0.0), vec2f(0.0), vec2f(0.0));
	}
	// arrays in a value can't be indexed by a variable
	var b = bases;
	let source = (bits >> SLOT_SOURCE_SHIFT) & 3u;
	return array(b.uv[source], b.dx[source], b.dy[source]);
}

// a slot's UVs: scrolled, rotated about the texture's centre, then its `_ST`
fn fx_slot_coords(id: u32, slot: u32, base: vec2f) -> vec2f {
	let anim = fx_row(id, FX_ANIM + slot);
	let st = fx_row(id, FX_UV + slot);
	let p = base + anim.xy * frame.eye.w - 0.5;
	let r = vec2f(anim.z * p.x - anim.w * p.y, anim.w * p.x + anim.z * p.y) + 0.5;
	return r * st.xy + st.zw;
}

// a base UV gradient carried through a slot's rotation and scale
fn fx_slot_gradient(id: u32, slot: u32, g: vec2f) -> vec2f {
	let anim = fx_row(id, FX_ANIM + slot);
	let st = fx_row(id, FX_UV + slot);
	return vec2f(anim.z * g.x - anim.w * g.y, anim.w * g.x + anim.z * g.y) * st.xy;
}

// explicit gradients keep sampling valid after the distortion and the branches
fn fx_sample(slot: u32, uv: vec2f, dx: vec2f, dy: vec2f) -> vec4f {
	switch slot {
		case 0u: {
			return textureSampleGrad(fx_tex0, fx_samp0, uv, dx, dy);
		}
		case 1u: {
			return textureSampleGrad(fx_tex1, fx_samp1, uv, dx, dy);
		}
		case 2u: {
			return textureSampleGrad(fx_tex2, fx_samp2, uv, dx, dy);
		}
		case 3u: {
			return textureSampleGrad(fx_tex3, fx_samp3, uv, dx, dy);
		}
		case 4u: {
			return textureSampleGrad(fx_tex4, fx_samp4, uv, dx, dy);
		}
		case 5u: {
			return textureSampleGrad(fx_tex5, fx_samp5, uv, dx, dy);
		}
		default: {
			return textureSampleGrad(fx_tex6, fx_samp6, uv, dx, dy);
		}
	}
}

// a texture stack slot's UV shift by the particle's custom data (VFXBaseV2's `*UVSpeed.zw`): the main texture's
// by its x, the sample textures' by its y
fn fx_custom_shift(id: u32, slot: u32, custom: vec4f) -> vec2f {
	let row = fx_row(id, FX_CUSTOM_SCROLL + slot / 2u);
	let scroll = select(row.xy, row.zw, slot % 2u == 1u);
	return scroll * select(custom.y, custom.x, slot == 0u);
}


const FX_KIND_WATER_SHEET = 1.0;
const WS_SOFT_MIN = 28u;
const WS_SOFT_RANGE = 29u;

// `EffectKind.Beam` (effect-look.ts), in FX_UNFOGGED's y
const FX_KIND_BEAM = 3.0;

// rows of a light beam's look (`BeamRow` in light-beam.ts, in vec4s)
const BM_COLOR = 0u;
const BM_CONE = 1u;
const BM_DIRECTION = 2u;
const BM_FALLOFF = 3u;
const BM_ALPHA = 4u;
const BM_GLARE = 5u;
const BM_FADE = 6u;
const BM_CLIP = 7u;
const BM_PLANE = 8u;
const BM_TILT = 9u;

// the beam's scale from its unit cone (the transform holds the rest): largest radius across, length along
fn beam_scale(id: u32) -> vec3f {
	let cone = fx_row(id, BM_CONE);
	let radius = max(max(cone.x, cone.y), 1e-6);
	return vec3f(radius, radius, fx_row(id, BM_FALLOFF).z);
}

// the cone mesh's vertex shaped into the beam: z squared along the length, the radius from start to end, and
// the side skewed along the beam's direction
fn beam_vertex(id: u32, p: vec3f) -> vec3f {
	let cone = fx_row(id, BM_CONE);
	let dir = fx_row(id, BM_DIRECTION);
	let scale = beam_scale(id);
	let z = p.z * p.z;
	var xy = p.xy * mix(cone.x, cone.y, z) / scale.x;
	xy += dir.xy * z * scale.z / (scale.xy * dir.z);
	return vec3f(xy, z);
}


// the near camera fade at a view depth: fades in from x to y metres and out from z to w
fn fx_near_fade(id: u32, depth: f32) -> f32 {
	if (fx_row(id, FX_MISC).x == 0.0) {
		return 1.0;
	}
	let near = fx_row(id, FX_NEAR);
	return saturate((depth - near.x) / (near.y - near.x)) * saturate((depth - near.z) / (near.w - near.z));
}

// the main pass's view depth at a pixel; the reversed-Z projection's depth is near / view depth
fn fx_scene_depth(px: vec2i) -> f32 {
	let d = textureLoad(fx_depth, px, 0);
	return select(1e9, frame.local_lights.w / d, d > 0.0);
}

// a premultiplied layer over the scene, fogged at its camera-relative position `rel` (drawn at `position`
// on screen) unless `unfogged` is set, for effects without fog of their own
fn fx_accumulate(premultiplied: vec3f, alpha: f32, rel: vec3f, position: vec2f, unfogged: f32)
	-> EffectAccumulated {
	if (unfogged > 0.5) {
		return EffectAccumulated(vec4f(premultiplied, alpha));
	}
	let fogged = fog_premultiplied(premultiplied, alpha, rel, position / frame.render_size.xy);
	return EffectAccumulated(vec4f(fogged, alpha));
}

// additive light over the scene, kept out of the fog: the game's additive effects fog themselves, if at all,
// by their own settings, which aren't read
fn fx_additive(light: vec3f) -> EffectAccumulated {
	return EffectAccumulated(vec4f(light, 0.0));
}

// a fragment that leaves the scene as it is
fn fx_nothing() -> EffectAccumulated {
	return EffectAccumulated(vec4f(0.0));
}


// unpacks the world normal from G-buffer B, or returns zero where nothing lit was drawn
fn fx_surface_normal(px: vec2i) -> vec3f {
	let gb = textureLoad(fx_surface, px, 0);
	if (!gbuffer_b_valid(gb)) {
		return vec3f(0.0);
	}
	return gbuffer_b_normal(gb);
}


// whether the surface under a pixel keeps lit decals off (`GBUFFER_NO_LIT_DECALS`), as the game's stencil test
fn fx_keeps_lit_decals_off(px: vec2i) -> bool {
	return gbuffer_b_no_lit_decals(textureLoad(fx_surface, px, 0));
}

// the main pass's roughness under a pixel (G-buffer B)
fn fx_surface_roughness(px: vec2i) -> f32 {
	return textureLoad(fx_surface, px, 0).b;
}


// an effect object's object → world basis (columns are its scaled axes), from its world → object rows
fn mist_basis(in: EffectOut) -> mat3x3f {
	return inverse3(transpose(mat3x3f(in.to_object0.xyz, in.to_object1.xyz, in.to_object2.xyz)));
}

// the camera-relative origin of an effect's object, from its world → object rows
fn mist_origin(in: EffectOut) -> vec3f {
	return -(mist_basis(in) * vec3f(in.to_object0.w, in.to_object1.w, in.to_object2.w));
}
