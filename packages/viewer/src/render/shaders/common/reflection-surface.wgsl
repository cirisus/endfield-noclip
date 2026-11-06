// what the screen-space reflections need of a surface, as the main pass writes it to `Shaded.reflection_surface`
// (frame.wgsl) and ssr.wgsl reads it back. needs octahedral.wgsl.
//
// x: octahedral normal · 0.5 + 0.5 in 12 bits each, perceptual roughness in the top 8; y: the screen-space
// reflection's weight (environment BRDF and specular occlusion) as the square root of each channel in 10 bits,
// bit 30 set, bit 31 `SURFACE_NO_LIT_DECALS`; 0 where there's no surface

struct ReflectionSurface {
	normal: vec3f,
	roughness: f32,
	// what a hit's radiance is multiplied by: environment BRDF and specular occlusion
	weight: vec3f,
	valid: bool,
}

// set in the packed surface's y where the material keeps `HGRP/DecalLit` decals off, as the game's stencil does
// (`keepsLitDecalsOff` in lit-look.ts)
const SURFACE_NO_LIT_DECALS = 1u << 31u;

fn pack_reflection_surface(n: vec3f, roughness: f32, weight: vec3f) -> vec2u {
	let e = vec2u(round(clamp(oct_encode(n) * 0.5 + 0.5, vec2f(0.0), vec2f(1.0)) * 4095.0));
	let r = u32(round(clamp(roughness, 0.0, 1.0) * 255.0));
	let w = vec3u(round(sqrt(clamp(weight, vec3f(0.0), vec3f(1.0))) * 1023.0));
	return vec2u(e.x | (e.y << 12u) | (r << 24u), w.x | (w.y << 10u) | (w.z << 20u) | (1u << 30u));
}

fn unpack_reflection_surface(packed: vec2u) -> ReflectionSurface {
	var s: ReflectionSurface;
	s.valid = (packed.y & (1u << 30u)) != 0u;
	let e = vec2f(f32(packed.x & 0xfffu), f32((packed.x >> 12u) & 0xfffu)) / 4095.0;
	s.normal = oct_decode(e * 2.0 - 1.0);
	s.roughness = f32(packed.x >> 24u) / 255.0;
	let w = vec3f(f32(packed.y & 0x3ffu), f32((packed.y >> 10u) & 0x3ffu), f32((packed.y >> 20u) & 0x3ffu)) / 1023.0;
	s.weight = w * w;
	return s;
}
