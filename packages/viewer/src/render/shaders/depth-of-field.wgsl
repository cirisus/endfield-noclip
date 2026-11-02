// signed circle of confusion, temporal downsample and separable circular bokeh.
// each dispatch has its own bind group; sampled and writable textures never alias.
struct Focus {
	full: vec4f,
	low: vec4f,
	tile: vec4f,
	// depth offset, depth scale, foreground cap, background cap (pixels)
	coc: vec4f,
	// history valid, temporal shaping, near clip, unused
	history: vec4f,
	forward: vec4f,
	right: vec4f,
	up: vec4f,
	eye_delta: vec4f,
	previous_view_proj: mat4x4f,
	jitter: vec4f,
}
@group(0) @binding(0) var<uniform> focus: Focus;
@group(0) @binding(1) var linear_sampler: sampler;
@group(0) @binding(2) var source0: texture_2d<f32>;
@group(0) @binding(3) var source1: texture_2d<f32>;
@group(0) @binding(4) var source2: texture_2d<f32>;
@group(0) @binding(5) var source3: texture_2d<f32>;
@group(0) @binding(6) var source4: texture_2d<f32>;
@group(0) @binding(7) var scene_depth: texture_depth_2d;
@group(0) @binding(8) var water_depth: texture_depth_2d;
@group(0) @binding(9) var output0: texture_storage_2d<rgba16float, write>;
@group(0) @binding(10) var output1: texture_storage_2d<rgba16float, write>;
@group(0) @binding(11) var output2: texture_storage_2d<rgba16float, write>;

fn sample_at(tex: texture_2d<f32>, uv: vec2f) -> vec4f {
	return textureSampleLevel(tex, linear_sampler, clamp(uv, vec2f(0.0001), vec2f(0.9999)), 0.0);
}
fn complex_product(a: vec2f, b: vec2f) -> vec2f {
	return vec2f(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x);
}
// symmetric complex Gaussian coefficients, stored from the outside tap to the centre.
const NEAR_KERNEL = array<vec2f, 9>(
	vec2f(-0.001442, 0.026656), vec2f(0.010488, 0.030945),
	vec2f(0.023771, 0.030830), vec2f(0.036356, 0.026770),
	vec2f(0.046822, 0.020140), vec2f(0.054555, 0.012687),
	vec2f(0.059606, 0.006074), vec2f(0.062366, 0.001584), vec2f(0.063232, 0.0));
const FAR_KERNEL_A = array<vec2f, 7>(
	vec2f(0.018671, -0.030012), vec2f(-0.040278, -0.022921),
	vec2f(-0.040304, 0.041487), vec2f(0.017240, 0.066525),
	vec2f(0.064784, 0.042949), vec2f(0.082792, 0.012205), vec2f(0.085774, 0.0));
const FAR_KERNEL_B = array<vec2f, 7>(
	vec2f(0.000152, 0.012075), vec2f(0.010320, 0.019409),
	vec2f(0.027619, 0.022913), vec2f(0.048604, 0.019954),
	vec2f(0.067953, 0.011884), vec2f(0.081151, 0.003515), vec2f(0.085774, 0.0));

@compute @workgroup_size(8, 8)
fn cs_coc(@builtin(global_invocation_id) id: vec3u) {
	if (any(id.xy >= vec2u(focus.full.xy))) { return; }
	let p = vec2i(id.xy);
	let depth = max(textureLoad(scene_depth, p, 0), textureLoad(water_depth, p, 0));
	let radius = clamp(focus.coc.x - focus.coc.y * depth, -focus.coc.z, focus.coc.w);
	textureStore(output0, p, vec4f(radius));
}

fn compress_color(color: vec3f) -> vec3f {
	return color / (1.0 + dot(color, vec3f(0.2126729, 0.7151522, 0.0721750)));
}
fn expand_color(color: vec3f) -> vec3f {
	let positive = max(color, vec3f(0.0));
	return positive / max(0.0001, 1.0 - dot(positive, vec3f(0.2126729, 0.7151522, 0.0721750)));
}

// source0: full CoC, source1: colour, source2/3: previous downsampled colour/CoC.
@compute @workgroup_size(8, 8)
fn cs_downsample(@builtin(global_invocation_id) id: vec3u) {
	if (any(id.xy >= vec2u(focus.low.xy))) { return; }
	let uv = (vec2f(id.xy) + 0.5) * focus.low.zw;
	var near_sum = 0.0;
	var far_sum = 0.0;
	for (var y = 0; y < 2; y++) {
		for (var x = 0; x < 2; x++) {
			let c = sample_at(source0, uv + (vec2f(f32(x), f32(y)) - 0.5) * focus.full.zw).r;
			near_sum += min(c, 0.0);
			far_sum += max(c, 0.0);
		}
	}
	let coc = select(far_sum, near_sum, -near_sum > far_sum) * 0.25;
	var sum = vec3f(0.0);
	var squares = vec3f(0.0);
	var cross_min = vec3f(1e20);
	var cross_max = vec3f(-1e20);
	var all_min = vec3f(1e20);
	var all_max = vec3f(-1e20);
	var current = vec3f(0.0);
	for (var y = -1; y <= 1; y++) {
		for (var x = -1; x <= 1; x++) {
			let color = compress_color(sample_at(source1, uv + vec2f(f32(x), f32(y)) * focus.low.zw).rgb);
			sum += color;
			squares += color * color;
			all_min = min(all_min, color);
			all_max = max(all_max, color);
			if (x == 0 || y == 0) {
				cross_min = min(cross_min, color);
				cross_max = max(cross_max, color);
			}
			if (x == 0 && y == 0) { current = color; }
		}
	}
	let mean = sum / 9.0;
	let sigma = sqrt(max(squares / 9.0 - mean * mean, vec3f(0.0))) * 1.25;
	let lo = min((cross_min + all_min) * 0.5, mean - sigma);
	let hi = max((cross_max + all_max) * 0.5, mean + sigma);
	let depth_pixel = clamp(vec2i(uv * focus.full.xy), vec2i(0), vec2i(focus.full.xy) - 1);
	let depth = max(textureLoad(scene_depth, depth_pixel, 0), textureLoad(water_depth, depth_pixel, 0));
	let ndc = uv * vec2f(2.0, -2.0) + vec2f(-1.0, 1.0) - focus.jitter.xy;
	let ray = focus.forward.xyz + ndc.x * focus.right.xyz + ndc.y * focus.up.xyz;
	let relative = ray * focus.history.z / max(depth, 1e-8) + focus.eye_delta.xyz;
	let previous_clip = focus.previous_view_proj * vec4f(relative, 1.0);
	let previous_uv = previous_clip.xy / max(previous_clip.w, 1e-8) * vec2f(0.5, -0.5) + 0.5;
	var result = current;
	if (focus.history.x > 0.5 && previous_clip.w > 0.0 && all(previous_uv >= vec2f(0.0)) && all(previous_uv <= vec2f(1.0))) {
		let previous = compress_color(sample_at(source2, previous_uv).rgb);
		let previous_coc = sample_at(source3, previous_uv).r;
		let center = (lo + hi) * 0.5;
		let extent = max((hi - lo) * 0.5, vec3f(0.0001));
		let displacement = previous - center;
		let units = abs(displacement / extent);
		let reach = max(units.x, max(units.y, units.z));
		let clipped = select(previous, center + displacement / max(reach, 0.0001), reach > 1.0);
		let cap = select(focus.coc.w, focus.coc.z, coc < 0.0);
		let stability = exp(-10.0 * abs(coc - previous_coc)) * (1.0 - exp(-abs(coc) * cap * focus.history.y));
		let weight = select(0.0, 0.95 * stability, coc * previous_coc > 0.0);
		result = mix(current, clipped, weight);
	}
	// full-resolution photography keeps the unfiltered CoC for spatial passes and history.
	textureStore(output0, vec2i(id.xy), vec4f(textureLoad(source0, vec2i(id.xy), 0).r));
	textureStore(output1, vec2i(id.xy), vec4f(expand_color(result), 1.0));
}

@compute @workgroup_size(8, 8)
fn cs_tile(@builtin(global_invocation_id) id: vec3u) {
	if (any(id.xy >= vec2u(focus.tile.xy))) { return; }
	let uv = (vec2f(id.xy) + 0.5) * focus.tile.zw;
	var radius = vec4f(0.0);
	for (var y = -16.0; y <= 17.0; y += 7.9200006) {
		for (var x = -16.0; x <= 17.0; x += 7.9200006) {
			radius = max(radius, -textureGather(0, source0, linear_sampler, uv + vec2f(x, y) * focus.low.zw));
		}
	}
	textureStore(output0, vec2i(id.xy), vec4f(max(max(radius.x, radius.y), max(radius.z, radius.w))));
}
@compute @workgroup_size(8, 8)
fn cs_tile_blur(@builtin(global_invocation_id) id: vec3u) {
	if (any(id.xy >= vec2u(focus.tile.xy))) { return; }
	var sum = 0.0;
	for (var y = -1; y <= 1; y++) {
		for (var x = -1; x <= 1; x++) {
			sum += sample_at(source0, (vec2f(id.xy) + 0.5 + vec2f(f32(x), f32(y))) * focus.tile.zw).r;
		}
	}
	textureStore(output0, vec2i(id.xy), vec4f(sum / 9.0));
}

// source0: tile radii, source1: colour, source2: signed CoC.
@compute @workgroup_size(8, 8)
fn cs_near_x(@builtin(global_invocation_id) id: vec3u) {
	if (any(id.xy >= vec2u(focus.low.xy))) { return; }
	let uv = (vec2f(id.xy) + 0.5) * focus.low.zw;
	let step = sample_at(source0, uv).r * focus.low.z / 8.0;
	var real = vec3f(0.0);
	var imaginary = vec3f(0.0);
	var coverage = 0.0;
	for (var i = -8; i <= 8; i++) {
		let at = uv + vec2f(f32(i) * step, 0.0);
		let color = sample_at(source1, at).rgb;
		let weight = NEAR_KERNEL[8 - abs(i)];
		real += color * weight.x;
		imaginary += color * weight.y;
		coverage += select(0.0, 1.0, sample_at(source2, at).r < 0.0);
	}
	textureStore(output0, vec2i(id.xy), vec4f(real, coverage));
	textureStore(output1, vec2i(id.xy), vec4f(imaginary, 0.0));
}
@compute @workgroup_size(8, 8)
fn cs_near_y(@builtin(global_invocation_id) id: vec3u) {
	if (any(id.xy >= vec2u(focus.low.xy))) { return; }
	let uv = (vec2f(id.xy) + 0.5) * focus.low.zw;
	let step = sample_at(source0, uv).r * focus.low.w / 8.0;
	var real = vec3f(0.0);
	var imaginary = vec3f(0.0);
	var coverage = 0.0;
	for (var i = -8; i <= 8; i++) {
		let at = uv + vec2f(0.0, f32(i) * step);
		let a = sample_at(source1, at);
		let b = sample_at(source2, at).rgb;
		let weight = NEAR_KERNEL[8 - abs(i)];
		real += a.rgb * weight.x - b * weight.y;
		imaginary += a.rgb * weight.y + b * weight.x;
		coverage += a.a;
	}
	textureStore(output0, vec2i(id.xy), vec4f(real * 0.767583 + imaginary * 1.862321, clamp(coverage * 0.0415224917, 0.0, 1.0)));
}
@compute @workgroup_size(8, 8)
fn cs_alpha_x(@builtin(global_invocation_id) id: vec3u) {
	if (any(id.xy >= vec2u(focus.low.xy))) { return; }
	let uv = (vec2f(id.xy) + 0.5) * focus.low.zw;
	var sum = 0.0;
	for (var i = -4; i <= 4; i++) { sum += sample_at(source0, uv + vec2f(f32(i) * focus.low.z, 0.0)).a; }
	textureStore(output0, vec2i(id.xy), vec4f(sum / 9.0));
}
@compute @workgroup_size(8, 8)
fn cs_alpha_y(@builtin(global_invocation_id) id: vec3u) {
	if (any(id.xy >= vec2u(focus.low.xy))) { return; }
	let uv = (vec2f(id.xy) + 0.5) * focus.low.zw;
	var sum = 0.0;
	for (var i = -4; i <= 4; i++) { sum += sample_at(source0, uv + vec2f(0.0, f32(i) * focus.low.w)).r; }
	textureStore(output0, vec2i(id.xy), vec4f(sample_at(source1, uv).rgb, sum / 9.0));
}

// background CoC limits the support: in-focus neighbours must not bleed across a silhouette.
fn far_uv(uv: vec2f, at: vec2f, tap: i32) -> vec2f {
	let coverage = clamp(sample_at(source0, at).r, 0.0, 1.0);
	return select(at, uv, coverage == 0.0 || coverage * 6.0 < f32(abs(tap)));
}
@compute @workgroup_size(8, 8)
fn cs_far_y(@builtin(global_invocation_id) id: vec3u) {
	if (any(id.xy >= vec2u(focus.low.xy))) { return; }
	let uv = (vec2f(id.xy) + 0.5) * focus.low.zw;
	let radius = max(sample_at(source0, uv).r, 0.0);
	var red = vec4f(0.0);
	var green = vec4f(0.0);
	var blue = vec4f(0.0);
	if (radius > 0.0) {
		for (var i = -6; i <= 6; i++) {
			let at = far_uv(uv, uv + vec2f(0.0, f32(i) * radius * focus.low.w / 6.0), i);
			let color = sample_at(source1, at).rgb;
			let weight = vec4f(FAR_KERNEL_A[6 - abs(i)], FAR_KERNEL_B[6 - abs(i)]);
			red += weight * color.r;
			green += weight * color.g;
			blue += weight * color.b;
		}
	}
	textureStore(output0, vec2i(id.xy), red);
	textureStore(output1, vec2i(id.xy), green);
	textureStore(output2, vec2i(id.xy), blue);
}
fn far_convolve(value: vec4f, a: vec2f, b: vec2f) -> vec4f {
	return vec4f(complex_product(value.xy, a), complex_product(value.zw, b));
}
fn far_combine(value: vec4f) -> f32 {
	return dot(value, vec4f(0.411259, -0.548794, 0.513282, 4.561110));
}
@compute @workgroup_size(8, 8)
fn cs_far_x(@builtin(global_invocation_id) id: vec3u) {
	if (any(id.xy >= vec2u(focus.low.xy))) { return; }
	let uv = (vec2f(id.xy) + 0.5) * focus.low.zw;
	let radius = max(sample_at(source0, uv).r, 0.0);
	var color = sample_at(source1, uv).rgb;
	if (radius > 0.0) {
		var red = vec4f(0.0);
		var green = vec4f(0.0);
		var blue = vec4f(0.0);
		for (var i = -6; i <= 6; i++) {
			let at = far_uv(uv, uv + vec2f(f32(i) * radius * focus.low.z / 6.0, 0.0), i);
			let a = FAR_KERNEL_A[6 - abs(i)];
			let b = FAR_KERNEL_B[6 - abs(i)];
			red += far_convolve(sample_at(source2, at), a, b);
			green += far_convolve(sample_at(source3, at), a, b);
			blue += far_convolve(sample_at(source4, at), a, b);
		}
		color = vec3f(far_combine(red), far_combine(green), far_combine(blue));
	}
	textureStore(output0, vec2i(id.xy), vec4f(color, 1.0));
}
@compute @workgroup_size(8, 8)
fn cs_composite(@builtin(global_invocation_id) id: vec3u) {
	if (any(id.xy >= vec2u(focus.full.xy))) { return; }
	let uv = (vec2f(id.xy) + 0.5) * focus.full.zw;
	let sharp = sample_at(source0, uv);
	let coc = sample_at(source1, uv).r;
	let near = sample_at(source2, uv);
	let far = sample_at(source3, uv).rgb;
	let background = mix(sharp.rgb, far, smoothstep(0.5, 1.5, max(coc, 0.0)));
	textureStore(output0, vec2i(id.xy), vec4f(mix(background, near.rgb, near.a), sharp.a));
}
