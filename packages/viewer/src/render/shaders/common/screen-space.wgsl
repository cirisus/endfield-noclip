// projecting onto the main pass's targets, for the screen-space reflection marches (ssr.wgsl and the water's
// ssr-trace.wgsl). needs post-common.wgsl and a `depth_texture` (the main pass's depth) declared by the pass.

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
