# scene effects

scenery effects are meshes using `HGRP/Effect/*` materials, mostly placed in dynamic structures. for
example, the magenta blight at Jingyu Valley's corrupted shrine (map02_lv001 near unity −905, 228,
−1505) combines `VFXDecal` ground stains and `VFXBaseV2` smoke cards in script group
`script:458752:41` (on by default). see [particles.md](particles.md) for particle systems and spline
movers, and [assets.md](assets.md#prefabs) for prefabs and billboards.

## VFXBaseV2 and VFXDecal

### the texture stack

both shaders are unlit and premultiplied (`One, OneMinusSrcAlpha`) and compose a stack of textures
by role:

| role     | effect                                                                                                                                                                                             |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| disturb  | R channel (remapped by `_Bi_Disturb`) shifts later textures' UVs by `_DisturbU/VIntensity1` (or `…2`) × each texture's `*UseDisturb`                                                               |
| weight   | scales distortion (`_WeightTexIntensity · _DisturbUseWeight`) and dissolve threshold                                                                                                               |
| mask     | multiplies main texture colour and alpha                                                                                                                                                           |
| blend    | adds `blend · saturate((alpha + blend.a) · _BlendTint.a) · _BlendTint.rgb`                                                                                                                         |
| dissolve | keeps alpha where R exceeds a threshold sweeping `−1.01..1.01` with `_DissolveScheduleOffset`, sharpened by `_DissolveEdgeSharp`; edge band `_DissolveEmissiveEdge` takes `_DissolveEmissiveColor` |

- `*UseDisturb` is often fractional: Si's Painting rising mist
  (`M_fxmap_dung02_rdg005_camille_range_smoke_01_1102`, map02_lv010) shifts its 2×2 sheet by 0.1 so
  neighbouring puffs do not bleed in.
- each texture scrolls by `*UVSpeed` per second, rotates about `(0.5, 0.5)`, then applies `_ST`.
  `*AsAlpha` uses R as alpha.
- LDR colour properties are linearized, and `[HDR]` colour properties are used as stored unless the
  shader also flags them `[Gamma]` (`0x30`; see [materials](materials.md#emission)), which Unity
  converts via `GammaToLinearSpace` (sRGB below 1, `c^2.2` past 1). VFXBaseV2, VFXAdvance, VFXDecal,
  VFXDitherAlpha, VFXRefract, and VFXSmoke_SixWay flag their HDR tint/emissive/Fresnel/edge colours
  `[HDR][Gamma]`, while VFXWater's `_TintColor` and FogSimple's colours are plain `[HDR]`.
  `_IgnorePostExposure` divides out post exposure.
- `_UseNearCameraFade` fades in over `_NearCameraFadeDistanceStart`–`…End` m of view depth and out
  over `…Start2`–`…End2` m.

### VFXBaseV2

- **textures**: main texture plus up to six `_SampleTexN` slots. `_SampleTexNUseWeightK` assigns
  each slot's role (`0` disturb 1, `1` disturb 2, `2` weight, `3` mask, `4` blend, `5` dissolve),
  applying that role's own `_ST` (`_DisturbTex1/2`, `_WeightTex`, `_MaskTex`, `_BlendTex`,
  `_DissolveTex`). unbound enabled slots and unbound main textures sample white (e.g. white talosite
  shards' mask, Origin Lodespring crater column base ring).
- **UV sources**: each texture blends UV0, UV1, polar, and screen UVs by `*UVWeights` (materials set
  one weight; disabled sources are 0, so textures weighted to them only scroll):
  - **polar** (`_USE_POLARUV` + `_UsePolarUV`): angle from `+v` as fraction of a turn and `2 ×`
    distance about UV0's centre.
  - **screen** (`_USE_SCREENUV` + `_UseScreenUV`): centred pixel position divided by half width
    (`v` = world height with `_UsePosYAsScreenV`), × object origin view depth past near plane
    (`_ScreenUVUseDepth`, default on). `_LocalPivortSpace` replaces pixel position with fragment
    offset from object origin along camera right/up (metres) before height/depth, anchoring to the
    object.
  - `_SampleTex5` (sixth slot) uses UV0 or UV1 alone and scrolls by `_SampleTex0UVSpeed`.
  - on particles (`_InParticle`), UV1 is UV set 0's `zw` (UV2 stream); UV set 1 is
    [particle custom data](#particle-custom-data).
- **colour & alpha**:
  - starts from `_TintColor · _TintColorIntensity · vertexColor` and
    `_TintColor.a · _TintColorAlpha`, brightened by `_ExpIntensity` above `_ExpThreshold`.
  - `_USE_ANIM_BREATHING` (e.g. Dijiang clue board panels): pulses alpha between
    `_BreathingMinAlpha` and 1 by `saturate((cos(t · _BreathingSpeed) · 0.5 + 0.5)^_BreathingPower)`
    (`t` = time scaled/offset by two per-draw values).
  - **Fresnel**: `f = saturate(N·V + _FresnelBias)^_FresnelPower` (flipped by `_FresnelFlip`; `N` is
    unflipped vertex normal on back faces too). runs before `_USE_EDGECOLOR` and brightening: mixes
    colour toward `_FresnelColor.rgb` by `_FresnelColor.w · f` and fades the clamped alpha by
    `_FresnelAffectOpacity`.
  - **`_USE_SOFTBLEND`**: fades alpha within `_SoftDistance` m of scene depth behind.
- **lighting (`_USE_LIGHTING`)**: treats colour as albedo (divided by post exposure under
  `_IgnorePostExposure`), lit by one per-renderer L1 irradiance probe, shadowed sun (no `1/π`,
  cached far shadow map only, no cloud shadow), and local lights, using camera-facing vertex normal
  or world up (`_RotateNormalToWorldUp`). examples: waterfall mist cards, indie_ccdg002 20–45 m
  smoke puffs (`p_fxmap_common_bigwind_smoke_medium_01`, world up). `_USE_FORCE_DYNAMIC_LIGHTING`
  (set on Marker Stone Interiors rift monster glow `M_fx_monster_enemy_etthillu_lsq_01`) is unread
  by all compiled variants.
- **blend modes**:
  - writes `alpha · (1 − _BlendMode)`. `_BlendMode` 1 (default; ~25% of scenery VFXBaseV2, e.g.
    corroded planet glare from Dijiang's deck) makes premultiplied output additive.
  - `_BlendMode` 2 writes `lerp(1, colour, alpha)` for `Blend DstColor Zero` (multiplicative).
- **ink wash**: `_OnlyShowAfterInkWash` scales alpha (and premultiplied colour) by
  `lerp(1, _InkWashGlobalParams.x, _OnlyShowAfterInkWash)`. outside ink wash, such materials draw
  nothing (e.g. Si's Painting grid quad `M_fxint_s_micro_008_decal_2501` in
  `int_drawing_puzzle_01_postmodel`, near unity 753, 278, 1308). the writer of
  `_InkWashGlobalParams` (`ShaderVariablesGlobal`) is untraced; its link to `VFXPPInkWash`
  (`PaintingScrollComponent`) is by name only.
- **opaque**: `_SrcBlend = One`, `_DstBlend = Zero` in queue 2000 overwrites colour with
  premultiplied colour and writes depth (forward-only: no GBuffer, no shadow). example: map01
  mining-pipe falling gravel (`p_fxmap_common_gravel_02`, near unity 635, 62, 632;
  `M_fx_quicksand_1104`, world-up lit, `_UseMainTexAsAlpha`, `_TintColorAlpha` 10; near-camera fade
  out 200–300 m turns distant rocks black instead of hiding them).

### edge colour

`_USE_EDGECOLOR` highlights depth intersections after dissolve and Fresnel, and before brightening:

```
e = _EdgeColor.a · saturate(_EdgeDistance / max(d, 0.001) − _EdgeDistanceOffset)
```

where `d` is view depth to scene depth behind. `_EdgeColorMode` blends between:

- `0`: multiplies colour by `_EdgeColor.rgb` and alpha by `e` (contact only)
- `1`: adds `(_EdgeColor.rgb, _TintColorAlpha) · e` (e.g. Dijiang aisle-guide panels
  `M_fxmap_base01_lv001_ship_aisle_guide_01_fj_05`, `_EdgeDistance` 0.002)

### vertex offset and brightening

- **`_USE_VERTOFFSET`**: moves vertices along `_OffsetDir` (`_OffsetSwitchDir`: 0 object, 1 world, 2
  vertex normal) by `_OffsetIntensity · (r · (1 + _Bi_Offset) − _Bi_Offset) · (1 − _InParticle)`.
  `r` is `_OffsetTex.r` at UV0 (UV1 with `_OffsetUVSet`), `_ST`, scrolled by `_OffsetSpeed`/s.
  `_UseVertexColorAlphaAsVertOffsetWeight` scales by vertex alpha. `_InParticle = 1` (default)
  disables it on particles and unconfigured meshes.
- **camera pull**: every VFXBaseV2 variant pulls vertices toward the camera by
  `(min(max(0, d − 1), _VertCameraOffset) + 0.001) · (1 − _InParticle)` m (`d` = camera distance).
  VFXDitherAlpha and VFXDecal do not pull.
  - keeps embedded glows visible: Marker Stone tower lamps (`P_fxmap_map_lv004_lamp_light_01`,
    `_InParticle = 0`) pull red streaks (`M_fxmap_map_lv004_lamp_light_01`, `_TintColor` red × 100)
    1 m, near stars 3 m, and far stars (>200 m) 50 m.
  - because each vertex pulls along its own view ray by its own distance, large quads skew along
    their diagonal within `_VertCameraOffset + 1` m (e.g. Si's Painting 5.5 m grid quad pulled 5 m).
- **`_USE_VERTOFFSETMASK`**: scales vertex offset (not camera pull) by
  `1 − (_OffsetMaskPower / 5) · (1 − m)`, where `m` is `_OffsetMaskTex.r` on offset UVs with its own
  `_ST` and `_OffsetMaskSpeed` (vertex stage only). used on collectible pieces
  (`M_fx_interactive_collection_2102` in `int_collection_piece_postmodel`: `_OffsetDir` 0.1 ×
  `_OffsetIntensity` 12.15 = 1.2 m along world y, mask power 3), Jingyu butterflies/waterfalls, and
  Wuling ink drops.
- **`_USE_BRIGHT`** (`_BrightType = 0`, `_BrightCenter.w = 0`): adds `_BrightColor` and UV wobble
  within `_OuterRadius` of the player (e.g. Wuling City floating-pillar teal streams
  `M_fx_map02_zhenlie_*`, map02_lv002). VFXBaseV2 uses material radii only; VFXAdvance and
  VFXDitherAlpha add [global reveal radii](#invisible-bridges) under `_USE_GLOBAL_APPEAR`.

## VFXAdvance

`HGRP/Effect/VFXAdvance` is VFXBaseV2 with fixed texture slots instead of `_SampleTexN`: main,
`_DisturbTex1/2` (shifting main and `_MaskTex` by `*UseDisturb`), mask, dissolve, blend, polar and
screen UVs, soft blend, edge colour, and an "interior" parallax tunnel.

differences from VFXBaseV2:

- **Fresnel**: reverses normal on back faces.
- **`_NORMAL_MAP`**: perturbs Fresnel normal with `_NormalMap` (Unity `alpha · red` unpack,
  `xy × _NormalScale`, undistorted `_NormalMap*` UVs). affects nothing else.
- **`_EMISSION`**: adds `_EmissionTex.rgb` (UV0 + `_ST`) × `_EmissionColor` before Fresnel colour.
  no variant combines `_EMISSION` with vertex offset. Deep Dale Street floating rocks/gravel
  (`M_fxmap_dung02_rdg008_rock_01_*`, `…_rock_float_gravel_01_1101`, near unity −62, 68, 85) use
  `_NORMAL_MAP` and `_EMISSION` (pale blue `_FresnelColor` at `w = 1`).
- **`_USE_DISSOLVE`**: VFXBaseV2 dissolve on `_DissolveTex` (`_Dissolve*` UVs,
  `_DissolveTexUseDisturb`), edge colour `_DissolveEmissiveColor · _TintColorIntensity`, applied
  after mask and before near-camera fade (e.g. ink bridge walls/floors/joins
  `M_fx_map02_lv007_inkbridge_freelance_*`).
- **`_USE_BLEND`**: VFXBaseV2 blend on `_BlendTex` (`_BlendTex*` UVs, `_ST` once,
  `_BlendTexUseDisturb`); `_BlendTint` multiplies by vertex colour unless `_BlendDisableVertColor`
  is set.
- **`_DisturbTex1Normal`**: reads disturb texture as a normal:
  `((a · r′, g) · 2 − 1) · _DisturbUIntensity1` on both axes (`r′` = R remapped by `_Bi_Disturb`;
  BC5 has `a = 1`).
- **fog & soft blend**: `_FogIntensity` scales fog (full past `_FogIntensityFadeOutDistance` m).
  `_USE_SOFTBLEND` fades alpha by `saturate((d_scene − d + _SoftBias) / _SoftDistance)` (e.g. Si's
  Painting cave ink road `M_fxmap_map02_lv010_cave_inkroad_02_fj_01/02/04`, near unity 727, 239,
  1166, script group 37900020000).
- **`_USE_BRIGHT`** (without `_USE_GLOBAL_APPEAR`): runs the [reveal](#invisible-bridges) with
  material radii only. Yinglung Pass ink rooms (map02_lv007 near unity −450, 270, 703;
  `M_fx_map02_lv007_inkroom_floor_0*` and `inkarea_*_postmod` walls in default-on script groups
  10200150010, …011, …021) set inner 8, outer 1, `_DistortAlpha` 0 (visible within 1–8 m, raised 2
  m).
- **`_INK_DISTORT` & `_INK_COLOR_DISTORT`**: sample the runtime ink simulation around the player
  (`_InkSimulationWorldToUV`). `_INK_DISTORT` (also in VFXDitherAlpha's GBuffer pass, shifting main,
  dissolve, and disturb via `_DisturbTex1UseInkSimulation`) offsets UVs by `RG · _InkDisturbOffset`.
  `_INK_COLOR_DISTORT` blends `_InkColor` by `result · _InkStrength` (max `_InkMaxAlpha`). both fade
  on steep surfaces and do nothing outside the simulation square.

## CharacterNPR_VFX

`HGRP/CharacterNPR_VFX` renders a single forward-pass effect shell over skinned character meshes:

- fixed-slot stack like VFXAdvance (main, `_DisturbTex1`, mask, blend, Fresnel, soft blend,
  near-camera fade, `_FogIntensity` fog) with VFXBaseV2 [screen UVs](#vfxbasev2) and
  `VFX_CHARACTER_DISSOLVE` instead of standard dissolve.
- vertex offset matches VFXBaseV2; camera pull is the full `_VertCameraOffset + 0.001` m (uncapped).
- Marker Stone Interiors rift monsters (`p_fxmap_map02_lv004_liexi_only_*`, ~80 placements) pair a
  VFXBaseV2 glow (`M_fx_monster_enemy_etthillu_lsq_01`) with a CharacterNPR_VFX shell
  (`M_fx_monster_enemy_etthillu_01d11d12_01_04_01`, `…a`) pushed 0.25 m along normals, pale blue
  blend layer, flipped Fresnel, object-anchored screen UVs, fading out at 20–40 m (`…a`: 80–100 m).

## invisible bridges

Yinglung Pass (map02_lv007) has ink bridges revealed around the player while carrying a lit fire
seed. they layer VFXAdvance (`M_fx_map02_lv007_inkbridge_freelance_801` body, `…_802` ink strokes
with vertex offset) and VFXDitherAlpha (`…_802_01` solid surface), all with `_USE_BRIGHT` and
`_USE_GLOBAL_APPEAR`. west of unity −602, 248, 569 (along `x ≈ −623`), two script groups form the
bridge: `z` 515–534 (group 10200150050, default-on) and `z` 556–587 (group 10200150054, shown by
script 10200030004 on server-driven custom event `#16fa73e2`).

- **reveal math**: let `d` = distance from player (`_VFXParams0.xyz`) raised by `_CharacterHeight`,
  `R` = global reveal radii (`_VFXParams3.xy`), and
  `s(x) = smoothstep(_OuterRadius + R.y, _InnerRadius + R.x, x)`:
  - tint adds `_BrightColor · s(d)` (alpha × vertex alpha with `_BrightUseVertColor`).
  - alpha becomes `saturate(mix(a, a · _DistortAlpha, s(d + _DistortOnEdge · n)))`, where
    `n ∈ [−1, 1]` is smooth value noise (sine-hashed lattice wrapped to 1024) on main UVs ×
    `_DistortScale`, scrolled by `time · _DistortSpeed` on both axes.
  - bridge materials set inner 2, outer −4, `_DistortAlpha` 0: visible within `R.x − 4` m, gone past
    `R.x + 2` m, frayed up to `_DistortOnEdge` (1 m on body).
- **fire seed**: `FireSeedBrain.SetFireSeedLevel` (called by `SetFireSeedLevel` in scripts
  10200030004 and 10200260001 for levels 0–4) sets `R` from `FireSeedGameplayConfig`:
  - level 0 (no seed): `invisibleBrightInnerRadius` / `…Outer` = 9999 / 50000 m (fully transparent).
  - level `n`: `effectRadius[n − 1]` (4, 7, 10, 10, 12 m) and `+ radiusThickness` (0.5 m), eased
    over `fadeTime` along `radiusChangeCurve`. initial `R` before any call is unrecovered.
  - script 10200030004 (active sphere 442 m around unity −589, 257, 607) sets level to map variable
    #142 (`fire_seed_level_map`) on entering trigger 80001 (two pass boxes), 0 on exit; custom
    events set levels 1–4 (`#72485a44`, `#86ef311f`, `#d5cf68e0`, `#8da37c78`) and 0 (`#e5aceaf8`).
    script 10200260001 also reads #142. no client data writes #142 (server-held).

## water blending

VFXBaseV2's `_USE_WATER_BLEND` attenuates fragments below `_WaterHeight` by `_WaterAbsorption` /
`_WaterAbsorption2` and adds inscatter over underwater ray length
`clamp(_WaterHeight − y, 0, 1000) / |view.y|`. above `_WaterHeight` (and in the vertex stage) it
does nothing.

- `VFXWaterBlendConfig` updates these parameters when entering water (inferred from fields/methods;
  code unread).
- authored `_WaterHeight` is −9999, −999, or 0, so out-of-water placements render unchanged (e.g.
  Aurelyne collectible orbs `int_collection_coin_*_postmodel` in Aburrey Quarry near unity 364, 44,
  −700; all map01/map02 orbs sit at `y ≥ 18.8`).

## soft-body animation

VFXBaseV2's `_VAT_SOFTBODY` plays a Houdini VAT in object space, reading `_PositionTexture` at UV1
and the current frame:

- **frame**:
  `floor(fract((time − _gameTimeAtFirstFrame) · _houdiniFPS / (_frameCount − 0.01) · _playbackSpeed) · _frameCount)`
  with `_B_autoPlayback`, else `_displayFrame − 1`.
- **UV**: `(u · a, 1 − b · ((1 − v) + frame / _frameCount))`, where `a`, `b` = `1 + x − ceil(x)` for
  `x = 10 · _boundMinZ` and `10 · _boundMaxX` (1 for seen bounds).
- **decoding**: `_TextureFormat` 1 stores raw HDR offsets; 8-bit maps `0..1` to
  `_boundMin*`..`_boundMax*`. vertices with `UV1.v ≤ 0.1` collapse to origin. `_RotationTexture`
  holds a quaternion rotating normal/tangent from `+y`/`−x` (8-bit stores `q / 2 + 0.5`).
- example: Hub Aurelyne core blob (`M_erosionmud_core`, map01_lv001 near unity −104, 118, −534; 100
  frames looped 3.5×/s).

[VFXWater](#waterfalls) shares `_VAT_SOFTBODY` and shades with the rotated normal. without
`_B_autoPlayback`, its frame is `floor(_displayFrame + d) − 1` (`d` = untraced per-draw offset,
taken as 0) plus particle custom data `w` under `_HoudiniVATInParticle`. Qingbo's octagonal
waterwheel pours (`M_fx_xiaoshuiche` on two renderers of `p_igroup_map02_sfwaterwheel+2_004_01`, 400
frames @ 60 fps) drive `_displayFrame` from the wheel's
[Animator clip](animation.md#scenery-animators) (four 1→375 ramps over 25 s, staggered half a ramp
apart) alongside `_TintColorAlpha` and `_DissolveScheduleOffset`.

## VFXDecal

`HGRP/Effect/VFXDecal` draws a unit cube (`s_fx_particle_decal_cube`), reconstructs scene depth, and
projects down box `y` (`UV = local.xz + 0.5`) for points inside the box.

- **fixed slots** (each gated by its `_USE_*` keyword): `_MainTex`, `_MaskTex`, `_BlendTex`,
  `_DisturbTex1/2`, `_WeightTex`, `_DissolveTex`.
  - `*SwitchUV`: `1` = screen UVs (pixel pos / width; requires `_USE_SCREENUV` + `_UseScreenUV`),
    `2` = polar UVs about box axis (requires `_USE_POLARUV` + `_UsePolarUV`).
  - `_WeightTex` does not scroll or rotate; scales distortion and dissolve by
    `1 − _WeightTexIntensity + red · _WeightTexIntensity` (`_DisturbUseWeight`,
    `_DissolveUseWeight`).
  - example: Power Plateau grating rift (map01_lv007 near unity −129, 173, 593; two decals around
    polar-UV VFXBaseV2 rings).
- **colour & fades**: `_DecalBaseColor` (alpha × `_TintColorAlpha`), faded at x/z faces
  (`_EdgeFadeX/Z` over `_EdgeFadeIntensity`), top/bottom (`_HeightFade` around `_HeightFadeOffset`),
  and with `_USE_NORMALBLEND` by `(N · boxUp)^_AngleBlendFallOff`. colour is premultiplied by alpha
  twice. under `Blend One One`, `_BlendMode` 1 drops fog in-scatter without scaling alpha (e.g.
  Marker Stone Interiors flowing-light ground glow
  `M_fxmap_dung02_rdg002_flowinglight_02_ground_fj_01`).
- **stencil**: tests `Equal` against `_StencilRef` with `_StencilReadMask` (defaults 0 and 32),
  ignoring `_StencilComp` (same as [decals](materials.md#decals)), so bit-32 surfaces (foliage) are
  excluded (e.g. Si's Painting 28–35 m water decals `M_fxmap_map02_lv010_waterdecal_02` near unity
  1110, 378, 1155, and all 29 known-path VFXDecal materials).
- **`_USE_PARALLAX`**: sinks the decal via 30-layer raymarch (`−_ParallaxScale · v.xz / v.y / 30`
  per layer in box frame, ≤31 samples from 29/30 down) through `_DepthTex.r` (1 at top), refining
  between the last two layers.
  - `_MainTex` and `_CrackMask` (undistorted) sample shifted UVs; `_CrackNoiseTex`
    (`_ParallaxSwitchUV`, `_ST`, `_CrackNoiseSpeed`/s) shifts by `_ParallaxUseDisturb` + parallax.
  - adds `lerp(_CrackColor · m, noise · _CrackNoiseColor · _CrackNoiseIntensity, m)` (`m` =
    `_CrackMask.r`) before dissolve edge colour. all three textures default white; dissolve is
    unshifted.
  - used by two materials: Marker Stone Interiors floor ash (`M_fxmap_map02_lv004_ash_01_03` in
    `p_fxmap_map02_lv004_ash_large_01`, indie_dg007) and erosion-mud anchor core
    (`M_fx_angel_anchorcore_852`).
- **custom data**: off particles, textures shift by `*UVSpeed.zw` × material constants
  (`_MainCustomData`, `_DisturbCustomData`, `_MaskCustomData`, `_BlendCustomData`,
  `_DissolveCustomData`), and dissolve schedule has no offset. on particles (`_USE_IN_PARTICLE`),
  uses its own stream layout ([below](#particle-custom-data)).

## particle custom data

on particles, UV set 1 carries custom data `c`
([custom data](particles.md#texture-sheets-and-custom-data)). shared rule: main UVs shift by
`*UVSpeed.zw · c.x`, other textures by `*UVSpeed.zw · c.y` (before rotation), and `c.z` adds to
`_DissolveScheduleOffset`.

| shader                                               | gate                | specifics                                                                                                                                                                                                                                    |
| ---------------------------------------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| VFXBaseV2, VFXDitherAlpha, VFXWater, VFXSmoke_SixWay | `_InParticle`       | six-way lightmaps act as main texture; VFXBaseV2 `c.w` scales distortion under `_UseParticleDisturb` (off ink-wash path, where `w` is `UV0.v`, so meshes get 0 distortion); VFXDitherAlpha vertex offset `zw` takes `c.y` (off on particles) |
| VFXRefract                                           | none (always reads) | on meshes, UV1 stands in; `c.x` shifts refract, `c.y` shifts mask/blend (dissolve/spread unshifted), `c.w` adds to spread schedule                                                                                                           |
| VFXDecal                                             | `_USE_IN_PARTICLE`  | Center and SizeXYZ streams give box centre/size; `Custom1.xyz` gives `c.xyz` (only `M_fx_map_lv007_angeresidue_2104` on decal-cube mesh particles)                                                                                           |

no effect shader reads the second custom stream or colour-mode custom data. example: dung02_rdg011
anchor black smoke (`blackfire01` in `p_fxmap_map_lv006_angel_anchor_smoke_active_1p8`,
`M_fx_angel_anchorlight_834`) randomizes UV shift and ramps dissolve from ~0.35 to 0.95 over life.

## portals

VFXBaseV2 exposes stencil (`_StencilComp`, `_StencilOp`, `_StencilRef`, `_StencilReadMask`,
`_StencilWriteMask`) and depth (`_ZTest`) states. `_UseVFXPortal` uses them to mask one effect
through another:

- Hub plaza cracks (map01_lv001 near unity −365, 95, −439): an opaque crack mask (queue 2000,
  shaded + depth write) writes stencil 7; the glow and red chasm cylinder draw only where stencil ==
  7 with depth test off.
- other pairs write stencil from a transparent layer and draw a second layer with `NotEqual`.

## solid effects

three dithered-alpha shaders draw solid effect meshes using interleaved gradient noise:

| shader                                 | pass    | lighting & notes                                                                                                                                                                                                                                 |
| -------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `HGRP/Effect/VFXDitherAlpha`           | GBuffer | `_UseLighting` writes saturated albedo, else emission; `_IgnorePostExposure` scales by inverse post exposure; `_NORMAL_MAP` (`_NormalScale`, `a·r` unpack); `_Roughness`, `_Metallic`; no shadow pass                                            |
| `HGRP/Effect/VFXWaterDitherAlpha`      | GBuffer | same passes with fewer variants (`_NORMAL_MAP`, `_USE_DISTURB`, `_USE_DISSOLVE`, `_USE_MASK` in depth, plus `_SUBSURFACE`, `_USE_SEQUENCE_FRAME_*`); `_SUBSURFACE` uses [subsurface](materials.md#subsurface) with `_Metallic` as scatter weight |
| `HGRP/Effect/VFXDitherAlphaNoLighting` | forward | no `_UseLighting`, no fog; draws only where depth pass survived (`ZTest Equal`, `One Zero`); colour × saturated alpha (without mask, before dither power)                                                                                        |

- **base colour**: `_TintColor · _TintColorIntensity` × vertex colour (unless `_DisableVertColor`) ×
  `_MainTex` (omitted under `_UseMainTexAsAlpha`). in VFXDitherAlpha, `_USE_MAIN2` with
  `_UseMainTex2AsAlpha` and `_MainTex2BlendMode` 0 multiplies by `_MainTex2Color` without sampling
  `_MainTex2` (depth pass has no `_USE_MAIN2`).
- **dithered depth pass**: keeps pixel when alpha exceeds interleaved gradient noise at
  `pixelPos · _DitherTilling`, offset by `_TaaFrameInfo.z` (TAA cycle index, unread in game code,
  resolved by TAA). tested alpha =
  `saturate(_TintColor.a · _TintColorAlpha · mainAlpha · vertexAlpha · nearFade)^_DitherAlphaExp`
  (`mainAlpha` = R under `_UseMainTexAsAlpha`; `vertexAlpha` omitted under `_DisableVertColor`).
  - examples: Power Plateau sky vortex `blackspot`; Origin Lodespring crater floating rocks (gold
    mask × tint 12× → black rock with gold veins); Wuling dam splashes
    (`M_fxmap_water_citywaterfall_820` in `p_fxmap_common_citywatersplashes_small_b_802` near unity
    −1243, 286, −336: `_Metallic` 0 → plain white foam, particle alpha 0.3–1 fading out); Si's
    Painting cave falls foam (`M_fx_map_common_waterdecal_splashes_2504_01` in
    `p_fxmap_map02_lv010_water_splashes_01` near unity 734, 233, 1151: intensity 50, metallic 0.8,
    normal map, `_UseMainTexAsAlpha`, power 2); Si's Painting ink plane
    (`M_fxmap_map02_lv010_inkpattern_huge_01_fj_03_d02` in `p_fxmap_map02_lv010_inkpattern_huge_01`)
    and cliff ink sheet (`M_fxmap_map02_lv010_inkpattern_crack_cave_01_fj_01_d` near unity 1100,
    356, 1246, script group 37900000011).
- **texture stack keywords**: `_USE_DISTURB` (`_DisturbTex1`, normal-read under `_DisturbTex1Normal`
  as in [VFXAdvance](#vfxadvance), `_MainTexUseDisturb` / `_DissolveTexUseDisturb` default 1),
  `_USE_DISSOLVE`, `_USE_POLARUV`, `_USE_SCREENUV` work as in VFXBaseV2.
- **`_USE_MASK`**: depth pass only. `_MaskTex` (alpha, or R under default `_UseMaskTexAsAlpha`;
  scrolls, rotates, `_MaskTexUseDisturb`) multiplies tested alpha without colouring. examples: Very
  Large Rift portal band (`glow_04_line` in `p_fxmap_dung02_dg005_boss_semicircle_01`); Yinglung
  Pass camphor leaves (`M_fxmap_common_camphor_leaves_07` in `p_fxmap_map02_lv007_camphor_leaves_01`
  near unity −816, 286, 613: unset `_MainTex` defaults white, mask cuts leaf, tint 4.7 × particle
  colour).
- **`_USE_VERTOFFSET`**: VFXBaseV2 vertex offset in both passes, without vertex-alpha weight or
  camera pull (e.g. Very Large Rift escaping trails `blue02`/`red02` in
  `p_fxmap_dung02_dg005_boss_semicircle_escapism_trail_02`, pushed 0.5 m along normals).

## reflection-only effects

`HGRP/Effect/VFXReflectionPass` is never shaded into the main image. it defines `ForwardReflection`
and two ray-traced reflection passes. the deferred path draws `ForwardReflection` only in the
[SSR](lighting.md#screen-space-reflections) pass, writing mesh normal and roughness 1 wherever alpha
(VFXBaseV2 tint, vertex colour, `_MainTex`, near fade) ≥ `_ReflectionPassAlphaCutout`. used by two
materials: Very Large Rift portal `quan_ad_01_pass` (dung02_dg005, twin of VFXBaseV2 `quan_ad_01`)
and `zhuangfangyi_shu_04_03_pass` (indie_dg005). on-screen effect is unchecked against the game.

## refraction

`HGRP/Effect/VFXRefract` runs after transparent effects (`LightMode` `Distortion`), sampling a copy
of the scene drawn so far at
`screenUV + _RefractDir · r · _Intensity · _TintColorAlpha · vertexAlpha` (`r` = `_RefractTex.r`
remapped by `_Bi_Refract`, or normal `xy` under `_RefractIsNormal`).

- **mask & blend**: `_MaskTex` (`_USE_MASK`) scales the offset and supplies blend alpha (R under
  default `_UseMaskTexAsAlpha`), faded by near-camera fade. vertex alpha scales only the offset, not
  blend coverage. blend/depth state comes from `_SrcBlend`, `_DstBlend`, `_ZWrite`, `_ZTest` (most
  use `SrcAlpha OneMinusSrcAlpha`). the pass draws opaque-queue refractors before transparent ones
  from the same copy: opaque `One Zero` materials (e.g. Hub technology-ball panels/logos
  `M_fx_technologyballpanel_862`, map01_lv001 near unity −21, 104, −382 and −52, 105, −367) replace
  the scene outright, discarding alpha. textures scroll (`*UVSpeed`), rotate (`*UVRotate` deg), and
  use UV0 or polar UVs (`_USE_POLARUV` + `*SwitchUV`).
- **`_USE_RBOFFSET` & `_USE_RGBOFFSET`**: chromatic split. takes an extra sample at
  `_RBOffset.xy · 0.01 · _Intensity · vertexAlpha` (× `r` or normal length under
  `_UseMainTexAsMask`), keeping `max(refract · _RBMainColorMask, shifted · _RBOffsetColorMask)` per
  channel. `_USE_RGBOFFSET` (only with `_USE_RBOFFSET`) adds a third sample at `_GOffset` × shift
  using `_RBOffset1ColorMask` and `_RBOffset2ColorMask`. `_RBIntensity` blends toward the split.
  `_USE_SOFTBLEND` fades alpha over `_SoftDistance` m of depth.
  - examples: balloon "connecting" glitch (`distortion01` in `P_interactive_ballonconnecting`,
    `M_fx_robotemoji_821`, magenta vs cyan); Deep Dale Street fog-wall heat haze (`refract` in
    `p_fxmap_map02_lv008_fogwall_01`, vertical red/blue split).
- **`_USE_DISSOLVE`**:
  `d = saturate((_DissolveTex.r − (_DissolveScheduleOffset · 2.02 − 1.01)) · _DissolveEdgeSharp)`
  (UV0, `_DissolveUVSpeed`, `_DissolveUVRotate` deg; custom data `c.z` adds to schedule) scales the
  refraction offset (affecting mask UVs, not chromatic split shift). `_DissolveAffectBlend` blends
  alpha from 1 to `d`.
- **`_USE_BLEND`**: multiplies colour by
  `(1 − _BlendColor.a) + blend.rgb · _BlendColor.rgb · _BlendColor.a` (HDR `_BlendColor` as stored)
  and alpha by `blend.a` (or R under `_UseBlendTexAsAlpha`). UVs scroll, rotate, support polar, and
  take `_BlendTexUseRefract` of the refraction offset.
- **`_USE_SPREAD`**: replaces mask base cover (default 1) with a sweeping band over `_SpreadTex.r`
  (`s`, UV0, `_SpreadUVSpeed.xy`, `_SpreadUVRotate` deg, never polar; `1 − s` under `_SpreadFlip`,
  `R = _SpreadRange`):
  `saturate(1 − |(_SpreadScheduleOffset + c.w) · (1 + 2R) − R − s| / R) · _SpreadAlphaCurve`. no
  shipped variant pairs spread with polar UVs.
  - example: Valley Pass fire column (`PatternSmoke01_ref` in `p_fxmap_smoke_range_f_smoke_02` at
    unity −753, 143, 55, global var 4 = 2; `M_fx_common_smoke_01_02_03_1`) uses both `_USE_BLEND`
    and `_USE_SPREAD`.

### the Very Large Rift's ripples

in Wuling Very Large Rift (dung02_dg005, unity 297, 100, 2), two default-on prefabs
(`p_fxmap_dung02_dg005_boss_semicircle_ripple_01` and `…_ripple_01_ground`, script groups
37000020004 and 37000020005; hidden by a 3 m entrance trigger at unity 23.6, 100, 18.7 and by the
server) emit one growing mesh every 6 s per child:

- `wenli_02`: 142 m VFXDitherAlpha cylinder (dissolve, disturb, polar UVs)
- `line_z`, `wai_noise1`: VFXBaseV2 cylinders
- `niuqu02` (and two 300 m ground cylinders): VFXRefract distortion rings
- `quan_ad_01`, `quan_ad_02`: 0.5 s centre flashes (VFXDitherAlpha disc + `_BlendMode` 2 VFXBaseV2
  multiply quad)

## waterfalls

waterfalls layer river surfaces, one or two `HGRP/Effect/VFXWater` sheets (~1,800 placements on
map02 in `P_fxmap_*waterfall*` prefabs; a few dozen `P_waterfall_map02lv001_*` are ECS entities in
dynamic streaming chunks), [WaterDecal](water.md#waterdecal) foam boxes, particle mist/splashes,
`FogSimple` cards, and optional shimmer planes (`niuqu` VFXRefract + vertex-offset VFXBaseV2
`add2`/`dark`, e.g. `P_fxmap_waterfall_map01lv005_00x`).

`HGRP/Effect/VFXWater` per pixel:

- **colour & opacity**: `_TintColor · _TintColorIntensity` (alpha `· _TintColorAlpha`) × vertex
  colour (unless `_DisableVertColor`) × `_MainTex` × `_MaskTex` (`_USE_MASK`; R as alpha under
  `_UseMainTexAsAlpha` / `_UseMaskTexAsAlpha`). UVs scroll, rotate about 0.5, and take `_ST`.
  `_WaterRandomUV` stretches/offsets main UVs by the fractional sum of object position.
- **distortion & dissolve**: `_USE_DISTURB` shifts main, mask, normal, and dissolve UVs by
  `_…UseDisturb` using `_DisturbTex1.r` (`_Bi_Disturb`, `_DisturbU/VIntensity1`) or normal xy
  (`_DisturbTex1Normal`). `_USE_DISSOLVE` eats alpha below `_DissolveScheduleOffset` with glowing
  edge.
- **flipbook (`_USE_SEQUENCE_FRAME`)**: `_SequenceBaseColorMap` (`_SequenceFrameSize` cols × rows
  from top) plays at `_PlaybackSpeed`/s (per-object offset `_RandomStartByPos`), blending two frames
  warped along `_SequenceMotionVectorMap` by `_MotionVectorDistortionStrength`. adds
  `rgb · _SequenceBaseColorMapTint · a`; opacity becomes
  `saturate(alpha · a · s − _SequenceOpacitySdf) · s` (`s = _SequenceOpacityScale`).
- **fades**: near-camera fade, `_USE_SOFTBLEND`, vertex alpha (`_UseVertexColorAsOpacity`), and
  `|N·V|^_FresnelStrength` (`_UseFresnelAsOpacity`).
- **lighting**: `_UseLighting` fraction is albedo. ambient = irradiance volume at normal
  (`_SequenceNormalMap` or `_NORMAL_MAP`, scaled by `_FrameNormalScale` / `_NormalScale`) +
  subsurface
  `HSV(_SubsurfaceHue, _SubsurfaceSaturation, _SubsurfaceValue · thickness · albedo.r) · _SubsurfaceIndirect`,
  desaturated by `_IndirectSaturation`. sun adds diffuse, GGX (`_Roughness`, F0 `0.08 · _Specular`,
  `· _DirSpecularStrength / opacity` so it survives premultiplication), and subsurface wrap +
  see-through lobes.
- **sun shadow**: sampled 0.5 m along normal from 4-tap sharp cascades, or tent-filtered cached far
  map alone when `_directional_shadow_asm_only > 0` (e.g. Si's Painting `*_asm` ink falls).
- **output**: `_IgnorePostExposure` divides out post exposure (including lit share). `_BlendMode` 1
  adds, as in VFXBaseV2.

## six-way smoke

`HGRP/Effect/VFXSmoke_SixWay` implements Unity six-way smoke lighting on billboard particles (e.g.
Valley's Aberrants black smoke columns `p_fxmap_common_smokeblack_large_01`, `M_fx_damagesmoke_06`,
18–25 m; several materials in dung01_wrdg001). `_PositiveAxesLightmap` stores transmission from `+X`
(right), `+Y` (up), `+Z` (away from camera) and opacity in A; `_NegativeAxesLightmap` stores `−X`,
`−Y`, `−Z`.

with `_USE_SIXWAY_LIGHTMAP`:

- **UVs**: lightmaps share `_LightMapUVSpeed`, rotation `−_LightMapUVRotate` deg about 0.5, and
  `_LightMapControls` scale/offset (own `_ST` unused). mask, blend, dissolve use `_…UVSpeed`,
  `_…UVRotate`, `_ST` (blend applies `_ST` a second time after distortion). default UV0;
  `_MaskUVSet` and `_DissolveUVSet` switch to UV1 (UV2 stream on particles, UV1 on meshes). follows
  [particle custom data](#particle-custom-data).
- **switched UVs**: `_USE_POLARUV` and `_USE_SCREENUV` compile only together. `*SwitchUV`
  (`_LightMap…`, `_Disturb…`, `_Mask…`, `_Blend…`, `_Dissolve…`) selects base UV before scroll: `1`
  screen (`_UsePosYAsScreenV`, `*ScreenDepthUV`), `2` polar about UV0 (or UV1 for mask under
  `_MaskUVSet`), else UV0. `_DissolveUVSet` overrides dissolve's switch. example: Valley Pass fire
  column (`smoke001_150` in `p_fxmap_smoke_range_f_smoke_02`, `M_fx_lv001_207_09`) uses screen UVs
  only on its `_BlendTint` `(1.84, 0.25, 0.12)` blend layer.
- **distortion**: `_USE_DISTURB` and `_USE_DISTURB_TEX2` sum R (`_Bi_Disturb`,
  `_DisturbU/VIntensityN`) or normal (`_DisturbTexNNormal`) and shift lightmap, mask, blend, and
  dissolve UVs by `_…UseDisturb`.
- **colour & opacity**: LDR `_TintColor · _TintColorIntensity`, alpha `· _TintColorAlpha`, × vertex
  colour × `_MaskTex` (`_USE_MASK`, `_UseMaskTexAsAlpha`), + `_USE_BLEND` (`_BlendTint` always ×
  vertex colour), − `_USE_DISSOLVE`, brightened above `_ExpThreshold`. opacity = alpha × soft blend
  × near fade × `_PositiveAxesLightmap.a`.
- **absorption**: colour sets per-channel absorption rather than multiplying directly: lightmap
  value `t` transmits `min(R, saturate(t / R)^k · R)` where `k = 1 − log2(colour) / log2(0.2)` and
  `R = (_AbsorptionRange + 1/π) / (1 − 1/π)`.
- **lighting & output**: main light direction in particle frame weights squared components of
  positive/negative lightmaps, passes through absorption, and takes light colour + per-vertex
  ramp-tinted shadow. irradiance volume takes the sum of all 6 absorbed channels, desaturated by
  `_EnvLightSaturation`. global scene-effect colour grade applies to both. `_USE_FOG` fogs at smoke
  depth. blends `SrcAlpha, OneMinusSrcAlpha`.

## mist

mist banks use `HGRP/FogSimple` cards (hundreds on map02, `SimpleFogCard*`; mostly additive, rest
premultiplied) and `HGRP/Effect/VFXFakeVolumeFog` boxes (dozens, `SimpleFakeVolumeFog*`; all
additive, with depth prepass).

- **cards (`HGRP/FogSimple`)**:
  - alpha starts from `_MainTex.r · mix(1, _NoiseTex.r, _FogNoiseIntensity) · _BaseColor.a`.
  - `_UseWind`: samples `_NoiseTex` at `uv · _WindScale` (`_WindScaleX/Y` under
    `_UseSeparateScale`), scrolling `(−_WindDirX, _WindDirY) · _WindSpeed`/s, remapped by
    `_WindNoiseContrast`, mixed by `_WindNoiseIntensity`, scaling both colour and alpha.
  - `_UseFresnel` (float, not keyword): scales colour and alpha after wind by
    `lerp(1, f^_FresnelContract, _FresnelIntensity)` (`f = 1 − N·V`, or `N·V` with `_FlipFresnel`,
    `N` facing camera). `_NoiseTex` defaults white (e.g. Marker Stone Interiors
    `M_fog_indie_dg007_001`: 50 m additive cards, `_BaseColor` 311, `_BaseAlphaIntensity` 0.02,
    flipped Fresnel 0.28).
  - colour: HDR `_BaseColor` (and `_IndirectColor`, as stored). `_USE_LIGHTING` multiplies
    `_BaseColor` by sun colour and blends toward `_IndirectColor` away from sun by `_LightFactor`
    using the normal map.
  - fades: distance in `_DistanceFadeStart`–`…End`, near camera out
    `_NearCameraFadeDistanceStart`–`…End`, top `saturate(h · _TopFadeContract + _TopFadeOffset)`
    (`h` = world height below card origin / y-axis length, so upside-down cards still fade upward),
    `_USE_SOFTBLEND` (`_SoftDistance`), × `_BaseAlphaIntensity`. `_USE_FOG` fogs by `_FogIntensity`
    and `_FogIntensityFadeOutDistance` (e.g. Sword Vault Dale middle-distance haze).
- **light through openings**: some cards fake daylight shafts. at Suiming's cave exit (near unity
  −145, 149, −188), an upside-down 77 m card (`T_fog_smoothradial_grad_01_M`, `_BaseColor` ≈ (16,
  20, 30)) creates a soft shaft from below and a bright top edge from above.
- **boxes (`HGRP/Effect/VFXFakeVolumeFog`)**:
  - `thickness` = ray segment through unit cube from camera (if inside) to nearer of box far face or
    scene depth (`_FakeVolumeFogDepthTexture`, which includes water surfaces on the deferred path).
  - alpha = `_FogColor.a · _TintColorAlpha · (1 − 2^(−thickness · _FogExponent)) · _FogDensity`,
    faded by `_CubEdgeFade`, height (`_HeightOffset`, `_HeightFalloff`, `_VerticalFalloffMin/Max`),
    `_NearFadeDistance`, `_FogIntensityFadeDistance`, and `_FogDepthStart` / `_FogDepthEnd`. colour
    is `_FogColor`.
- **box noise (`_USE_NOISE3D`)**: 64³ `_NoiseTex3D.a` (`n`, repeat) at world pos (or local with
  `_NoiseTexUseWorldUVW` off) × `_NoiseTexTilling1`, scrolling `_NoiseUVWDir1 · _NoiseUVWSpeed1`/s,
  scales alpha by `saturate(1 − n + i · n)`. `i` interpolates from `_NoiseIntensity` at camera to
  `_NoiseFarIntensity` at `10 · _NoiseFar` m (most map02 boxes use 0 near, ~−0.3 far to break up
  distant banks).

## blending

effects draw after fog and water (so mist covers water). only `_USE_FOG` materials are fogged at
their own depth; others ignore fog (e.g. Origin Lodespring red light stripes
`M_fx_prop_connectline_*`).

transparent pass order (starts from an opaque-scene copy without transparents, used by refracting
glass):

1. full-screen scene colour grade (`_VFXParams1`, driven by `HGVFXManager.m_currentSceneDarkValue`
   and saturation; neutral `(1, 1, 1, 1)` unless `VFXSceneDark` runs)
2. water lighting (one-pass deferred path)
3. scan-line post effect
4. forward decals
5. `VFXDecal` boxes (own list, always beneath other effects)
6. glass and effects in one sorted list
   ([transparent draw order](materials.md#transparent-draw-order)) — queues 2900–3100 (2900–3400
   with low-res transparents off; starts at 2650 with refraction off)
7. world-space UI, rain, and snow

later passes handle distortion, after-distortion, after-DoF, and after-post-processing queues. the
transparent pass binds depth read-only and writes a motion-vector flag where `luma · alpha > 0.05`
for temporal passes. half-size transparent rendering exists only on the one-pass deferred path
(default off, unused on PC quality levels, forced off by scene saturation adjustment).

## one-shot effects

prefabs may carry `PostModelViewStateController` (`stateList`, `animatorNode`). each state's
`effectPlayConfigs` can target an `effectNode` GameObject (`controlActive` toggles it on). an
`EffectSetting` (`effectLogicCfg`) under the node records `isLoop` and `duration` (seconds).

- **bursts**: a node saved inactive whose `EffectSetting`s all have `isLoop = 0` plays only when
  triggered and never rests on (e.g. `int_challenge_start_point_once_postmodel`'s 3 s `OneShot` node
  on `SwitchToRunning`).
- **clip-disabled nodes**: controller states drive an Animator whose clips toggle GameObjects
  ([activity bindings](animation.md#bindings)). a node saved inactive that every clip starts and
  ends off never appears (e.g. `int_challenge_start_point_once_postmodel` holds `dotAdd3stages` and
  blue decal off in all states, unlike repeatable `int_challenge_start_point_postmodel`).

## effect LOD tables

an enabled `EffectSetting` holds a `lodSetting` table of entries (`gameobject`, quality level,
per-band `_distanceLodInfos` with `isActive` and `speedPercent`).

- **saved-off rule**: on first application, the table records each GameObject's saved activity. it
  activates a GameObject only if both its LOD band `isActive` and its saved activity are true;
  otherwise it deactivates it (even if `isActive = 1` in all bands or something else turned it on).
  - example: Very Large Rift `p_fxmap_map02_lv002_qinshihuoyan_middle_01_half` keeps its `dither`
    layer off beside `caihong`, `wenli`, and `trans`.
  - a dynamic-structure prefab whose root is saved off and listed in its own table never shows (in
    map02: `p_fxmap_lv002_fangyuzhenlie_middle_01`, beside drawn `_high_03`, `_middle_02`,
    `_middle_03`).
- **bands**: `distanceLodCfgList` defines bands; each entry toggles its GameObject's whole subtree.
  band selection depends on placement:
  - **camera distance** (scene, factory, battle effect instances): when `isUseDistanceLod` is set,
    picks the last band whose `distance < cameraDist` (else band 0) using 3D distance to the
    setting's GameObject. beyond `cullDis`, band updates stop; with `_isCullDisable`, the setting's
    GameObject disables until back in range. `lodFadeTime` fades transitions.
    - example: collectible marker (`int_collection_common_postmodel`): bands 0, 30, 60 m, culled at
      80 m (0–30 m all; 30–60 m icon + rings; 60–80 m icon only).
  - **LOD proxy** ([dynamic structures](world.md#dynamic-load-grids)): ignores camera distance,
    `isUseDistanceLod`, and `cullDis`. only the root `EffectSetting` is driven: band 0 when near
    grid is loaded, 1 when only far grid is loaded, 2 when neither is loaded (missing bands leave
    the table unchanged).
    - example: indie_ccdg002 green light beam (`p_fxmap_map02_lv002_dragonball_lightbeam_01`,
      `cullDis` 150 m) stays visible 225 m away across the arena's `x < 0` half because its level-2
      near grid (`x` 128–256) unloads while its far grid selects band 1 (`01_ad` on, `01` and
      `wenli` off).

## open

- `_InkWashGlobalParams`: what drives the ink-wash screen effect's global parameters
- [invisible bridges](#invisible-bridges): initial reveal radius before any script sets a fire-seed
  level
- [water blending](#water-blending): `VFXWaterBlendConfig` asset layout and runtime water height
- [soft-body animation](#soft-body-animation): per-draw frame offset (`d`) source
- `VFXDitherAlpha`: `_TaaFrameInfo.z` frame value
- [reflection-only effects](#reflection-only-effects): `VFXReflectionPass` behaviour against an
  in-game shot
- [effect LOD tables](#effect-lod-tables): which `EffectSetting` in a multi-setting prefab an effect
  instance drives, and whether static scenery uses distance-banded effects
