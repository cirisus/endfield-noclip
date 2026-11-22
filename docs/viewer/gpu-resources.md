# GPU resource management

## device and layouts

[`gfx/device.ts`](../../packages/viewer/src/gfx/device.ts) requests the adapter's limits for sampled
textures and storage buffers per stage (effects exceed WebGPU's default of 16 sampled textures);
samplers stay at the default. optional features: BC textures (without them, BC textures don't stream
and materials use untextured looks), stencil (effect portals), and timestamp queries (GPU
profiling).

fragment-stage bindings vs WebGPU defaults:

| pipeline | sampled textures (16) | samplers (16) | storage buffers (8) |
| -------- | --------------------- | ------------- | ------------------- |
| mesh     | 14                    | 9             | 4                   |
| terrain  | 12                    | 7             | 4                   |
| effects  | 19                    | 15            | 4                   |
| water    | 15                    | 7             | 3                   |

## buffers and pools

- **range allocator**
  ([`gfx/range-allocator.ts`](../../packages/viewer/src/gfx/range-allocator.ts)): first-fit over
  units with neighbour coalescing on free to bound fragmentation. sub-allocates `GrowableBuffer`s
  ([`gfx/growable-buffer.ts`](../../packages/viewer/src/gfx/growable-buffer.ts)), which double via
  GPU copy when full and never shrink (owners rebuild bind groups when `version` changes). fixed
  texture arrays allocate full size up front since arrays cannot grow without copying every layer:

  | pool                   | backing                                        | initial                               | max            |
  | ---------------------- | ---------------------------------------------- | ------------------------------------- | -------------- |
  | instance rows          | `GrowableBuffer` (96 B/row, 1 range/block)     | 128k (12 MiB)                         | 1.5M (137 MiB) |
  | irradiance cells       | `GrowableBuffer`                               | 32 MiB                                | 192 MiB        |
  | terrain height pages   | `GrowableBuffer` (1 unit/page)                 | 1024 (8 MiB)                          | 4096 (33 MiB)  |
  | rect decal placements  | `GrowableBuffer`                               | growable                              | —              |
  | terrain surface pages  | 2 × BC3 texture arrays (1 layer/page)          | 1024 layers (34 MiB, or device limit) | fixed          |
  | terrain splat pages    | RGBA8 control + BC3 tint arrays + index buffer | 256 slots (21 MiB)                    | fixed          |
  | terrain layer textures | 2 × BC7 texture arrays                         | sized at load                         | fixed          |

- **geometry pools**
  ([`render/meshes/geometry-pools.ts`](../../packages/viewer/src/render/meshes/geometry-pools.ts)):
  still geometry sub-allocates from shared vertex and index buffers so draws bind once and offset
  via `baseVertex` / `firstIndex` (copied into indirect args by the GPU culler).
  - four vertex pools by `(uvFormat, streamSet)`: _compact_ (positions, normals, UV0, tangents; ~90%
    of map02 vertices; binds UV0 as UV1 and normals as colours, ignored without `HasColors`) and
    _full_ (all 6 streams), plus one index pool per index format. splitting compact vs full avoids
    ~33% padding for missing streams.
  - start at 64k vertices / 1 MiB indices, grow 1.5× up to `maxBufferSize`, never shrink (residency
    counts used ranges; stats pool bytes count whole buffers).
  - draws sort by pool within each pipeline, cutting vertex-buffer rebinds to a handful per frame.
  - animated geometries (written by compute skinning, with bind pose/frames/params alongside) and
    still geometries that don't fit a pool use standalone vertex buffers + a zero buffer for missing
    streams.
- **uniform ring** ([`gfx/uniform-ring.ts`](../../packages/viewer/src/gfx/uniform-ring.ts)): one
  uniform buffer split into 3 per-frame regions, sub-allocated at `minUniformBufferOffsetAlignment`.
  `flush` uploads the frame's region in one `writeBuffer`; draws bind group 0 with dynamic offsets.
  [`render/frame/frame-uniform-writer.ts`](../../packages/viewer/src/render/frame/frame-uniform-writer.ts)
  packs the main block plus view-projection copies for each shadow layer and local-light shadow
  tile.
- **bind layouts**
  ([`render/frame/bind-layouts.ts`](../../packages/viewer/src/render/frame/bind-layouts.ts)):
  - **group 0** (frame): uniforms, shadow map, reflection cubemap, irradiance clipmaps, shadow ramp,
    local lights (records, bins, shadow atlas), cloud shadow. shared by every family and volumetric
    fog; bound once per pass.
    [`render/frame/frame-bindings.ts`](../../packages/viewer/src/render/frame/frame-bindings.ts)
    builds main and shadow group 0s (shadow passes bind a depth placeholder for the shadow map;
    unstreamed textures use placeholders and rebuild only on view change).
  - **group 1**: per family.
  - **group 2** (meshes): 16-float per-draw parameters (rewritten each frame: dequantization, look
    flags + streaming/stream state, UV transforms, look-table slot), look table, and fog inputs.
  - **group 3** (meshes): material textures
    ([`mesh-pipelines.ts`](../../packages/viewer/src/render/meshes/mesh-pipelines.ts), vertex stage
    samples 2 slots for [vertex offset](materials.md#vertex-offset)).
  - **look table** ([`mesh-renderer.ts`](../../packages/viewer/src/render/meshes/mesh-renderer.ts)):
    `GrowableBuffer` of 768-byte (`LOOK_FLOATS`, 48 rows) immutable slots, starting at 4096 (3 MiB)
    and doubling as needed. assigned on first draw, uploaded in one write per new run, replaced on
    package unload.

## pipelines and uploads

- **pipeline cache** ([`gfx/pipeline-cache.ts`](../../packages/viewer/src/gfx/pipeline-cache.ts)):
  caches shader modules by label and pipelines by state key (e.g. `mesh/opaque/back/unorm16x2`) via
  `createRenderPipelineAsync` / `createComputePipelineAsync` (`prepareCompute` for volumetric fog,
  irradiance update, auto-exposure histogram, skinning, instance culler, depth pyramid), once per
  session. renderers pre-warm their pipelines at construction; only mesh stencil variants (portals)
  compile on first use. fullscreen post passes and lens flare compile synchronously outside the
  cache. draws/dispatches skip while compiling and trigger a redraw when ready. related modules:
  [`render/meshes/mesh-pipelines.ts`](../../packages/viewer/src/render/meshes/mesh-pipelines.ts),
  [`draw-ranges.ts`](../../packages/viewer/src/render/meshes/draw-ranges.ts),
  [`gfx/blend.ts`](../../packages/viewer/src/gfx/blend.ts), and
  [`vertex-bindings.ts`](../../packages/viewer/src/render/meshes/vertex-bindings.ts)
  (position/normal layouts shared by meshes and water).
- **buffers** ([`gfx/buffers.ts`](../../packages/viewer/src/gfx/buffers.ts)): static buffers
  (indices, configs, fixed uniforms) fill via `mappedAtCreation`; mutable per-pass uniforms use
  `UNIFORM | COPY_DST` + `writeBuffer`.
- **staged writes** ([`gfx/staged-write.ts`](../../packages/viewer/src/gfx/staged-write.ts)):
  streamed uploads ≥ 128 KiB copy from a `mappedAtCreation` staging buffer instead of
  `queue.writeBuffer` / `queue.writeTexture`. Chrome's queue writes stall the main thread (~2 ms/MiB
  idle, 15–30 ms/MiB while streaming), vs ~0.1 ms for a staged copy. texture levels use staging when
  row pitch is a multiple of 256 bytes (all BC levels ≥ 64 px wide); a texture's large levels share
  one staging buffer and submit.

## textures and samplers

- **texture sets** ([`gfx/texture-set.ts`](../../packages/viewer/src/gfx/texture-set.ts)): groups a
  pass's render-size targets (post passes, water foam), destroys and rebuilds on resize, and counts
  bytes from formats and mips for stats.
- **samplers** ([`gfx/samplers.ts`](../../packages/viewer/src/gfx/samplers.ts)): device-wide
  deduplicated cache keyed with WebGPU defaults filled in, plus presets (bilinear clamp for render
  targets, trilinear repeat for materials, 4× anisotropy for water, 8× for terrain layers).
- **placeholders** ([`gfx/placeholders.ts`](../../packages/viewer/src/gfx/placeholders.ts)): 1×1
  black (zero) and white textures per view dimension, destroyed with the device; passes detect
  missing textures by reference equality. shadow passes use a dedicated depth placeholder in
  `FrameBindings`.
- **texture store**
  ([`render/textures/texture-store.ts`](../../packages/viewer/src/render/textures/texture-store.ts)):
  stores a contiguous mip run from the finest integrated piece down to 1×1. integrating finer pieces
  or releasing them allocates a new texture and copies coarser levels over; out-of-order finer
  pieces wait. BC blocks upload raw without transcoding. replaced textures are destroyed one commit
  later so in-flight command buffers stay valid.
  [`gfx/bind-group-cache.ts`](../../packages/viewer/src/gfx/bind-group-cache.ts) caches material,
  effect, and water bind groups by resource versions and views.
