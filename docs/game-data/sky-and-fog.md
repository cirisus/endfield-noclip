# sky and fog

atmosphere, clouds, sun disc, celestial layers, and fogs, with their environment-profile inputs. see
[lighting.md](lighting.md#units) for units/pre-exposure, [sun](lighting.md#sun) for effect sun
directions, [environment.md](environment.md) for profiles/blending, and
[post-processing.md](post-processing.md) for post passes.

## sky

`atmosphereConfig` drives a Hillaire-style SkyAtmosphere (transmittance, multiple-scattering, and
sky-view LUTs; km units, per-km coefficients, `scale × colour` per term, tent ozone).

- **radiance scaling**: the sky-view LUT stores radiance per unit sun illuminance. C# scales it
  during LUT rendering by `atmosphere.outerSunIrradianceColor` (raw) × `light.directIntensity`
  (`directLux · preExposure`) × `sky.proceduralSkyLuxFactor`; the sky pass samples it unscaled.
- **horizon & grading**: the LUT fades just below the horizon with a ground bounce from
  `atmosphere.groundAlbedo`. the procedural sky then applies `_VFXParams1`
  ([blending](effects.md#blending), neutral `(1, 1, 1, 1)` outside `VFXSceneDark` playables).
- **cloud panorama (`cloud.cloudTexture`)**: blended over the sky above the horizon by alpha. covers
  the upper hemisphere only: `u` is azimuth (`atan2(x, z)`) turned back by `rotation` degrees; `v`
  runs horizon (0, bottom row) to zenith (1), spanning 90° elevation.
  - tint: `cloudTint` (raw, no sRGB decode) × `cloudFadeAlpha` × `brightness`.
  - `brightness`: `cloudAbsoluteBrightness`, or with `lightAffectCloud`:
    `(cloudBrightness + light.directIntensityDividePi) × sky.proceduralSkyLuxFactor` (base profiles
    leave this off; local phases like Power Plateau's `Env_map01_lv007_art_overcast_brightness` ≈
    4.3× and boss phases enable it with low tint alpha).
  - `brightness` affects alpha only when `brightnessAffectCloudAlpha` is set. texture mode 0 uses
    `cloudOpacityR`/`cloudOpacityG` per channel.
- **fog**: the sky is fogged at `sky.skyDistance`.

## sun disc

enabled by `sky.enableSunDisc`, added onto the atmosphere around `rotationSunDisc` before planets
and clouds (so clouds occlude it). with view direction `d` and sun direction `s`:

- `c = saturate(s · d)^20`
- `lobe = 0.0100164 · (1 + c²) / max((1.9801 − 1.98 · c)^(8 · sunDiscRadius^0.65), 1e-4)`
- `disc = mix(smoothstep(0.5, 1, lobe) · lobe, lobe, sunDiscRampIntensity)`
- final radiance:
  `clamp(disc · sunDiscColor · directIntensityDividePi · proceduralSkyLuxFactor, 0, 3)`
  (`sunDiscColor` raw)

pre-exposed scaling lets the disc exceed the [light shafts](post-processing.md#light-shafts)
threshold.

## beyond the atmosphere

all layers beyond the atmosphere render inside the single sky-dome draw, switched by shader keywords
from `celestialConfig` and `starConfig`:

- **nebula (`star.enableNebula`)**: equirectangular `nebulaMap` rotated around up by
  `nebulaMapRotation`, times raw `nebulaTint × 2`. hidden behind sky planets by
  `celestialNebulaConverage`.
- **stars (`star.enableStars`)**: one candidate per grid cell (`starsTilling × 200` cells/radian),
  kept where hash clears `1 − starsDensity`, sized in `minMaxRange`, tinted between `starsTint` and
  `starsTint1`, twinkling at `starsFlickerSpeed`, scaled by `starsExposure`. thinned by
  `skyBoxStarRangeMap`, nebula brightness (`nebulaStarConverage`), sky planet rings, and clouds
  (`cloudRingStarCoverage`).
- **ray-traced planet (`advancedPlanetConfig`, Dijiang's Talos-II)**: material
  `HGRP/Planet/PlanetBillboard` supplies linearised colours and parameters. sphere of
  `_RealPlanetRadius` at `_PlanetWSBase + (−sin φ, sin θ, −cos θ cos φ) · _Dist` (`_Phi2`,
  `_Theta2`), cylindrical equal-area UV after `_Pitch`/`_Roll` tilt. uses RSM map (`g` depth, `b`
  sea mask) for sea colours, point-sampled RGBA cloud atlas (4 quadrants of longitude ×
  hemisphere) + cloud shadows, URP minimal GGX, soft terminator `1 / (1 + e^(−20 n·l))`, rim, flat
  ambient, and a 3-sample single-scattering atmosphere with transmittance LUT. lit from
  `_CustomLightDir` if `_CustomLightDirection` is set, by directional light colour or material
  colour if `_CustomLightColorPla` is set (rim and flat ambient ignore light colour). replaces the
  sky behind its disc.
- **sky planets (`planetConfig`, `talosAlphaConfig`, when `drawPlanetInSkydome`)**: spheres viewed
  from `moonConfig.orbitRadius − moonConfig.radius` along `skydomeDrawer.pitchYaw`, lit from
  `incidentLightingPitchYaw`. frame is `Euler(selfTiltX, 0, selfTiltZ)` rotated by `selfRotationY`
  about its pole (engine passes frame right as shader "forward" and forward as "right"). samples
  `_MainTex`, `_EmissiveTex`, planet-shadowed ring (`_RingTex`, inner→outer over `v`), and a
  single-scattering rim at 2000 units. fades below horizon when `drawPlanetBelowHorizon` is set.
  `_BlendMode`: 0 alpha, 1 additive, 2 premultiplied. slot 1 applies `_VFXParams1`; slot 2 does not.
- **moon's ring (`HG_RING`, `moonConfig` when `enableRing`, `ring.width > 0`, non-black
  `ringColor`)**: sky-spanning arc of the standing body's ring viewed from `worldLatitude`,
  `worldLongitude` (rotated by `rotationAroundUp`). adds `planetRingMap × ringColor` (raw) where
  view crosses the ring plane on the far side from the pole; fades below horizon with
  `drawPlanetBelowHorizon`. Dijiang sets `enableRing` with width 0 (draws none); which phases draw
  it and its exact draw order are unrecorded.

**compositing order**:

1. atmosphere + sun disc
2. sky planets (with `drawCloudAfterPlanet`, as in Wuling City; without it, planet discs draw over
   clouds and only their off-disc glow is covered)
3. cloud panorama
4. nebula and stars (thinned behind clouds by `cloudRingStarCoverage`)
5. ray-traced planet (over everything)

the sky shader also has an aurora (uninspected). Snowy Forest's aurora curtains are placed effects
swapped by level scripts ([trigger volume shapes](scene-states.md#trigger-volume-shapes)).

## fog

three fog layers apply to opaque surfaces, sky, and water in order: **atmosphere fog → height fog →
volumetric fog**. glass and fogged effects apply the same fog at their own distance.

- **atmosphere fog (`fogConfig.enable`)**: single scattering in an exponentially height-thinning
  medium starting at `startDistance`. Rayleigh and Mie scattering come from `fogConfig` (negative
  `rayleighScatteringScale` defers to `atmosphereConfig`), absorption from `atmosphereConfig` Mie
  absorption, sun from `light.directColor` × pre-exposed sun intensity, plus `inscatterAmbientColor`
  (all colours raw).
- **height fog (`heightFogConfig.enable`)**: two exponential layers (density, falloff, start height
  each; packed base-2 units), raw pre-exposed `heightFogInscatter`, max opacity, start/cutoff ramps,
  and directional inscatter toward `rotationHeightFogDirectionalInscattering` past a start distance.
  while `volumetricFogConfig.enable` is set (PC path), layer parameters come from
  `volumetricFogConfig`'s own height-fog set (often very different from `heightFogConfig`'s), while
  on/off still follows `heightFogConfig.enable`.
- **volumetric fog (`volumetricFogConfig.enable`)**: camera froxel grid from
  `volumetricFogStartDistance` to `volumetricFogDistance`:
  - **medium**: extinction = `0.5 × heightFogLayerDensity × volumetricFogExtinctionScale`;
    scattering = `extinction × volumetricFogAlbedo`; emission = `volumetricFogEmissive / 1000` per
    metre.
  - **lighting**: scatters sun (raw `directColor` × pre-exposed intensity ×
    `volumetricFogDirectLightingScatteringIntensity`, 1 shadow-map tap ×
    [cloud shadow](lighting.md#cloud-shadows), sun-off override + strength, Henyey-Greenstein phase
    `volumetricFogScatteringDistribution` toward atmosphere sun), ambient probe L1
    (`× volumetricFogSkyLightingScatteringIntensity / π × indirectDiffuseFactor`,
    [ambient](lighting.md#ambient)), and [local lights](lighting.md#local-lights) (excluding
    character-only; shadow-only lights emit nothing and multiply local-light sum by their shadow).
  - **integration**: front-to-back per column, fading in over `volumetricFogNearFadeInDistance`.
  - **grid layout**: cells are at least a tier-defined pixel size with a tier-defined grid cap
    ([quality settings](quality-settings.md#values-by-level)). depth slices are logarithmic:
    `s = log2(z · B + O) · S`, starting at `max(near + 0.095 m, volumetricFogStartDistance)` to
    `volumetricFogDistance`, `S` slices per depth doubling (`S`, jitter scales, and history weight
    unrecovered).
  - **interaction with height fog**: while volumetric fog is on, height fog integrates only beyond
    `volumetricFogDistance` (start/cutoff ramps and max opacity still measure the full ray; nothing
    nearer than start distance is fogged). thus the height-fog set's start distance and inscatter
    colour govern the far fog, not the near fog.
  - **temporal reprojection**: each froxel samples at a shared per-frame Halton offset and blends
    with reprojected last-frame scattered light and extinction. history misses average multiple
    jittered samples (count per [quality level](quality-settings.md#values-by-level)).

volumetric fog also supports voxelized local fog volumes and `enableVLFlowNoise` (scrolling
perturbed scattering noise), neither described here.

## flow noise

`enableFlowNoise` in the active height-fog set (volumetric section's while volumetric fog is on,
else height-fog section's) modulates fog on opaque surfaces via a scrolling 3D noise (e.g. drifting
fog banks at Marker Stone), applied in deferred lighting after all fog:

- **sampling**: pipeline texture `HeightFogFlowNoise` (64³ alpha-only, repeat) at
  `worldPos · flowNoiseTilling + flowNoiseDir · flowNoiseSpeed · t`.
- **modulation**: `k = flowNoiseIntensity · saturate(1 − distance / flowNoiseDistance)`; surface
  becomes `mix(unfogged, fogged, min(1 − k + 2 · noise · k, 1 + T))`, where `T` is mean fog
  transmittance (`noise = 0.5` leaves fog unchanged; low clears, high thickens up to 2×).
- **volume blending**: two noises with matching speed and tiling blend intensity, distance, and
  direction; otherwise the first fades out to ½ and the second fades in after. one-sided noise fades
  from 0 intensity with that side's settings. a phase without flow noise turns it off when at full
  weight (e.g. Wuling City over its outskirts).

## open

- whether `cloudFadeAlpha` reaches cloud alpha without `brightnessAffectCloudAlpha` (two differing
  code paths; PC path unchecked).
- which phases draw the moon's ring and its exact layer order; which light a space level gives the
  ray-traced planet.
- volumetric fog's slices per doubling (`S`), jitter scales, history weight, native diffuse-ambient
  scale on sky term, and local fog volume shader.
- flow-noise blending in the volumetric section's height-fog set (read from height-fog section;
  assumed identical).
- whether flow noise affects sky, water, and forward surfaces (only deferred lighting checked).
- the aurora.
