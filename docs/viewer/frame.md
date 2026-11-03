# the render frame

`#render` encodes one command buffer per frame. passes in order:

| #   | pass                                                                 | when                                                                                                                                                                                                                    |
| --- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `irradiance update 0–2` (compute)                                    | a clipmap level re-centred or got new cells ([`render/irradiance-volume.ts`](../../packages/viewer/src/render/irradiance-volume.ts))                                                                                    |
| 1b  | `skin` (compute)                                                     | an animated geometry is resident ([`render/skin-animation.ts`](../../packages/viewer/src/render/skin-animation.ts))                                                                                                     |
| 2   | `shadow layer 0–3`                                                   | `shadows` on, a package loaded, `debugView` is `lit`, and the casters or a layer's fit changed since the layers were drawn, or an animated geometry is drawn                                                            |
| 3   | `volumetric fog` (compute)                                           | `heightFog` on, a package loaded, `lit`, and the environment's volumetric fog on ([`render/volumetric-fog.ts`](../../packages/viewer/src/render/volumetric-fog.ts))                                                     |
| 4   | `main`                                                               | always (empty without a package)                                                                                                                                                                                        |
| 5   | `transparent`                                                        | always, so the composite reads cleared targets                                                                                                                                                                          |
| 6   | `transmittance lut`, `multiple scattering lut`                       | once per environment                                                                                                                                                                                                    |
| 7   | `sky view lut`, `sky mean`                                           | `sky` on                                                                                                                                                                                                                |
| 8   | `ao depth`, `gtao`, `gtao blur`                                      | `ao` on, `lit`, and the environment has AO settings                                                                                                                                                                     |
| 9   | `ssr march`, `ssr temporal`, `ssr downsample` ×n, `ssr resolve`      | `reflections` on, `lit`, and the environment has reflection settings; otherwise `ssr off` only clears the output ([`render/screen-space-reflections.ts`](../../packages/viewer/src/render/screen-space-reflections.ts)) |
| 10  | `celestial`                                                          | always; writes nothing with `sky` off or nothing beyond the atmosphere                                                                                                                                                  |
| 11  | `composite`                                                          | always                                                                                                                                                                                                                  |
| 12  | scene copy + `water`                                                 | `water` on, `lit`, and visible water surfaces                                                                                                                                                                           |
| 12b | `effect multiply`, scene copy + `effect refract`                     | effects that multiply or refract the composited scene are drawn ([effects](effects.md#over-the-composited-scene))                                                                                                       |
| 13  | `light shaft downsample`, `light shaft blur` ×n, `light shaft apply` | `lit`, the environment has light shafts, and the sun is in front of the camera ([`render/light-shafts.ts`](../../packages/viewer/src/render/light-shafts.ts))                                                           |
| 14  | `lens flare`                                                         | `lit`, the environment has a flare, and the sun is on screen (or the flare allows it off screen) ([`render/lens-flare.ts`](../../packages/viewer/src/render/lens-flare.ts))                                             |
| 15  | `taa`                                                                | always ([`render/temporal-aa.ts`](../../packages/viewer/src/render/temporal-aa.ts)); with `antialiasing` off it only scales to the output size                                                                          |
| 16  | `auto exposure histogram` (compute)                                  | `autoExposure` on, `lit`, the profile meters, and a readback buffer is free ([`render/auto-exposure.ts`](../../packages/viewer/src/render/auto-exposure.ts))                                                            |
| 17  | `bloom down` ×n, `bloom up` ×n                                       | `bloom` on, `lit`, and a canvas large enough for the mip chain                                                                                                                                                          |
| 18  | `tonemap`                                                            | always, into the swapchain                                                                                                                                                                                              |

passes up to the lens flare run at the render size, the canvas's device-pixel size times
`renderScale` (clamped to [0.25, 1]); `taa` and everything after it run at the output (canvas) size.
what each post pass computes is in [post-processing](post-processing.md) and
[sky and fog](sky-and-fog.md).

hosts can register `Viewer.addOverlay` callbacks after tonemapping. each callback receives
the output target and size, the current opaque/cutout reversed-Z depth view and its NDC
projection jitter, and the device/encoder for that frame. targets are transient; host
renderers own their buffers and pipelines. registration and removal invalidate the frame.
depth sampling must account for jitter and the difference between render and output size.

- **depth.** reversed-Z `depth32float`, cleared to 0 and tested with `greater`, with an infinite far
  plane and a 0.25 m near plane; logarithmic depth is avoided because writing fragment depth
  disables early-Z and, on tile-based GPUs, hidden-surface removal. where the GPU has the
  `depth32float-stencil8` feature, depth carries a stencil, cleared to 0, which only effect
  [portals](effects.md#portals) use; post passes sample the depth aspect alone
  ([`gfx/render-targets.ts`](../../packages/viewer/src/gfx/render-targets.ts),
  [`scene/camera.ts`](../../packages/viewer/src/scene/camera.ts)). everything renders
  camera-relative: instance block origins are rebased to the eye on the CPU in f64 each frame, so
  f32 precision holds at any distance.
- **main pass.** one sample per pixel into radiance and its ambient part (`rgba16float`), plus what
  lit surfaces hand the screen-space reflections: the sky reflection the radiance holds
  (`rgba16float`) and the normal, roughness and hit weight packed in `rg32uint`, which fills
  WebGPU's default 32 bytes per sample; depth is stored for post. draw order: the opaque meshes'
  depth, terrain, meshes (opaque, then alpha-tested, then stencil-only portal masks), instance
  boxes, box outlines (boxes larger than `outlineMetres`), terrain wireframe.
- **decal relight pass.** lit decals that change only a surface's normal, roughness or occlusion add
  the change in its light to the radiance, reading the depth, packed surface and ambient targets
  ([decals](materials.md#decals)).
- **transparent pass.** alpha-blended meshes draw after the main pass, testing its depth without
  writing it (the stencil stays writable), into a weighted sum and a revealage that the composite
  resolves ([glass](materials.md#glass)). a third target, the glow, sums additively blended light,
  which the other two can't hold; the composite adds it after the fog, unfogged (and the water pass
  again over water, [water](water.md#shading)), and its alpha holds the weight of the layers kept
  out of the fog ([blending](effects.md#blending)).
- **antialiasing** is temporal with upsampling, as in the game, which has no MSAA. the main pass's
  projection is offset by a Halton (2, 3) subpixel jitter each frame (8 positions per cycle, more
  when upsampling), and the post passes that reconstruct view rays undo it. `taa` reconstructs each
  output pixel from the 3×3 render-size samples around it (a Gaussian fit to Blackman-Harris),
  reprojects the previous output through the depth buffer and the previous camera (the scenery is
  static, so there are no motion vectors), samples it with Catmull-Rom, clips it to the
  neighbourhood's colour box in YCoCg and blends in 10% of the new frame, less where upsampling
  leaves no sample near the pixel. colours are weighted by `1 / (1 + luminance · exposure)` while
  filtering. two output-size histories alternate. a cut (a new package, the first pose, a debug view
  or antialiasing toggle) drops the history. below the output size, material textures sample with a
  mip bias of `log2(renderScale)` (terrain layers by scaling their gradients), and selection, LOD
  and texture streaming measure screen sizes in output pixels, so `renderScale` trades shading cost
  only.
- **shadows.** four depth layers, fitted, filtered and fed with off-screen casters as
  [lighting](lighting.md#shadows) describes
  ([`render/shadow-map.ts`](../../packages/viewer/src/render/shadow-map.ts)). each layer's pass
  reuses this frame's main-pass selection and gets its own copy of the frame uniforms with its
  view-projection. off-screen casters land in cast-only buckets, drawn first in each phase so the
  shadow passes draw a prefix and the main pass skips it; only their alpha texture is requested,
  they never draw as boxes, and their tiles never hold back the HLOD refinement of tiles in view.
  each bucket's rows are grouped by the first layer they can cast into (within the layer's radius
  across the light, and up to the caster reach towards the sun), so a layer draws a prefix of each
  bucket: the three sharp cascades skip everything beyond their 80 m, and instances no layer reaches
  don't draw into the shadow map at all. this cut draws by more than half at every profiled pose.
  the depth-only stages (shadow casters, alpha-tested depth) bind only the vertex streams they read:
  positions, plus the UV sets for alpha testing.
- **animated geometries** ([package format](../package-format.md#geometry-blob-mesh-efgm)) are
  skinned on the GPU before anything draws: each frame, `skin` blends the two current frames' bone
  matrices, skins the bind pose (kept in its own storage buffer with the weights and bones) and
  writes positions, normals and tangents over the geometry's own vertex streams, in the formats
  every mesh pipeline already reads, positions quantized to the animation's box. so the prepass,
  shading and shadow passes need no variants, and every placement of a geometry shows the same frame
  of the viewer's clock. normals and tangents turn by the blended matrix itself, as Unity's skinning
  turns them. a frame that draws one redraws the shadow layers.
- **post** ([`render/post-process.ts`](../../packages/viewer/src/render/post-process.ts)) is
  fullscreen triangles with `auto` layouts. composite adds the screen-space reflections
  ([lighting](lighting.md#screen-space-reflections)), then applies AO, sky, atmosphere fog and
  height fog; `heightFog` and `atmosphereFog` change what composite does, not which passes run.
  water draws over a copy of the composited scene so it can refract and reflect it
  ([`render/water-renderer.ts`](../../packages/viewer/src/render/water-renderer.ts),
  [water](water.md)). it's the one post pass with an explicit layout, because it also binds the main
  pass's frame group for the sun shadow, irradiance volume and sky reflection; its shader moves the
  post uniforms to group 3.
- **debug views** (`albedo`, `normals`, `roughness`, `ambient`, and `clouds` for the raw cloud
  panorama) show the main pass as it is: no shadows, local lights, cloud shadows, exposure,
  tonemapping, fog, AO, reflections, bloom, light shafts, lens flare or water. temporal antialiasing
  still applies.
