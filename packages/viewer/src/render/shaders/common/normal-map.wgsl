// a tangent-space normal from a map's RG, with the game's dead zone around flat and the Z floor

fn unpack_normal_xy(rg: vec2f) -> vec2f {
	let xy = rg * 2.0 - 1.0;
	return select(xy, vec2f(0.0), abs(xy) < vec2f(0.012));
}

fn normal_z(xy: vec2f) -> f32 {
	return max(1.0 / 2048.0, sqrt(saturate(1.0 - dot(xy, xy))));
}
