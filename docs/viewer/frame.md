# the render frame

each frame encodes one command buffer. the post chain splits around composited-scene passes:
composite → lit decals, water, transparent, screen effects → post-scene passes.

| #   | pass                                                                      | when                                                                                                                                                                                 |
| --- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | `irradiance update 0–2` (compute)                                         | clipmap level re-centred or received new cells                                                                                                                                       |
| 1b  | `skin` (compute)                                                          | animated geometry drawn and clock moved to another frame                                                                                                                             |
| 1c  | `depth pyramid`, `instance cull` (compute)                                | new selection left rows to GPU ([GPU culling](streaming.md#gpu-culling)); `depth pyramid` only with `occlusionCulling` on and a previous frame                                       |
| 2   | `shadow layer 0–3`                                                        | `shadows` on, package loaded, `debugView` `lit`. layers 0–2: casters/fit changed or `skin` ran. layer 3: fit moved to another grid cell, or casters changed and drawn ≥ 8 frames ago |
| 2b  | `local light shadow`                                                      | `shadows` and `localLights` on, and a [shadow tile](lighting.md#local-light-shadows) waits (1 tile/frame)                                                                            |
| 3   | `volumetric fog` (compute)                                                | `heightFog` on, package loaded, `lit`, environment volumetric fog on                                                                                                                 |
| 4   | `main`                                                                    | always (empty without a package)                                                                                                                                                     |
| 4a  | `mip feedback` (compute)                                                  | package loaded, feedback target supported, readback buffer free ([mip feedback](streaming.md#mip-feedback))                                                                          |
| 4b  | `decal relight`                                                           | package loaded                                                                                                                                                                       |
| 5   | `transmittance lut`, `multiple scattering lut`                            | once per environment                                                                                                                                                                 |
| 6   | `sky view lut`                                                            | `sky` on                                                                                                                                                                             |
| 7   | `ao depth`, `gtao`, `gtao blur`                                           | `ao` on, `lit`, environment has AO settings                                                                                                                                          |
| 8   | `ssr march`, `ssr temporal`, `ssr downsample` ×n, `ssr resolve`           | `reflections` on, `lit`, environment has reflection settings; else `ssr off` clears output                                                                                           |
| 9   | `celestial`                                                               | always (no-op if `sky` off or nothing beyond atmosphere)                                                                                                                             |
| 9b  | `water depth`                                                             | always (draws nearest water depth when `water` will run, else clears)                                                                                                                |
| 10  | `composite`                                                               | always                                                                                                                                                                               |
| 10b | `lit decals`                                                              | overlay lit decals drawn ([decals](materials.md#decals))                                                                                                                             |
| 11  | scene copy, `water foam`, `water`                                         | `water` on, `lit`, visible water surfaces; `water foam` only when foam effects drawn                                                                                                 |
| 11a | `transparent`                                                             | glass or effects drawn                                                                                                                                                               |
| 11b | `effect multiply`, scene copy + `effect refract opaque`, `effect refract` | multiply or refract effects drawn ([effects](effects.md#over-the-composited-scene))                                                                                                  |
| 12  | `light shaft downsample`, `light shaft blur` ×n, `light shaft apply`      | `lit`, environment has light shafts, sun in front of camera                                                                                                                          |
| 13  | `lens flare`                                                              | `lit`, environment has flare, sun on screen or allowed off screen                                                                                                                    |
| 14  | `taa`                                                                     | always; with `antialiasing` off, only scales to output size                                                                                                                          |
| 15  | `auto exposure histogram` (compute)                                       | `autoExposure` on, `lit`, profile meters, view changing/settling (or un-metered), readback buffer free                                                                               |
| 16  | `bloom down` ×n, `bloom up` ×n                                            | `bloom` on, `lit`, canvas large enough for mip chain                                                                                                                                 |
| 17  | `tonemap`                                                                 | always, into swapchain                                                                                                                                                               |

passes 1–13 run at render size (`devicePixels × clamp(renderScale, 0.25, 1)`); `taa` (14) onward run
at output (canvas) size. see [post-processing](post-processing.md) and [sky and fog](sky-and-fog.md)
for pass details.

- **depth.** reversed-Z `depth32float` (clear 0, compare `greater`), 0.25 m near plane, infinite far
  plane. avoids logarithmic depth so early-Z and tile-GPU HSR stay active. uses
  `depth32float-stencil8` when supported (clear 0, used only by effect
  [portals](effects.md#portals); post reads depth aspect only). all rendering is camera-relative:
  instance block origins rebase to the eye in f64 on the CPU each frame.
- **main pass.** 1 sample/pixel into 4 targets (32 B/sample, WebGPU default): radiance
  (`rgba16float`), ambient (`rgba16float`), sky reflection (`rgba16float`), and packed
  normal/roughness/hit-weight (`rg32uint`). where `maxColorAttachmentBytesPerSample ≥ 36`, a 5th
  `r32uint` target holds [mip feedback](streaming.md#mip-feedback). depth is stored for post. draw
  order: opaque mesh depth → alpha-tested cut-out depth → terrain → opaque meshes (depth-equal) →
  alpha-tested meshes (depth-equal) → non-depth-writing alpha-tested overlays (`_ZWRITE_OFF` mesh
  decals, `greater-equal`) → opaque [effects](effects.md#vfxbasev2-and-vfxdecal) → stencil-only
  portal masks → instance boxes → box outlines (> `outlineMetres`) → terrain wireframe.
- **decal relight pass.** normal/roughness/occlusion-only lit decals add lighting delta to radiance
  using depth, packed surface, and ambient ([decals](materials.md#decals)).
- **lit decal pass.** albedo-writing lit decals draw over the composited scene (no depth test,
  reading main-pass depth) before water so water covers riverbed decals
  ([decals](materials.md#decals)).
- **transparent pass.** matches the game's
  [transparent draw order](../game-data/materials.md#transparent-draw-order) and
  [blending](../game-data/effects.md#blending): glass and alpha-blended effects draw after water,
  far to near, testing main-pass depth (stencil remains writable). when any draw writes depth
  (`transparentDepthWrite`, `_Zwrite` on `HGRP/LitTransparent`), main-pass depth copies first so
  effects keep sampling opaque depth while depth-writing transparents write into the live depth
  attachment; otherwise depth attaches read-only. each fogs itself and blends premultiplied
  (additive = opacity 0; [blending](effects.md#blending)). sorted per instance by
  `(sortBand, far-to-near)` where `sortBand` = `(sortingLayer, sortingOrder, renderQueue)` (0 for
  static scenery), merging adjacent identical draws into shared draw calls. stencil-writing draws go
  first so stencil-testing effects see the full mask.
- **antialiasing.** temporal with upsampling (no MSAA, matching the game). Halton (2, 3) subpixel
  jitter (8 positions/cycle, more when upsampling) offsets the main projection; post passes undo it
  when reconstructing rays. `taa` reconstructs from a 3×3 render-size Gaussian fit to
  Blackman-Harris, reprojects history via depth + previous camera (no motion vectors, so moving
  particles/cloth/animated/spinning geometry reprojects as static) with Catmull-Rom, clips in YCoCg,
  and blends 10% new frame (less when upsampling leaves no nearby sample), weighted by
  `1 / (1 + luminance · exposure)`. alternates two output-size histories; cuts (new package, first
  pose, debug view, or AA toggle) drop history. below output size, material textures use mip bias
  `log2(renderScale)` (terrain scales gradients), while selection/LOD/streaming measure in output
  pixels so `renderScale` trades shading cost only.
- **shadows.** four depth layers ([lighting](lighting.md#shadows)), reusing main-pass selection with
  per-layer view-projection uniforms. off-screen casters go into cast-only buckets drawn first in
  each phase (skipped by main pass); only their alpha texture streams, they never draw boxes, and
  they never block HLOD refinement. bucket rows group by first reachable shadow layer (within layer
  radius + caster reach toward sun) so each layer draws a prefix — cutting shadow draws by > 50% at
  all profiled poses. depth-only stages bind only position (plus UVs for alpha test).
- **animated geometries** ([package format](../package-format.md#geometry-blob-mesh-efgm)). `skin`
  blends the two current bone frames on the GPU, skins the bind pose, and overwrites the geometry's
  standalone vertex streams (positions quantized to animation box; normals/tangents rotated by
  blended matrix, matching Unity). prepass, shading, and shadow pipelines need no skinning variants;
  all instances share the viewer clock's frame. running `skin` redraws the sharp shadow layers.
- **post.** `composite` adds [SSR](lighting.md#screen-space-reflections), then applies AO, sky,
  atmosphere fog, and height fog (`heightFog`/`atmosphereFog` only affect `composite`). water draws
  over a scene copy for refraction/reflection ([water](water.md)).
- **debug views** (`albedo`, `normals`, `roughness`, `ambient`, `gaps` for surface-keyword gaps,
  `clouds` for raw cloud panorama). show the main pass directly: disables shadows, local lights,
  cloud shadows, exposure, tonemapping, fog, AO, reflections, bloom, light shafts, lens flare, and
  water. TAA still runs.
