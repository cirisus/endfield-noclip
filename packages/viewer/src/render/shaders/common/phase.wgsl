// scattering phase functions. needs PI (brdf.wgsl)

// Henyey–Greenstein with anisotropy `g` at the cosine `mu` between the light's travel and the view ray, its
// denominator kept off zero for strongly forward lobes. the atmosphere's Mie phase (atmosphere.wgsl) is the same
// lobe without that floor
fn henyey_greenstein(g: f32, mu: f32) -> f32 {
	let x = 1.0 + g * g - 2.0 * g * mu;
	return (1.0 - g * g) / max(4.0 * PI * x * sqrt(x), 0.001);
}
