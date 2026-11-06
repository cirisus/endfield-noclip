// screen-space noise shared by the frame's and the post passes' shaders.

// interleaved gradient noise (Jimenez) at a pixel
fn gradient_noise(px: vec2f) -> f32 {
	return fract(52.9829189 * fract(dot(px, vec2f(0.06711056, 0.00583715))));
}
