# water

viewer implementation of [game-data/water.md](../game-data/water.md) in
[`water-renderer.ts`](../../packages/viewer/src/render/water/water-renderer.ts) and
[`water.wgsl`](../../packages/viewer/src/render/water/water.wgsl); packed table in
[package-format.md](../package-format.md#water).

## placements

the entire water table lives in the core archive. each frame selects surfaces with an active
visibility group and a ready geometry entry.

- geometry blobs stream at a priority falling with horizontal distance from the camera, in view or
  not, keeping shown surfaces resident (map02's ~1000 surfaces share a few hundred meshes, <1 MiB
  packed).
- resident surfaces in the frustum draw, up to 4096 per frame.

## surface meshes

- vertices read `unorm16x4` (dequantized) or `float32x4` positions and, when present on placed
  surfaces, octahedral normals
  ([how surfaces are drawn](../game-data/water.md#how-surfaces-are-drawn)); volume surfaces face
  straight up.
- both depth and shading passes cull back faces by transformed winding (hiding downward-wound twin
  triangles from above and all surfaces from below). transforms are made eye-relative on the CPU.

## `Global_Water_Config`

the wave-normal array, global flow map, and caustic map stream whole. sector tiles and the rain map
are packed but unbound; flow and foam use the global map everywhere.

## shading

computes the [game's shading](../game-data/water.md#shading) per fragment in one pass (instead of a
water G-buffer + fullscreen light pass):

- **depth prepass**: before composite, `fs_water_depth` writes the nearest visible water surface's
  depth into `SceneTextures.waterDepth` (dropping fragments behind opaque scene depth). shading
  tests against `waterDepth` so only the nearest surface shades (e.g. Wuling's stream slopes stay
  hidden under its river plane).
- **shading pass**: runs after composite over a copy of the HDR scene, in the `lit` debug view only,
  before the [transparent pass](frame.md). transparent effects test opaque scene depth without
  water, matching the game's camera depth ([WaterDecal](../game-data/water.md#waterdecal); unchecked
  against an in-game shot).
- **lighting and reflections**: binds the main pass's frame group (sun shadows, irradiance volume,
  sky reflection scaled by `envLightSpecularIntensity` alone, matching the game). because water
  draws after composite, it marches SSR separately using the same march
  ([`ssr-trace.wgsl`](../../packages/viewer/src/render/water/ssr-trace.wgsl)) and samples last
  frame's resolved HDR scene (reprojected through the previous camera, falling back to the opaque
  copy on the first frame or off-screen hits) so reflections include transparent effects and
  particles such as waterfall mist and sheets.

divergences from the game:

- LOD surfaces draw as meshes rather than a near-camera top-down resampled grid; grid wave
  displacement is omitted.
- sun highlight is not aimed at the nearest sun-disc point, omits multiple scattering, and divides
  direct light by π ([sun](lighting.md#sun)).
- `FlowmapOption` 1 coverage mask is unused (waves keep full amplitude; no map02 config sets it).
- configs bind by asset rather than `materialIndex`, so colliding indices keep separate looks.
- water is absent from the SSR depth buffer, so rays toward higher water surfaces (terraced pools,
  rivers) hit their beds.
- rain, character ripples, shore wetness, and the TAA hint are omitted.

## water volumes

[`water-levels.ts`](../../packages/viewer/src/scene-states/water-levels.ts) tracks each
[water volume](../game-data/water.md#water-volumes)'s fill:

- surfaces are packed at authored fill; the renderer offsets transforms and bounds by the fill
  delta. floating instance rows (listed in each block's `floaters` section) shift by the same delta
  in both CPU culling copies and GPU buffers, tracked from block upload to release ("floating parts"
  count = loaded rows).
- the "Water levels" panel
  ([`water-levels.tsx`](../../packages/viewer/src/ui/scene-controls/water-levels.tsx)) lists
  script-moved volumes and [pumped pools](../game-data/water.md#depletable-pools) (current level
  first), each with a `waterLevel` control, surface height, and "Go" camera jump (`waterHeight`,
  `surfaceView`).
- fill moves linearly at script speed (or volume fill speed; Suiming stages take 2–3 minutes);
  "Movement" speeds up or jumps. follower volumes track their parent's surface within their own
  depth. package defaults and "Reset" snap immediately to default fills (quest-drained pools start
  empty).

divergences from the game:

- volumes without a config use their water type's
  [surface prefab](../game-data/water.md#water-volumes) config
  ([`water-volume-surfaces.ts`](../../packages/extractor/src/game/water/water-volume-surfaces.ts));
  when the type names a `decalPrefab`, the packer emits a resident global floating instance sharing
  the volume's polygon mesh 1 cm above the surface
  (`WaterVolumeManager.m_waterDecalPositionOffset`), so it rises and falls with the volume and
  shades through `fs_water_foam`. per-level multipliers are omitted, and outlines are always
  triangulated instead of loading `_WaterSurface` meshes.
- moves are linear (no end-of-move easing; scripts without a fixed speed use fill speed as m/s).
- floaters keep authored height above water without settling to `surface_offset` or lagging.
- switches, clocks, and quests are listed by script ID in labels, not executed.
- [pumped pools](../game-data/water.md#depletable-pools) offer only empty, authored, and full
  (quest-drained pools default to empty, others to authored).
- `ground_distance`, volume flow speed/direction, and inter-volume transfers
  (`WaterVolumeTransfer(All)`, transferers, switch interactives) are unread.
- volumes coinciding with placed surfaces (some map02 lv006, lv010 `37900010002`, several
  lv002/lv003 pools) draw twice (game behaviour unchecked).
- volume surfaces leave no shore wetness.

## WaterProxy and WaterDecal

the mesh renderer skips `HGRP/WaterProxy`
([game data](../game-data/water.md#waterproxy-and-waterdecal)) because none of its passes draw to
the main view.

### foam boxes

[WaterDecal](../game-data/water.md#waterdecal) boxes pack as `waterFoam` surfaces and draw via
`fs_water_foam` in [`effect.wgsl`](../../packages/viewer/src/render/meshes/effect.wgsl) inside the
water pass when any are in frame:

1. **water depth**: `SceneTextures.waterDepth` laid down before composite.
2. **foam target**: boxes draw into `rgba8unorm` cleared to `(0, 0, 0, 1)` with `waterDepth`
   read-only for `_ZTest` (`waterFoam`, `waterFoamBehind`, `waterFoamThrough` looks, one phase
   each), projecting onto `waterDepth`. blend accumulates `rgb = box_premul + dst_rgb * (1 − a)` and
   `a = dst_a * (1 − a)`. mip bias scales base-colour and mask UV gradients; dissolve samples a
   fixed mip.
3. **shading**: water reads the target and computes `saturate(rgb + saturate(own) * a)` (8-bit
   clamp; own foam saturates even without boxes).

- **erosion (`wf_erosion`)**: [water erosion](../game-data/water.md#water-erosion) needs 6 textures
  and reuses distortion, mask, and dissolve slots (`EROSION_SLOTS` in
  [`water-foam.ts`](../../packages/viewer/src/looks/effects/water-foam.ts)), so it draws only when
  dissolve is off, distortion strength is 0, and no mask texture is set. flowmap and gradient clamp
  UVs half a texel inside edges (no clamping sampler), and gradient mip ignores noise U.
- **static boxes (InitChunkData component 31)**: packed like rect decals; non-neutral renderer
  values generate a material variant (`placedWaterFoam` in
  [`water-foam.ts`](../../packages/extractor/src/game/materials/effects/water-foam.ts)) applying
  tiling to base UVs, speed to scroll, and opacity/brightness/tint to output.
- **unsupported and divergences**: keywords beyond `_BLEND_BASECOLOR`, `_BLEND_BASECOLOR2`,
  `_BLEND_DISPLACEMENT`, `_USE_DISTURB`, `_USE_MASK`, `_USE_SOFTBLEND`, `_USE_DISSOLVE`,
  `_USE_WATER_EROSION`, `_USE_BUBBLE`, `_USE_TWO_LAYER_FLOATING_MAP`, or `_ZTest` other than 4, 5, 8
  show as [unsupported](materials.md#unsupported-materials). displacement pass is omitted
  (`_BLEND_DISPLACEMENT` draws foam only; value read but unused), `_USE_TWO_LAYER_FLOATING_MAP` uses
  an upward geometric normal `(0, 1, 0)` instead of sampling `normalRoughnessWithWater`, prefab
  `HGWaterDecalRenderer` values are not packed (all map02 prefabs are neutral), soft blend uses the
  viewer's near plane, and distortion mip bias is omitted (unidentified property).
