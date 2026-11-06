// colour space conversions shared by the post passes. the RGB-to-HSV conversions stay with their shaders:
// tonemap.wgsl's, celestial.wgsl's and water.wgsl's differ in their epsilon or in how they break ties.

fn to_ycocg(c: vec3f) -> vec3f {
	return vec3f(dot(c, vec3f(0.25, 0.5, 0.25)), dot(c, vec3f(0.5, 0.0, -0.5)), dot(c, vec3f(-0.25, 0.5, -0.25)));
}

fn from_ycocg(c: vec3f) -> vec3f {
	return vec3f(c.x + c.y - c.z, c.x + c.z, c.x - c.y - c.z);
}

// hue (turns), saturation, value to RGB
fn hsv_to_rgb(c: vec3f) -> vec3f {
	let p = abs(fract(c.xxx + vec3f(1.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
	return c.z * mix(vec3f(1.0), clamp(p - 1.0, vec3f(0.0), vec3f(1.0)), c.y);
}
