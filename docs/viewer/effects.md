# scene effects

viewer implementation of [game-data/effects.md](../game-data/effects.md) and
[light beams](#light-beams); full gaps in [status.md](../status.md).

particle-mesh effects run through [particles](particles.md#particles) and carry
[custom data](particles.md#custom-data).

## VFXBaseV2 and VFXDecal

- **slot limits**: vertex offset and a 6th sample texture share a slot, and a vertex-offset mask
  uses an empty sample slot, so materials combining all 5 sample slots with a vertex-offset mask
  stay unsupported. enabled sample slots with no bound texture bind white when the shader default is
  white, else are omitted.
- **blending & opaque queue**: `_BlendMode` 1 adds unfogged.
  [opaque](../game-data/effects.md#vfxbasev2) VFXBaseV2 draws in the main pass after meshes, writing
  depth and `rgb * a` radiance (no SSR, AO, or decals). opaque materials with soft blend, edge
  colour, or stencil stay unsupported. composite fogs them as opaque surfaces (unchecked).
- **lighting**: per-pixel irradiance volume + far-layer-only sun shadow without cloud shadow, no
  local lights, sun divided by π ([sun](lighting.md#sun)).
- **breathing**: runs on the viewer clock with no per-draw time scale/offset (all placements pulse
  in step).
- **water blending**: omitted (matches game above `_WaterHeight`). fragments below `_WaterHeight`
  show the unsupported checker; heights ≤ −1000 are treated as below all levels.
- **soft-body animation**: rotation texture is unread, so soft bodies with lighting, Fresnel, vertex
  offset, 6th sample texture, or particle playback stay unsupported.
- **camera pull & edge colour**: camera pull applies in the vertex stage (omitted in particle mode,
  VFXDitherAlpha, and VFXDecal); edge colour compares fragment view depth to main-pass depth.
- **VFXDecal**: draws back-face cubes without depth test, reconstructing main-pass surface from
  depth (and normal from packed surface for `_USE_NORMALBLEND`). `*CustomData` shifts fold into slot
  offsets; `_USE_IN_PARTICLE` is unsupported. additive (`Blend One One` + `_BlendMode` 1) adds
  unfogged; other additive modes are unsupported. [parallax](../game-data/effects.md#vfxdecal)
  combined with a blend layer stays unsupported.

## VFXAdvance and the reveal

- **VFXAdvance**: supports main, disturb 1, mask, blend, dissolve (using VFXBaseV2 sweep/edge),
  Fresnel, normal map, emission, soft blend, fog, vertex offset, and reveal; other keywords and
  interiors stay unsupported. emission + vertex offset collide on texture slots (unsupported). ink
  keywords draw as without ink simulation.
- **`CharacterNPR_VFX`**: shares the VFXAdvance path with screen UVs and no dissolve; nonzero
  `_VertCameraOffset` is unsupported. local-pivot screen UVs use the draw origin (prefab origin for
  posed skinned meshes, which can shift the pattern vs. game).
- **reveal**: modifies tint before stack combine for VFXAdvance and VFXDitherAlpha effects. camera
  stands in for player; global radii come from `fireSeed:player` (`PackageManifest.fireSeed`, 0 if
  absent), while local reveals use material radii around the camera (e.g. Yinglung Pass ink rooms).
  fixed-point reveals are unsupported.

## over the composited scene

passes running after composite and water, into the composited scene with main-pass depth read-only:

- **multiply**: `_BlendMode` 2 VFXBaseV2 layers (no stencil available; stencilled ones stay
  unsupported).
- **refraction**: [VFXRefract](../game-data/effects.md#refraction) samples a copy of the
  post-multiply scene (includes fog, transparents, water, which the game's copy may not); colour
  offsets sample the same copy, soft blend reads main-pass depth. custom data comes from particles
  only (mesh UV1 unread).
- **opaque refraction**: draws just before blended refraction from the same copy with `One Zero`
  blend, writing main-pass depth.

## reflection-only effects

omitted and excluded from viewer SSR inputs.

## portals

[portals](../game-data/effects.md#portals) use a stencil buffer (requires `depth32float-stencil8`).
opaque masks write stencil only at the end of the main pass (depth-tested, no colour/depth write).
in the transparent pass, stencil writers draw first; stencil ops other than keep/replace are
unsupported.

## solid effects

VFXDitherAlpha and VFXWaterDitherAlpha split into two paths:

- **opaque mesh path**:
  - [dither](../game-data/effects.md#solid-effects) runs as alpha-test for default
    `_DitherAlphaMode` without `_USE_MAIN2`, using instance colour as vertex alpha, near-camera
    fade, and TAA jitter phase (0 when AA off).
  - `_USE_MAIN2` draws only for `_UseMainTex2AsAlpha` + `_MainTex2BlendMode` 0 (multiplies tint by
    `_MainTex2Color`, skips alpha-test).
  - lit materials whose only effect keyword is `_USE_MASK` bind a still UV0 mask (e.g. Qingbo
    reeds/bamboo leaves); if `_MainTex` is unset, the mask drives alpha with tint-only colour (e.g.
    Yinglung camphor leaves, unchecked).
  - vertex colour is assumed linear (unchecked). `_SUBSURFACE` uses sun subsurface scattering with
    metallic zeroed (local lights treat as default surface).
- **texture-stack path**:
  - unlit VFXDitherAlpha with distortion, dissolve, mask, or polar/screen UVs, plus
    VFXDitherAlphaNoLighting with distortion, mask, and vertex offset.
  - alpha-blends using `alpha^_DitherAlphaExp` instead of dithering (no depth write, so effects
    behind are not occluded; thins Very Large Rift's red sky ring `wenli_01_red` at exp 3). when
    nothing can lower the tested alpha below 1 (unset `_MainTex`, alpha ≥ 1, no dissolve, mask,
    reveal, or near fade), draws as opaque in the main pass with depth writes so transparent
    overlays (like the water switch's foreground icon) sort over it.
  - NoLighting uses G-buffer surface fog (unchecked). `_INK_DISTORT` draws as without it. vertex
    offset omits vertex-alpha weight and camera pull (offset alone does not promote a material to
    the stack). `_USE_MAIN2` folds `_MainTex2Color` into tint when `_UseMainTex2AsAlpha` and
    `_MainTex2BlendMode` 0 (e.g. Wuling red-tide walls); otherwise it blends a second main texture
    (e.g. Wuling water switch screen `M_fx_fxint_switch_water_004`).
  - unsupported on stack: lit variants, other dither modes, object-relative screen UVs.

## waterfalls

VFXWater:

- `_BlendMode` 1 adds light. post-exposure division applies to the unlit share only (applying it to
  lit darkened dark-cave falls like Jingyu). normal-map tangent frame uses UV screen derivatives.
- `VFX_WATER_SIMPLE_LIGHT` shades fully; non-UV0 textures are unsupported. shadows use the standard
  surface lookup (far layer only when flagged), not the sheet's 4-tap cascade filter and 0.5 m
  normal offset.
- **soft body**: collides with flipbook motion vectors and normal map (unsupported if combined, or
  if particle-driven).
- **refraction**: when a refracting sheet is in view, the frame graph copies the composited scene
  (including water) before the transparent pass.

## six-way smoke

- particle frame: normal faces camera, object X orthogonalized to it.
- sun uses `lightColor / π` with per-pixel shadow (no ramp texture).
- mask/dissolve on UV1 reads UV0 on particles (`_InParticle`), unsupported on meshes.

## mist

[mist](../game-data/effects.md#mist):

- **cards**: lit cards use `sun / π` with mesh normal (no normal map) and omit `_USE_FOG`. missing
  noise binds white. additive cards add unfogged; premultiplied cards fog and blend over.
- **boxes**: additive only (no depth prepass or vertex colour). draw back faces without depth test;
  thickness uses the nearer of scene depth, water depth, and back face. 3D noise streams whole (box
  waits for residency).

## light beams

[light beams](../game-data/lighting.md#light-beams):

- vertex stage shapes the cone; fragment recovers beam and camera frames from the instance inverse
  transform.
- additive beams add unfogged; alpha-blended beams fog under `VLB_USE_FOG`.
- omitted: 3D noise, per-renderer scale, global tint. colour is not scaled by exposure (matches game
  shader; unverified against an in-game shot).

## blending

transparent effects draw with glass in the [transparent pass](frame.md), far-to-near by instance:
fogged effects fog at their own distance and blend premultiplied; additive effects add unfogged with
opacity 0. effects cast no shadows and wait until all textures are resident.
