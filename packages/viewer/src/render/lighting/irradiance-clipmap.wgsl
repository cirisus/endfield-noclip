// the irradiance clipmaps' layout (see irradiance-volume.ts), shared by the update pass and the lighting. the three
// levels stack along z in one A and one B texture so the frame binds two textures rather than six. each level
// takes a slab of 128 slices plus a copy of its last slice before them and of its first after them, so A
// filters across its z wrap as a repeating sampler would; x and y wrap or clamp in the sampler itself

// texels per level
const IRRADIANCE_TEXELS = vec3f(128.0, 64.0, 128.0);
// slices per level's slab, wrapped copies included, and in the stacked textures
const IRRADIANCE_SLAB = 130.0;
const IRRADIANCE_DEPTH = 390.0;

// the stacked textures' z for a level's z in [0, 1)
fn irradiance_z(level: i32, z: f32) -> f32 {
	return (f32(level) * IRRADIANCE_SLAB + 1.0 + z * IRRADIANCE_TEXELS.z) / IRRADIANCE_DEPTH;
}

// the stacked textures' z for a level's z in [0, 1), clamped to its edge texels as a clamping sampler would
fn irradiance_z_clamped(level: i32, z: f32) -> f32 {
	let half = 0.5 / IRRADIANCE_TEXELS.z;
	return irradiance_z(level, clamp(z, half, 1.0 - half));
}
