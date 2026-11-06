// camera-spawned additive billboards; positions use the same reversed-Z projection as the scene.
struct Particle {
	clip: vec4f,
	// projected half-width and half-height vectors, already rotated
	axes: vec4f,
	color: vec4f,
	// atlas origin and tile extent
	uv: vec4f,
}
@group(0) @binding(0) var<storage, read> particles: array<Particle>;
@group(0) @binding(1) var image: texture_2d<f32>;
@group(0) @binding(2) var image_sampler: sampler;
@group(0) @binding(3) var depth: texture_depth_2d;

struct Out {
	@builtin(position) position: vec4f,
	@location(0) uv: vec2f,
	@location(1) color: vec4f,
}
@vertex
fn vs_particle(@builtin(vertex_index) vertex: u32, @builtin(instance_index) instance: u32) -> Out {
	let p = particles[instance];
	let corner = vec2f(f32(vertex & 1u), f32(vertex >> 1u));
	let local = corner * 2.0 - 1.0;
	let rotated = local.x * p.axes.xy + local.y * p.axes.zw;
	var out: Out;
	out.position = p.clip + vec4f(rotated, 0.0, 0.0);
	// Unity's quad v increases with local y; texture rows are retained as stored.
	out.uv = p.uv.xy + corner * p.uv.zw;
	out.color = p.color;
	return out;
}
@fragment
fn fs_particle(in: Out) -> @location(0) vec4f {
	if (in.position.z < textureLoad(depth, vec2i(in.position.xy), 0)) { discard; }
	let sample = textureSample(image, image_sampler, in.uv);
	return vec4f(sample.rgb * in.color.rgb * sample.a * in.color.a, 0.0);
}
