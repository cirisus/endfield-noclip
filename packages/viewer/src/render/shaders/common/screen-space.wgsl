// projecting onto the main pass's targets and marching screen-space reflection rays (shared by ssr.wgsl and
// the water's ssr-trace.wgsl). needs post-common.wgsl (with noise.wgsl) and a `depth_texture` (the main pass's
// depth) declared by the pass.

// a camera-relative point on the main pass's (jittered) targets: xy uv, z device depth
fn ssr_project(rel: vec3f) -> vec3f {
	let d = dot(rel, post.forward.xyz);
	let right = post.right.xyz;
	let up = post.up.xyz;
	let ndc = vec2f(dot(rel, right) / dot(right, right), dot(rel, up) / dot(up, up)) / d + post.jitter.xy;
	return vec3f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5, post.forward.w / d);
}

// the main pass's (reversed-Z) device depth under a uv, 0 for the sky
fn ssr_device_depth(uv: vec2f) -> f32 {
	let px = clamp(vec2i(uv * post.viewport.xy), vec2i(0), vec2i(post.viewport.xy) - 1);
	return textureLoad(depth_texture, px, 0);
}

struct SsrMarchHit {
	// hit uv (xy) and device depth (z)
	position: vec3f,
	hit: bool,
}

// marches a reflection ray from `start` (uv, device depth) towards `end` (uv, device depth), stretched to the
// screen's edge (Unreal's clip-to-screen) and stepped in `steps` equal steps of uv and device depth.
// `target_size` is the pass's size in pixels and `noise_px` seeds the per-frame start offset.
fn ssr_march_ray(start: vec3f, end: vec3f, steps: f32, target_size: vec2f, noise_px: vec2f) -> SsrMarchHit {
	let start_ndc = vec2f(start.x * 2.0 - 1.0, 1.0 - start.y * 2.0);
	var delta = vec3f((end.x - start.x) * 2.0, (start.y - end.y) * 2.0, end.z - start.z);
	{
		let half_length = max(0.5 * length(delta.xy), 1e-9);
		let scale =
			1.0 - max(abs(delta.xy + start_ndc * half_length) - half_length, vec2f(0.0)) / max(abs(delta.xy), vec2f(1e-9));
		delta *= min(scale.x, scale.y) / half_length;
	}
	let tolerance = max(abs(delta.z) / steps, 1e-4);
	let step = vec3f(delta.x * 0.5, -delta.y * 0.5, delta.z) / steps;
	var offset: f32;
	{
		let pixels = abs(step.xy * target_size);
		let longest = max(pixels.x, pixels.y);
		if (longest < 1.0) {
			offset = 1.0 / (longest + 0.001);
		} else {
			offset = gradient_noise(noise_px + vec2f(2.083, 4.867) * post.eye.w);
		}
	}
	var position = start + step * offset;
	var last = position.z - ssr_device_depth(position.xy);
	for (var i = 0.0; i < steps; i += 4.0) {
		var diff: array<f32, 4>;
		var found = -1;
		for (var k = 0; k < 4; k++) {
			let tap = position + step * f32(k + 1);
			diff[k] = tap.z - ssr_device_depth(tap.xy);
			// a hit lies behind the depth buffer's surface by less than two steps' depth
			if (found < 0 && abs(diff[k] + tolerance) < tolerance) {
				found = k;
			}
		}
		if (found >= 0) {
			let before = select(diff[max(found - 1, 0)], last, found == 0);
			let after = diff[found];
			position += step * (f32(found) + clamp(before / (before - after), 0.0, 1.0));
			return SsrMarchHit(position, true);
		}
		position += step * 4.0;
		last = diff[3];
	}
	return SsrMarchHit(position, false);
}

// fades a hit towards the screen's edges and for surfaces seen head-on
fn ssr_fade(uv: vec2f, normal: vec3f, view_dir: vec3f, fade_on_screen: f32, mirror_mul: f32, mirror_add: f32) -> f32 {
	let edge = min(1.0 - max(uv.x, uv.y), min(uv.x, uv.y));
	let on_screen = clamp(select(edge / fade_on_screen, 1.0, edge > fade_on_screen), 0.0, 1.0);
	let mirror = 1.0 - clamp(abs(dot(normal, view_dir)) * mirror_mul + mirror_add, 0.0, 1.0);
	return on_screen * mirror;
}
