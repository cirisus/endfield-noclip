// the water pass's reflection march, the same screen-space march as the game's (and ssr.wgsl's `fs_march`): the
// mirror ray is projected to the screen, stretched to its edge and stepped in equal steps of uv and device depth,
// so it has no reach limit in metres. needs post-common.wgsl and shaders/common/screen-space.wgsl (with its
// `depth_texture`).

// PC high quality's `ssrRayMarchingSampleCount`, which glossy surfaces such as water always take
const SSR_STEPS = 32.0;
// the ScreenSpaceReflectionVolume's fadenessOnScreen, fadenessOnMirrorMul and fadenessOnMirrorAdd, the same in
// every shipped profile
const SSR_FADE_ON_SCREEN = 0.1;
const SSR_FADE_MIRROR_MUL = 2.0;
const SSR_FADE_MIRROR_ADD = -1.0;

struct SsrHit {
	// where the ray hit, on the main pass's targets
	uv: vec2f,
	// 0 for a miss, fading towards the screen's edges and for surfaces seen head-on
	confidence: f32,
}

// marches the mirror ray `r` of the surface at the camera-relative `start` with normal `n`; `px` seeds the
// per-frame start offset
fn ssr_trace(start_rel: vec3f, r: vec3f, n: vec3f, px: vec2f) -> SsrHit {
	let miss = SsrHit(vec2f(0.0), 0.0);
	let eye = dot(start_rel, post.forward.xyz);
	let end_rel = start_rel + r * eye;
	if (dot(end_rel, post.forward.xyz) <= post.forward.w) {
		return miss;
	}
	let start = ssr_project(start_rel);
	let end = ssr_project(end_rel);
	let march = ssr_march_ray(start, end, SSR_STEPS, post.viewport.xy, px);
	if (!march.hit) {
		return miss;
	}
	let v = normalize(start_rel);
	return SsrHit(
		march.position.xy,
		ssr_fade(march.position.xy, n, v, SSR_FADE_ON_SCREEN, SSR_FADE_MIRROR_MUL, SSR_FADE_MIRROR_ADD),
	);
}
