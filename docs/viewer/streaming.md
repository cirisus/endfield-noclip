# streaming and selection

every frame whose view or content changed runs one traversal; frames that only settle antialiasing
or exposure reuse the last selection. "frames" in the stream rules below count traversals.

1. walk the tile tree for terrain patches and instance row ranges; advance spinning and riding rows
   in selected blocks ([per-instance LOD](#per-instance-lod)).
2. cull, LOD-select, and bucket instances in those ranges.
3. request sky textures, water surfaces, and irradiance cells.
4. cancel, dispatch, upload, and evict blobs; adjust [texture reduction](#residency-and-budgets) and
   apply texture shrinks.
5. if rendering, write per-frame GPU buffers.

## tile tree

the tile tree links quadtree nodes to their children and splits each node's content refs by kind:
terrain height page, terrain surface page, leaf terrain splat page, HLOD refs (with tier), detail
refs, and conditional refs. nodes at or below the cell level record their cell id for current-level
[priority](#priority).

## levels

every level in a package renders at once; a visibility group's level only records ownership. the
viewer tracks one current level, chosen in order from:

1. the `level` URL parameter at load (else the first level with instances);
2. a level picked in the levels panel (which also flies over it);
3. the level owning the 128 m cell the camera enters (ignoring the initial load cell, a level-flight
   landing cell, and unowned cells).

the current level sets the [base environment](environment.md#blending-at-the-camera), streams
immediately after near-camera tiles, and lists its controls first in the
[scene conditions panel](scene-states.md#the-scene-conditions-panel).

## instance selection

instance selection uses 3D Tiles-style REPLACE refinement over the game's
[HLOD rings](../game-data/world.md#streaming-layers) by camera-to-bounds distance. because packages
omit per-cluster [linked children](../game-data/world.md#lod-and-hlod), a tile swaps all of its
clusters together:

| node / ref            | refinement / draw rule                                                                                                   |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| HLOD tier 0           | refines within `detailDistance` (default 160 m, game's high PC preset 4000)                                              |
| HLOD tier 1           | refines within `max(512 m, detailDistance)` (HLOD0 radius)                                                               |
| HLOD tier 2           | refines within `max(1024 m, detailDistance)` (HLOD1 radius); keeps drawing past 2048 m so overviews aren't empty         |
| no shown HLOD         | internal nodes always refine; leaves refine within `detailDistance`                                                      |
| conditional (reached) | draws while `detail` is on and camera is inside its [reach](../package-format.md#tile-tree) rectangle (~0.1 ms on map02) |
| conditional (other)   | draws while `detail` is on within `detailDistance` of its tile (scene-state content, facilities)                         |
| global refs           | pinned, drawn whenever resident, never requested, no radius limit                                                        |

- **hysteresis and cross-fade.** refined nodes and conditional tiles stay active until 20 m past
  their load ring (the game's `unloadDirtyDistance`), and reached dynamic blocks stay active until
  `min(10, span / 30)` m past each edge of their reach rectangle (matching the game's
  `min(3 · cell + 20, 3.2 · cell)` dynamic-grid unload square), preventing boundary thrashing.
  crossing a ring or reach boundary dissolves over 0.35 s: opaque and cutout meshes dither in/out
  with complementary noise thresholds (non-fading opaque draws stay on the early-Z prepass while
  fading buckets use a fading prepass), and transparent meshes and scene effects scale alpha.
  transitions snap on camera jumps (> 64 m) or when animation is paused.
- **no holes.** a node keeps drawing its own HLOD until all refinement targets are resident.
  disabled HLOD tiers are refined past.
- **empty leaves.** with `detail` on, a leaf refines even if it has no detail blocks, because a
  cluster's children may live in neighbouring leaves.
- **geometric error.** package geometric error (1/16 of a node's edge) only orders
  [priority](#priority); screen-space error refinement would draw detail far beyond the game's
  radius.
- **reached blocks.** dynamic structures (e.g. Dijiang's planet and satellites) and LOD-proxy effect
  layers ([chains](../package-format.md#binary-encodings)) use reach rectangles so they stay visible
  from distant vantage points.
- **visibility groups.** every ref draws only while its visibility group is shown. shown groups
  ([package-format.md](../package-format.md#visibility-groups)) update when a scene value or camera
  stream area changes and are shared by the selector, water, local lights, and irradiance volume.

## terrain selection

terrain uses CDLOD with a viewer-defined LOD rule (the game's `maxHeightError` is not an error
bound; see [terrain](../game-data/terrain.md)).

- each level's distance range derives from its sample spacing and `terrainPixels` (default 3 px per
  sample).
- a node subdivides while the next finer range reaches it. quadrants whose child page is not
  resident draw from the parent page while requesting the child.
- vertices morph to the coarser grid over the last 30% of a level's range (coarsest never morphs).
- every selected quadrant is an instance of one shared grid, drawn in a single call.
- each visited node requests its surface page at the same priority and shades from the finest
  resident surface page at or above it.
- leaves within `DETAIL_DISTANCE` (160 m) also request their splat page for
  [close-up layers](terrain.md#close-up-layers) (pinning all layer textures when the first splat
  page arrives). `terrainSurface` and `terrainSplat` toggle them; neither loads without BC support.

## per-instance LOD

before selection runs, moving rows in selected blocks update on the CPU and re-upload to the GPU:

- **spinning rows**: rotates transforms and bounds centres from their stored pose by the viewer
  clock (phase starts at 0, not the game's gameplay clock) and re-uploads runs bridging ≤ 8 still
  rows.
- **riding rows**: offsets each row's translation and bounds centre by its path at the viewer clock
  (loop starts at 0), moving meshes, effects, billboards, cull spheres, and particle emitter frames
  (including live world-space particles) together.
- any selected block with spinning or riding rows forces re-traversal on rendered frames so shadows
  follow.

**group culling.** the decode worker groups every 32 consecutive rows with group sphere, max row
radius, segments, and handedness (median radius ~20 m on map02); selection fills in each group's
farthest LOD reach on first use. a group failing any cull test is skipped whole, except groups with
spinning or riding rows.

**per-instance steps (CPU path)**:

1. cull by projected bounding-sphere radius (`minBoxPixels`, default 1.5 px) and frustum planes.
2. compute Unity's LODGroup metric (`2 × maxHalfExtent / screenHeight`, unverified; see
   [chains](../package-format.md#binary-encodings)), or squared distance to origin for
   `CameraDistance` chains, and pick every draw whose `(minSquared, maxSquared]` band contains it.
   instances past the smallest threshold or in an empty band are culled.
3. if all picked geometries are resident, append the row to a bucket keyed by
   `(geometry, submesh, material, mirrored)` (`mirrored` = negative transform determinant, flips
   triangle winding). otherwise request missing geometries at projected pixel height and draw the
   nearest resident LOD (coarser on ties, protected from eviction, not requested). only instances
   with no resident LOD draw boxes (particle emitters and shadow-only instances never do).

### GPU culling

with `gpuCulling` on (default when `indirect-first-instance` is supported), the CPU operates per
segment (rows of one group in one chain run: bounds, min/max LOD size, handedness) and a compute
pass tests individual rows.

for each passing segment, the CPU:

1. picks all slots whose bands the segment can reach (bands widened 2% for f32).
2. requests missing geometry at the segment's max priority, capped at each slot's band top (falling
   back to stand-in LOD slots). priority uses max row at nearest centre unless row centres spread
   > 1/4 of their distance, in which case rows are measured individually — avoiding a ~9× texture
   > spike near the 0.1 m floor at close indie_race001 views (measured + capped is ~1.3× the CPU
   > path).
3. reserves bucket space for visible rows and for every reachable shadow layer.

`instance cull` appends each passing row (in-view and out-of-view casters) to its bucket regions and
writes indirect draw arguments, skipping empty shadow layers.

- **CPU fallback.** segments stay on the CPU path if their chain draws particles, has a
  `CameraDistance` band or non-opaque/alpha-tested slot, needs a box fallback with no resident
  stand-in, or belongs to a spinning/riding group.
- **overhead.** segment-range slot picking leaves some buckets empty (~50% more draws at a dense
  Jingyu view, far cheaper than CPU selection). in-view instance/triangle stats read back a few
  frames late.
- **occlusion culling.** with `occlusionCulling` on (default), `depth pyramid` reduces last frame's
  depth to a farthest-depth pyramid (half-res level 0). each row's bounding-sphere cube is
  reprojected to last frame's camera, widened 1 texel for jitter, and tested at the level spanning ≤
  3×3 texels. occluded rows skip the main pass (still casting shadows). bypassed for boxes crossing
  the screen edge or near plane, on the first frame, after a cut, or when the eye moved > 8 m.
  disoccluded rows appear 1 frame late. flying over Jingyu, this hides ~1/3 of in-view triangles and
  cuts ~5% GPU time.

**face culling, UVs, and textures**:

- front faces are clockwise (Unity); mirrored buckets flip front/back culling. each mesh phase
  (including shadows) has a pipeline per `(cullMode, uvFormat)`, sorted by both. the vertex shader
  dequantizes 16-bit UVs via per-draw transforms.
- invisible materials and non-casting shadow-only draws are stripped from each chain on first use
  ([unsupported](materials.md#unsupported-materials) materials still draw). remaining shadow-only
  draws go to cast-only buckets.
- texture pieces are requested per bucket down to the needed mip + `textureBias` (default 0; each
  level quarters memory):
  - **mip feedback** for main-pass materials;
  - **screen size × UV tiling** (~1 texel/pixel across largest on-screen use) for glass, scene
    effects, cast-only buckets, parallax, and layer slots;
  - **whole texture** for sky, water, and 3D effect textures.

### mip feedback

screen-size estimation over-requests on hulls, atlases, trim sheets, and occluded streets (~450 MiB
at Wuling City street level; packer-computed UV density asked for even more on distant atlases).

instead, the GPU reports sampled footprints:

- opaque and alpha-tested main-pass shaders write look-table slot + longest UV-footprint axis for
  both UV sets in quarter-levels to a 5th main-pass target. equal-depth shading ensures only visible
  surfaces report; colour swatches (> 32 km per UV unit) report nothing.
- a compute pass reads 1 pixel per 4×4 block (rotating each frame) and keeps the finest footprint
  per `(material, uvSet)`. readbacks arrive a few frames later and merge across two windows of ≥ 16
  readbacks and 0.4 s, dropping off-screen materials in ~1 s.
- target mip is `log2(texels · tiling) − footprintLevels`, rounded per sampler mode. applies to base
  colour, normal, mask, emissive, and detail slots. drawn but unreported materials request 2 levels
  coarser than screen size, capped at 256 px. unused levels stay resident until evicted.
- cuts Wuling City textures in use to 150–250 MiB. falls back to screen-size when the feedback
  target is unsupported or `mipFeedback` is off.

the CPU path outputs the same visible-row list and per-bucket ranges as GPU culling.

## priority

- **base.** SSE for tiles; projected pixel height for geometry and textures.
- **boosts.** ×64 within 256 m of camera; ×8 for farther tiles in the current level's cells.
- **off-frustum.** ×0.1 where traversal reaches outside the frustum: terrain children prefetch and
  [off-screen casters](lighting.md#shadows) (and their geometry).
- **texture pieces.** `bucketPriority / (1 + pieceIndex)` — coarse levels load first, while adjacent
  pieces in one archive coalesce into a single round trip.
- **fixed high priority.** irradiance cells and whole-streamed sky/water textures sit above all
  scenery; effect 3D textures use their bucket's priority.

## residency and budgets

the stream manager tracks blob lifecycles:
`idle → queued → fetching → fetched → decoding → uploading → ready` (or `failed`, never retried;
failed shard reads retry twice from `idle` to tolerate transient empty dev-server answers).

- **wanting.** traversal marks wanted blobs with priority every frame. wanted resident blobs count
  as used even while a coarser stand-in draws, preventing eviction during refinement.
- **pinning.** core heights, core instances (coarse terrain, HLODs, global scenery), and core
  surfaces (if BC supported) are pinned at load. terrain layer textures pin when the first splat
  page arrives (saving tens of MB on overviews). pinned blobs load from memory, upload first, and
  never evict. pinned heights stay on the CPU for ground-height queries.
- **fetching.** max 32 range reads in flight (3× faster than 8 on Wuling; 64 or wider coalescing
  gains little). queued blobs seed reads by priority and coalesce same-archive neighbours (gap ≤ 64
  KiB, span ≤ 2 MiB, ≤ 96 blobs). up to 32 reads (≤ 2 MiB total, always ≥ 1 full read) bundle into
  one multi-range request where supported ([sources](loading.md#sources)), halving map02 flight
  requests and cutting p95 wait 25–33%. blobs are sorted by archive offset once at open, so dispatch
  heapifies and walks neighbours instead of re-sorting. core blobs skip request slots. requests
  unwanted > 2 frames abort; queued blobs unwanted this frame return to `idle`. new reads pause at
  384 undecoded blobs.
- **decoding.** fetched blobs queue in the stream manager; each freed worker slot (64/worker; see
  [decode workers](loading.md#decode-workers-and-zstd)) pulls the highest-priority blob. blobs
  unwanted for 30 frames are dropped. new decodes pause above 64 MiB of raw blobs decoding or
  awaiting upload (at least 1 blob always proceeds).
- **uploading.** pinned first, then by priority, up to 24 MiB or 2 ms/frame for unpinned uploads (at
  least 1/frame; game uses 1.5 ms, see [streaming layers](../game-data/world.md#streaming-layers)).
  large uploads use a [staging buffer](gpu-resources.md). decoded blobs unwanted for 30 frames are
  dropped. on a full pool, evicts up to 16 unused unpinned same-kind blobs of ≤ priority (oldest
  first) and retries.
- **budget.** all resident bytes count against `budgetMiB` (default 1536). over budget, LRU unused
  unpinned blobs evict. if in-use bytes still exceed budget, the manager becomes _saturated_:
  unpinned fetches and uploads pause (queued blobs return to `idle`, decoded blobs drop) to avoid
  thrashing.
- **texture reduction.** while saturated and in-use textures ≥ 25% of budget, texture reduction adds
  +0.5 mip to material texture requests (on top of `textureBias`, max 3) every 4 frames, letting
  freed levels evict so paused loads resume (e.g. North Wuling `(-508, 235, 1018)` wants ~600 MiB of
  textures; +1 mip more than halves it). every 30 frames it lowers by 0.5 if `inUse + inUseTextures`
  fits in 85% of budget. the frame loop keeps traversing a still view while a raise may help. shown
  beside texture bytes in the stats panel. the game uses Unity's
  [texture streaming](../game-data/world.md#texture-streaming) with a texture-only budget.
- every upload and eviction triggers a redraw.
