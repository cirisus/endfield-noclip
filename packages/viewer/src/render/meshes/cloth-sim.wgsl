// GPU cloth simulation compute shader: WGSL port of Endfield's `ClothSingleDispatchCS` (`ClothSimMain`).
// one workgroup of 256 threads simulates one cloth (1 or 2 batches of up to 256 nodes each), integrating wind
// lift/drag + gravity via Verlet, solving distance, collision-plane, max-deviation, and anchor constraints in
// workgroup shared memory, and writing each node's 3×4 object-space skinning matrix to `skeletons`.

struct ClothUniforms {
	// x = dt (0.023333333), y = 1 / dt, z = loop_num (u32 bits as f32), w = unused
	dt_info: vec4f,
	// x = wind_time, yz = wind_noise_uv, w = unused
	wind_params: vec4f,
	// x = wind_intensity (_WindGlobalParams0.x), y = unused, zw = wind_dir.xz
	wind_global: vec4f,
}

@group(0) @binding(0) var<uniform> params: ClothUniforms;
@group(0) @binding(1) var<storage, read> cloth_meta: array<array<u32, 44>>;
@group(0) @binding(2) var<storage, read> batch_meta: array<vec4i>;
@group(0) @binding(3) var<storage, read> cache_map: array<vec4u>;
@group(0) @binding(4) var<storage, read_write> cloth_nodes: array<array<u32, 48>>;
@group(0) @binding(5) var<storage, read_write> skeletons: array<vec4f>;
@group(0) @binding(6) var wind_noise: texture_2d<f32>;
@group(0) @binding(7) var wind_sampler: sampler;

// 0..255 = ping buffer, 256..511 = pong buffer, 512..639 = cross-batch neighbor cache
var<workgroup> shared_pos: array<vec3f, 640>;
// 0..255 = batch node UVs, 256..383 = cross-batch neighbor UVs
var<workgroup> shared_uv: array<vec2f, 384>;

fn mf32(cloth: u32, word: u32) -> f32 {
	return bitcast<f32>(cloth_meta[cloth][word]);
}

fn nf32(node: u32, word: u32) -> f32 {
	return bitcast<f32>(cloth_nodes[node][word]);
}

fn ni32(node: u32, word: u32) -> i32 {
	return bitcast<i32>(cloth_nodes[node][word]);
}

fn read_shared_pos(idx: i32, ping_offset: u32) -> vec3f {
	let u = u32(idx);
	let slot = select(u, u + ping_offset, u < 256u);
	return shared_pos[slot];
}

fn read_shared_uv(idx: i32) -> vec2f {
	let u = u32(idx);
	let slot = select(u - 256u, u, u < 256u);
	return shared_uv[slot];
}

fn safe_sign(x: f32) -> f32 {
	return select(select(0.0, -1.0, x < 0.0), 1.0, x > 0.0);
}

@compute @workgroup_size(256, 1, 1)
fn cs_cloth_sim(
	@builtin(workgroup_id) wg_id: vec3u,
	@builtin(local_invocation_id) local_id: vec3u,
) {
	let cloth_idx = wg_id.x;
	let tid = local_id.x;

	let raw_node_start = cloth_meta[cloth_idx][0];
	let raw_node_end = cloth_meta[cloth_idx][1];
	let raw_batch_start = cloth_meta[cloth_idx][2];
	let iter_num = cloth_meta[cloth_idx][3];

	let damping = mf32(cloth_idx, 4u);
	let wind_freq_factor = mf32(cloth_idx, 5u);
	let wind_balance_factor = mf32(cloth_idx, 6u);
	let wind_intensity_scale = mf32(cloth_idx, 7u);

	let group_node_offset = bitcast<i32>(cloth_meta[cloth_idx][8]);
	let group_batch_offset = bitcast<i32>(cloth_meta[cloth_idx][9]);
	let group_cache_offset = bitcast<i32>(cloth_meta[cloth_idx][10]);

	let longest_anchor_dist = mf32(cloth_idx, 12u);
	let soft_clamp_flag = mf32(cloth_idx, 13u) != 0.0;
	let wind_spatial_scale = mf32(cloth_idx, 14u);

	let cloth_normal = vec3f(mf32(cloth_idx, 16u), mf32(cloth_idx, 17u), mf32(cloth_idx, 18u));

	let l2w0 = vec4f(mf32(cloth_idx, 20u), mf32(cloth_idx, 21u), mf32(cloth_idx, 22u), mf32(cloth_idx, 23u));
	let l2w1 = vec4f(mf32(cloth_idx, 24u), mf32(cloth_idx, 25u), mf32(cloth_idx, 26u), mf32(cloth_idx, 27u));
	let l2w2 = vec4f(mf32(cloth_idx, 28u), mf32(cloth_idx, 29u), mf32(cloth_idx, 30u), mf32(cloth_idx, 31u));

	let w2l0 = vec4f(mf32(cloth_idx, 32u), mf32(cloth_idx, 33u), mf32(cloth_idx, 34u), mf32(cloth_idx, 35u));
	let w2l1 = vec4f(mf32(cloth_idx, 36u), mf32(cloth_idx, 37u), mf32(cloth_idx, 38u), mf32(cloth_idx, 39u));
	let w2l2 = vec4f(mf32(cloth_idx, 40u), mf32(cloth_idx, 41u), mf32(cloth_idx, 42u), mf32(cloth_idx, 43u));

	let node_start = u32(i32(raw_node_start) + group_node_offset);
	let node_end = u32(i32(raw_node_end) + group_node_offset);
	let batch_start = u32(i32(raw_batch_start) + group_batch_offset);

	let node_count = node_end - node_start;
	let batch_count = (node_count + 255u) >> 8u;
	let loop_num = u32(params.dt_info.z);
	let dt = params.dt_info.x;
	let inv_dt = params.dt_info.y;
	let dt2 = dt * dt;

	// global wind parameters (ClothSimMain lines 400..446)
	let wind_strength = clamp(params.wind_global.x * 0.5, 0.0, 1.0);
	let effective_intensity = wind_intensity_scale * wind_strength;
	let raw_dir_xz = params.wind_global.zw;
	let base_wind_dir = select(
		vec3f(raw_dir_xz.x, 0.0, raw_dir_xz.y),
		vec3f(0.0, 0.0, 1.0),
		dot(raw_dir_xz, raw_dir_xz) < 0.99,
	);
	let wind_dir = normalize(mix(base_wind_dir, cloth_normal, abs(wind_balance_factor)));
	let noise_mix = clamp(effective_intensity * 0.3, 0.0, 1.0);
	let wind_amp = effective_intensity * 1.6;
	let wind_freq = wind_freq_factor * 10.0 * (effective_intensity * 0.6 + 1.0);

	// columns of localToWorld (for M_world * localToWorld)
	let l2w_c0 = vec3f(l2w0.x, l2w1.x, l2w2.x);
	let l2w_c1 = vec3f(l2w0.y, l2w1.y, l2w2.y);
	let l2w_c2 = vec3f(l2w0.z, l2w1.z, l2w2.z);
	let l2w_c3 = vec4f(l2w0.w, l2w1.w, l2w2.w, 1.0);

	for (var batch = 0u; batch < batch_count; batch++) {
		let batch_node_start = node_start + batch * 256u;
		let batch_node_end = min(node_end, batch_node_start + 256u);
		let node_idx = batch_node_start + tid;
		let is_active = node_idx < batch_node_end;

		// unpack this batch's cross-batch cache range
		let batch_global = batch_start + batch;
		let batch_pair = batch_meta[batch_global >> 1u];
		let cache_range_local = select(batch_pair.xy, batch_pair.zw, (batch_global & 1u) != 0u);
		let cache_start = cache_range_local.x + group_cache_offset;
		let cache_end = cache_range_local.y + group_cache_offset;
		let has_cache = i32(tid) < (cache_end - cache_start);

		var cache_src_node = 0u;
		var cache_pos_slot = 0u;
		var cache_uv_slot = 0u;
		if (has_cache) {
			let cache_idx = u32(cache_start) + tid;
			let pair = cache_map[cache_idx >> 1u];
			let entry = select(pair.xy, pair.zw, (cache_idx & 1u) != 0u);
			cache_src_node = u32(group_node_offset + i32(entry.x));
			cache_pos_slot = entry.y;
			cache_uv_slot = select(entry.y - 256u, entry.y, entry.y < 256u);
		}

		// per-thread node state
		var anchor_idx = vec2i(-1, -1);
		var anchor_dist = vec2f(0.0);
		var my_uv = vec2f(0.0);
		var plane = vec4f(0.0);
		var base_pos = vec4f(0.0);
		var base_normal = vec3f(0.0, 1.0, 0.0);
		var base_tangent = vec4f(1.0, 0.0, 0.0, 1.0);
		var prev_pos = vec3f(0.0);
		var cur_pos = vec3f(0.0);
		var cur_normal = vec3f(0.0, 1.0, 0.0);
		var nbr_idx_lo = vec4i(-1);
		var nbr_idx_hi = vec4i(-1);
		var nbr_dist_lo = vec4f(0.0);
		var nbr_dist_hi = vec4f(0.0);

		if (is_active) {
			anchor_idx = vec2i(ni32(node_idx, 0u), ni32(node_idx, 1u));
			anchor_dist = vec2f(nf32(node_idx, 2u), nf32(node_idx, 3u));
			my_uv = vec2f(nf32(node_idx, 4u), nf32(node_idx, 5u));
			base_pos = vec4f(nf32(node_idx, 8u), nf32(node_idx, 9u), nf32(node_idx, 10u), nf32(node_idx, 11u));
			base_normal = vec3f(nf32(node_idx, 12u), nf32(node_idx, 13u), nf32(node_idx, 14u));
			base_tangent = vec4f(nf32(node_idx, 16u), nf32(node_idx, 17u), nf32(node_idx, 18u), nf32(node_idx, 19u));
			prev_pos = vec3f(nf32(node_idx, 20u), nf32(node_idx, 21u), nf32(node_idx, 22u));
			cur_pos = vec3f(nf32(node_idx, 24u), nf32(node_idx, 25u), nf32(node_idx, 26u));
			cur_normal = vec3f(nf32(node_idx, 28u), nf32(node_idx, 29u), nf32(node_idx, 30u));
			// collision plane: (planeXY.x, planeXY.y, baseNormal.w, prevPos.w)
			plane = vec4f(nf32(node_idx, 6u), nf32(node_idx, 7u), nf32(node_idx, 15u), nf32(node_idx, 23u));
			nbr_idx_lo = vec4i(ni32(node_idx, 32u), ni32(node_idx, 33u), ni32(node_idx, 34u), ni32(node_idx, 35u));
			nbr_idx_hi = vec4i(ni32(node_idx, 36u), ni32(node_idx, 37u), ni32(node_idx, 38u), ni32(node_idx, 39u));
			nbr_dist_lo = vec4f(nf32(node_idx, 40u), nf32(node_idx, 41u), nf32(node_idx, 42u), nf32(node_idx, 43u));
			nbr_dist_hi = vec4f(nf32(node_idx, 44u), nf32(node_idx, 45u), nf32(node_idx, 46u), nf32(node_idx, 47u));
		}

		var next_pos = cur_pos;
		var ping = 0u;

		for (var step = 0u; step < loop_num; step++) {
			if (is_active) {
				if (step > 0u) {
					prev_pos = cur_pos;
					cur_pos = next_pos;
				}
				let norm_anchor = clamp(anchor_dist.x / longest_anchor_dist, 0.0, 1.0);
				let noise_uv = cur_pos.xz * 0.05 + params.wind_params.yz;
				let noise = textureSampleLevel(wind_noise, wind_sampler, noise_uv, 0.0).xy;
				let n_blend = mix(noise.x, noise.y, noise_mix);
				let spatial = n_blend * dot(cur_pos, wind_dir) * wind_spatial_scale * 0.08;
				let phase = wind_freq * params.wind_params.x + norm_anchor * 0.62831855 + spatial;
				let waves = sin(vec3f(1.0, noise.x, noise.y) * phase) + vec3f(wind_balance_factor);
				let wind_scalar = (waves.x + waves.y * 0.3 + waves.z * 0.6) * (wind_amp * norm_anchor);

				let vel = cur_pos - prev_pos;
				let rel_wind = wind_dir * wind_scalar - vel * inv_dt;
				let rel_speed2 = dot(rel_wind, rel_wind);
				let rel_speed = sqrt(rel_speed2);
				let rel_dir = select(rel_wind / rel_speed, vec3f(0.0), rel_speed < 0.001);
				let ndot = dot(rel_dir, cur_normal);
				let s = safe_sign(ndot);
				let lift = (cur_normal * s) * (rel_speed2 * 0.4);
				let drag = rel_dir * (ndot * s * 0.3);
				let accel = lift + drag + vec3f(0.0, -5.0, 0.0);

				var p = cur_pos + vel * damping + accel * dt2;
				let to_base = base_pos.xyz - p;
				let dist = length(to_base);
				let limit = min(base_pos.w, max(dist, 1.5));
				let excess = max(dist - limit, 0.0);
				next_pos = p + to_base * (excess / max(dist, 1e-4));
			}

			if (step == 0u) {
				if (is_active) {
					shared_pos[tid] = next_pos;
					shared_uv[tid] = my_uv;
				}
				if (has_cache) {
					shared_pos[cache_pos_slot] = vec3f(
						nf32(cache_src_node, 24u),
						nf32(cache_src_node, 25u),
						nf32(cache_src_node, 26u),
					);
					shared_uv[cache_uv_slot] = vec2f(
						nf32(cache_src_node, 4u),
						nf32(cache_src_node, 5u),
					);
				}
			} else {
				if (is_active) {
					shared_pos[tid] = next_pos;
				}
			}
			workgroupBarrier();

			// distance constraints + collision plane (weighted Jacobi, ping-ponging 0..255 <-> 256..511)
			ping = 0u;
			for (var iter = 0u; iter < iter_num; iter++) {
				if (is_active) {
					let read_off = ping << 8u;
					let my_p = shared_pos[read_off + tid];
					var sum_p = vec3f(0.0);
					var sum_w = 0.0;

					let nbrs = array<i32, 8>(
						nbr_idx_lo.x, nbr_idx_lo.y, nbr_idx_lo.z, nbr_idx_lo.w,
						nbr_idx_hi.x, nbr_idx_hi.y, nbr_idx_hi.z, nbr_idx_hi.w,
					);
					let dists = array<f32, 8>(
						nbr_dist_lo.x, nbr_dist_lo.y, nbr_dist_lo.z, nbr_dist_lo.w,
						nbr_dist_hi.x, nbr_dist_hi.y, nbr_dist_hi.z, nbr_dist_hi.w,
					);
					for (var k = 0u; k < 8u; k++) {
						let ni = nbrs[k];
						if (ni >= 0) {
							let np = read_shared_pos(ni, read_off);
							let delta = np - my_p;
							let d = length(delta);
							let corr = delta * ((d - dists[k]) / (2.0 * max(d, 1e-6)));
							let dst_p = my_p + corr;
							let w = max(length(corr), 0.001);
							sum_p += dst_p * w;
							sum_w += w;
						}
					}
					let solved = select(my_p, sum_p / sum_w, sum_w > 0.0);
					ping = 1u - ping;
					shared_pos[(ping << 8u) + tid] = solved;
				}
				workgroupBarrier();

				if (is_active) {
					let slot = (ping << 8u) + tid;
					let p = shared_pos[slot];
					let pen = max(-dot(plane, vec4f(p, 1.0)), 0.0);
					shared_pos[slot] = p + plane.xyz * pen;
				}
				workgroupBarrier();
			}

			// post-constraint base-position clamp
			if (is_active) {
				let slot = (ping << 8u) + tid;
				let p = shared_pos[slot];
				let to_base = base_pos.xyz - p;
				let dist = length(to_base);
				var corr: vec3f;
				if (soft_clamp_flag && base_pos.w != 0.0 && base_pos.w < dist) {
					corr = to_base * ((dist - base_pos.w) / (2.0 * dist)) * 0.1;
				} else {
					corr = to_base * (max(dist - base_pos.w, 0.0) / max(dist, 0.001));
				}
				shared_pos[slot] = p + corr;
			}
			workgroupBarrier();

			// anchor tether constraints
			if (is_active) {
				let read_off = ping << 8u;
				let slot = read_off + tid;
				var p = shared_pos[slot];
				if (anchor_idx.x != -1) {
					let ap = read_shared_pos(anchor_idx.x, read_off);
					let dvec = ap - p;
					let d2 = dot(dvec, dvec);
					let d = sqrt(d2);
					let excess = max(d - anchor_dist.x, 0.0);
					p += dvec * (excess * inverseSqrt(max(d2, 1e-12)));
				}
				if (anchor_idx.y != -1) {
					let ap = read_shared_pos(anchor_idx.y, read_off);
					let dvec = ap - p;
					let d2 = dot(dvec, dvec);
					let d = sqrt(d2);
					let excess = max(d - anchor_dist.y, 0.0);
					p += dvec * (excess * inverseSqrt(max(d2, 1e-12)));
				}
				next_pos = p;
				shared_pos[slot] = p;
			}
			workgroupBarrier();
		}

		// recompute normal/tangent frame, write 3×4 bone matrix and updated node state
		if (is_active) {
			let read_off = ping << 8u;
			let final_pos = next_pos;

			var sum_n = vec3f(0.0);
			var sum_t = vec3f(0.0);
			var sum_b = vec3f(0.0);

			let nbrs = array<i32, 8>(
				nbr_idx_lo.x, nbr_idx_lo.y, nbr_idx_lo.z, nbr_idx_lo.w,
				nbr_idx_hi.x, nbr_idx_hi.y, nbr_idx_hi.z, nbr_idx_hi.w,
			);
			if (nbrs[0] >= 0) {
				var prev_dp = read_shared_pos(nbrs[0], read_off) - final_pos;
				var prev_duv = read_shared_uv(nbrs[0]) - my_uv;
				for (var k = 1u; k < 8u; k++) {
					let ni = nbrs[k];
					if (ni >= 0) {
						let dp = read_shared_pos(ni, read_off) - final_pos;
						let duv = read_shared_uv(ni) - my_uv;
						sum_n += cross(prev_dp, dp);
						let det = prev_duv.x * duv.y - prev_duv.y * duv.x;
						if (abs(det) > 1e-5) {
							let inv_det = 1.0 / det;
							sum_t += (duv.y * prev_dp - prev_duv.y * dp) * inv_det;
							sum_b += (prev_duv.x * dp - duv.x * prev_dp) * inv_det;
						}
						prev_dp = dp;
						prev_duv = duv;
					}
				}
			}

			let n = sum_n * inverseSqrt(max(dot(sum_n, sum_n), 1.17549435e-38));
			let t_raw = vec3f(
				select(sum_t.x, 0.0, sum_t.x == 0.0),
				select(sum_t.y, 0.0, sum_t.y == 0.0),
				select(sum_t.z, 1.0, sum_t.z == 0.0),
			);
			let t_orth = t_raw - n * dot(n, t_raw);
			let t = t_orth * inverseSqrt(max(dot(t_orth, t_orth), 1.17549435e-38));
			let b_raw = cross(n, t);
			let b = b_raw * safe_sign(dot(b_raw, sum_b));

			// rigid transform from rest frame (base_t, base_b, base_n, base_pos) to current frame (t, b, n, final_pos)
			let base_b = cross(base_normal, base_tangent.xyz) * base_tangent.w;
			let inv_t = vec4f(
				dot(base_tangent.xyz, -base_pos.xyz),
				dot(base_b, -base_pos.xyz),
				dot(base_normal, -base_pos.xyz),
				1.0,
			);
			let bx = vec3f(base_tangent.x, base_b.x, base_normal.x);
			let by = vec3f(base_tangent.y, base_b.y, base_normal.y);
			let bz = vec3f(base_tangent.z, base_b.z, base_normal.z);

			let c0 = vec4f(t.x, b.x, n.x, final_pos.x);
			let c1 = vec4f(t.y, b.y, n.y, final_pos.y);
			let c2 = vec4f(t.z, b.z, n.z, final_pos.z);

			// M_world (3×4 rows)
			let mw0 = vec4f(dot(c0.xyz, bx), dot(c0.xyz, by), dot(c0.xyz, bz), dot(c0, inv_t));
			let mw1 = vec4f(dot(c1.xyz, bx), dot(c1.xyz, by), dot(c1.xyz, bz), dot(c1, inv_t));
			let mw2 = vec4f(dot(c2.xyz, bx), dot(c2.xyz, by), dot(c2.xyz, bz), dot(c2, inv_t));

			// M_wl = M_world * localToWorld (4 columns, each vec3f / vec4f)
			let mwl_c0 = vec3f(dot(mw0.xyz, l2w_c0), dot(mw1.xyz, l2w_c0), dot(mw2.xyz, l2w_c0));
			let mwl_c1 = vec3f(dot(mw0.xyz, l2w_c1), dot(mw1.xyz, l2w_c1), dot(mw2.xyz, l2w_c1));
			let mwl_c2 = vec3f(dot(mw0.xyz, l2w_c2), dot(mw1.xyz, l2w_c2), dot(mw2.xyz, l2w_c2));
			let mwl_c3 = vec4f(dot(mw0, l2w_c3), dot(mw1, l2w_c3), dot(mw2, l2w_c3), 1.0);

			// M_object = worldToLocal * M_wl (3×4 rows)
			let skel_base = node_idx * 3u;
			skeletons[skel_base] = vec4f(
				dot(w2l0.xyz, mwl_c0),
				dot(w2l0.xyz, mwl_c1),
				dot(w2l0.xyz, mwl_c2),
				dot(w2l0, mwl_c3),
			);
			skeletons[skel_base + 1u] = vec4f(
				dot(w2l1.xyz, mwl_c0),
				dot(w2l1.xyz, mwl_c1),
				dot(w2l1.xyz, mwl_c2),
				dot(w2l1, mwl_c3),
			);
			skeletons[skel_base + 2u] = vec4f(
				dot(w2l2.xyz, mwl_c0),
				dot(w2l2.xyz, mwl_c1),
				dot(w2l2.xyz, mwl_c2),
				dot(w2l2, mwl_c3),
			);

			// write back previous position, current position, and current normal
			cloth_nodes[node_idx][20] = bitcast<u32>(cur_pos.x);
			cloth_nodes[node_idx][21] = bitcast<u32>(cur_pos.y);
			cloth_nodes[node_idx][22] = bitcast<u32>(cur_pos.z);
			cloth_nodes[node_idx][24] = bitcast<u32>(final_pos.x);
			cloth_nodes[node_idx][25] = bitcast<u32>(final_pos.y);
			cloth_nodes[node_idx][26] = bitcast<u32>(final_pos.z);
			cloth_nodes[node_idx][28] = bitcast<u32>(n.x);
			cloth_nodes[node_idx][29] = bitcast<u32>(n.y);
			cloth_nodes[node_idx][30] = bitcast<u32>(n.z);
		}
		workgroupBarrier();
	}
}
