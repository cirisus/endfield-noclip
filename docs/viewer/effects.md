# scene effects

viewer implementation of [game-data/effects.md](../game-data/effects.md) and
[light beams](#light-beams); full gaps in [status.md](../status.md).

pipeline: extractor describers
([`game/materials/effects/`](../../packages/extractor/src/game/materials/effects/), one per shader)
emit a [surface](../package-format.md#materials) or mark it unsupported →
[`looks/effects/`](../../packages/viewer/src/looks/effects) (shared rows in `effect-look.ts`) packs
it into all 48 look rows (mesh looks use the first 35) →
[`effect.wgsl`](../../packages/viewer/src/render/meshes/effect.wgsl) shades it. particle-mesh
effects run through [particles](particles.md#particles) and carry
[custom data](particles.md#custom-data).

## VFXBaseV2 and VFXDecal

- **slots and packing**:
  - 6th sample texture uses the vertex-offset slot; vertex stage reads vertex offset from slot 7.
  - [vertex offset mask](../game-data/effects.md#vertex-offset-and-brightening) takes the highest
    empty sample slot (`EffectVertexOffsetMask.slot`, no role so fragment skips it; vertex reads
    `EffectRow.offsetMask`). if all 5 sample slots are used, material is unsupported.
  - enabled sample slots with no bound texture bind white when the shader default is white, else
    omitted.
  - per-slot distortion share (`*UseDisturb`) packs into slot bits above the low byte in 1/1024ths
    (`slotDisturb`).
- **blending & opaque queue**: `_BlendMode` 1 adds unfogged.
  [opaque](../game-data/effects.md#vfxbasev2) VFXBaseV2 draws in the main pass after meshes
  (`effectOpaque`, `fs_effect_opaque`), writing depth and `rgb * a` radiance (no SSR, AO, or
  decals). main-pass outputs bind 1×1 `mainPassStandIns`, so opaque materials with soft blend, edge
  colour, or stencil stay unsupported. composite fogs them as opaque surfaces (unchecked).
- **lighting**: per-pixel irradiance volume + far-layer-only sun shadow without cloud shadow
  (`sun_visibility_far_cloudless`), no local lights, sun divided by π ([sun](lighting.md#sun)).
- **breathing**: runs on the viewer clock with no per-draw time scale/offset (all placements pulse
  in step); values sit in the decal-fade row.
- **water blending**: omitted (matches game above `_WaterHeight`). fragments below `_WaterHeight`
  show the unsupported checker (`waterBlendBelow`); heights ≤ −1000 are treated as below all levels.
- **soft-body animation**: position texture takes the vertex-offset slot, UV/scroll rows hold UV1
  scales + cycles/s + phase (held frame = still phase), offset rows hold bounds and frame count
  (`VertexMotion` in [`stack.ts`](../../packages/viewer/src/looks/effects/stack.ts)). rotation
  texture is unread, so soft bodies with lighting, Fresnel, vertex offset, 6th sample texture, or
  particle playback stay unsupported.
- **camera pull & edge colour**: `EffectStackSurface.cameraPull` (`null` in particle mode,
  VFXDitherAlpha, VFXDecal) applies in `vs_effect` before vertex offset (`EffectRow.cameraPull`).
  edge colour compares fragment view depth to main-pass depth (`EffectRow.edgeColor`, `edge`,
  `edgeAlpha`).
- **VFXDecal**: draws back-face cubes without depth test, reconstructing main-pass surface from
  depth (and normal from packed surface for `_USE_NORMALBLEND`). `*CustomData` shifts fold into slot
  offsets; `_USE_IN_PARTICLE` is unsupported. additive (`Blend One One` + `_BlendMode` 1) adds
  unfogged; other additive modes are unsupported. [parallax](../game-data/effects.md#vfxdecal)
  (`DecalParallax`) places depth, crack mask, and crack noise in 3 unused role-less slots and its
  parameters in reveal rows (`EffectRow.parallax`, `crack`, `crackNoise`), evaluated by
  `fx_decal_parallax` and `fx_decal_cracks`; parallax beside a blend layer stays unsupported.

## VFXAdvance and the reveal

- **`describeVfxAdvance` (`variant: 'advance'`)**: supports main, disturb 1, mask, blend, dissolve
  (slots 0–4; dissolve uses VFXBaseV2 sweep/edge), Fresnel, normal map, emission, soft blend, fog,
  vertex offset, and reveal; other keywords/interiors stay unsupported.
  - normal map (`EffectStackSurface.normalMap`) and emission texture take role-less slots 5 and 6
    (`fx_fresnel_normal`, `fx_stack_layer`); emission + vertex offset collides on slot 6
    (unsupported).
  - rows 44–46 (`EffectRow.fresnelColor`, `normalMap`, `emission`) hold Fresnel colour (also used by
    VFXBaseV2), normal-map slot/scale, back-face normal flip, and emission colour/slot.
  - row 43 adds `disturbNormal` (read disturb as normal) and `blendVertexColor` (multiply blend tint
    by vertex colour). ink keywords draw as without ink simulation.
- **`CharacterNPR_VFX` (`describeCharacterVfx`)**: shares the VFXAdvance path with screen UVs and no
  dissolve; nonzero `_VertCameraOffset` is unsupported. `screenUv.localPivot` (bit 4 of screen-UV
  flags) uses the draw origin (prefab origin for posed skinned meshes, which can shift the pattern
  vs. game).
- **reveal (`EffectAppear`, rows 40–43)**: `fx_appear` modifies tint before stack combine for
  VFXAdvance and VFXDitherAlpha effects. camera stands in for player; global radii pass via
  `frame.render_size.zw` from `fireSeed:player` (`PackageManifest.fireSeed`, `revealRadii`, 0 if
  absent). `EffectAppear.global == false` uses material radii around the camera (e.g. Yinglung Pass
  ink rooms); fixed-point reveals are unsupported. brightening colour is linearized like tint.

## over the composited scene

passes running after composite and water, into the composited scene with main-pass depth read-only
(`MaterialLook.queue`: `multiply`, `refractOpaque`, `refract` in
[`draw-ranges.ts`](../../packages/viewer/src/render/meshes/draw-ranges.ts)):

- **multiply (`fs_effect_multiply`)**: `_BlendMode` 2 VFXBaseV2 layers (no stencil available;
  stencilled ones stay unsupported).
- **refraction (`fs_refract`)**: [VFXRefract](../game-data/effects.md#refraction) samples a copy of
  the post-multiply scene (includes fog, transparents, water, which the game's copy may not); colour
  offsets sample the same copy, soft blend reads main-pass depth. slot 2 = dissolve, slot 3 = blend
  layer, slot 4 = spread (rows reuse VFXBaseV2 vertex-offset/edge rows via `RefractRow`). custom
  data comes from particles only (mesh UV1 unread).
- **opaque refraction (`RefractSurface.opaque`)**: draws just before blended refraction from the
  same copy with `One Zero` blend, writing main-pass depth (effect group binds stand-in depth; only
  discarded alpha reads it).

## reflection-only effects

omitted (`UNDRAWN_SHADERS` in
[`material-describe.ts`](../../packages/extractor/src/game/materials/material-describe.ts)) and
excluded from viewer SSR inputs.

## portals

[portals](../game-data/effects.md#portals) use a stencil buffer (`LookStencil` in `look.ts`,
requires `depth32float-stencil8`). opaque masks write stencil only at the end of the main pass
(depth-tested, no colour/depth write). in the transparent pass, stencil writers draw first; stencil
state and depth test select pipeline variants. stencil ops other than keep/replace are unsupported.

## solid effects

VFXDitherAlpha and VFXWaterDitherAlpha split into two paths:

- **opaque mesh path (`ditheredLook` in `special-looks.ts`)**:
  - [dither](../game-data/effects.md#solid-effects) runs as alpha-test in `fs_cutout_depth`
    (`mesh.wgsl`) for default `_DitherAlphaMode` without `_USE_MAIN2`. `_UseMainTexAsAlpha` binds
    texture in normal slot (unlit) or base slot (lit, tint provides base colour). uses instance
    colour as vertex alpha, `DitherRow.near` for near-camera fade, and TAA jitter phase
    (`frame.params.w`, 0 when AA off).
  - `_USE_MAIN2` draws only for `_UseMainTex2AsAlpha` + `_MainTex2BlendMode` 0 (multiplies tint by
    `_MainTex2Color`, skips alpha-test).
  - lit materials whose only effect keyword is `_USE_MASK` bind a still UV0 mask in the noise slot
    without its shading flag (`DitheredSurface.dither.mask`, e.g. Qingbo reeds/bamboo leaves). if
    `_MainTex` is unset, the mask packs as `dither.texture` (red-alpha main texture, tint-only
    colour; e.g. Yinglung camphor leaves, unchecked).
  - `DitherFlags.VertexColor` multiplies instance colour × mesh vertex colour (assumed linear,
    unchecked) into tint and texture before albedo saturate (`DitherFlags.Surface` tags the row for
    `dither_bits`). NoLighting sets `DitherFlags.AlphaColor` to multiply colour by pre-mask,
    pre-power `dither_alpha` (including mesh vertex alpha).
  - `_SUBSURFACE` uses `subsurface_sun` and `Surface.scatter` (`DitherRow.subsurface`, metallic
    zeroed; local lights treat as default surface).
- **texture-stack path (`describeDitherEffect`, `stackLook`)**:
  - unlit VFXDitherAlpha with distortion, dissolve, mask, or polar/screen UVs, plus
    VFXDitherAlphaNoLighting with distortion, mask, and vertex offset.
  - alpha-blends using `alpha^_DitherAlphaExp` instead of dithering (no depth write, so effects
    behind are not occluded; thins Very Large Rift's red sky ring `wenli_01_red` at exp 3).
  - `maskAlphaOnly` (`EffectRow.maskAlphaOnly`) scales alpha only (red under `_UseMaskTexAsAlpha`,
    else alpha). NoLighting sets `EffectRow.colorTimesAlpha` and uses G-buffer surface fog
    (unchecked). `_INK_DISTORT` draws as without it. vertex offset omits vertex-alpha weight and
    camera pull (offset alone does not promote a material to the stack). `_USE_MAIN2` (alpha +
    multiply) multiplies tint by `_MainTex2Color` without sampling (e.g. Wuling red-tide walls).
  - unsupported on stack: lit variants, other dither/main2 modes, object-relative screen UVs.

## waterfalls

VFXWater draws via `water_sheet` (`effect.wgsl`,
[`water-sheet.ts`](../../packages/viewer/src/looks/effects/water-sheet.ts)):

- `_BlendMode` 1 adds light. post-exposure division applies to the unlit share only (applying it to
  lit darkened dark-cave falls like Jingyu). normal-map tangent frame uses UV screen derivatives.
- `VFX_WATER_SIMPLE_LIGHT` shades fully; non-UV0 textures are unsupported.
  `WaterSheetSurface.farShadowOnly` uses `sun_visibility_far`; both kinds use standard surface
  shadow lookup (not the sheet's 4-tap cascade filter and 0.5 m normal offset).
- **soft body (`WaterSheetSurface.softBody`)**: position texture in slot 6 (`setSoftBodySlot`),
  rotation texture in slot 5 (`fx_soft_body_normal` in `vs_effect`), bounds/frame count in
  `WaterSheetRow.softMin`. collides with flipbook motion vectors and normal map (unsupported if
  combined, or if particle-driven).

## six-way smoke

draws via `six_way_smoke` (`effect.wgsl`,
[`six-way-smoke.ts`](../../packages/viewer/src/looks/effects/six-way-smoke.ts)):

- slot 0 = positive lightmap, slot 6 = negative lightmap (at slot 0 UVs), slots 1–5 = distortion,
  mask, blend, dissolve.
- slot bits carry switched-UV starts plus `SIX_WAY_SCREEN_DEPTH` (depth-scaled screen UVs);
  `_UsePosYAsScreenV` rides in screen-UV flags (stack's own depth scale stays off).
- particle frame: normal faces camera, object X orthogonalized to it. sun uses `lightColor / π` with
  per-pixel shadow (no ramp texture). mask/dissolve on UV1 reads UV0 on particles (`_InParticle`),
  unsupported on meshes.

## mist

[mist](../game-data/effects.md#mist) uses `fs_mist_card` and `fs_mist_volume` in `effect.wgsl`:

- **cards**: lit cards use `sun / π` with mesh normal (no normal map) and omit `_USE_FOG`. missing
  noise binds white (`MistCardSurface.noise == null`); Fresnel is `MistCardSurface.fresnel`.
  additive cards add unfogged; premultiplied cards fog and blend over.
- **boxes**: additive only (no depth prepass or vertex colour). draw back faces without depth test;
  thickness uses the nearer of scene depth, water depth, and back face. 3D noise streams whole into
  `volumeTexture` (zeroed placeholder when absent; box waits for residency).

## light beams

[light beams](../game-data/lighting.md#light-beams) draw via `light_beam` (`effect.wgsl`,
[`light-beam.ts`](../../packages/viewer/src/looks/effects/light-beam.ts)):

- `beam_vertex` in `vs_effect` shapes the cone; fragment recovers beam and camera frames from the
  instance inverse transform.
- additive beams add unfogged; alpha-blended beams fog under `VLB_USE_FOG`.
- omitted: 3D noise, per-renderer scale, global tint. colour is not scaled by exposure (matches game
  shader; unverified against an in-game shot).

## blending

transparent effects draw with glass in the [transparent pass](frame.md), far-to-near by instance:
`fx_accumulate` fogs fogged effects at their own distance and blends premultiplied colour + opacity;
`fx_additive` adds unfogged with opacity 0. effects cast no shadows and wait until all textures are
resident.
