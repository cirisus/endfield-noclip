// a pyramid of the farthest depth (reversed-Z, so the smallest) under each texel, from the main pass's depth:
// the instance culler tests bounds against it. a level of odd size leaves a row or column out of the next,
// floored one, so the next's last texel takes it in

@group(0) @binding(0) var source_depth: texture_depth_2d;
@group(0) @binding(1) var source: texture_2d<f32>;
@group(0) @binding(2) var output: texture_storage_2d<r32float, write>;

// the source texels under a target texel: its 2 × 2, plus the row or column an odd source leaves at the edge
fn footprint(id: vec2u, target_size: vec2u, source_size: vec2u) -> vec4i {
	let first = vec2i(id * 2u);
	let last_x = id.x == target_size.x - 1u && source_size.x > target_size.x * 2u;
	let last_y = id.y == target_size.y - 1u && source_size.y > target_size.y * 2u;
	let count = vec2i(select(2, 3, last_x), select(2, 3, last_y));
	return vec4i(first, count);
}

@compute @workgroup_size(8, 8)
fn cs_first(@builtin(global_invocation_id) id: vec3u) {
	let size = textureDimensions(output);
	if (any(id.xy >= size)) {
		return;
	}
	let source_size = textureDimensions(source_depth);
	let area = footprint(id.xy, size, source_size);
	let edge = vec2i(source_size) - 1;
	var depth = 1.0;
	for (var y = 0; y < area.w; y++) {
		for (var x = 0; x < area.z; x++) {
			depth = min(depth, textureLoad(source_depth, min(area.xy + vec2i(x, y), edge), 0));
		}
	}
	textureStore(output, id.xy, vec4f(depth));
}

@compute @workgroup_size(8, 8)
fn cs_down(@builtin(global_invocation_id) id: vec3u) {
	let size = textureDimensions(output);
	if (any(id.xy >= size)) {
		return;
	}
	let source_size = textureDimensions(source);
	let area = footprint(id.xy, size, source_size);
	let edge = vec2i(source_size) - 1;
	var depth = 1.0;
	for (var y = 0; y < area.w; y++) {
		for (var x = 0; x < area.z; x++) {
			depth = min(depth, textureLoad(source, min(area.xy + vec2i(x, y), edge), 0).r);
		}
	}
	textureStore(output, id.xy, vec4f(depth));
}
