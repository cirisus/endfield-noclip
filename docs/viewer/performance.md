# performance

measurement instructions are in [driving the viewer](../driving-the-viewer.md#profiling).

- **redraw only when dirty.** `Viewer.#tick` renders when the camera moved, canvas resized, an
  option or scene value changed (`#dirty`), a water level is moving, stream `version` changed, a
  pipeline compiled, tab visibility returned (works around a Firefox R/B swap bug on hidden tabs),
  or `continuous` is on.
  - renders 32 more frames (`SETTLE_FRAMES`) after any change so TAA converges (skipped if
    `antialiasing` is off).
  - keeps rendering while auto exposure adapts (or awaits its first histogram), but meters new
    histograms only during changes/settling so water and particles don't prevent convergence.
  - animated content (scrolling UVs, water, clouds, particles, drifting
    [flow noise](../game-data/sky-and-fog.md#flow-noise)) reads one animation clock that advances
    only on rendered frames with `animate` on, pausing cleanly when idle.
  - settle/adapt frames reuse the last selection unless `animate` is on and particles or
    spinning/riding rows are visible.
  - traverses without rendering while `!stream.idle` or while a saturated stream may raise
    [texture reduction](streaming.md#residency-and-budgets); does nothing when still and idle.
  - environment re-blends only when eye, settings, or a fade changes.
- **throttled stats and UI.** stats publish every 250 ms and notify subscribers only on JSON change.
  environment UI tracks a separate revision (name, applied volume phases, rounded weights) used only
  by the settings panel's applied volumes and look legend. scene conditions sections render lazily
  when expanded (`LazyDetails`), cutting map02 re-renders from > 100 ms to a few tens of ms (still
  re-renders on level change).
- **group culling.** mesh selection rejects 32-row groups before testing individual rows
  ([per-instance LOD](streaming.md#per-instance-lod)), cutting ~20% off dense map02 views.
- **GPU culling and occlusion.** resident groups cull in compute and emit indirect draws
  ([GPU culling](streaming.md#gpu-culling)), cutting ~25% off dense Jingyu frames (halving mesh
  selection). last-frame depth-pyramid occlusion culling cuts ~5% GPU time flying over Jingyu.
- **game detail radius.** detail draws within `detailDistance` (default 160 m, game's high preset)
  and HLOD past it ([instance selection](streaming.md#instance-selection)); mesh selection scales
  with rows in reach (a few hundred thousand foliage rows in Jingyu ≈ half the frame).
- **capped particle replay.** full emitters jump directly to the earliest particle death time using
  a min-heap of end times, avoiding hundreds-of-ms hitches on map02 effects emitting 10M/s capped at
  1 particle.
- **one traversal, many passes.** shadow layers reuse the frame's selection buckets. settle/adapt
  frames keep cached shadow layers unless a fit moved or pipelines were compiling.
- **few draws, pooled geometry.** terrain is 1 draw/pass, ordered by first reachable shadow layer
  (cutting lv008 sharp shadow layer time to ~1/3). each mesh bucket is 1 instanced `drawIndexed`.
  depth-writing draws sort by `(pipeline, pool, nearest-first)` for early-Z; others by
  `(pipeline, pool, geometry, material)`
  ([`render/meshes/draw-order.ts`](../../packages/viewer/src/render/meshes/draw-order.ts)).
  [geometry pools](gpu-resources.md#buffers-and-pools) share vertex/index buffers, cutting encoding
  by 33–50% on map02 views of a few thousand draws.
- **depth prepass.** opaque meshes write depth only (no fragment shader), then terrain skips covered
  pixels, then opaque meshes shade at `depthCompare: 'equal'` using the same `@invariant` position
  function. saves ~1/7 GPU time on dense RDNA 2 2560×1600 views.
- **early depth with alpha test.** opaque pipelines never discard (shadow pipelines have no fragment
  stage). alpha-tested meshes write cut-out depth before terrain, then shade at
  `depthCompare: 'equal'` without discarding, cutting main-pass time ~25% at dense Jingyu views.
  alpha-tested materials draw opaque until their
  [alpha texture](../game-data/materials.md#alpha-testing) streams in.
- **no MSAA.** at 2560×1600 on Apple M-series, 4× MSAA cost ~3× the GPU time of TAA (< 1 ms) and
  > 2× target memory. `renderScale` 0.5 cuts GPU time to ~1/3.
- **half-resolution SSR and AO.** [SSR](lighting.md#screen-space-reflections) runs at half
  resolution (matching PC high). `ao depth` downsamples depth once; GTAO marches half-res depth and
  depth-aware blur upsamples.
- **cached work.** transmittance and multiple-scattering LUTs render once per environment;
  irradiance clipmaps update only on re-centre or new cells; local lights select/bin/upload only on
  camera, size, or visibility changes.
- **mip feedback.** [mip feedback](streaming.md#mip-feedback) cut resident textures at
  street/interior stops by 33–67%, downloads by 25–40%, and map02 walk frame median/p95 from ~15/34
  ms to 12/23 ms (eliminating > 50 ms upload stalls). target costs 4 B/px; compute/readback overhead
  unprofiled.
- **staged uploads.** uploads ≥ 128 KiB use [staged writes](gpu-resources.md#pipelines-and-uploads),
  avoiding 15–30 ms/MiB main-thread stalls.
- **decode and fetch pipeline.** 64 jobs/worker (64 MiB cap;
  [decode workers](loading.md#decode-workers-and-zstd)) cut map02 teleport settle from 2.5 s to ~1 s
  and page load from 5 s to ~2 s; [multi-range requests](streaming.md#residency-and-budgets) halved
  flight request counts.
- **tabulated particles.** velocity-curve integrals read from precomputed tables
  ([motion](particles.md#motion)); colours evaluate without allocating.
- **zero per-frame hot-path allocation.** selections, buckets, and plane arrays reuse storage across
  frames; per-bucket texture requests allocate nothing. the stream manager evicts from a ready
  unpinned set and reads each shard blob's byte range once.

target reuse: `composite` needs its own HDR target so next frame's SSR can read it after `main`
overwrites radiance; `celestial` reuses the sky reflection target after SSR finishes.

## baseline

indicative numbers from map02 on RDNA 4 at 2560×1600 (not a specification).

**2026-11-07 (initial run)**:

| measure                                                 | value     |
| ------------------------------------------------------- | --------- |
| flight (40 m/s, 40 m AGL), median/p95                   | ~7/20 ms  |
| settled (Jingyu, Jingyu ground, lv008 overview)         | 6–7 ms    |
| GPU at those views                                      | ~5 ms     |
| `mesh select` at those views                            | 3.5–4 ms  |
| `encode`, `prepare`                                     | < 1.5 ms  |
| teleport to idle / page load to idle                    | 3 s / 5 s |
| GPU pool bytes (including geometry pool spare capacity) | ~800 MiB  |

flight hitches are bursts of mesh selection and draw preparation, not uploads, instance-block
builds, or material derivations.

**2026-11-11 walks (12 m/s, eye height) and crossings (60–80 m/s, 40 m AGL), uncapped frame rate
(p95 includes [backpressure](../driving-the-viewer.md#profiling)):**

| route                                        | pre-feedback median/p95 | with mip feedback (11-12) | `mesh select` | GPU    |
| -------------------------------------------- | ----------------------- | ------------------------- | ------------- | ------ |
| Wuling City walk                             | 12/27 ms                | 12/24 ms                  | 6 ms          | 7 ms   |
| Jingyu Valley walk                           | 14/29 ms                | 12/23 ms                  | 7 ms          | 8 ms   |
| Qingbo Stockade walk                         | 11/25 ms                | 10/19 ms                  | 6 ms          | 8 ms   |
| Si's Painting walk                           | 5/14 ms                 | 5/14 ms                   | 1.5 ms        | 5 ms   |
| map02 crossing (8 levels)                    | 17/34 ms                | 16/34 ms                  | 6 ms          | 7 ms   |
| map01 walks (Hub, Lodespring, Power Plateau) | 4–5/9–12 ms             | unchanged (±1 ms)         | 1.5–2.5 ms    | 3–6 ms |
| map01 crossing (6 levels)                    | 5/14 ms                 | unchanged (±1 ms)         | 2 ms          | 5 ms   |

**2026-11-14 (multi-range requests + 64 decode jobs/worker, same-day A/B on first table's run)**:

- page load to idle: 5.2 s → 2.2 s; Jingyu / lv008 teleport to idle: 2.6 s → 1.0 s.
- flight frame median/p95: 6.9/18 ms → 6.3/16 ms; requests: ~18,000 → 8,000.
- p95 wait from want to ready: meshes 400 ms → 110 ms, textures 340 ms → 140 ms. at teleports,
  meshes still wait longest (~0.5 s median vs ~0.1 s textures; cause uninvestigated).

**bottlenecks and static memory**:

- map02 walks are CPU-bound: in Wuling City, ~1/3 of `mesh select` is placing particles (a few
  thousand live across ~100 emitters) and the rest is per-segment bookkeeping (~9k segments).
- every route ends with a full budget (1–3 GB downloaded per walk, uncategorized): on Wuling City
  walk, ~40% of uploaded texture bytes and 50% of geometry bytes were re-uploads of evicted blobs
  (half evicted < 7 s earlier).
- non-streaming GPU allocations at 2560×1600 total ~540 MiB: main targets 215 MiB, post targets 165
  MiB, sun shadow map 64 MiB, local-light shadow atlas 64 MiB, volumetric fog 21 MiB.

## optimization candidates

see [quality settings](../game-data/quality-settings.md) for what the game toggles.

- **GPU LOD selection.** moving slot picking and bucket allocation to GPU (count, prefix sum, write)
  would reduce CPU work from per-segment to per-row-group.
- **particle caching / offload.** cache immutable per-particle start attributes instead of
  re-hashing every frame (~1 µs/particle on CPU), or move placement to a worker or compute shader.
- **eviction policy.** keeping integrated texture mips +0.5 level past use cut repeat uploads by 1/3
  on Wuling walk but triggered saturation/reduction (reverted). untried: evict textures before
  geometry (geometry is ~1/7 the bytes and costlier to reload), or size budget to the device.
- **16-bit local-light shadow atlas.** currently `depth32float` (64 MiB); `depth16unorm` needs a
  larger near plane for short-range perspective depth.
- **empty GPU-culled draws.** segment-range picking leaves empty buckets the CPU still encodes.
- **settle-frame selection reuse.** fixed row spans for emitters and swept bounds for moving rows
  would let settle frames skip re-traversal.
- **shadow caching.** cache cascades across selections when fit and casters match; tile the far
  shadow layer (game caches 200 m tiles and redraws ≤ 8/frame instead of the whole layer).
- **small shadow-caster culling.** game culls casters by `CSMScreenSizeMin` / `ASMScreenSizeMin`
  (metric undecoded; verify against in-game shots at 30–80 m first).
- **16-bit sun shadow map.** tighten depth range (caster bounds or `depth-clip-control` near-plane
  clamping) to switch from `depth32float` (1500 m reach, 64 MiB) to `depth16unorm` (32 MiB, half
  bandwidth; requires bias retuning).
- **pack ambient + sky reflection.** combine both `rgba16float` targets (16 B/px, reflection alpha
  unused) into one `rg32uint` (shared-exponent or 11-11-10) to save ~32 MiB at 2560×1600 and
  matching reads (`celestial` would need its own target).
- **geometry pool compaction.** compact or shrink pools when mostly free so unused capacity returns
  to the device ([geometry pools](gpu-resources.md#buffers-and-pools)).
- **AO blur reads.** pack depth with AO or use `textureGather`.
- **terrain close-up blending.** profile stochastic projection or lower anisotropy.
- **timestamp queries.** measure overhead before restricting queries to when the stats panel is
  open.
