# materials

viewer implementation of [game-data/materials.md](../game-data/materials.md); full gaps in
[status.md](../status.md).

pipeline: extractor describers
([`game/materials/surfaces/`](../../packages/extractor/src/game/materials/surfaces/), one per
shader) emit a [surface](../package-format.md#materials) →
[`material-looks.ts`](../../packages/viewer/src/looks/material-looks.ts) dispatches to a look
builder (`lit-look.ts` for Lit,
[`special-looks.ts`](../../packages/viewer/src/looks/special-looks.ts) for erosion/dithered/matte
painting, [`effects/`](../../packages/viewer/src/looks/effects) for [effects](effects.md)) →
[`mesh.wgsl`](../../packages/viewer/src/render/meshes/mesh.wgsl) shades it.

the mesh shader has 7 texture slots (`SLOTS` in
[`looks/look.ts`](../../packages/viewer/src/looks/look.ts); frame group uses the rest of WebGPU's
16), so rare feature combinations share slots or parameter rows (when two collide, one wins):

| feature                                 | shared slot / rows                                                           | conflict / skipped when                                      |
| --------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `_TRI_CHANNEL_MASK`                     | MRO slot, or emissive slot on MRO-layout materials (base sampler)            | emissive map or mask layer's mask map occupies emissive slot |
| `_PARALLAX_MAP_WORLDSPACE`              | MRO / mask slot (`_ParallaxMaskMap`); tail rows (`ParallaxWorldRow`)         | MRO map or tri-channel mask holds the mask slot              |
| `_EMISSIVE_ANIM` pulse                  | parallax rows                                                                | parallax glow or layer present                               |
| `_LAYERBLEND_TOP` / `_LAYERBLEND_MASK`  | parallax slots & rows; mask map in emissive slot                             | mask layer on emissive-mapped material                       |
| `FlowGlow` (glowing foliage)            | parallax noise slot; parallax rows unused by emission pulse (`FlowGlowRow`)  | parallax slots hold anything else                            |
| `vertexOffset`                          | parallax slots (`VertexOffset` flag); parallax rows unused by emission pulse | parallax glow or layer present                               |
| `HGRP/Foliage/Trunk` (`_FOLIAGE_TRUNK`) | leaf rows (`Trunk` flag; dithered looks use same rows)                       | sway on Lit trunk                                            |
| swaying cloth / pendulum                | foliage rows (pendulum kind in dither row, gated on non-zero intensity)      | Lit trunk holds rows                                         |

**animated materials**: materials with [motion](../package-format.md#materials) get a `LookMotion`
(`lookMotion` in `material-looks.ts`). each loop step rebuilds parameters only (textures, queue,
flags stay fixed). `MeshRenderer.animate` advances visible looks and rewrites their look-table rows
in lockstep with `skinFrame` (e.g. Qingbo's waterwheels). moves only while frames render.

## emission

- post exposure for [emission](../game-data/materials.md#emission) is
  `autoExposure * viewerExposure`; `_IgnorePostExposure` divides out both.
- `_EMISSIVE_ANIM` pulse runs on the animation clock (only while frames render) in the parallax rows
  (skipped if parallax glow or layer is present). `_EnableEmissiveAnimFlicker` draws steady;
  `_EmissiveSpeed` scroll is unread.
- emissive map G, B, and A colours (pre-multiplied by `_EmissiveType`, null if zero) sit in the
  three effect-parameter rows unused by mesh looks.
- `_EMISSIVE_ANIM_SWEEP` omits the moving band: the packer scales each emission colour by
  `1 − alpha` (steady value outside the band). `_EMISSIVE_NOMAP` emits nothing.
- static scenery per-draw emission is taken as zero (uses `_EmissiveColor`). prefab
  `AnimationProperties_Emissive` resting colours and view-state emissive configs bake into renderer
  emission at pack time
  ([`emissive-override.ts`](../../packages/extractor/src/game/prefabs/emissive-override.ts)); albedo
  tint rides in `LitEmission.albedoTint` (applied in `mesh.wgsl` before emission reads albedo).
  breathing is unread.

## lit layers

`HGRP/LitEffect` draws as Lit (without dissolve or disturb), and `Hidden/HGRP/LitEffectBlend` draws
as Lit (without `_ObjectBlend*` soft depth blending).

- **`_TRI_CHANNEL_MASK`**: uses the MRO slot, or the emissive slot on MRO-layout materials (e.g.
  Sword Vault Dale's UV1 banners) with the base-colour sampler; skipped if an emissive map or mask
  layer uses that slot. only switch-texture R blends (no slots for G/B).
  `_UseMaskRUVSetAndTilingScale` is unread.
- **`_PARALLAX_MAP`**: [pulse](../game-data/materials.md#lit-layers) runs while frames render
  ([performance](performance.md); `continuous` keeps it running); player brightening uses the camera
  as the player. without a noise map, only the pattern binds and the march reads height 0.
  `_PARALLAX_MAP_WORLDSPACE` binds `_ParallaxMaskMap` in the mask slot and stores its parameters in
  the tail rows (`ParallaxWorldRow` in `lit-look.ts`, omitting `_ParallaxSignControl`, unused on
  map02). omitted: non-world-space `_UseParallaxMask` (no slot) and native `_VFXParams2` global
  highlight.
- **`_MATCAP`**: omitted (no free slot; campfire crystals lack sheen).
- **`_LAYERBLEND_TOP` / `_LAYERBLEND_MASK`**: maps use parallax slots/rows; mask map uses emissive
  slot (skipped on emissive-mapped materials). UV set 2 falls back to UV0; missing UV1 falls back to
  UV0 (matching game). `_BaseHeightMap` has no slot and reads 0.5. omitted: `_LAYERBLEND_NOISEBLEND`
  and `_LAYERBLEND_MASK_PARALLAX_PBR`.

## foliage

- `foliage_sun` and `local_lighting` in
  [`frame.wgsl`](../../packages/viewer/src/render/frame/frame.wgsl) evaluate the
  [foliage model](../game-data/materials.md#foliage) per pixel.
- `HGRP/Foliage/Leaf` and grass shaders pack `foliage`
  ([`foliage.ts`](../../packages/extractor/src/game/materials/surfaces/foliage.ts)) via `leafParams`
  / `grassParams`; leaf `_BLEND_COLOR` reuses tri-channel mask rows.
- leaves and grass without `_TwoSidedNormal` keep their normal on back faces; with it (and on all
  other materials), back faces flip their normal by face winding (corrected for mirrored instances).
  grass `h` is object-space vertex height. grass card LOD omits bend and masks (normal decoding
  unread).
- `HGRP/Foliage/Trunk` uses Lit layout plus `_FOLIAGE_TRUNK` vertex AO/ramp (`trunkParams`, `Trunk`
  flag). `HGRP/Foliage/TreeFoliageCardMeshLod` draws as alpha-tested foliage.
- [glowing foliage](../game-data/materials.md#glowing-foliage) (`describeFoliageGlow`) is Lit +
  `FlowGlow` overlay (`flow_glow` in `mesh.wgsl`): noise in parallax noise slot, parameters in
  `FlowGlowRow` ([`lit-look.ts`](../../packages/viewer/src/looks/lit-look.ts)), `t` in seconds
  (unchecked). terrain blend is omitted (marked in gaps view).

## swaying cloth

[swaying cloth](../game-data/materials.md#swaying-cloth) and
[swinging pendulums](../game-data/materials.md#swinging-pendulums) pack `sway` (`swayParams`) and
apply in `instance_rel` across shading, depth, cutout-depth, and shadow passes.

- vertex-colour alpha arrives in position W
  ([geometry blob](../package-format.md#geometry-blob-mesh-efgm)), so depth passes need no extra
  stream. skinned geometry drops the weight (swaying animated meshes stay still).
- wind clock `Frame.wind.x` advances with the animation clock at the blended environment's
  [wind](../game-data/environment.md#wind) rate (one clock for all placements; still air without an
  environment; pauses when idle). `_DisableAnimateVert` is 0; no motion vectors (previous offset
  omitted).
- pendulums use exact sin/cos instead of Taylor series (within 10⁻³); the packer grows bounds by
  turn reach on all axes. pendulums with gravity, custom anchor, or no swing (none on map02), and
  sways on Lit trunks, stay still and record a gap.
- [cloth simulation](../game-data/materials.md#cloth-simulation) is not run (draws at rest with sway
  only; `pack` reports `clothSimulated`).

## vertex animation textures

the packer bakes [VATs](../game-data/materials.md#vertex-animation-textures) into
[skeletal animations](../package-format.md#geometry-blob-mesh-efgm) (one bone per rigid piece/soft
point, or existing bones; [extraction](../extraction.md#asset-classes)). surfaces read nothing of
them.

- keywords record a gap only for cases `vatOf` skips (per-draw frame, particle data, kept mesh
  normals, missing rotation texture).
- bone weights are normalized at pack time (game blends as stored). soft-body normals/tangents
  rotate `+y`/`−x` by the bone; tangent keeps the mesh's bitangent sign (game uses 0).
- loops run on the animation clock, interpolating frames (game steps them) in sync across
  placements. meshes with multiple animations (e.g. map02 machine parts at 5 speeds) or on
  posed/animated renderers stay still (listed in `debug/assets.json` under `unanimated`).

## vertex offset

[vertex offset](../game-data/materials.md#vertex-offset) (`vertexOffset` in
[`lit-sway.ts`](../../packages/extractor/src/game/materials/surfaces/lit-sway.ts), packed by
`vertexOffsetParams`) adds to sway in `vertex_offset` (`mesh.wgsl`).
[`mesh-pipelines.ts`](../../packages/viewer/src/render/meshes/mesh-pipelines.ts) exposes the two
parallax slots and a fourth sampler (noise slot's) to the vertex stage.

- **passes**: applies only to alpha-tested looks (`vs_main` and `vs_cutout_depth` share the
  expression; opaque depth reads positions only; all map02 materials with the keyword are
  alpha-tested). stays off while alpha or offset textures stream so colour and depth never split.
- **clock**: scrolls on `Frame.eye.w` (animation clock, seconds), in step across placements.
- **weights and bounds**: vertex-colour alpha reads from position W; packer expands mesh bounds by
  offset reach. skinned meshes drop the weight (weighted offsets stay still; unweighted ones, like
  the balloon, apply after skinning). object-space directions transform by the draw transform
  (prefab transform for posed skinned meshes).
- **omitted**: normal-direction offset (`_OffsetSwitchDir` 2; depth passes lack normals), offset
  colliding with parallax glow or layer, unset offset texture. fractional `_OffsetUVSet` rounds to
  the nearest set.

## glass

[glass](../game-data/materials.md#glass) shades like Lit, with opacity from `_AlphaMaskChannel`
times `_BaseColor.a` (tint alpha alone while streaming), no shadows. premultiplied glass (src
factor 1) adds full radiance and dims behind by opacity.

draws in the [transparent pass](frame.md) far-to-near with effects over the composited scene, fogged
at its own distance before blending (so distant effects behind glass, like the corroded planet's
plume behind Dijiang's deck, dim through the pane).

## decals

without a GBuffer, [decals](../game-data/materials.md#decals) draw back-face cubes without depth
test in a dedicated pass after composite and before water and the [transparent pass](frame.md)
([`litDecalLook`](../../packages/viewer/src/looks/effects/lit-decal.ts), `fx_lit_decal` in
[`effect.wgsl`](../../packages/viewer/src/render/meshes/effect.wgsl)) so bed decals stay under
water.

- **shared look & placement**: placements share one material look and draw the VFXDecal cube; each
  row's block word indexes placement colour and UV transform in a side buffer (`row_placement` in
  `frame.wgsl`). `_DrawOrder` is unread (no set overlap order).
- **laid-over decals**: read main-pass normal/roughness where masks keep them (unwritten occlusion =
  1, metallic = 0), shade normally, and blend by alpha.
- **stencil emulation**: bit 31 of the main pass's packed surface (`SURFACE_NO_LIT_DECALS` in
  `frame.wgsl`) replaces the stencil bit: looks writing `_StencilRef` with bit 32 set it
  (`keepsLitDecalsOff` in [`lit-look.ts`](../../packages/viewer/src/looks/lit-look.ts)). lit decals
  skip those pixels; VFXDecal boxes with read mask 32 test it via `decalFade.covers` (other read
  masks are unsupported).
- **relight pass (`fs_decal_relight`)**: handles decals that write no albedo, `_BLEND_WETNESS`, and
  `HGRP/WetnessDecal` (`wetnessDecalLook`, `wd_wetness`):
  - estimates surface albedo as dielectric from main-pass diffuse ambient divided by ambient light
    at its normal (keeping emission, AO, metallic as drawn).
  - lights the surface before and after applying the decal, adding the radiance delta (times alpha,
    or whole for `_BLEND_WETNESS` / `WetnessDecal`) and updating the sky reflection target.
  - writes the blended normal, roughness, and reflection weight to a decal surface target read by
    [SSR](lighting.md#screen-space-reflections) (last overlapping decal wins), preventing
    near-mirror water-flow decals (`_WaterRoughness * B ≈ 0.01`) from reflecting bright sky where
    SSR hits rock.
  - emissive relit decals add `emission * alpha` on top of existing emission.
    `_BLEND_SLUDGE_EROSION` binds its wall texture in slot 3 (scale in UV row, texture's own
    sampler).
  - `HGRP/WetnessDecal` has no wetness mask, so overlapping boxes wet twice and porosity uses Lit
    defaults.
- **unsupported**: keywords beyond `_COMPLETE_PBR`, `_NORMAL_ANGLE_BLEND`, `_BLEND_WATER_FLOW`,
  `_BLEND_EMISSIVE`, `_BLEND_SLUDGE_EROSION`, `_BLEND_WETNESS` (footprints, UV noise, arcs); sludge
  without texture or combined with water flow/emission; wetness with another blend keyword or
  without albedo write.

## matte paintings

[`mattePaintingLook`](../../packages/viewer/src/looks/special-looks.ts) draws
[matte paintings](../game-data/materials.md#matte-paintings): folds alpha scale into the cutout
threshold (reusing alpha-test depth), fogs in composite, and waits for texture residency.
`_UseMainTexAsAlpha` is unread; non-UV0 textures are dropped.

## forward Lit

[forward Lit](../game-data/materials.md#forward-lit) (`HGRP/LitForward`, e.g. golden chest) draws as
standard Lit in the main pass without optional layers. it reflects the scene sky cubemap and SSR
instead of its `_CUSTOM_IBL` cubemap, making metal darker than in-game.

## erosion

[`erosionLook`](../../packages/viewer/src/looks/special-looks.ts) and `erosion_surface` in
`mesh.wgsl` draw [erosion rock](../game-data/materials.md#erosion), reusing Lit texture slots and
omitting `_ObjectBlend*` soft blending. `HGRP/ErosionDynamic` is
[unsupported](#unsupported-materials).

## unsupported materials

unhandled materials can display a 0.5 m world-space magenta/black checker (double-sided, unlit,
exposure-invariant, no shadows) via two off-by-default toggles:

- **"unsupported materials"**: meshes whose material lacks a viewer look.
- **"missing content"**: package [stand-ins](../package-format.md#stand-ins)
  (`DrawRole.Unsupported`).
- when off, [`mesh-selection.ts`](../../packages/viewer/src/streaming/mesh-selection.ts) skips them
  (`unsupportedLook` in `material-looks.ts`).

what becomes unsupported: effect shaders without a look ([effects](effects.md)); effect materials
with unhandled keywords, blend modes, stencil ops, texture combos, or UV sets (>1, or >0 for
VFXWater/VFXRefract); unhandled lit decals or ones lacking placement/base map; non-effect additive
materials; shaders without a family (`HGRP/CharacterNPR`, `HGRP/ErosionDynamic`, etc.); failed
conversions.

the extractor classifies these when [describing surfaces](../package-format.md#materials) and writes
`unsupported`, `keywordsNotDrawn` (from
[`surface-keywords.ts`](../../packages/extractor/src/game/materials/surfaces/surface-keywords.ts)),
and `slotErrors` into `debug/assets.json`. surface shaders draw without unread keywords (marked in
the [gaps view](#gaps)) rather than checkering whole scenes.

intentionally undrawn (invisible in game): `HGRP/WaterProxy`, lit decals writing nothing the viewer
draws, and ink-wash-only VFXBaseV2 materials ([effects](../game-data/effects.md#vfxbasev2)).

## gaps

the `gaps` debug view turns surfaces grey, stripes materials with known gaps amber/black, and lists
missing features in view (nearest first). inspect programmatically via `viewer.gapsInView()` or a
bucket's `look.gaps` ([driving the viewer](../driving-the-viewer.md#inspecting)).

`MaterialLook.gaps` collects from two sources:

- **package [`gaps`](../package-format.md#materials)**: unread keywords (`keywordsNotDrawn`) and
  skipped property cases (`PROPERTY_GAPS` in `surface-keywords.ts`).
- **look builder**: slot/row collisions in `lit-look.ts` (tri-channel mask, mask layer, emission
  pulse, vertex offset).

not tracked by `gaps`: misread properties, effect materials (marked unsupported instead), terrain,
water, dropped content, runtime per-draw values, and [cloth simulation](#swaying-cloth).
