# GPU resource management

## device and layouts

the viewer requests the adapter's limits for sampled textures and storage buffers per stage (effects
exceed WebGPU's default of 16 sampled textures); samplers stay at the default. optional features: BC
textures (without them, BC textures don't stream and materials use untextured looks), stencil
(effect portals), and timestamp queries (GPU profiling).

fragment-stage bindings vs WebGPU defaults:

| pipeline         | sampled textures (16) | samplers (16) | storage buffers (8) |
| ---------------- | --------------------- | ------------- | ------------------- |
| mesh (G-buffer)  | 10                    | 5             | 2                   |
| mesh transparent | 18                    | 9             | 4                   |
| terrain          | 6                     | 2             | 2                   |
| effects          | 19                    | 15            | 4                   |
| water            | 15                    | 7             | 3                   |

## buffers and pools

- **growable buffers vs fixed arrays**: dynamic GPU buffers (instance rows, irradiance cells,
  terrain height pages, rect decal placements, look table) sub-allocate from first-fit range
  allocators with neighbour coalescing on free, doubling via GPU copy when full and never shrinking.
  fixed texture arrays (terrain surface pages, splat pages, terrain layer textures) allocate full
  size up front since arrays cannot grow without copying every layer.
- **geometry pools**: still geometry sub-allocates from shared vertex and index buffers so draws
  bind once and offset via `baseVertex` / `firstIndex` (copied into indirect args by the GPU
  culler).
  - vertex pools split by `(uvFormat, streamSet)` into _compact_ (positions, normals, UV0, tangents;
    ~90% of map02 vertices) and _full_ (all 6 streams), avoiding ~33% padding for missing streams.
  - pools grow up to `maxBufferSize` and never shrink (residency counts used ranges; stats pool
    bytes count whole buffers).
  - draws sort by pool within each pipeline, cutting vertex-buffer rebinds to a handful per frame.
  - animated geometries (written by compute skinning) and oversized still geometries use standalone
    vertex buffers.
- **uniform ring**: one uniform buffer split into 3 per-frame regions, flushed in one `writeBuffer`
  per frame and bound via dynamic offsets (main frame block plus per-shadow-layer and local-light
  shadow tile copies).
- **bind layouts**:
  - **group 0** (`frameCore` vs `frame`): G-buffer, depth, shadow, decal, foam, and screen-effect
    passes bind `frameCore` (the `Frame` uniform buffer only — zero textures, eliminating shadow
    placeholders). lighting passes (deferred lighting, volumetric fog, water, transparent meshes,
    lit effects) bind `frame` (uniforms plus shadow map, reflection cubemap, irradiance clipmaps,
    shadow ramp, local lights, cloud shadow, and reflection probes; unstreamed textures use 1×1
    placeholders).
  - **group 1**: per family.
  - **group 2** (meshes): per-draw parameters (dequantization, flags, UV transforms, look-table
    slot + extra mesh flags in the high 16 bits), immutable look table, and fog inputs.
  - **group 3** (meshes): 9 material texture slots + 4 samplers (vertex stage also samples 2 slots
    for [vertex offset](materials.md#vertex-offset)); effects keep 7 texture slots + 7 samplers plus
    scene inputs.

## pipelines and uploads

- **pipeline cache**: caches shader modules and pipelines asynchronously once per session (including
  deferred lighting, shadow-tile clear, weather, and lens flare passes). mesh and effect shaders
  split into per-family `GPUShaderModule`s so depth/shadow, G-buffer, decal, foam, and screen-effect
  passes do not compile lighting code. mesh pipelines compile lazily on first seen
  `(phase, cull, positionFormat, uvFormat, stencil)` — pre-warming only the 6 hottest back-culled
  `unorm16x4`/`unorm16x2` Lit/depth/shadow pipelines at startup and collapsing UV-format variants on
  position-only phases. draws skip while compiling and trigger a redraw when ready.
- **staged writes**: streamed uploads ≥ 128 KiB copy from a `mappedAtCreation` staging buffer
  instead of `queue.writeBuffer` / `queue.writeTexture`. Chrome's queue writes stall the main thread
  (~2 ms/MiB idle, 15–30 ms/MiB while streaming), vs ~0.1 ms for a staged copy. texture levels use
  staging when row pitch is a multiple of 256 bytes (all BC levels ≥ 64 px wide); a texture's large
  levels share one staging buffer and submit.

## textures and samplers

- **samplers**: deduplicated device-wide with presets (bilinear clamp for render targets, trilinear
  repeat for materials, 4× anisotropy for water, 8× for terrain layers).
- **texture store**: stores a contiguous mip run from the finest integrated piece down to 1×1.
  integrating finer pieces or releasing them allocates a new texture and copies coarser levels over;
  out-of-order finer pieces wait. BC blocks upload raw without transcoding. replaced textures are
  destroyed one commit later so in-flight command buffers stay valid.
