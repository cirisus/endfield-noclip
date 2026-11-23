# materials

the game's HGRP surface shaders: Lit and its optional layers, alpha testing, emission, foliage,
glass, decals, matte paintings, erosion rock, cloth, and vertex animation. see
[assets.md](assets.md#material-and-shader) for serialized material state, [lighting.md](lighting.md)
for lighting, and [effects.md](effects.md) for `HGRP/Effect/*` shaders.

## texture layouts

`HGRP/Lit`, `HGRP/LitTransparent`, `HGRP/LitEffect`, `Hidden/HGRP/LitEffectBlend`, and
`HGRP/Foliage/Trunk` support two texture layouts selected by `_BaseTextureMapCount` (when absent,
`_TWO_BASEMAP` selects 2 and its absence selects 0). `LitEffect` declares a subset of Lit's
properties plus dissolve and disturb; `LitEffectBlend` is `LitEffect` with a depth-soft GBuffer
blend (`_ObjectBlendFactor`, `_ObjectBlendFallOff`, as in [erosion](#erosion)); `Trunk` adds no
properties over Lit.

| `_BaseTextureMapCount` | layout      | normal map                     | metallic / roughness / occlusion                |
| ---------------------- | ----------- | ------------------------------ | ----------------------------------------------- |
| 0                      | MRO         | `RAG` (`x = R · A`, DXT5nm)    | `_MROMap`: R metallic, G roughness, B occlusion |
| 1                      | two-basemap | RG normal, B roughness, A occ. | metallic = base colour alpha                    |
| 2 (most materials)     | two-basemap | RG normal, B roughness, A occ. | metallic = `_Metallic`                          |

- decoded normal `x` and `y` snap to 0 when `|component| < 0.012`.
- foliage normal maps store roughness in B the same way.
- map roughness remaps between `_RoughnessMin` and `_RoughnessMax`. inverted ranges (`min = 1`,
  `max = 0`) mean B stores smoothness.
- roughness and occlusion from the normal map do not depend on mesh tangents (only bump mapping uses
  tangents). for example, Dijiang's hall steel sculpture (`M_prop_map01_zmdlife+1_005_01`) has no
  tangents, metallic in base alpha, and range 1..0, giving satin ~0.7 roughness from B.

## forward Lit

`HGRP/LitForward` renders Lit in a forward pass instead of the GBuffer. in surveyed scenes, only the
golden treasure chest body uses it (`M_anm_com_treasurechest+1_001_02` in
`int_trchest_common_gorgeous_postmodel`).

- **surface inputs**: identical to Lit (texture layouts, base colour, `0.08 · _Specular`
  reflectance, emission mask multiplied by `_EnableEmissiveMap`).
- **`_CUSTOM_IBL`**: replaces scene reflections with `_CustomIBL` (128² BC6H cubemap on the chest) ×
  `_CustomIBLIntensity`, sampled at a roughness-derived mip.
- **undecoded variants**: `_THIN_FILM`, `_PLANAR_REFLECTION`, `_LAYERBLEND_MASK`.

## base colour

Lit, LitTransparent, and foliage shaders compute albedo as:

```
mix(saturate(baseMap · linear(_BaseColor) · _BaseColorBrighterScale), linear(_BaseColor), _BaseColorTintCover)
```

- `_BaseColorTintCover` is significant: Dijiang's black floors and walls use a light grey map tinted
  by ~0.3.
- `HGRP/LitHLOD` ignores `_BaseColorTintCover`.

## alpha testing

with `_ALPHATEST_ON`, HGRP Lit tests alpha against `_AlphaClipThreshold`. `_AlphaMaskChannel` picks
the source:

- `0`: base colour alpha
- `1`: normal map alpha (~24 map01 materials, all two-basemap where base alpha is metallic, e.g. the
  Hub's white container walls)

## emission

HGRP Lit emits through `_EMISSIVE_*` keywords. `_EmissiveColor` is an HDR colour authored in linear
space (`base × 2^intensity`) and used as stored. emission adds to lit colour without pre-exposure
(the Hub's white ceiling panels store ~24). in Unity's `SerializedProperties::MakePropertySheet`,
any property flagged `[Gamma]` (`ShaderPropertyFlags` bit 5, `0x20`) is still converted through
`GammaToLinearSpace` (sRGB below 1, `c^2.2` past 1, alpha unchanged) even when also flagged `[HDR]`
(bit 4, `0x10`): `HGRP/LitEffect` flags `_EmissiveColor{,G,B,A}` as `0x30` (`[HDR][Gamma]`), whereas
`HGRP/Lit` flags them `0x10` (`[HDR]` only).

| keyword           | emission                                                         |
| ----------------- | ---------------------------------------------------------------- |
| `_EMISSIVE_MAP`   | `_EmissiveColor` × `_EmissiveMap.r`, plus G, B, A channels below |
| `_EMISSIVE_MASK`  | `_EmissiveColor` × channel selected by `_EmissiveMaskChannel`    |
| `_EMISSIVE_NOMAP` | ships only with `_EMISSIVE_ANIM_SWEEP`                           |

- **multi-channel `_EMISSIVE_MAP`**: Lit and LitEffect add `_EmissiveMap` G, B, A × HDR
  `_EmissiveColorG`, `_EmissiveColorB`, `_EmissiveColorA` (linearized on LitEffect via `[Gamma]`),
  scaled by `_EmissiveType` (0 = R only). Dijiang's cargo shaft stripe rings
  (`M_fx_base01_lv001_ship_line_1123`, `_1125`, `HGRP/LitEffect`) set `_EmissiveType` 1 with R, G, B
  colours.
- **UV scroll**: `_EmissiveSpeed` scrolls emissive UVs (`xy` per tick of an untraced shader clock;
  stripe rings use `(0, 0.1)`).
- **`_EMISSIVE_ANIM`**: pulses smoothly from `_EmissiveMinBrightness` to 1 and back over
  `_EmissiveAnimInterval` of each cycle. controlled by `_EmissiveAnimSpeed`, per-object phase
  `_EmissiveAnimRandom`, and pulse depth `_EmissiveColor.a`, driven by [the clock](#clock) (e.g.
  Wuling and Marker Stone tower lamp cubes `M_module_tylight+1_001_03` at speed 40 pulse every ~3
  s). `_EnableEmissiveAnimFlicker` replaces the pulse with value-noise on/off flicker hashed per
  object position (unused in map02).
- **`_EMISSIVE_ANIM_SWEEP`** (~90 map02 materials, e.g. clearable rocks, drone targets): sweeps a
  band up object-space y. each emission colour (main, G, B, A) multiplies by `mix(1, band, alpha)`
  (`alpha = 1` glows only in band; `alpha = 0` glows steadily). parameters: width
  `_EmissiveSweepWidth`, edge `_EmissiveSweepFalloff`, speed `_EmissiveSweepSpeed`, start offset
  `_EmissiveSweepHeightOffset`, repeat `_EmissiveSweepInterval`, per-object phase
  `_EmissiveSweepRandom`. inside the band, strength scales with albedo brightness via
  `_EmissiveSweepAlbedoScale` and a per-draw runtime factor; outside, it is 0. Jingyu's clearable
  rock (`M_interactive_hongshan_obstaclerock+1_001_01`) keeps red cracks lit (`alpha = 0`) and
  sweeps a 2.1 grey glow from G (`alpha = 1`).
- **per-draw emission**: each draw carries a runtime emission colour that replaces `_EmissiveColor`
  by its alpha. static scenery stores 0; GameObject renderers set it from interactive configs or
  VFX.
- **`AnimationProperties_Emissive`**: a VFX playable that starts on enable and writes
  `emissiveColor` to every renderer in `affectRenderers` (`_EmissiveColor.a` still sets pulse/sweep
  depth). water drone targets (`int_waterdrone_floating_target_postmodel`,
  `M_anm_map02_machine+1_003_02`) leave material `_EmissiveColor` black and emit green
  `(0, 1, 0.17, 1)` on R through this component (G lights only in the sweep). it also writes:
  - `emissiveAlbedoColor`: where emission strength (remapped mask or `_EmissiveMap.r`) ≥ 0.1,
    multiplies albedo by `mix(1, rgb, alpha)` (× `_EnableEmissiveAlbedo` in map variants; 0 on
    targets). albedo-following emission (`_AlbedoAffectEmissive` 0) uses the tinted albedo.
  - `breathFrequency` and `breathIntensity` (0 on targets).
  - interactive view states can replace these via an emissive config
    ([emission view states set](interactives.md#emission-view-states-set)).
- **tower lamps**: `M_module_tylight+1_001_03` cubes emit white; their coloured glow comes from one
  effect prefab per tower ([pull towards the camera](effects.md#vertex-offset-and-brightening)).
  Wuling (`P_fxmap_map02_lv002_citywall_lighting_02`) draws an additive teal (`_TintColor` 0.45,
  0.84, 0.75) round glow and 40 × 5 m horizontal streak at each lamp; Marker Stone
  (`P_fxmap_map_lv004_lamp_light_01`) draws red.
- **mask channels (`_EmissiveMaskChannel`)**:
  - `0`: none
  - `1`: base colour alpha
  - `2`: normal B (two-basemap) or base alpha (MRO)
  - `≥ 3`: normal alpha (two-basemap) or MRO alpha (Hub ceiling panels use 3)
  - remapped by `saturate((m − 0.05) / 0.9)`.
- **albedo & exposure**: emission multiplies by albedo unless `_AlbedoAffectEmissive` is 1.
  `_IgnorePostExposure` (nearly all emitters) divides out post exposure
  ([auto exposure](post-processing.md#auto-exposure)).

## lit layers

each Lit map selects UV set 0 or 1 via a dedicated float: `_BaseUVSet`, `_BasePbrMapUVSet` (normal
and MRO), `_DetailUVSet`, `_MaskUVSet`, and `_EmissiveUVSet`. the texture slot's `m_UVSetIndex`
stays 0 even when materials sample UV1 (e.g. Power Plateau concrete walls' weathering streaks on
UV1; originium crystals' base and detail maps tiled ×5 on UV1).

- **`_TRI_CHANNEL_MASK`** (~450 map01 materials, mostly rock): each `_MaskMap` channel produces
  weight `saturate(s/2 + mix(−s, 1, m + offset)) · _MaskAlbedo*.a` (`s = _Mask*Scale`,
  `offset = _Mask*Offset`). blends albedo toward linear `_MaskAlbedo*`, roughness toward
  `_MaskRoghness*`, and metallic toward `_MaskMetallic*`, in order B → G → R (originium crystals
  tint grey rock brown at 0.5 on R).
  - `_TRI_CHANNEL_MASK_SWITCH_TEXTURE*`: sources G and B colours from `_MaskAlbedoGTex` / `…BTex`
    (tiled by `_MaskAlbedoGUVTilling` / `…B…`) × `_MaskAlbedoTintG` / `…B` (alpha = strength).
  - `_UseMaskRUVSetAndTilingScale`: reads R from `_MaskRUVSet` tiled by `_MaskRTilingScale` (unused
    in map01).
- **`_DETAIL_MAP`**: weight selected by `_DetailMaskMode` (1, detail alpha, base alpha, normal B, or
  normal A) fades over view depth `_DetailFalloffStart`–`…End`. detail normal ×
  `_DetailNormalIntensity` reorients onto the base normal.
  - `_DetailMode` 1: blends roughness toward detail B; multiplies occlusion by detail A.
  - `_DetailMode` 0: overlays `_DetailOverlayColor` where detail B is dark; blends roughness toward
    detail A.
  - both modes scale blends by `_DetailPBRIntensity`.
- **`_PARALLAX_MAP`** (originium crystal glow):
  - view ray in geometric tangent frame steps `trunc(_ParallaxMarchNum)` times (max 20) through
    `_ParallaxNoiseMap` (tiled by `_ParallaxNoiseMapTilling`) at depth `_ParallaxStrength`, refining
    between the last two steps.
  - at hit, `_ParallaxMap.g` (tiled by `_ParallaxTilling`; both maps ignore `_ST`) blends
    `_ParallaxColorDark` and HDR `_ParallaxColor`, × `_ParallaxIntensity`.
  - emitted as `colour · mask² · (N·V)^floor(_ParallaxFresnelStrength) · pulse`:
    - `mask` = channel from `_ParallaxMaskChannel` (emission mask numbering − 1).
    - `pulse` = `cos(_ParallaxAnimSpeed · T + _ParallaxAnimRandom · (x + y + z))` remapped to
      `[_ParallaxMinBrightness, 1]`, with `T` from [the clock](#clock) and `x + y + z` the object's
      world position.
    - with `_ParallaxCharPos`, adds
      `_ParallaxBrightStrength · smoothstep(_ParallaxBrightOuterRadius, _ParallaxBrightInnerRadius, distToPlayer)`
      to the pulse (map01 crystals mostly use strength 20 over 3–25 m; one stores glow 0.75 so it
      glows mainly near the player).
    - `_ParallaxIgnorePostExposure` divides out post exposure.
  - both maps default to black. crystals without a noise map (campfire
    `M_interactive_campfire+1_003_02`, display `M_iprop_map01_zmdmachine+1_009_02`, Dijiang far
    `M_building_dijianghao+1_001_11`) see height 0 everywhere and read the pattern at full depth.
  - **`_PARALLAX_MAP_WORLDSPACE`** (Hongshan great tree `M_tree_hsbigtree+1_004_02`, `_002_02` and
    surrounding plinths `M_imod_map02_tianshitan+1_001_01a`/`_01b`; no-op without `_PARALLAX_MAP`):
    projects `_ParallaxMaskMap` over world XZ around `_MaskWorldPosParams.xz` (rotated by `.y`
    degrees, divided by `max(.w, 0.1)`, shifted by `0.5 + pattern.xy · _ParallaxMinBrightness`, mip
    `mix(3, 0, |geomN.y|)`). multiplies the exposed parallax radiance by the pattern colour blend
    again and `mask.rgb · _ParallaxMaskMapColorStrength`, then blends between HDR
    `_ParallaxPatternColor` and `_ParallaxPatternColorDark` by
    `saturate(length(deltaXZ) + pattern.r · 20 − _ParallaxLerpSchedule)` (plus optional
    `_ParallaxSignControl` alpha bands × vertex red). emits that times
    `mix(base.a, saturate(_ParallaxSignLerpFactor1.w − world.y), saturate(_ParallaxSignLerpFactor1.w)) · _ParallaxIntensity`,
    plus
    `(0.3 + glow) · _WorldParallaxAdditionalColor · saturate(objectY − _ParallaxSignLerpFactor1.y)`
    masked by `_WorldParallaxAdditionalLightMaskChannel` (0 base A, 1 normal B, 2 normal A).
- **`_MATCAP`** (campfire crystal, a few Dijiang props): adds `_MatcapMap` sampled at
  `viewNormal.xy · 0.5 + 0.5`, × `_MatcapMapStrength`, to emission (not albedo-tinted).
  `_MatCapIgnorePostExposure` divides out post exposure.
- **`_LAYERBLEND_TOP`** (moss/sand on rock tops; ~220 map02, a few dozen map01):
  - coverage `saturate((up − _TopBlendThreshold) / _TopBlendSmoothness)`, where `up` is world Y of
    the vertex normal blended toward the normal-mapped normal by `_TopBlendWithBumpMap`.
  - with `_LayerBlendHeight`, base height and `_Layer1BaseMap.a` (weighted by coverage) compete
    within `_LayerBlendHeightTransition`.
  - layer colour: desaturate by `_Layer1Saturation`, tint by `_Layer1TintColor`, brighten by
    `_Layer1ColorBrighterScale`. replaces albedo (`_Layer1BaseColorBlendMode` 0) or adds to it (mode
    1, × `_Layer1BaseColorAdditiveIntensity`).
  - PBR: roughness → `_Layer1BumpMap.b`; occlusion → `_Layer1BumpMap.a` (by `_Layer1AOStrength`, or
    1 with `_LayerAOType`); metallic → `_Layer1Metallic` or layer alpha (`_LayerMetallicType`);
    layer normal (× `_Layer1BumpScale`) reoriented onto base normal by `_Layer1BaseNormalIntensity`.
  - applies after detail map and tri-channel mask. both maps sample `_LayerBlendUVType` (UV0, world
    XZ, or UV2) × `_Layer1Tilling + _Layer1Offset`, ignoring `_ST`. no map02 mesh using UV2 actually
    has UV2; the game reads a missing UV2 as UV0 (seen on Jingyu moss rocks; see [open](#open)).
    all-moss rocks without a base map have a white base.
- **`_LAYERBLEND_MASK`** (~200 map02 materials): same layer, driven by a mask instead of `up`:
  `_LayerBlendMaskMap.r` untiled from UV0 (or UV1 when `_LayerBlendMaskUVType` is 0, ignoring the
  slot's UV set), or `_LayerBlendMaskType` 1–4 = layer bump alpha, base alpha, normal alpha, or 1.
- **`_LAYERBLEND_MOSS`** (with either layer; rabbit-hole resource mounds): shades the layer as moss.
  with `f = 1 − N·V` (blended normal) and raw coverage `c` (before height blend):
  - edge `e = saturate(1 − (c − _Layer1FuzzyEdgeShadowOffset)² / _Layer1FuzzyEdgeShadowRange)`
    darkens layer colour by `_Layer1FuzzyEdgeShadowIntensity`.
  - colour scales by `mix(1 − _Layer1FuzzyCoreDarkness, 1, f^_Layer1FuzzyDarkPower)` and brightens
    toward silhouettes by `_Layer1FuzzyEdgeBrightness · 2 · luma · f^_Layer1FuzzyBrightPower` (both
    powers ≥ 0.1).
  - world normal tips down by `e · _Layer1FuzzyNormalStrength`.

## foliage

foliage uses a dedicated deferred lighting model fed by four GBuffer terms: sun shadow, diffuse
`N·L`, transmission, and subsurface. per unit of sun illuminance (before shadow map and cloud
shadow), all four terms multiply by the sun shadow term:

- **diffuse**: `albedo · storedNL / π` (no `1 − F`)
- **specular**: GGX × `mix(sat(n·v + 0.2) · sat(sat(v·l) + 0.5), 1, sat(v·l + 1))` (dims only from
  behind the leaf)
- **transmission**:
  `(albedo / max(albedo.r, albedo.g, albedo.b)) · transmission · sat(0.5 − n·l) · GGX(α² = 0.36, toward sun) / π`
- **wrap**: `albedo · (sat(n·l + subsurface) − sat(n·l)) / π`

[local lights](lighting.md#local-lights) evaluate the same four terms using the shading normal's
`N·L` and omitting `1/π`.

`HGRP/Foliage/Leaf` fills inputs from material properties and vertex colours (R = AO, A = canopy
height):

| input                                                        | effect                                                                                                                                                                                             |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `_OcclusionShadow`                                           | sun shadow × `mix(1, R, _OcclusionShadow)`                                                                                                                                                         |
| `_FakeDirectionalShadowStrength`, `…Pow`                     | sun shadow × `sat(1 − pow(n·d · 0.5 + 0.5, pow) · strength)` (`d` = sun travel direction; darkens leaves facing away)                                                                              |
| `_DiffuseUseVertexNormal`                                    | diffuse `N·L` uses stored vertex normal (not flipped toward viewer) instead of normal-mapped normal                                                                                                |
| `_OcclusionStrength`                                         | material occlusion `mix(1, R, strength)` (ambient only)                                                                                                                                            |
| `_Transmission`, `_TransmissionDistanceFade`                 | transmission × `(1 − normal.a)`, faded out over 50–60 m when fade is on                                                                                                                            |
| `_SubsurfaceIntensity`                                       | wrap amount                                                                                                                                                                                        |
| `_AoAffect{Transmission,Subsurface}{Start,Range}`            | scales transmission / subsurface by smoothstep of material occlusion over range                                                                                                                    |
| `_CANOPY_COLOR_RAMP`: `_CanopyRamp{Color,Intensity,Range,…}` | blends albedo toward colour (multiplied, brightened, or covering) by `smoothstep(range + transition, range, A) · (1 − normal.a) · intensity`; `…StartAtTop` uses `1 − A`                           |
| `_BLEND_COLOR`: `_BlendColor`, `_BlendNormal{Add,Power}`     | `albedo · mix(_BlendColor, _BaseColor, k)`, `k = sat(pow(sat(n.y + 0.5 + add), power) + 1 − sat((1 − normal.a) · _BlendColor.a · 10))`; `_BlendWithVertexNormal` blends `n.y` toward vertex normal |
| `_Reflectance`                                               | F0 = `0.08 · (0.5 + 0.75 · r)`, `r` quantized to 3 bits                                                                                                                                            |

- back faces keep the front shading normal unless `_TwoSidedNormal` is set. canopy leaf cards carry
  canopy-shaped normals, so without `_TwoSidedNormal` (e.g. Jingyu cherry trees) the canopy shades
  as one volume; fake directional shadow and `N·L` use that unturned normal.
- `_BLEND_COLOR` tints blossoms (Marker Stone pear trees: near-white `_BaseColor`, pink
  `_BlendColor`; thin low-normal-alpha petal areas turn pink unless facing up, thick parts take
  `_BaseColor` twice). every shipped `_BLEND_COLOR` variant also sets `_NORMAL_MAP` and
  `_ALPHATEST_ON`, never `_CANOPY_COLOR_RAMP`. this keeps Marker Stone pit cherry blossoms from
  blowing out under 80–100 klx sun phases.

`HGRP/Foliage/Grass` and `HGRP/Foliage/Grass Cardmesh Lod` fill the same GBuffer inputs. `h` is
vertex height measured from a point tens of metres below the root (effectively object-space height
across a blade):

| input                                                       | effect                                                                                                            |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `_BendNormalUpward` (grass only)                            | blends normal map XY toward tangent `+Y` before `_NormalScale`; shading normal and `N·L` both use the bent normal |
| `_TwoSidedNormal` (grass only)                              | back faces flip only the surface normal, keeping the bent normal pointing up                                      |
| `_AoParams` (x, y, z)                                       | material occlusion `mix(z, 1, sat((h − x) · y))` (darker at root)                                                 |
| `_DirParams` (x, y, z)                                      | sun mask `d = mix(z, 1, sat((h − x) · y))`                                                                        |
| `_MaskOnDiffuse`, `_MaskOnTransmission` (grass only)        | diffuse/transmission masks = `d · mix(1, normal.a, …)`; sun shadow = `max(diff, trans)`; transmission × `1 −      | diff − trans | `   |
| `_Transmission`                                             | transmission × 0.5                                                                                                |
| `_SubsurfaceIntensity`                                      | wrap amount                                                                                                       |
| `_USE_CAMERA_BASED_TILLING`: `_CameraBasedTillingIntensity` | shifts vertex by `h · intensity` m along camera up flattened onto ground (blades lean away from camera)           |

- both write reflectance `4/7`. the card LOD decodes its normal map differently and masks by B.
- grass grids supply a per-instance colour ([world](world.md#foliage-grids)): the second parameter
  vector's RGB covering albedo by its A.

`HGRP/Foliage/Trunk` uses Lit's lighting and texture layout. with `_FOLIAGE_TRUNK`, vertex colours
add:

- material occlusion × `mix(1, R, _TrunkVertexAoStrength)` (only occlusion when `_OcclusionStrength`
  is 0)
- `_EnableTrunkRamp`: blends albedo toward `_TrunkRampColor` by
  `_TrunkRampIntensity · baseMap.a · smoothstep(range + transition, range, A)` (`_TrunkRampRange`,
  `_TrunkRampTransitionRange`)
- wind sway

### glowing foliage

`HGRP/Foliage/Glow` is a static, opaque shader for glowing growths (e.g. Deep Dale Street mushroom
stalks `M_bush_map02_glow+1_001_01`, near unity −43, 63, 89).

- **GBuffer**: standard Lit GBuffer from two-basemap layout without remaps: roughness = normal B,
  occlusion = normal A, metallic = 0 (`_Metallic` ignored), albedo =
  `mix(saturate(base · _BaseColor), _BaseColor, _BaseColorTintCover)` (no brightening). textures
  ignore `_ST`. writes `_StencilRef`.
- **base emission**: always emits `_EmissiveColor` × base alpha (as `_EMISSIVE_MASK`), weighted
  toward albedo by `_EmissiveIgnoreAlbedo` and exposure by `_IgnorePostExposure`.
- **`_DISTORTION_FLOW`**: adds an exposure-independent flowing glow on `_DistortionUVSet` (blending
  UV0 and UV1) with clock `t = _VFXParams0.w`:
  - `n1 = _FoliageGlowNoise.r((uv · _DistortionFlowScale1 + (0, t · _DistortionFlowSpeed1)) / 4)`
  - `n2 = _FoliageGlowNoise.r(((2·n1 − 1) · _DistortionFlowWarp + uv · _DistortionFlowScale2 + (t, t) · _DistortionFlowSpeed2) / 4)`
  - `glow = _DistortionColor · albedo · max(1 + 10 · (luma(albedo) − _DistortionLuminanceBase), 0) · saturate((2·n2 − 1) · _DistortionFlowMultiplier + _DistortionFlowBias) · mix(1, vertexR, _VertexColorRControlDistortion)`
    (Rec. 709 luma).
- **`_TERRAIN_BLEND`**: blends into terrain beneath as in Lit.

## subsurface

deferred lighting has a third model alongside default and foliage for subsurface scattering. a
material with `_EnableSubsurface` registers `_SubsurfaceColor` (as stored) and `_SubsurfaceIndirect`
in a 63-entry table and writes its index to the GBuffer (unregistered materials read 0).

per pixel, `c = mix(1, hue, saturation) · v`, where `v = value · gbufferMetallic` and
`k = saturate(1 − v)`. the surface is non-metallic (all diffuse, F0 = 0.04):

- **sun**: adds `c · mix(t · mix(1, w^1.5 · 5/3, k) / 2π, 1, saturate(−V·L)^12 · mix(3, 0.1, k))`
  beside default diffuse and specular, where `w = saturate(N·L · 2/3 + 1/3)` wraps past the
  terminator and `t` is the GBuffer occlusion channel.
- **ambient**: uses `albedo + c · _SubsurfaceIndirect` as diffuse colour.

[VFXWaterDitherAlpha](effects.md#solid-effects) writes this model under `_SUBSURFACE` (`_Metallic`
in metallic, `t = 1`). [VFXWater](effects.md#waterfalls)'s forward pass evaluates the same two
terms. the second branch (up to 15 `HGSubsurfaceProfile`s with scatter/indirect lookup textures),
the local-light pass, and other writers (`HGRP/Lit` has `_SUBSURFACE*` keywords) are not read.

## glass

`HGRP/LitTransparent` draws windows and glass walls (~12 map01 materials, e.g. Originium Science
Park offices).

- **state & layout**: alpha-blended (`_EnableAlphaBlend`, `SrcAlpha OneMinusSrcAlpha`, queue 3000,
  no depth write), Lit texture layouts. some materials set `SrcBlend = One` (suggests premultiplied
  colour; unchecked). Fresnel opacity (`_UseFresnel`, `_FresnelAffectOpacity`) is off on all map01
  materials. screen refraction (`_IoR`, `_RefractionIntensity`, `_RefractThickness`, `_RefractTint`,
  `_RefractTex`, `_UseProbeRefraction`) and planar reflection (`_EnabledPlanarReflection`) are not
  decompiled.
- **base variant (no keywords)**: Lit shading + fog at glass depth (height, atmosphere, volumetric)
  - scene-effect grade (`_VFXParams1`). opacity = `_BaseColorMap.a · _BaseColor.a` (× vertex R with
    `_Use_VerexTexColorAsOpacity`). alpha channel blends `One, OneMinusSrcAlpha`. Dijiang deck glass
    (`M_common_glass+1_001_03b`) is 180/255 opaque (29% see-through).

### transparent draw order

glass and effects share one sorted draw list (full pass order in [blending](effects.md#blending)):

1. copies opaque scene into its own target, then draws decals.
2. draws queue 2900–3400 renderers on PC (2900–3100 if low-resolution transparents are enabled),
   combining static ECS scenery and GameObject renderers (all `LightMode` `ForwardOnly`).
3. each side sorts back-to-front with `sortingCriteria = 0x57`
   (`CommonTransparent | RendererPriority`): sorting layer (`m_SortingLayer`, then `m_SortingOrder`,
   lower first) → render queue → distance → renderer priority. the two sorted lists merge
   farther-first.

consequences:

- a lower render queue always draws first regardless of distance (Qingbo Stockade falls draw
  `VFXWater` at 3001 over `VFXBaseV2` at 3000).
- prefabs stack co-located parts with `m_SortingOrder`: blue talosite sets `glow01_andi` −4, light
  column and ground glow −2, upper glow line −1, shards and star icon 0.
- `_TransparentSortPriority` (±50) acts only through the material's render queue.
- PC settings never enable half-size transparents. the exact distance key (likely bounds centre) is
  untraced.

## decals

`HGRP/DecalLit` projects moss, sand, stains, cracks, and tyre tracks onto floors and rocks (e.g.
Power Plateau grass cave, map01_lv007 near unity −102, 147, 524).

- **world entities**: rect decal entities ([world](world.md#initchunkdata-layout)) store a unit-cube
  matrix, material, UV scale/offset, RGBA8 colour, and intensity. drawn into the GBuffer after
  opaque scenery in `_DrawOrder`, projecting down box y onto depth-reconstructed points inside the
  box.
- **stencil mask**: the decal pass tests stencil `Equal` against ref 0 with read mask 32 (from the
  pass's shared stencil state; per-face states say always). GBuffer passes write `_StencilRef`
  (`HGRP/Lit`, foliage, card LODs; `HGRP/LitHLOD` always writes 0). surfaces with bit 32 set (map02
  grass/leaves 33, trunks 32) reject decals (e.g. Sword Vault Dale blight erosion decals
  `M_rdecal_com_effect_erosion…` skip grass and trees).
- **prefab decals**: `HGDecalProjector` (1,213 in install: cutscenes, dialogue, interactives, Qingbo
  waterwheels) uses the GameObject transform as the box and `m_UvTilling`, `m_UvOffset`,
  `m_BaseColor`, `m_BaseColorIntensity`, `m_SectorAngle` as placement fields (matching world carving
  decals such as Si's Painting puzzle grid `P_rdecal_com_marking_carving+1_003_01`, offset
  `(1, 1)`). 1,196 have `m_ShapeType` 0, the rest 1–3, none has `m_CustomMesh`. other shapes,
  `m_LODScreenSizeMin` (0.02 on the puzzle grid), and `m_SortOrderOffset` (0–3) are unread.

standard `HGRP/DecalLit` channels:

- **UV**: `(local.xz + 0.5) · scale + offset` for `_BaseColorMap` and `_SampleTex1` (PBR map: normal
  RG, roughness B; with `_SampleTex1UVSet`, uses its own `_ST` on box UVs).
- **albedo**: placement colour (as stored, not gamma-decoded) × intensity × base map RGB. with
  `_BaseTexChannel`, the base map is the PBR map and the placement colour stands alone.
- **alpha**: `base.a · colour.a · _DecalOpacity`. with `_NORMAL_ANGLE_BLEND`, ×
  `sat(boxY · N)^_AngleBlendFallOff` so vertical walls stay clean.
- **roughness**: `mix(_RoughnessMin, _RoughnessMax, B)`.
- **normal**: PBR RG × `_NormalScale` in box frame (`x` tangent, `y` normal), blended toward surface
  normal by `_BlendSceneNormal`, then blended onto surface normal by `_AffectNormal`.
- **metallic & occlusion**: `_Metallic` or `_SampleTex1` channel (`_MetallicChannel` 2–5 = R–A);
  occlusion from `_SampleTex1` channel (`_OcclusionChannel` 1–4) × `_OcclusionStrength`.
- **write masks**: each GBuffer target blends by alpha, gated by `_ColorMask3` (albedo),
  `_ColorMask2` (normal RG, roughness B), and `_ColorMask1` (metallic R, occlusion G), derived by
  the editor from `_AffectNormal`, `_AffectRoughness`, etc. some decals write no albedo (e.g. Wuling
  City terraces bump/roughen only).

special `HGRP/DecalLit` variants:

- **`_BLEND_EMISSIVE`** (Deep Dale Street purple patches, dung02_rdg008 near unity 13, 92, −21):
  always writes the GBuffer emission target (ignoring colour masks), blended by alpha:
  `_EmissiveColor` × `_EmissiveChannel` (0–3 `_SampleTex1` R–A, 4 base alpha) × albedo (or 1 with
  `_AlbedoAffectEmissive`). `_IgnorePostExposure` divides out post exposure.
- **`_BLEND_WATER_FLOW`** (wet rock beside waterfalls, e.g. Jingyu Valley near unity −1075, 207,
  −1414): writes normal and roughness only, sampling `_WaterNormalTex` in world space:
  - projects along X (world `zy`) and Z (world `xy`), × `_ST` scale, blended by normalized `N.x²`
    and `N.z²`.
  - two layers scroll down world y: scale `_UVMovement.z` at speed `.x`, and `.w` at `.y` (UVs/s),
    pushed further by `steep · _NormalFactor` (`steep = (1 − |N.y|)^_AngleBlendFallOff2`).
  - four decoded normals sum, `xy × _WaterNormalScale`, into box or surface frame.
  - roughness = `_WaterRoughness` × mean of layer 1's two B samples
    (`M_rdecal_common_water_flow+1_001_*` ≈ 0.01 → near-mirror for SSR).
  - alpha = `base.a · colour.a · _DecalOpacity · steep` (level ground stays dry).
- **`_BLEND_SLUDGE_EROSION`** (blight erosion on built ground, e.g. Hub deck map02_lv002 near unity
  −784, 256, 13; compiles alone or with `_COMPLETE_PBR` and `_NORMAL_ANGLE_BLEND`): alters albedo
  and alpha only.
  - albedo weights three projections by squared world normal: `N.y²` uses standard albedo; `N.x²`
    and `N.z²` sample `_SludgeDecalTex` at local `zy` and `xy` × `_ST` (untinted). world weights
    with local coordinates align only on unrotated boxes.
  - alpha =
    `base.a · _SludgeDecalAlphaScale · sat(1 − local.y · _SludgeDecalHeightFalloff) · colour.a · _DecalOpacity`
    (× angle fade), `local.y ∈ [−0.5, 0.5]`. sludge alpha is unused; it reads via an untraced
    pipeline sampler.
- **`_BLEND_WETNESS`** (puddles, e.g. Yinglung Pass gate floor map02_lv007 near unity −841, 261,
  258; `M_rdecal_com_ground_puddle+1_002_03`, `_04`; requires `_COMPLETE_PBR`): splits alpha into
  `a = base.a · colour.a` and `o = a · _DecalOpacity`.
  - normal and roughness blend by `a`; metallic and occlusion by `o`.
  - albedo = `surface · (1 − _Wetness · a) · (1 − o) + decal · o`.
  - puddles set `_DecalOpacity = 0` and `_Wetness = 0.3`: darken up to 30% and replace
    normal/roughness without tinting.

### wetness decals

`HGRP/WetnessDecal` wets surfaces inside a rect decal box without colouring them (e.g. Qingbo's
waterwheel, map02_lv003 near unity −278, 293, −1404; `M_fxmap_common_wateringtruck_wetnessdecal_01`,
the only such material on map02). it writes no GBuffer target; drawn after decals into the water
wetness mask ([WaterProxy](water.md#waterproxy-and-waterdecal)), storing `1 − wetness` with min
blending.

- **wetness**: `placement.a · _OverallOpacity` × linear fade out to `_DistanceFade` m (300 on the
  waterwheel). placement colour is ignored.
- **`_USE_MASK`**: multiplies by base map R and face fade
  `saturate(1 − 2·|d| + _SoftBias · _UseSoftBlend)`, where `d` is the local coordinate along the
  dominant box axis (geometric normal from depth screen gradients in box frame, scaled by box size).
  the other two coords `+ 0.5` pass through placement UV then `_ST`.
- **sector bend**: when placement `_m6 & 255 == 2`, the box bends into a sector by `_m5 / 12`
  degrees.
- **deferred lighting**: reads the mask (separate from [rain wetness](environment.md#wetness);
  active when `_WaterWetnessMaskParam0.x > 1/2048`, setter untraced) using Lit GBuffer porosity
  `saturate(_PorosityFactorX · roughness + _PorosityFactorZ · metallic + _PorosityFactorY)` (0 with
  `_DisableVerticalFlow`). for wetness `w`:
  - `albedo *= 1 − porosity · w²`
  - `roughness = mix(roughness, min(1 − porosity · w, roughness), w²)`
  - normal is unchanged. Lit defaults (0.2, 0.4, 0) darken roughness 0.7 to ~46% and smooth it to
    0.46 at full wetness.

## matte paintings

`HGRP/MattePainting` draws unlit horizon mountain rings (600–1000 m radius, 1000 m tall, single wide
texture such as map01's 4096×512).

- **colour**: `_MainTex · _TintColor · _TintColorIntensity`, plus `_ExpIntensity` × amount above
  `_ExpThreshold` (pre-exposed unless `_IgnorePostExposure` is set).
- **alpha**: `saturate(tex.a · _TintColor.a · _TintColorAlpha)`, alpha-tested against
  `_AlphaClipThreshold`.
- **shadows**: none (no shadow pass).

## erosion

`HGRP/Erosion` draws dark blight rock (Originium Science Park and map01). it has no base colour map;
all maps sample UV0 and tile by `*Tilling` (ignoring `_ST`). metal, noise, and flow colours are HDR
and used as stored.

- **`_MetalMixMap`**:
  - R = 0 (metal): colour `_MetallicColor`, roughness 0.01, metallic
    `_Metallic · (metal − _MetallicOffset)`.
  - elsewhere: colour `_BaseColor`, roughness `_Roughness · map.a` blended toward detail alpha by
    `_DetailRoughnessCover`.
  - G = occlusion (scaled by `_OcclusionStrength`); B = flow band mask.
- **noise layer**: `_NoisePatternMap` shifted by one parallax step (`_NoiseStrength`), tinted by
  `_NoisePatternTintColor` and base normal alpha, scaled by `max(N·V, _NoiseMin)` and faded over
  `_DistanceBlend` m. adds to colour and (× `_NoiseEmissiveStrength`) emission.
- **flow band**: `_FlowRampMap` sampled along object-space height
  (`× _FlowNormalTilling + metalMap.g · _FlowNoiseStrength + _FlowSpeedOffset`, scrolling by
  `_FlowNormalSpeed` on [the clock](#clock)). coloured `_FlowBottomColor` below `_FlowColorOffset`
  and `_FlowTopColor` above. adds `_FlowColorStrength` to colour where `metalMap.b` is set,
  `_FlowColorEmissiveStrength` to emission elsewhere, and lowers roughness by
  `_FlowRoughness · brightness`.
- **normals & depth blend**: base and detail normal maps sum (each with own scale); metal flattens
  the bitangent. `_ObjectBlend*` blends softly against scene depth.

`HGRP/ErosionDynamic` (animated, glowing) is used only by clearable erosion prefabs
(`P_erosion_map01_dynamic…`), load-gated while their map variable ≠ 2
([blight and its cores](scene-states.md#dynamic-load-gates)).

## swaying cloth

`HGRP/Lit` with `_SIMPLE_VERTEXANIM` and `_SIMPLE_VERTEXANIM_CLOTH` (map02 kites, flags, canvases,
logos) offsets vertices in world space in every pass after object-to-world. gated on
`_SimpleVertexAnimationWindIntensity + _NoiseOffsetIntensity != 0` and vertex colour alpha `a != 0`.

with `I` = `_SimpleVertexAnimationWindIntensity`, `F` = `_SimpleVertexAnimationWindFreq`, `S` = soft
factor, `T` = `_DirectionTendency`, `t` = [wind clock](environment.md#wind), and `x₀` = object world
X:

- **`_Kite` non-zero**: `s = sin(t · F + lerp(0, y · S − a · π, _Kite) + x₀) · y` (`y` =
  object-space height), `amplitude = I · 0.05`.
- **otherwise**: `s = sin(t · F − z · S − a · 3.14 + x₀)` (`z` = vertex world Z),
  `amplitude = I · 0.5`.

`offset = direction · (s + 1 + T) · amplitude · a`, where `direction` is horizontal: `(cos, 0, sin)`
of `_MainDirectionAngle` (degrees, truncated Taylor series) under `_Use_Custom_WindDir`, else the
wind direction.

- motion vectors evaluate the previous frame with the previous wind clock.
- per-pass `_DisableAnimateVert` scales the offset by `1 − value` (per-pass values unknown).
- `_NoiseOffsetIntensity` enters only the gate.
- `_SIMPLE_VERTEXANIM_ROPE` is another branch (undocumented); `_SIMPLE_VERTEXANIM_PENDULUM`
  [swings](#swinging-pendulums). [vertex offset](#vertex-offset) is independent and additive.

### swinging pendulums

`HGRP/Lit` with `_SIMPLE_VERTEXANIM` and `_SIMPLE_VERTEXANIM_PENDULUM` (Qingbo wind chimes
`M_prop_map02_sfornament+1_001_01a` and `_03`, hanging lamps, scepter, logo, Valley IV watchtower)
rotates each vertex in world space in every pass under the same gate.

around anchor `A` (object origin, or `_AnchorPoint` under `_Use_Custom_Anchor`), using `x₀`, `t`,
`I`, `F`, and sway direction `(dx, 0, dz)`:

1. rotate about `normalize(−dz, −dx, dx)` by `sin(t · F + x₀) · I · 0.05` rad.
2. rotate about world `+Y` by `sin(t · _SelfRotationSpeed + x₀) · _SelfRotationRange · π / 360` rad
   (degree factor `π / 180` to `1e-4`, halved).

both rotations use truncated Taylor sin/cos. the resulting displacement scales by
`lerp(a · I · 0.5, 1, _Stability) · a · (1 − _DisableAnimateVert)` (`a` = vertex alpha;
`_DisableAnimateVert` sits at `+16` in per-pass constants, unnamed in GBuffer). normals are not
rotated.

- `_SIMPLE_VERTEXANIM_USE_GRAVITY` (scepter) is not described here.
- across the 8 known materials, none sets `_Use_Custom_Anchor`, `I` spans 0.5–2.75, and chimes turn
  up to 4° about `+Y` at 18.8 rad per clock unit.

### cloth simulation

`_GPU_CLOTH` (map02 canvases, flags, banners; mostly alongside sway keywords, though some such as
Qingbo's red emblem banners `M_cloth_map02_sfcanvas+1_001_02` — 5 in cell −2, −11 — have no sway)
lets a draw read positions from a cloth simulation.

- sway still runs when enabled. object-space positions are replaced only if the global switch is on
  and per-draw data names a skeleton buffer slot (filled for entities with a cloth hash,
  [InitChunkData component 60](world.md#initchunkdata-layout); entities without one, e.g. Sword
  Vault Dale's red banner `P_cloth_map02_sfcanvas+1_001_01`, only sway).
- each simulated vertex transforms its rest position by a 3×4 matrix from the skeleton buffer
  (stores current and previous step per bone). vertex colour selects bones: R and G (`× 255`) are
  two indices blended by B, or `R · 256 + G` for single-skeleton cloths. alpha stays the sway
  weight.
- simulation inputs ship per 128 m cell as [cloth groups](world.md#cloth-groups) (iterations,
  damping, wind factors, transform; per node: rest position/normal/tangent, ≤2 anchors, ≤8
  neighbours with rest distances). compute shaders (`ClothSingleDispatchCS`, `ClothDataUploadCS`,
  fixed `1/60 · 1.4 s` step, ≤4 character capsule colliders) are not read.

## vertex offset

`HGRP/Lit` with `_USE_VERTOFFSET` (map02 tree cloth ribbons such as Jingyu's cherry-tree islet,
balloon tubes; all alpha-tested with `_USE_VERTOFFSETMASK`) offsets vertices in world space in every
pass (GBuffer, depth, shadow) after skinning and object-to-world:

```
offset = direction · _OffsetIntensity · (n · (1 + _Bi_Offset) − _Bi_Offset) · w · k
```

- `n`: `_OffsetTex.r` at mip 0, UV =
  `uv · _OffsetTex_ST.xy + _OffsetTex_ST.zw + _OffsetSpeed.xy · t` (`uv` blends UV0 and UV1 by
  `_OffsetUVSet`; `t` = gameplay clock below). `_Bi_Offset` 0 keeps `n` in `0..1`; 1 remaps to
  `−1..1`.
- `direction`: `_OffsetDir.xyz` (unnormalized, so length scales offset). `_OffsetSwitchDir`: 1 =
  world space as-is, 2 = vertex normal transformed by object matrix, other = `_OffsetDir`
  transformed by object matrix (rotation and scale).
- `w`: vertex alpha when `_UseVertexColorMask > 0`, else 1.
- `k`: `1 − (_OffsetMaskPower / 5) · (1 − m)` under `_USE_VERTOFFSETMASK` (else 1), `m` =
  `_OffsetMaskTex.r` on the same UV set with its own `_ST` and `_OffsetMaskSpeed`. at power 5, `m`
  scales directly.

both textures use their own samplers (all repeat on the 4 surveyed materials). `_DisableAnimateVert`
scales the offset as in sway; motion vectors use the previous frame's clock. the scroll clock is the
4th component of pipeline time ([gameplay time](#clock)), making `_OffsetSpeed` UV tiles/s.

## vertex animation textures

`HGRP/Lit` supports [bone animation](#bone-animation) from a matrix texture and two Houdini VAT
modes sampling `_PositionTexture` and `_RotationTexture` in every pass (one column per piece/point,
one row per frame; frame and row math match [soft-body animation](effects.md#soft-body-animation)).
Jingyu's hanging ornaments pair both from one simulation: rigid cans/charms and soft strings.

### rigid-body animation

`HGRP/Lit` with `_VAT_RIGIDBODY` moves mesh pieces rigidly (Jingyu cans/charms
`M_map02_sfornament_1_001_*`, machine parts `M_fx_zmdmachinevat_*`, rocks, Hongshan waterway).
`HGRP/LitEffect` also has the keyword (map02 cedar snow, floors, drones; vertex stage unread).

per vertex in every pass:

- **texel**: UV1 gives column `u · a` and row `1 − b · ((1 − v) + f / _frameCount)` (`a`, `b` from
  `_boundMinZ`, `_boundMaxX` as in [soft-body animation](effects.md#soft-body-animation)).
- **pivot**: `(−UV2.x, UV3.x, 1 − UV3.y)`.
- **frame `f`**: 0-based autoplay under `_B_autoPlayback`, else `_displayFrame − 1 + perDraw`.
- **position & rotation**: `_PositionTexture` stores piece position (raw under `_TextureFormat` 1,
  else normalized between `_boundMin*` and `_boundMax*`); `alpha · 4` selects which quaternion
  component `_RotationTexture` omits (`0 = w, 1 = x, 2 = y, 3 = z`; last two negated with the
  rebuilt component). 8-bit rotation textures store `q / 2 + 0.5`.
- **transform**: object-space `position + s · rotate(q, rest − pivot)` before object-to-world;
  normal and tangent rotate by `q`. `s = _globalPscaleMul`, multiplied by
  `_VATMaxPieceScale · (1 − fract(4 · alpha))` under `_pScaleInPosA`.
- **overrides**: frame 0 keeps rest position unless `_B_animateFirstFrame` is set; `UV1.v ≤ 0.1`
  collapses to the object origin.

across 37 known materials (both shaders): all use RGBA half-float (`_TextureFormat` 1); none sets
`_pScaleInPosA`, `_HoudiniVATInParticle`, or `_BlendMeshNormalAndTangent`; all autoplay (speeds
−8..9, some with `_gameTimeAtFirstFrame`); `_B_interpolate` is off (no frame blending). the cans
(`s_map02_sfornament_1_001_05_lod0`, 19 texels × 160 frames @ 30 fps) are point-sampled with repeat
wrapping and reproduce rest positions at frame 0 within 1 mm.

### soft-body animation

`HGRP/Lit` with `_VAT_SOFTBODY` (map02: only Jingyu ornament strings
`M_map02_sfornament_1_001_*_soft_lod*`) moves each vertex independently.

- **position**: `rest + offset`, sampling `_PositionTexture` as in rigid-body VAT.
- **frame**: `_RotationTexture` stores a full quaternion (`q / 2 + 0.5` in 8-bit). normal =
  `rotate(q, +y)`, tangent = `rotate(q, −x)`, replacing mesh vectors (`_BlendMeshNormalAndTangent`
  blends back; strings set 0, giving bitangent sign 0).
- **overrides**: no frame-0 rest override (strings store zero offset at frame 0); `UV1.v ≤ 0.1`
  collapses to origin.
- example: `s_map02_sfornament_1_001_05_soft_lod0` (436 columns × 160 frames) keeps string ends
  within 1 mm of cans swinging up to 34 cm.

### bone animation

`HGRP/Lit` with `_COMMONVAT_BONE_1` to `_4` (map02 only: Qingbo bamboo ornaments
`M_vat_map02_sfornament+1_001_*`, chair `M_vat_map02_chair+1_006_02`) skins meshes in every pass
from `_CommonVATMap`.

- **layout**: 3 texels per bone per frame row (a 3×4 matrix: moves object-space rest position, 3×3
  rotates normal and tangent). `_CommonVATMapParams` stores width and frame count.
- **skinning**: blends 1–4 bones per keyword. indices in UV2 (8-bit signed, `127 · u`), weights in
  UV3 (unrenormalized).
- **frame**: `_TimeParameters.w · _CommonVATFPS % frames` under `_CommonVATAutoPlay`, else
  `_CommonVATCurrentFrame + perDraw`. sampled at `v = 1 − (frame + 0.5) / frames` (point-sampled,
  stepping frame-to-frame). `_CommonVATBlendNormal` blends back to the mesh normal.
- all 7 materials autoplay at 30 fps with RGBA half-float maps and no normal blend. the checked pair
  (`T_vat_map02_sfornament+1_001_06_VAT` / `S_vat_map02_sfornament+1_001_06_LOD0`, 14 bones × 200
  frames) has integer indices, rigid matrices (orthonormal within `5 · 10⁻⁴`), and weights summing
  to 1 (a handful within 0.01, one at 0.87).

## clock

animated surface terms share `T = seconds / 20` (`_Time.x`; parallax pulse and erosion flow advance
`0.05 × speed` per tick). the pipeline populates:

- `_Time = (t / 20, t, 2t, g)`
- `_TimeParameters = (t, sin t, cos t, g)`

`t` is Unity `Time.time` in seconds. `g` is a separate gameplay time derived from an integer divided
by 1000 (assumed ms → s; setter untraced), read by vertex offset scroll and bone animation.

## open

- what sets the [clock](#clock)'s gameplay time, its units (assumed seconds), and the clock that
  scrolls the emissive map
- detail map channels per `_DetailMode` (roughness from B in mode 1, alpha in mode 0), unchecked
  against a shot
- layer UV set 2 read as set 0 (inferred from map02 meshes and one in-game shot)
- whether anything sets a per-draw [emission](#emission) colour on static scenery (no drawn object
  needs one)
- whether premultiplied [glass](#glass) multiplies colour by alpha, and how glass refracts
- what distance each side of the [transparent draw order](#transparent-draw-order) sorts by (bounds
  centre inferred, untraced)
- how bump mapping behaves on meshes without tangents
