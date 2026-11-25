// instanced meshes with the HGRP surface shaders (looks/, docs/game-data/materials.md): Lit and its
// layers, foliage, glass, matte paintings, erosion and VFXDitherAlpha, opaque, alpha-tested or
// alpha-blended. quantized positions, octahedral normals and tangents, UV sets 0 and 1 and vertex colours from
// the geometry blob; instances from this frame's visible list; draw parameters by the list entry's draw id,
// and the material's parameters by the draw's look slot (`LookRow` in look.ts lays them out).

struct Draw {
	// dequantization: position = offset.xyz + value · scale.xyz; offset.w = look flags (u32 bits)
	offset: vec4f,
	// w = the material's slot in `looks` (u32 bits)
	scale: vec4f,
	// UV sets 0 and 1: uv = value · xy + zw
	uv0: vec4f,
	uv1: vec4f,
}

// a material's parameters, `LOOK_FLOATS` in look.ts
struct Look {
	// linear tint, w = alpha-test threshold (negative without alpha testing)
	tint: vec4f,
	// UV transforms (uv · xy + zw) of the base colour, normal, mask, emissive, detail, parallax and parallax
	// noise slots
	slot_uv: array<vec4f, 7>,
	// roughness min, roughness max, metallic, normal scale
	surface: vec4f,
	// occlusion strength, f0, transmission, base colour brighter scale
	surface2: vec4f,
	// emissive colour (linear), w = how much the tint covers the base colour
	emissive: vec4f,
	// x = how little the albedo tints emission (1: not at all), y = the emission mask channel, z = 1 when
	// emission ignores the post exposure
	emissive2: vec4f,
	// the tri-channel mask's R, G and B: linear colour, strength. leaves: `_BLEND_COLOR` (`LeafBlendRow` in
	// lit-look.ts)
	mask_albedo: array<vec4f, 3>,
	// per mask channel (xyz): the roughness and metallic it blends toward, its contrast and offset.
	// `mask_offset.w` is 1 when the mask sits in the emissive slot
	mask_roughness: vec4f,
	mask_metallic: vec4f,
	mask_scale: vec4f,
	mask_offset: vec4f,
	// detail mode (0 colour overlay, 1 PBR), mask mode, normal intensity, PBR intensity
	detail: vec4f,
	// view depths where the detail starts and finishes fading, overlay brighter scale (transparent looks: 1 for
	// premultiplied blending), 1 when the surface keeps lit decals off
	detail2: vec4f,
	// overlay colour (linear), how much it covers
	detail_overlay: vec4f,
	// parallax depth, march steps, Fresnel power, pulse amplitude. without parallax or layer maps, this row and
	// the next hold `_EMISSIVE_ANIM`'s pulse (`emissive_pulse`)
	parallax: vec4f,
	// pulse phase per second, pulse phase per metre of the object's position, 1 when the glow ignores the post
	// exposure, pulse mean
	parallax2: vec4f,
	// bright colour, w = mask channel. with a vertex offset, this row and the next two hold its inputs
	// (`VertexOffsetRow` in lit-look.ts)
	parallax_color: vec4f,
	// dark colour
	parallax_dark: vec4f,
	// brightening near the player: outer radius, inner radius, strength
	parallax_bright: vec4f,
	// leaves (`leafParams` in lit-look.ts): how much the vertex AO shadows the sun, the fake directional
	// shadow's strength and power, 1 when the sun's N·L takes the vertex normal. Lit layers: the fuzzy shading's
	// core darkness, edge brightness, edge shadow range and offset. dithered VFXDitherAlpha (`DitherRow` in
	// special-looks.ts): the subsurface colour times its amount, the amount
	foliage: vec4f,
	// leaves: the vertex AO ranges fading transmission (xy: start, range) and subsurface (zw) in. Lit layers:
	// the fuzzy edge shadow's intensity, the dark and bright powers, the edge's normal strength. dithered
	// VFXDitherAlpha: the subsurface colour's share of the ambient light
	foliage_ao: vec4f,
	// leaves: subsurface intensity, 1 when transmission fades out with distance, canopy ramp intensity, 1 when
	// the ramp starts at the top
	foliage2: vec4f,
	// leaves: canopy ramp range, transition range, colour brighter scale, colour cover. dithered VFXDitherAlpha
	// (`DitherRow` in special-looks.ts): alpha scale, exponent, dither tiling, its `DitherFlags`.
	// trunks (`TrunkRow` in lit-look.ts): the ramp's range and transition range, vertex AO strength, ramp intensity
	canopy: vec4f,
	// leaves: canopy ramp colour (linear), then 1 for `_TwoSidedNormal`. trunks: the ramp's colour (linear)
	canopy_color: vec4f,
	// the HDR colours the emissive map's G, B and A add (rgb); effect looks use these rows and the rest for
	// their own (`EffectRow` in effects/effect-look.ts)
	emissive_channels: array<vec4f, 3>,
	// the per-draw albedo tint where the emission's strength is at least 0.1: linear colour, w = weight
	emissive_albedo: vec4f,
	effect_only: array<vec4f, 12>,
}

const BASE_MAP = 1u;
const NORMAL_MAP = 2u;
const MASK_MAP = 4u;
const EMISSIVE_MAP = 8u;
const NORMAL_RAG = 16u;
const NORMAL_ROUGHNESS = 32u;
const FOLIAGE = 64u;
const METALLIC_BASE_ALPHA = 128u;
const NORMAL_OCCLUSION = 256u;
const EMISSIVE_MASK = 2048u;
const UNLIT = 4096u;
const ALPHA_NORMAL = 8192u;
const TRI_CHANNEL_MASK = 16384u;
const DETAIL_MAP = 32768u;
const PARALLAX_MAP = 65536u;
const PARALLAX_NOISE_MAP = 131072u;
// `HGRP/Erosion` (`erosionLook` in special-looks.ts)
const EROSION = 33554432u;
// `HGRP/Foliage/Leaf` (`leafParams` in lit-look.ts)
const FOLIAGE_LEAF = 134217728u;
// a scene effect, drawn by effect.wgsl; its rows are laid out by looks/effects/
const EFFECT = 268435456u;
// `_USE_VERTOFFSET` (`vertexOffsetParams` in lit-look.ts): the parallax slots hold the vertex offset's texture
// and its mask, which the vertex stage samples
const VERTEX_OFFSET = 536870912u;
// `HGRP/Foliage/Trunk`'s `_FOLIAGE_TRUNK` (`trunkParams` in lit-look.ts): the canopy rows hold its vertex AO
// and ramp
const TRUNK = 1073741824u;
// `_LAYERBLEND_TOP` or `_LAYERBLEND_MASK` (`layerBlendParams` in lit-look.ts): the parallax slots and rows hold
// the layer, and a mask map sits in the emissive slot
const LAYER_BLEND = 2147483648u;
// what decides the layer's coverage (`LayerSource` in lit-look.ts)
const LAYER_SOURCE_TOP = 0.0;
const LAYER_SOURCE_MASK_MAP = 1.0;
// slot i samples UV set 1 when bit UV1_SHIFT + i is set
const UV1_SHIFT = 18u;
// set per draw from the geometry's streams (`GeometryFlags` in look.ts)
const HAS_NORMALS = 512u;
const HAS_TANGENTS = 1024u;
const HAS_COLORS = 67108864u;

// the bits of a dithered look's `canopy.w` (`DitherFlags` in special-looks.ts)
const DITHER_RED_ALPHA = 1u;
const DITHER_VERTEX_COLOR = 2u;
const DITHER_MASK = 4u;
const DITHER_MASK_RED = 8u;
const DITHER_SURFACE = 16u;
const DITHER_ALPHA_COLOR = 32u;

const BASE_SLOT = 0u;
const NORMAL_SLOT = 1u;
const MASK_SLOT = 2u;
const EMISSIVE_SLOT = 3u;
const DETAIL_SLOT = 4u;
const PARALLAX_SLOT = 5u;
const NOISE_SLOT = 6u;
// the layer's `_Layer1BaseMap`; `_Layer1BumpMap` is in the noise slot, with the same coordinates
const LAYER_SLOT = 5u;

@group(1) @binding(0) var<storage, read> rows: array<InstanceRow>;
@group(1) @binding(1) var<storage, read> blocks: array<vec4f>;
@group(1) @binding(2) var<storage, read> list: array<u32>;
@group(1) @binding(4) var<storage, read> cloth_skeletons: array<vec4f>;
@group(2) @binding(0) var<storage, read> draws: array<Draw>;
// per visible-list entry: its index into `draws`
@group(2) @binding(1) var<storage, read> draw_ids: array<u32>;
// written once per material, when it's first drawn
@group(2) @binding(5) var<storage, read> looks: array<Look>;

// a draw's index into `looks`
fn look_slot(draw: Draw) -> u32 {
	return bitcast<u32>(draw.scale.w);
}
@group(3) @binding(0) var base_map: texture_2d<f32>;
@group(3) @binding(1) var normal_map: texture_2d<f32>;
@group(3) @binding(2) var mask_map: texture_2d<f32>;
@group(3) @binding(3) var emissive_map: texture_2d<f32>;
@group(3) @binding(4) var detail_map: texture_2d<f32>;
@group(3) @binding(5) var parallax_map: texture_2d<f32>;
@group(3) @binding(6) var parallax_noise_map: texture_2d<f32>;
@group(3) @binding(7) var base_sampler: sampler;
@group(3) @binding(8) var detail_sampler: sampler;
@group(3) @binding(9) var parallax_sampler: sampler;
// the noise slot's own sampler, for the vertex offset's mask and a dithered look's; the glow and the layers
// sample the slot with the parallax slot's
@group(3) @binding(10) var noise_sampler: sampler;

struct VertexIn {
	@location(0) position: vec4f,
	@location(1) normal: vec2f,
	@location(2) uv0: vec2f,
	@location(4) uv1: vec2f,
	// octahedral tangent, z = bitangent sign; zero without tangents
	@location(3) tangent: vec4f,
	@location(5) color: vec4f,
}

struct VertexOut {
	// alpha-tested meshes are shaded where their depth equals that of an earlier pass with another pipeline
	@builtin(position) @invariant position: vec4f,
	@location(0) rel: vec3f,
	@location(1) normal: vec3f,
	// w = bitangent sign, 0 without a tangent
	@location(2) tangent: vec4f,
	// dequantized UV sets 0 and 1
	@location(3) uv: vec4f,
	@location(4) @interpolate(flat) draw: u32,
	// the sum of the object's world position components, which offsets the parallax pulse
	@location(5) @interpolate(flat) phase: f32,
	// the object-space position, along which erosion flow bands and ripples run
	@location(6) object_pos: vec3f,
	// the vertex colour, white for meshes without one
	@location(7) color: vec4f,
	// the camera-relative object origin, which the leaves' transmission fades out by
	@location(8) @interpolate(flat) origin: vec3f,
	// transition fade code from `list_fade` (0 = opaque)
	@location(9) @interpolate(flat) fade: u32,
	// 1 when the instance matrix has a negative determinant (inverted triangle winding)
	@location(10) @interpolate(flat) mirrored: u32,
}

@vertex
fn vs_main(v: VertexIn, @builtin(instance_index) ii: u32) -> VertexOut {
	let entry = list[ii];
	let row = rows[list_row(entry)];
	let draw_id = draw_ids[ii];
	let draw = draws[draw_id];
	let look = looks[look_slot(draw)];
	let p = draw.offset.xyz + v.position.xyz * draw.scale.xyz;
	let origin = vec3f(row.t0.w, row.t1.w, row.t2.w) + blocks[row_block(row.block)].xyz;
	let m = row_basis(row.t0, row.t1, row.t2, row.info);
	let mirrored = determinant(m) < 0.0;
	let flags = bitcast<u32>(draw.offset.w);
	let uv = vec4f(v.uv0 * draw.uv0.xy + draw.uv0.zw, v.uv1 * draw.uv1.xy + draw.uv1.zw);
	if ((flags & EROSION) != 0u && look.emissive2.w > 1.5) {
		let sv = sludge_vertex(uv.xy, origin, m, look);
		var out: VertexOut;
		if (sv.discarded) {
			out.position = vec4f(0.0, 0.0, 0.0, 0.0);
			return out;
		}
		out.position = frame.view_proj * vec4f(sv.rel, 1.0);
		out.rel = sv.rel;
		out.normal = sv.normal;
		out.tangent = sv.tangent;
		out.uv = uv;
		out.draw = draw_id;
		out.phase = 0.0;
		out.object_pos = p;
		out.color = sv.color;
		out.origin = origin;
		out.fade = list_fade(entry);
		out.mirrored = select(0u, 1u, mirrored);
		return out;
	}
	// as vs_cutout_depth computes it, so alpha-tested depth matches exactly where they're shaded
	let rel = instance_rel(v.position, v.color, ii, draw, look) + vertex_offset(flags, look, m, uv, v.position.w);
	// no normals in the mesh: zero here, faceted in the fragment shader
	var n = vec3f(0.0);
	if ((flags & HAS_NORMALS) != 0u) {
		// strictly the inverse transpose; scenery is scaled close to uniformly, so the matrix does once
		// renormalized
		n = m * oct_decode(v.normal);
	}
	var t = vec4f(0.0);
	if ((flags & HAS_TANGENTS) != 0u) {
		let sign = select(-1.0, 1.0, v.tangent.z >= 0.0) * select(1.0, -1.0, mirrored);
		t = vec4f(m * oct_decode(v.tangent.xy), sign);
	}
	let world = origin + frame.eye.xyz;
	var out: VertexOut;
	out.position = frame.view_proj * vec4f(rel, 1.0);
	out.rel = rel;
	out.normal = n;
	out.tangent = t;
	out.uv = sheet_uv(row.sheet, uv);
	out.draw = draw_id;
	out.phase = world.x + world.y + world.z;
	out.object_pos = p;
	out.color = select(vec4f(1.0), v.color, (flags & HAS_COLORS) != 0u) * unpack4x8unorm(row.color);
	out.origin = origin;
	out.fade = list_fade(entry);
	out.mirrored = select(0u, 1u, mirrored);
	return out;
}

// the depth-only stages read only the streams they need, so they bind fewer vertex buffers per geometry:
// positions (plus vertex colour for GPU cloth bone indices) for opaque shadow casters, plus the UV sets for
// alpha-tested depth
struct DepthIn {
	@location(0) position: vec4f,
	@location(5) color: vec4f,
}

struct CutoutDepthIn {
	@location(0) position: vec4f,
	@location(2) uv0: vec2f,
	@location(4) uv1: vec2f,
	@location(5) color: vec4f,
}

const ROW_CLOTH = 8u;

fn cloth_bone_pos(bone: u32, p: vec4f) -> vec3f {
	let base = bone * 3u;
	return vec3f(
		dot(cloth_skeletons[base], p),
		dot(cloth_skeletons[base + 1u], p),
		dot(cloth_skeletons[base + 2u], p),
	);
}

// `_GPU_CLOTH` vertex skinning (`docs/game-data/materials.md#cloth-simulation`): vertex colour R/G index into
// the simulated cloth's bone matrices (`B` blends two bones for ≤256-node cloths; `R * 256 + G` for larger
// single-skeleton cloths)
fn cloth_skin(p: vec3f, color: vec4f, row: InstanceRow) -> vec3f {
	if ((row.info & ROW_CLOTH) == 0u) {
		return p;
	}
	let offset = row.custom.x;
	let p4 = vec4f(p, 1.0);
	let r = u32(round(color.r * 255.0));
	let g = u32(round(color.g * 255.0));
	if (row.custom.y != 0u) {
		return cloth_bone_pos(offset + r * 256u + g, p4);
	}
	let a = cloth_bone_pos(offset + r, p4);
	let b = cloth_bone_pos(offset + g, p4);
	return mix(a, b, color.b);
}

// the camera-relative position of a vertex of list entry `ii`; `position.w` is the geometry's sway weight
fn instance_rel(position: vec4f, color: vec4f, ii: u32, draw: Draw, look: Look) -> vec3f {
	let row = rows[list_row(list[ii])];
	let p = cloth_skin(draw.offset.xyz + position.xyz * draw.scale.xyz, color, row);
	let origin = vec3f(row.t0.w, row.t1.w, row.t2.w) + blocks[row_block(row.block)].xyz;
	let rel = row_basis(row.t0, row.t1, row.t2, row.info) * p + origin;
	let flags = bitcast<u32>(draw.offset.w);
	return rel + grass_lean(flags, look, p.y) + sway(flags, look, p, position.w, rel, origin);
}

// `_SIMPLE_VERTEXANIM`'s world-space offset (`swayParams` in lit-look.ts,
// docs/game-data/materials.md#swaying-cloth). `weight` is the vertex colour's alpha, which the geometry carries
// in position W
fn sway(flags: u32, look: Look, p: vec3f, weight: f32, rel: vec3f, origin: vec3f) -> vec3f {
	let intensity = look.foliage2.x;
	if (weight == 0.0 || intensity == 0.0 || (flags & (FOLIAGE | EROSION | UNLIT | EFFECT)) != 0u) {
		return vec3f(0.0);
	}
	let frequency = look.foliage2.y;
	let along = select(frame.wind.zw, look.canopy_color.zw, look.canopy_color.y > 0.5);
	let x0 = origin.x + frame.eye.x;
	let phase = frame.wind.x * frequency + x0;
	if (look.canopy.x > 0.5) {
		return pendulum(look, weight, rel - origin, along, phase, x0);
	}
	let softness = look.foliage2.z;
	let kite = look.foliage2.w;
	let tendency = look.canopy_color.x;
	var s: f32;
	var amplitude: f32;
	if (kite != 0.0) {
		amplitude = intensity * 0.05;
		s = sin(phase + mix(0.0, p.y * softness - weight * PI, kite)) * p.y;
	} else {
		amplitude = intensity * 0.5;
		s = sin(phase - (rel.z + frame.eye.z) * softness - weight * 3.14);
	}
	let offset = (s + 1.0 + tendency) * amplitude * weight;
	return vec3f(along.x, 0.0, along.y) * offset;
}

// `_SIMPLE_VERTEXANIM_PENDULUM`'s offset (docs/game-data/materials.md#swinging-pendulums): the vertex at `v`
// from the object's origin swings about an axis across `along`, then turns about +Y, both by sines of the
// wind clock with the object's world X `x0` as their phase; `phase` is the swing's
fn pendulum(look: Look, weight: f32, v: vec3f, along: vec2f, phase: f32, x0: f32) -> vec3f {
	let intensity = look.foliage2.x;
	// the game's axis from its direction (x, 0, z) is (0 − z, −x, x), which still air leaves undefined
	let across = vec3f(-along.y, -along.x, along.x);
	var swung = v;
	if (dot(across, across) > 1e-12) {
		swung = rotate_about(normalize(across), sin(phase) * intensity * 0.05, v);
	}
	let spin = sin(frame.wind.x * look.foliage2.w + x0) * look.canopy_color.x;
	let turned = rotate_about(vec3f(0.0, 1.0, 0.0), spin, swung);
	let follow = mix(weight * intensity * 0.5, 1.0, look.foliage2.z);
	return (turned - v) * follow * weight;
}

// `v` turned by `angle` radians about the unit `axis` (Rodrigues)
fn rotate_about(axis: vec3f, angle: f32, v: vec3f) -> vec3f {
	let c = cos(angle);
	return v * c + cross(axis, v) * sin(angle) + axis * dot(axis, v) * (1.0 - c);
}

// `_USE_VERTOFFSET`'s world-space offset (`vertexOffsetParams` in lit-look.ts,
// docs/game-data/materials.md#vertex-offset): along a direction by a scrolling texture's red, scaled by a
// mask's. `basis` is the object's transform, `uv` the mesh's UV sets before the sheet remap, and `weight` the
// vertex colour's alpha, which the geometry carries in position W. only alpha-tested draws are offset, since
// only their depth and shadow passes read the UV sets and textures (vs_cutout_depth): a look's draws are
// alpha-tested exactly while the map holding its alpha is bound. the offset waits for its own textures too
fn vertex_offset(flags: u32, look: Look, basis: mat3x3f, uv: vec4f, weight: f32) -> vec3f {
	let alpha_map = select(BASE_MAP, NORMAL_MAP, (flags & ALPHA_NORMAL) != 0u);
	let needed = VERTEX_OFFSET | PARALLAX_MAP | alpha_map;
	let shape = look.parallax_dark;
	let masked = shape.w != 0.0;
	if ((flags & needed) != needed || (masked && (flags & PARALLAX_NOISE_MAP) == 0u)) {
		return vec3f(0.0);
	}
	let direction = look.parallax_color;
	let scroll = look.parallax_bright * frame.eye.w;
	// both textures sample one UV set, each through its own transform
	let source = slot_set(uv, flags, PARALLAX_SLOT);
	let noise_t = look.slot_uv[PARALLAX_SLOT];
	let mask_t = look.slot_uv[NOISE_SLOT];
	let noise_uv = source * noise_t.xy + noise_t.zw + scroll.xy;
	let noise = textureSampleLevel(parallax_map, parallax_sampler, noise_uv, 0.0).r;
	var scale = shape.x * (noise * (1.0 + shape.y) - shape.y);
	if (masked) {
		let mask_uv = source * mask_t.xy + mask_t.zw + scroll.zw;
		let mask = textureSampleLevel(parallax_noise_map, noise_sampler, mask_uv, 0.0).r;
		scale *= 1.0 - shape.w * (1.0 - mask);
	}
	if (shape.z > 0.5) {
		scale *= weight;
	}
	return select(basis * direction.xyz, direction.xyz, direction.w > 0.5) * scale;
}

// `_USE_CAMERA_BASED_TILLING` (`grassParams` in lit-look.ts): grass leans away from the camera along its up
// vector flattened onto the ground, by the vertex's object-space height times the intensity in world metres
fn grass_lean(flags: u32, look: Look, height: f32) -> vec3f {
	if ((flags & (FOLIAGE | FOLIAGE_LEAF)) != FOLIAGE) {
		return vec3f(0.0);
	}
	return vec3f(frame.view_up.x, 0.0, frame.view_up.z) * (height * look.foliage.y);
}

@vertex
fn vs_depth(v: DepthIn, @builtin(instance_index) ii: u32) -> @builtin(position) @invariant vec4f {
	let draw = draws[draw_ids[ii]];
	let look = looks[look_slot(draw)];
	return frame.view_proj * vec4f(instance_rel(v.position, v.color, ii, draw, look), 1.0);
}

// the opaque depth prepass writes depth alone; the targets' write masks are 0
@fragment
fn fs_depth() {}

// depth prepass for opaque draws holding fading instances: kept separate from fs_depth so non-fading opaque
// draws keep early-Z
struct FadeDepthOut {
	@builtin(position) @invariant position: vec4f,
	@location(0) @interpolate(flat) fade: u32,
}

@vertex
fn vs_depth_fade(v: DepthIn, @builtin(instance_index) ii: u32) -> FadeDepthOut {
	let draw = draws[draw_ids[ii]];
	let look = looks[look_slot(draw)];
	var out: FadeDepthOut;
	out.position = frame.view_proj * vec4f(instance_rel(v.position, v.color, ii, draw, look), 1.0);
	out.fade = list_fade(list[ii]);
	return out;
}

@fragment
fn fs_depth_fade(in: FadeDepthOut) {
	if (fade_discard(in.fade, in.position.xy)) {
		discard;
	}
}

// what fs_cutout_depth reads, at VertexOut's locations so vs_main can feed it too
struct CutoutDepthVaryings {
	@builtin(position) position: vec4f,
	@location(3) uv: vec4f,
	@location(4) @interpolate(flat) draw: u32,
	@location(7) color: vec4f,
	@location(9) @interpolate(flat) fade: u32,
}

struct CutoutDepthOut {
	@builtin(position) @invariant position: vec4f,
	@location(3) uv: vec4f,
	@location(4) @interpolate(flat) draw: u32,
	// the instance's colour (a particle's), without the mesh's vertex colours, whose stream these passes don't bind
	@location(7) color: vec4f,
	@location(9) @interpolate(flat) fade: u32,
}

@vertex
fn vs_cutout_depth(v: CutoutDepthIn, @builtin(instance_index) ii: u32) -> CutoutDepthOut {
	let draw_id = draw_ids[ii];
	let draw = draws[draw_id];
	let look = looks[look_slot(draw)];
	let entry = list[ii];
	let row = rows[list_row(entry)];
	let m = row_basis(row.t0, row.t1, row.t2, row.info);
	let flags = bitcast<u32>(draw.offset.w);
	let uv = vec4f(v.uv0 * draw.uv0.xy + draw.uv0.zw, v.uv1 * draw.uv1.xy + draw.uv1.zw);
	if ((flags & EROSION) != 0u && look.emissive2.w > 1.5) {
		let origin = vec3f(row.t0.w, row.t1.w, row.t2.w) + blocks[row_block(row.block)].xyz;
		let sv = sludge_vertex(uv.xy, origin, m, look);
		var out: CutoutDepthOut;
		out.position = select(frame.view_proj * vec4f(sv.rel, 1.0), vec4f(0.0, 0.0, 0.0, 0.0), sv.discarded);
		out.uv = uv;
		out.draw = draw_id;
		out.color = vec4f(1.0);
		out.fade = list_fade(entry);
		return out;
	}
	// as vs_main computes it
	let rel = instance_rel(v.position, v.color, ii, draw, look) + vertex_offset(flags, look, m, uv, v.position.w);
	var out: CutoutDepthOut;
	out.position = frame.view_proj * vec4f(rel, 1.0);
	out.uv = sheet_uv(row.sheet, uv);
	out.draw = draw_id;
	out.color = unpack4x8unorm(row.color);
	out.fade = list_fade(entry);
	return out;
}

// the UV set a slot samples, before its transform
fn slot_set(uv: vec4f, flags: u32, slot: u32) -> vec2f {
	return select(uv.xy, uv.zw, (flags & (1u << (UV1_SHIFT + slot))) != 0u);
}

// read through the buffer: arrays in a `let` copy can't be indexed by a variable
fn slot_uv(look_id: u32, uv: vec4f, flags: u32, slot: u32) -> vec2f {
	let t = looks[look_id].slot_uv[slot];
	return slot_set(uv, flags, slot) * t.xy + t.zw;
}

// samples a material slot with explicit screen-space derivatives (already scaled by exp2(bias)), so optional
// maps can be skipped in non-uniform control flow without changing mip selection
fn sample_slot(
	tex: texture_2d<f32>,
	samp: sampler,
	look_id: u32,
	uv: vec4f,
	uv0_dx: vec2f,
	uv0_dy: vec2f,
	uv1_dx: vec2f,
	uv1_dy: vec2f,
	flags: u32,
	slot: u32,
) -> vec4f {
	let use_uv1 = (flags & (1u << (UV1_SHIFT + slot))) != 0u;
	let t = looks[look_id].slot_uv[slot];
	let coords = select(uv.xy, uv.zw, use_uv1) * t.xy + t.zw;
	let dx = select(uv0_dx, uv1_dx, use_uv1) * t.xy;
	let dy = select(uv0_dy, uv1_dy, use_uv1) * t.xy;
	return textureSampleGrad(tex, samp, coords, dx, dy);
}


// true on a mesh's geometric front face: mirrored instances keep `FRONT_FACE` while inverting triangle
// winding, so `@builtin(front_facing)` is inverted for them
fn is_front_face(front_facing: bool, mirrored: u32) -> bool {
	return front_facing == (mirrored == 0u);
}

// shading normal before normal mapping: the vertex normal (flipped on back faces when `flip` is set), or the
// screen-space faceted normal (already facing the viewer) for meshes without vertex normals
fn surface_normal(vertex_normal: vec3f, faceted: vec3f, flip: bool) -> vec3f {
	if (dot(vertex_normal, vertex_normal) < 1e-6) {
		return normalize(faceted);
	}
	let n = normalize(vertex_normal);
	return select(n, -n, flip);
}

// a shader that may discard loses early depth and, on tile-based GPUs, hidden-surface removal, so only the
// depth passes of alpha-tested materials discard (fs_cutout_depth). their shading runs fs_opaque where the
// depth matches.


// a VFXDitherAlpha look's `DitherFlags`, 0 on other looks: only leaves and trunks, which have their own flags,
// fill the canopy row otherwise
fn dither_bits(look: Look, flags: u32) -> u32 {
	return select(u32(look.canopy.w), 0u, (flags & (FOLIAGE | FOLIAGE_LEAF | TRUNK)) != 0u);
}

// a dithered look's alpha before its mask, saturation and power: the tested texture's alpha (or red) times the
// alpha scale, the vertex alpha and the near camera fade, at a view depth
fn dither_alpha(look: Look, bits: u32, texel: vec4f, vertex_alpha: f32, depth: f32) -> f32 {
	var alpha = select(texel.a, texel.r, (bits & DITHER_RED_ALPHA) != 0u) * look.canopy.x;
	if ((bits & DITHER_VERTEX_COLOR) != 0u) {
		alpha *= vertex_alpha;
	}
	// the near camera fade: in over the first range of view depths, out over the second
	let near = look.canopy_color;
	if (any(near != vec4f(0.0))) {
		alpha *= saturate((depth - near.x) / (near.y - near.x)) * saturate((depth - near.z) / (near.w - near.z));
	}
	return alpha;
}

// what multiplies a VFXDitherAlpha look's colour: the vertex colour, a particle's, under
// `DitherFlags.VertexColor`; 1 on other looks
fn dither_vertex_color(look: Look, flags: u32, color: vec4f) -> vec3f {
	return select(vec3f(1.0), color.rgb, (dither_bits(look, flags) & DITHER_VERTEX_COLOR) != 0u);
}


struct SludgeVertex {
	rel: vec3f,
	normal: vec3f,
	tangent: vec4f,
	color: vec4f,
	discarded: bool,
}

// `HGRP/SludgeV2` vertex displacement (`SludgeRow` in special-looks.ts): samples the patch's 64×64 BC7
// heightmap (rg octahedral normal, b height, a coverage), clips empty/outside cells, and adds animated waves
fn sludge_vertex(uv: vec2f, origin: vec3f, m: mat3x3f, look: Look) -> SludgeVertex {
	var out: SludgeVertex;
	out.discarded = true;
	let hm = textureSampleLevel(parallax_noise_map, noise_sampler, uv, 0.0);
	let h = hm.z;
	if (h < 1e-6) {
		return out;
	}
	let sludge_size = max(look.emissive2.x, 1e-4);
	let size_y = max(look.emissive2.y, 1e-4);
	var local = vec3f(uv.x * sludge_size, h * size_y, uv.y * sludge_size);
	let clip0 = look.mask_scale;
	let clip1 = look.mask_offset;
	if (dot(clip0, vec4f(local, 1.0)) < 0.0 || dot(clip1, vec4f(local, 1.0)) < 0.0) {
		return out;
	}
	// octahedral normal decode matching `HGRP/SludgeV2`
	let e = hm.xy * 2.0 - 1.0;
	let ny = 1.0 - abs(e.x) - abs(e.y);
	var ln = vec3f(e.x, ny, e.y);
	if (ny < 0.0) {
		let folded = (1.0 - abs(ln.zx)) * select(vec2f(-1.0), vec2f(1.0), ln.xz >= vec2f(0.0));
		ln = vec3f(folded.x, ny, folded.y);
	}
	ln = normalize(ln);

	let coverage = hm.w;
	let center = vec3f(sludge_size * 0.5, size_y * 0.5, sludge_size * 0.5);
	let cov2 = coverage * 2.0;
	let wave_phase = look.parallax2 * distance(local, center) - look.parallax_color * frame.eye.w;
	let wave_amp = look.parallax * vec4f(saturate(cov2 - 1.0), saturate(cov2), 0.1, 0.0);
	let wave_y = dot(sin(wave_phase) + vec4f(1.0), wave_amp);
	var wave_xz = normalize(local - center + vec3f(1e-6)) * dot(cos(wave_phase) + vec4f(1.0), wave_amp);
	wave_xz.y = 0.0;
	local.y += wave_y;
	let anim_n = ln + wave_xz;
	local += anim_n * look.surface2.z;
	local += clip0.xyz * max(-dot(clip0, vec4f(local, 1.0)), 0.0);
	local += clip1.xyz * max(-dot(clip1, vec4f(local, 1.0)), 0.0);

	let right_u = m[0] / sludge_size;
	let up_u = m[1] / size_y;
	let fwd_u = m[2] / sludge_size;
	let world_n = normalize(right_u * anim_n.x + up_u * anim_n.y + fwd_u * anim_n.z);
	out.rel = origin + right_u * local.x + up_u * local.y + fwd_u * local.z;
	out.normal = world_n;
	out.tangent = vec4f(normalize(cross(world_n, fwd_u) + vec3f(1e-6)), 1.0);
	out.color = vec4f(coverage, 1.0 - wave_y, 0.0, 1.0);
	out.discarded = false;
	return out;
}


// the depth of alpha-tested materials, in the main pass and the shadow passes (opaque ones have no fragment
// stage there). only drawn for materials with an alpha-test threshold whose alpha texture is bound (`cutout`
// in look.ts and MeshRenderer.prepare). a negative threshold marks VFXDitherAlpha's dithered test
// (`DitherRow` in special-looks.ts), which keeps a fraction of the pixels equal to the scaled alpha
@fragment
fn fs_cutout_depth(in: CutoutDepthVaryings) {
	if (fade_discard(in.fade, in.position.xy)) {
		discard;
	}
	let draw = draws[in.draw];
	let flags = bitcast<u32>(draw.offset.w);
	let id = look_slot(draw);
	let look = looks[id];
	let gradient_scale = exp2(frame.params.y);
	let uv0_dx = dpdx(in.uv.xy) * gradient_scale;
	let uv0_dy = dpdy(in.uv.xy) * gradient_scale;
	let uv1_dx = dpdx(in.uv.zw) * gradient_scale;
	let uv1_dy = dpdy(in.uv.zw) * gradient_scale;
	if ((flags & EROSION) != 0u && look.emissive2.w > 1.5) {
		return;
	}
	var texel: vec4f;
	if ((flags & ALPHA_NORMAL) != 0u) {
		texel = sample_slot(normal_map, detail_sampler, id, in.uv, uv0_dx, uv0_dy, uv1_dx, uv1_dy, flags, NORMAL_SLOT);
	} else {
		texel = sample_slot(base_map, base_sampler, id, in.uv, uv0_dx, uv0_dy, uv1_dx, uv1_dy, flags, BASE_SLOT);
	}
	if (look.tint.w < 0.0) {
		let dither = look.canopy;
		let bits = u32(dither.w);
		var scaled = dither_alpha(look, bits, texel, in.color.a, 1.0 / in.position.w);
		if ((bits & DITHER_MASK) != 0u) {
			let masking = sample_slot(
				parallax_noise_map,
				noise_sampler,
				id,
				in.uv,
				uv0_dx,
				uv0_dy,
				uv1_dx,
				uv1_dy,
				flags,
				NOISE_SLOT,
			);
			scaled *= select(masking.a, masking.r, (bits & DITHER_MASK_RED) != 0u);
		}
		let alpha = pow(saturate(scaled), dither.y);
		// the pattern moves each frame, so the temporal antialiasing resolves the surviving pixels into coverage
		if (alpha - gradient_noise(in.position.xy * dither.z + frame.params.w) < 1e-5) {
			discard;
		}
	} else if (texel.a < look.tint.w) {
		discard;
	}
}

