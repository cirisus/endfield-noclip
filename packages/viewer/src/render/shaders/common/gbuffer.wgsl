// G-buffer normal, roughness and flags encoding shared by the geometry passes, decals, GTAO, SSR and deferred
// lighting. needs octahedral.wgsl.
//
// `gbuffer_b` (`rgb10a2unorm`):
//   rg: octahedral world normal · 0.5 + 0.5 (10 bits each)
//   b:  perceptual roughness (10 bits)
//   a:  2-bit flags / 3.0 — bit 0 (`GBUFFER_VALID`) set on lit surfaces, bit 1 (`GBUFFER_NO_LIT_DECALS`) set on
//       surfaces that reject `HGRP/DecalLit` and `VFXDecal` (stencil bit 32 in the game)
//
// `gbuffer_a.a` (`rgb10a2unorm`, 2 bits): shading model id (`SHADING_*`)

const SHADING_LIT = 0u;
const SHADING_FOLIAGE = 1u;
const SHADING_SUBSURFACE = 2u;
const SHADING_UNLIT = 3u;

const GBUFFER_VALID = 1u;
const GBUFFER_NO_LIT_DECALS = 2u;

fn pack_gbuffer_b(n: vec3f, roughness: f32, flags: u32) -> vec4f {
	let e = clamp(oct_encode(n) * 0.5 + 0.5, vec2f(0.0), vec2f(1.0));
	return vec4f(e, clamp(roughness, 0.0, 1.0), f32(flags & 3u) / 3.0);
}

fn gbuffer_b_flags(gb: vec4f) -> u32 {
	return u32(round(gb.a * 3.0));
}

fn gbuffer_b_valid(gb: vec4f) -> bool {
	return (gbuffer_b_flags(gb) & GBUFFER_VALID) != 0u;
}

fn gbuffer_b_no_lit_decals(gb: vec4f) -> bool {
	return (gbuffer_b_flags(gb) & GBUFFER_NO_LIT_DECALS) != 0u;
}

fn gbuffer_b_normal(gb: vec4f) -> vec3f {
	return oct_decode(gb.rg * 2.0 - 1.0);
}

fn gbuffer_shading_model(ga: vec4f) -> u32 {
	return u32(round(ga.a * 3.0));
}
