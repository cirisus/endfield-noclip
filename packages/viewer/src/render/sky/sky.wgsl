// the sky, atmosphere fog and height fog as the composite and water passes apply them. needs
// post-common.wgsl and atmosphere.wgsl.

// the fog as the game's deferred lighting and sky apply it (docs/game-data/sky-and-fog.md#fog): the
// atmosphere fog, then the two-layer height fog, in the game's own units, with the volumetric fog
// (volumetric-fog.wgsl) in front when it's on. the froxels then cover the ray out to the fog's distance in
// view depth, and the height fog only what lies beyond.

// the volumetric fog integrated up to each slice: scattered light (rgb) and transmittance (a)
@group(1) @binding(5) var froxel_texture: texture_3d<f32>;

// one height-fog layer's density along a ray from `base_y`, per metre of ray: Unreal's base-2 form of the
// line integral, with its series near zero
fn fog_layer_density(layer: vec4f, base_y: f32, delta_y: f32) -> f32 {
	let x = max(-127.0, layer.y * delta_y);
	var integral = 0.693147182 - 0.240226507 * x;
	if (abs(x) > 5.96e-8) {
		integral = (1.0 - exp2(-x)) / x;
	}
	return layer.x * exp2(-max(-127.0, layer.y * (base_y - layer.z))) * integral;
}

struct Fog {
	// what the colour behind is multiplied by
	transmittance: vec3f,
	// what's added in front
	inscatter: vec3f,
}

// the volumetric fog in front of a point
struct Froxels {
	// scattered light (rgb) and transmittance (a)
	light: vec4f,
	// view depth (m) the froxels cover, which the height fog leaves out
	covered: f32,
}

// for rays the froxel grid doesn't hold (reflections): the height fog all the way
const NO_FROXELS = Froxels(vec4f(0.0, 0.0, 0.0, 1.0), 0.0);

// the volumetric fog in front of something `depth` metres of view depth away, at `uv` on screen
fn froxels_at(uv: vec2f, depth: f32) -> Froxels {
	if (post.froxel_slices.w <= 0.0) {
		return NO_FROXELS;
	}
	// as in the game, nothing nearer than the start distance
	if (depth < post.froxel_range.x) {
		return Froxels(vec4f(0.0, 0.0, 0.0, 1.0), post.froxel_slices.w);
	}
	let w = log2(depth * post.froxel_slices.x + post.froxel_slices.y) * post.froxel_slices.z;
	return Froxels(textureSampleLevel(froxel_texture, lut_sampler, vec3f(uv, w), 0.0), post.froxel_slices.w);
}

// the fog between the camera and something `distance` metres along unit `direction`
fn fog_over(direction: vec3f, distance: f32, froxels: Froxels) -> Fog {
	var fog = Fog(vec3f(1.0), vec3f(0.0));
	let point_y = post.eye.y + direction.y * distance;

	// atmosphere fog: density e^((start height − y) / H), integrated from the camera's height
	var atmosphere = vec3f(1.0);
	if (post.flags.z != 0u && post.sky_fog.y > 0.5) {
		let below = -point_y * post.atmo_mie.w;
		let a = max(0.01, below + post.eye.y * post.atmo_mie.w);
		let depth = max(0.0, distance * post.atmo_rayleigh.w - post.atmo_extinction.w) * ((1.0 - exp(-a)) / a) *
			exp(below + post.atmo_ambient.w);
		atmosphere = exp(-post.atmo_extinction.rgb * depth);
		let mu = dot(direction, post.atmo_sun.xyz);
		let g = post.atmo_sun.w;
		let hg_base = 1.0 + g * g - 2.0 * g * mu;
		let hg = (1.0 - g * g) / max(4.0 * PI * hg_base * sqrt(hg_base), 0.001);
		let rayleigh = 3.0 / (16.0 * PI) * (1.0 + mu * mu);
		let scattered = clamp(post.atmo_rayleigh.rgb * rayleigh + post.atmo_ambient.rgb + post.atmo_mie.rgb * hg,
			vec3f(0.0), vec3f(255.0));
		fog = Fog(atmosphere, scattered * (vec3f(1.0) - atmosphere));
	}

	// height fog: fades in past the start distance and out past the cutoff, each over 1 / transition metres.
	// it integrates only the part of the ray past the froxels (a negative length leaves it clear); the ramps
	// and the opacity cap still measure the whole distance
	if (post.flags.y != 0u) {
		let cosine = dot(direction, post.forward.xyz);
		var covered = 0.0;
		if (cosine > 5.96e-8) {
			covered = froxels.covered / cosine / distance;
		}
		let delta_y = direction.y * distance;
		let base_y = post.eye.y + covered * delta_y;
		let rest_y = delta_y * (1.0 - covered);
		let rest = distance * (1.0 - covered);
		let density = fog_layer_density(post.fog_layer0, base_y, rest_y) +
			fog_layer_density(post.fog_layer1, base_y, rest_y);
		let range = post.fog_range;
		let before_start = clamp((range.x - distance) * range.y, 0.0, 1.0);
		let past_cutoff = clamp((distance - range.z) * range.w, 0.0, 1.0);
		let t = clamp(max(clamp(exp2(-density * rest), 0.0, 1.0), post.fog_color.w) + before_start + past_cutoff,
			0.0, 1.0);
		let toward_light = clamp(dot(direction, post.fog_directional_direction.xyz), 0.0, 1.0);
		let directional_depth = density * max(rest - post.fog_directional_direction.w, 0.0);
		let directional = post.fog_directional.rgb * pow(toward_light, post.fog_directional.w) *
			(1.0 - clamp(exp2(-directional_depth), 0.0, 1.0)) * (1.0 - past_cutoff);
		fog = Fog(fog.transmittance * t, fog.inscatter * t + post.fog_color.rgb * (1.0 - t) + directional);
	}
	// the froxels add in front of both
	let light = froxels.light;
	return Fog(fog.transmittance * light.a, fog.inscatter * light.a + light.rgb);
}

// the atmosphere's sky along a direction; the cloud panorama and what lies beyond the atmosphere go over it in
// celestial.wgsl
fn sky_radiance(direction: vec3f) -> vec3f {
	if (post.flags.x == 0u) {
		return vec3f(0.0);
	}
	// the game's LUT scale (its outer sun colour, exposed sun and procedural sky lux factor); it fades the LUT out
	// just below the horizon
	return sky_view(direction) * post.sky_illuminance.rgb * clamp(1.0 + direction.y * 10.0, 0.0, 1.0);
}

// #region transparent layers

// the transparent pass's layers at a pixel (`TRANSPARENT_TARGETS` in render-targets.ts), as the composite and
// water passes lay them over the fogged scene behind
struct Layers {
	// 1 − revealage: how much of the scene behind they hide
	coverage: f32,
	// their weighted mean colour
	mean: vec3f,
	// the share of `mean` that belongs to layers kept out of the fog (effects without fog of their own)
	unfogged: f32,
	// their weighted mean distance (m)
	distance: f32,
}

const NO_LAYERS = Layers(0.0, vec3f(0.0), 0.0, 0.0);

// the layers from the transparent pass's targets: the weighted sum, the revealage, the unfogged layers' weight
// (the glow's alpha) and the weighted distance code
fn resolve_layers(sum: vec4f, revealage: f32, unfogged_weight: f32, distance_sum: f32) -> Layers {
	if (revealage >= 1.0) {
		return NO_LAYERS;
	}
	let weight = max(sum.a, 1e-5);
	// the inverse of `layer_distance_code` in frame.wgsl: d / (d + 1 km)
	let code = clamp(distance_sum / weight, 0.0, 0.999);
	return Layers(1.0 - revealage, sum.rgb / weight, saturate(unfogged_weight / weight), 1000.0 * code / (1.0 - code));
}

// whether the water pass lays the layers over itself rather than the composite under it: wherever there's water
// (its reversed-Z depth `water_depth` isn't 0). the game lights its water before drawing transparent things,
// tested against the depth without water, so they lie over the water even where they're under its surface
fn water_takes_layers(layers: Layers, water_depth: f32) -> bool {
	return layers.coverage > 0.0 && water_depth > 0.0;
}

// the layers over the fogged scene behind them, `behind`, seen along unit `direction` from `uv`. a weighted
// blend keeps no order, so the fogged layers take the fog at their weighted mean distance, which is exact for
// one layer and close for layers near each other; the fog reaches the scene behind through them as it would
// per layer
fn over_layers(behind: vec3f, layers: Layers, uv: vec2f, direction: vec3f) -> vec3f {
	if (layers.coverage <= 0.0) {
		return behind;
	}
	var fogged = layers.mean;
	if (layers.unfogged < 1.0) {
		let fog = fog_over(direction, layers.distance,
			froxels_at(uv, layers.distance * dot(direction, post.forward.xyz)));
		fogged = layers.mean * fog.transmittance + fog.inscatter;
	}
	return mix(behind, mix(fogged, layers.mean, layers.unfogged), layers.coverage);
}

// #endregion

// the fog over something `distance` metres away
fn atmosphere_over(color: vec3f, direction: vec3f, distance: f32, froxels: Froxels) -> vec3f {
	let fog = fog_over(direction, distance, froxels);
	return color * fog.transmittance + fog.inscatter;
}
