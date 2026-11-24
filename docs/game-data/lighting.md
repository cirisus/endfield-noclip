# lighting

how the game lights surfaces: sun and shadows, ambient and reflections, and local lights, with their
environment-profile inputs. see [environment.md](environment.md) for profiles and blending,
[irradiance.md](irradiance.md) for baked GI, and [post-processing.md](post-processing.md) for post
passes.

## units

HGRP (Hypergryph's deferred PBR Unity fork) lights in physical units pre-exposed by a fixed profile
exposure. emission is authored pre-exposed ([emission](materials.md#emission));
[auto exposure](post-processing.md#auto-exposure) adjusts on top. native engine code packs most
profile fields into shader constants on the CPU; unknown packings are under [open](#open).

these pages describe PC high (level 4000). see [quality settings](quality-settings.md) for preset
mapping and other tiers.

## sun

| input                                  | effect                                      |
| -------------------------------------- | ------------------------------------------- |
| `light.directLux`, `light.directEV100` | sun illuminance and exposure value          |
| `light.directColor`                    | sun colour (stored as sRGB)                 |
| `light.directPitchYaw`                 | direction of shading and shadow-casting sun |
| `light.directSpecularIntensity`        | scales the sun's specular lobe              |

each sun-driven effect has its own direction: `<effect>PitchYawMode` 0 follows the light, 1 uses
`<effect>PitchYaw`. the resolved `rotation*` quaternions match pitch, yaw, and mode in every shipped
phase. art direction often decouples these from the shading sun:

| effect (`<effect>PitchYaw`, `rotation<Effect>`) | used for                                        |
| ----------------------------------------------- | ----------------------------------------------- |
| `atmosphere`                                    | sky LUTs, atmosphere fog, volumetric fog sun    |
| `heightFogDirectionalInscattering`              | height fog directional term                     |
| `sunDisc`                                       | [sun disc](sky-and-fog.md#sun-disc)             |
| `lensFlare`                                     | [lens flare](post-processing.md#lens-flare)     |
| `cloudShadow`                                   | [cloud shadows](#cloud-shadows) skew            |
| `lightShaft`                                    | [light shafts](post-processing.md#light-shafts) |

other derived fields on `lightConfig` can be stale: `forwardDirect` disagrees with `directPitchYaw`
by tens of degrees in over a dozen shipped phases (map01 lv000 destruction/cave, indie_race001
boss), and `directIntensity` disagrees with `directLux · preExposure` in about as many.

the sun uses the same BRDF lobe as [local lights](#local-lights), with `_DirectionalLightColor`
populated on the CPU from `linear(directColor) · directIntensityDividePi` (`1/π` folded in); foliage
uses its two-sided model ([foliage](materials.md#foliage)).

## shadows

PC high uses three sharp cascades (12, 30, 80 m) plus a cached, tiled far shadow map out to 800 m
(ASM, `HGASMManager`, configured by `asm*` fields). shadow-only renderers cast into shadow maps
without drawing; interiors rely on them (e.g. Dijiang's 177 × 348 m roof plane at y 46 blocks the
sun because interior walls cull back faces; no Dijiang material changes `_ShadowCullMode`).

- **sharp cascades**: 16 gathers (64 depths) on a Poisson disk rotated per 4×4 pixel cell. filter
  radius in the 2×2 atlas UV is `csmShadowSoftness / split` (splits 12, 30, and 40 m —
  `CSMSplit2 = 0.5` halves the 80 m split for penumbra only). a curve hardens edges for nearby
  blockers and falls back to plain PCF for distant ones.
- **cascade selection (unverified)**: uses the first containing cascade, dithered with the next over
  the outer 10% of its bounding sphere radius; sharp cascades fade into the far map before 80 m
  (`CSMFadeInnerDistance` = 60 m at PC high).
- **far map (ASM)**: tent-filtered 16 × 16 grid of 200 m tiles, 256² each (~0.78 m/texel) over 800 m
  around the camera. up to 8 dirty tiles re-render per frame; large camera moves recache all tiles.
- **caster filtering**: cascades re-render every frame on PC and draw only realtime casters
  (`CastShadow` + `RealtimeShadowCaster` + cascade bit, all four or none). the far map draws only
  static casters (`CastShadow` + `StaticShadowCaster`). ~1/7 of map02 chunk draws set `CastShadow`
  with neither flag and cast no sun shadow ([render flags](world.md#render-flags)). alpha-tested
  foliage casts into all maps. each map skips casters below a native screen-size threshold (0.005,
  0.01, 0.02 for cascades; 0.01 for far tiles; measure undecoded).
- **contact shadows**: Bend Studio screen-space shadows (PC low+). multiply direct sun light by
  `mix(1, contact, contactShadowIntensity)` (0.5 in most of map02's open world; 0.9–1 in caves and
  interiors).
- **acne**: receivers push toward the sun by the clear contact-shadow ray length where no blocker is
  found; casters use hardware bias.
- **`shadowConfig`**: blended across volumes like any phase section (map02 sets softness 0.01 and
  strength 1 everywhere; Yinglung Pass tints penumbrae purple; some cave/interior volumes block the
  sun entirely):

  | input                                              | effect                                                               |
  | -------------------------------------------------- | -------------------------------------------------------------------- |
  | `csmShadowSoftness`                                | filter radius numerator above                                        |
  | `disableCsmBlendFactor`, `csmSimulatedAttenuation` | blends shadow toward attenuation (caves: 1 and 0)                    |
  | `csmIntensity`                                     | sun visibility `mix(1, shadow, intensity)`                           |
  | `csmRampTexture`                                   | penumbra tint: sun × `1 − (1 − ramp(v)) · (1 − v)` (black if absent) |

  without a ramp, sun multiplies directly by visibility `v`.

### cloud shadows

`cloudConfig.cloudShadowConfig` (active when `enable` and `enableCloudShadow` are set) darkens the
sun with a tiling texture skewed along the sun direction by height:

- offset `d` from `cloudShadowEnvCenter` skews to `d + l · d.y`, where `l` is
  `rotationCloudShadow`'s direction divided by `clamp(|cos(pitch / 360)|, 0.001, 1)`. `pitch`
  (`cloudShadowPitchYaw` if mode 1, else `directPitchYaw`) is in degrees while `cos` takes radians,
  so the divisor stays within 1% of 1 at all pitches (even Wuling City's 0° pitch).
- `uv = skewed.xz × (0.001 / cloudShadowCoverage) + flowDirection · (flowSpeed / 1000) · t`
  (`cloudShadowCoverage` in km).
- past `cloudShadowScaleStartDistance` m horizontally, over the next `cloudShadowScaleEndDistance`
  m, the sample smoothsteps to `uv / cloudShadowDistanceScale`.
- sun visibility multiplies by `mix(1, red, cloudShadowAlpha)` before the sun-off override,
  strength, and ramp.

no shipped phase sets `enableFarCloudShadowTexture`. rain phases use high alphas (Marker Stone:
0.75–1 vs 0.49–0.70 dry), creating most of the overcast look. volumetric fog applies the same cloud
shadow to its sun (alpha 1 in Marker Stone caves blocks sun in fog).

## ambient

diffuse ambient comes from the [irradiance volume](irradiance.md) where covered, and the **ambient
probe** elsewhere. all diffuse ambient (and volumetric fog's sky term) scales by
`light.indirectDiffuseFactor` (`_EnvironmentGlobalParams0.x`; `.y` is
`light.indirectSpecularFactor`).

- **ambient probe**: `sky.skyAmbientSH` (Unity `SphericalHarmonicsL2`, 27 floats channel-major).
  volumetric fog reads `skyAmbientSH` directly as L1 SH without `skyDirectIntensity`.
- **irradiance volume default SH** (`_IVDefaultSHAr/g/b`): `sky.customIVDefaultSH` when
  `sky.useCustomIVDefaultSH` is set, else `sky.skyAmbientSH`, packed as pure L1 SH
  (`[u3, u1, u2, u0]` per channel, without L2's `−u6` fold) and scaled by `sky.skyDirectIntensity`.
  shaders blend it with irradiance volume probes by sky visibility and multiply the combined
  irradiance by `light.indirectDiffuseFactor`.
- **irradiance volume probes**: used unscaled as stored (already pre-exposed). bake fields
  (`skyBakedIndirectIntensity`, `bakedIndirectMultiplier`, `giSkyMultiplier`,
  `giBakedIndirectMultiplier`) do not apply at runtime through the volume.
- **clipmaps**: three camera-centred clipmaps filled from volume cells
  ([cells and probes](irradiance.md#cells-and-probes)), reaching ±29, ±116, and ±464 m horizontally
  and ±13, ±52, and ±208 m vertically, fading over their outer 2, 8, and 32 m into the next coarser
  level. probe validity blends in the ambient probe with a vertical boundary correction. lookups
  jitter and clipmap centres shift along the view.
- **occlusion**: diffuse ambient uses Jimenez's per-channel multi-bounce AO on
  `min(GTAO, materialAO)` (or linear `materialAO` alone when
  [ambient occlusion](post-processing.md#ambient-occlusion) is off). specular ambient uses Lagarde's
  specular occlusion on `min(materialAO, GTAO)`.
- **lightmaps**: likely unused (no dynamic-prefab renderer carries a lightmap index, all use light
  probes, and no VFS path names a lightmap; HLOD and terrain unchecked).

specular ambient samples `sky.reflectionMap` (BC6H cubemap, prefiltered by roughness across mips)
along the roughness-bent reflection vector, weighted by a split-sum environment BRDF and
`light.indirectSpecularFactor` (`_GraphicsFeaturesGlobalParam0` is `(AO on, SSR on, 1, 1)`).
cubemaps can be black (e.g. Dijiang's `T_reflectionprobe_envdefault0`), leaving metal to local
reflection probes.

sky reflections normalise against local diffuse irradiance: with `d` = diffuse irradiance luminance
and `p` = `_ReflectionProbeGlobalParam3` dotted with `(N, 1)` (the Rec. 709 luminance of pure L1
`sky.skyAmbientSH`, unscaled by `indirectDiffuseFactor` or `skyDirectIntensity`, with Y and Z
swapped relative to `GetCoefficientsL1`), the scale is `(2 · min(d / p, 1) + d) / (2 + p)` (~`d / p`
indoors, ~1 outdoors).

local reflection probes live in `InitChunkData` tag-1 `MonoObject`s under component type `0x10000`
(`StreamingComponentType.ReflectionProbe`, matching Unity `ReflectionProbe`: box size, influence
scale, `m_TRS` / `m_TRInverse`, intensity, box projection, mode, importance, shape box/sphere, baked
or custom L2 SH, and cubemap path hash). the game packs them into a 32-slot octahedral atlas, bins
them into screen tiles and depth slices like [local lights](#local-lights), blends front-to-back in
priority order over the sky cubemap, and normalises each probe against its own luminance L1 SH.
cubemap textures ship as 128² BC6H cubemaps (and `reflectionprobe-*.exr` assets); a handful of
decoration prefabs (`p_lightingdeco_*_reflectionprobe`) also place probes.

### screen-space reflections

at PC high, every lit surface at any roughness gets SSR:

`specular = (hit · fade + sky · (1 − fade)) · environment BRDF · specular occlusion`

only the `sky` term carries the diffuse normalisation and `indirectSpecularFactor`. on a miss, the
sky reflection remains. at PC high (4000), all passes run at half resolution with 32 march steps; PC
very high (5000) raises the march to 128 steps and enables `ssrV2Upsample` (half-res march outputs
hit UVs, full-res scene lookup and colour temporal filter, half-res downsample/pyramid/resolve, and
a full-res upsample pass that keeps the full-res temporal colour where cone mip < 0.25). per-tier
values are in [quality settings](quality-settings.md#values-by-level).

- **march**: mirror ray projects to screen, stretches to screen edge, and steps linearly in UV and
  device depth (4 taps/loop): 32 steps (`ssrRayMarchingSampleCount` at PC high, also the distance
  floor), dropping to 4 at roughness ≥ 0.3. hits when behind depth by `< 2` step depths, refined
  linearly. start offsets by per-frame interleaved gradient noise (or ~1 px when steps are
  sub-pixel).
- **colour**: samples last frame's composited scene (including fog, transparents, water,
  reflections) at the hit's previous-frame screen position.
- **fade**: product of three ramps from the post profile's `ScreenSpaceReflectionVolume` (every
  shipped profile sets `0.1, 2, −1`): screen-edge fade over `fadenessOnScreen` UV; head-on fade
  `1 − saturate(|N·V| · fadenessOnMirrorMul + fadenessOnMirrorAdd)`; and 90–100 m distance fade
  (skipped when roughness < 0.1).
- **temporal filter**: blends 97% reprojected history (colour stored as `c / (1 + max(c))`, clipped
  to the 3×3 neighbourhood box averaging plus/full extremes widened to `mean ± 1.25 σ`) times
  confidence `exp(−motionPx · saturate(ln(0.02 · viewDepth) + 0.01))` (full 97% under ~50 m,
  decaying with full-res screen motion beyond).
- **blur & resolve**: up to 7-mip pyramid, each a 4×4 binomial `(1 3 3 1)²` weighted by
  `exp(−0.01 · |Δ viewDepth|)` against nearest depth. resolve selects mip `log2(coneFootprintPx)`
  from Blinn-Phong lobe half-angle `acos(0.244^(1 / (2/α² − 1)))` at hit distance, blending the two
  surrounding mips with the same depth-weighted binomial (below 0.25 mip, uses filtered colour
  directly); fade reads the lower mip.

passes run as compute kernels with motion-vector reprojection. under rain, a variant re-derives wet
roughness ([wetness](environment.md#wetness)) and adds rain ripple normals. forward-drawn reflectors
(water, [reflection-only effects](effects.md#reflection-only-effects)) write normal, roughness, and
depth for the march.

## local lights

point, spot, and tube lights come from three sources:

- **chunk files** ([world.md](world.md#initchunkdata-layout)): a point light with positive length is
  a tube along its direction. colours are precomputed: linear sRGB × intensity × HDRP
  colour-temperature tint (pivot 6570 K).
- **dynamic structures**: ECS groups in the same layout (a few hundred on map02, e.g. outpost
  lamps), visible with their structure ([dynamic structures](assets.md#dynamic-structures)).
- **prefabs**: Unity `Light` + HG additional light data on the same GameObject (e.g. Dijiang
  `lightingdeco_spaceship_*` holds the growth chamber's 6 spots). same settings as chunk lights,
  with culling box in prefab axes (unverified: rotates with placement).

scenes also contain directional lights, shadow-only lights (~a dozen on map02; emit nothing, darken
other local lights via [shadow maps](#local-light-shadows)), and character-only lights (none on
map02). both realtime and mixed bake types light directly.

| input                                                         | effect                                                                                                                                              |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| final colour                                                  | linear colour × intensity × temperature tint (precomputed in chunk files); added without pre-exposure                                               |
| range, falloff exponent                                       | negative exponent: `(1 / (d² + 1)) · (1 − (d²/R²)²)²`; otherwise `(1 − d²/R²)^exponent`                                                             |
| tube length                                                   | `1 / (d² + 1)` → `1 / ((\|a\|\|b\| + a·b) / 2 + 1)` over segment ends `a`, `b`; `n·l` averages ends; specular uses segment point nearest reflection |
| spot angle, inner spot angle                                  | `saturate((cos θ − cos(outer/2)) / (cos(inner/2) − cos(outer/2)))²`                                                                                 |
| culling box (offset, half extents, Euler rotation, threshold) | world axes around light; with `m` = max box coordinate: `(1 − saturate((m − (1 + t)/2) / ((1 − t)/2)))²`                                            |
| culling and falloff distance                                  | fades linearly in `d²` from falloff distance to 0 at culling distance                                                                               |
| soft source radius `s`                                        | widens lobe: `α += saturate(s / d)² / (3.6 v·h + 0.4)`                                                                                              |
| specular intensity                                            | scales specular lobe                                                                                                                                |
| volumetric scattering intensity                               | scales light in volumetric fog                                                                                                                      |

**BRDF (local lights and sun)**: GGX with height-correlated Smith visibility and Schlick Fresnel,
omitting `1/π` on diffuse/NDF and `(1 − F)` on diffuse:

`colour · attenuation · n·l · (diffuseColour + π · specularBRDF)`

specular clamps to 1000, the light sum clamps to 255, and a multiple-scattering term adds on top.

**culling and binning**: each frame keeps the nearest 256 visible lights within culling distance
(sorted by distance, then priority; 256 at all PC tiers,
[quality settings](quality-settings.md#values-by-level)). compute shaders bin them into 32 px screen
tiles and 2048 × 1 m depth slices from the near plane (256-bit masks); pixels walk the intersection
of their tile and slice masks. volumetric fog lights froxels with the same lists via
Henyey-Greenstein phase × volumetric scattering intensity ([fog](sky-and-fog.md#fog)).

**foliage** uses its two-sided model ([foliage](materials.md#foliage)): albedo × `N·L`, back-dimmed
specular, transmission lobe, and wrapped diffuse, all multiplied by the material's vertex AO and
sun-aimed fake directional shadow (no `1/π`).

lights can also carry cookies (none on map02), a flicker component, and [light beams](#light-beams).

### local light shadows

~1000 map02 lights cast shadows. each frame walks visible lights nearest-first and creates shadow
casters for shadowed lights within `min(shadowCullDistance, 200 m)` (1 caster per spot; 1 per
enabled cube face for points):

- **static casters** (stationary light, static objects cast — nearly all shadowed map lights): share
  a 4096² atlas (high quality) divided into a 4×4 quadtree of three sizes:
  - ranks 1–12: 1024² (full tile)
  - ranks 13–24: 512² (quarter tile)
  - ranks 25–40: 256² (sixteenth tile)
  - past 40: unshadowed
  - draws 1 tile per frame (rank-changed casters first, then missing tiles). tiles stay cached while
    within cull distance (in view or not); full tiers evict LRU.
- **dynamic casters** (moving light, or dynamic objects cast): up to 6 still and 2 moving lights get
  dedicated tiles beside the atlas, redrawn every frame with dynamic objects.

**rendering**: spot maps use FOV `spotAngle + guardAngle` from shadow near plane to shadow far plane
(distinct from range); point faces are 92° wide. static tiles draw static shadow casters (including
foliage), culled to frustum and culling box, with hardware depth bias.

**sampling**: pushes surface along normal by `texelSizeAt1m × normalBias × 7.5`, filters with a 5×5
tent, and blends by shadow strength (fading to 0 over the last `1 − fadeRatio` of cull distance).
spot shadows also fade over the last 0.2 m before the far plane and the outer 5% of the map. at high
quality, volumetric fog froxels sample these shadows too.

### light beams

light beams use a modified Volumetric Light Beam asset: shared `ConeMesh.asset` + per-beam
`Hidden/VLB_HGRP_SinglePass` (~150 materials across map01, map02, and checked dungeons, mostly
map02). Wuling Very Large Rift (`dung02_dg005`) has the largest (781 m across), in script groups
pairing dark (default) and bright (script-shown) sets.

`ConeMesh.asset` is a 64-sided cone (`z ∈ [0, 1]`) with a start cap; UV0 `u` marks the cap, `v`
marks outside (1) vs inside (0), allowing one back-culled draw to show inside faces from within. the
vertex shader squares `z`, scales radius `_ConeParams0.x → .y` (over the larger), and skews along
`_ConeParams1.xyz`; the transform supplies the rest of the size.

opacity (in beam-local units: radius, and `_DistanceFallOff.z` along the axis) is the product of:

| term           | from                                                                                                                   |
| -------------- | ---------------------------------------------------------------------------------------------------------------------- |
| side term      | side normal (`_ConeParams0.zw`) vs view (across axis or straight-on as view aligns with beam), raised to `_FresnelPow` |
| attenuation    | over `_DistanceFallOff.xy`: smooth linear or `1 / (1 + 25t²)` with tail fade, mixed by `_AttenuationLerpLinearQuad`    |
| start fade     | fades in over `_DistanceFallOff.w` from start (none at 0)                                                              |
| facing         | inside faces fade looking down the beam; outside faces fade looking back                                               |
| depth blend    | `VLB_DEPTH_BLEND`: fades over `_DepthBlendDistance` toward background surface                                          |
| near camera    | fades in over `_DistanceCamClipping` past near plane                                                                   |
| distance fade  | camera view depth to beam origin over `_DistanceFadeStart`–`End` and second pair (equal ends = step)                   |
| clipping plane | `_UseClippingPlane`: fades across `_AdditionalClippingPlaneWS` over `_ClippingPlaneTransition`                         |
| cap            | shown only when `_ConeParams1.w == 1` (0 on every checked beam)                                                        |

colour is `_ColorFlat` (LDR) × `_AlphaInside` or `_AlphaOutside`. `_BlendMode` 1 is additive
(`One One`, nearly all materials); 0 is alpha-blended. `VLB_NOISE_3D` multiplies by global 3D noise;
`VLB_USE_FOG` applies atmosphere and exponential fog. the shader also scales by an untraced
per-renderer value and `_VFXParams1` ([blending](effects.md#blending)).

## open

- baked lightmaps on HLOD and terrain (unchecked).
- [local light shadows](#local-light-shadows): native dirty flag that triggers cached tile redraws,
  native caster cull and small-caster metric, how static+dynamic lights combine both tiles, and how
  fog froxels filter the map.
