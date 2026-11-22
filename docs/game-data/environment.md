# environment

environment volumes placed in the world apply environment phases, blended by priority at the camera.
there is no per-level environment setting. rendering of a blended phase is in
[lighting.md](lighting.md), [sky-and-fog.md](sky-and-fog.md), and
[post-processing.md](post-processing.md).

## environment phases

an `HGEnvironmentPhase` (`EnvParse/Env_*.asset`, a MonoBehaviour read through its embedded TypeTree)
holds a list of `HG*Config` sections. each section has `m_active`: inactive sections leave
lower-priority volumes and the scene's global phase unchanged, even when their fields hold plausible
values.

| phase field           | holds                                                         |
| --------------------- | ------------------------------------------------------------- |
| `lightConfig`         | sun, exposure, ambient scale, effect directions               |
| `skyConfig`           | ambient SH, reflection cubemap, sky distance, sun disc        |
| `atmosphereConfig`    | sky LUTs, fog absorption                                      |
| `fogConfig`           | atmosphere (distance) fog                                     |
| `heightFogConfig`     | height fog                                                    |
| `volumetricFogConfig` | volumetric fog, and its own height-fog set used while it's on |
| `cloudConfig`         | cloud panorama, cloud shadows                                 |
| `windConfig`          | wind                                                          |
| `lightShaftConfig`    | sun shafts                                                    |
| `colorGradingConfig`  | grading                                                       |
| `autoExposureConfig`  | [auto exposure](post-processing.md#auto-exposure)             |
| `shadowConfig`        | sun shadow softness, strength, penumbra ramp, sun-off         |
| `celestialConfig`     | planets in the sky                                            |
| `starConfig`          | star field and nebula                                         |
| `rainConfig`          | rain, rain wetness ([wetness](#wetness))                      |
| `lensFlareConfig`     | the sun's [lens flare](post-processing.md#lens-flare)         |

phases also carry other sections (`snowConfig`, `volumetricCloudConfig`, …) not covered here.

data conventions:

- colours pass to shaders raw (no sRGB decode; HDR values exceed 1).
- `SphericalHarmonicsL2` is 27 floats, channel-major.
- sections reference textures (BC6H sky reflection cubemap, cloud panorama, cloud flow map,
  cloud-shadow texture), celestial body draw materials, and `LensFlareDataSRP`
  ([lens flare](post-processing.md#lens-flare)).
- `*ForEdit` fields are editor-only previews.

fields with unknown effects (checked across map01, map02, dungeon, base, and race scenes):

- `cloudConfig.cloudFlowType`: 1 or 2 in most phases with clouds, usually with nonzero `flowSpeed`;
  type 2 also references `cloudFlowMap` (presumably scrolls the panorama).
- `skyConfig.skyMaterialType`: 1 in `Env_map01_lv006_art_boss_area_01` (with `skyboxCubeMap`),
  `Env_dung02_rdg008_sword`, and `Env_indie_race001_art_bossS1_end2`; 0 elsewhere (1 presumably
  swaps the procedural sky for the cubemap).
- `skyConfig.reflectionType`: 0 or 1, roughly evenly.
- `skyConfig.useCustomIVDefaultSH`: set in ~⅓ of phases; `customIVDefaultSH` presumably supplies the
  fallback SH outside irradiance-volume coverage ([lighting](lighting.md#open)).
- `heightFogConfig.enableVolumetricFog`: false in a few dozen phases (including map02's
  `Env_map02_lv003_global`), while `volumetricFogConfig.enable` is true wherever that section is
  active; which flag controls the PC fog path is unknown.

## environment volumes

chunk volumes are tag-1 rows in InitChunkData with asset references in paired StreamingChunkData
([world.md](world.md)). other volume sources are [prefabs](#prefab-volumes) and
[LevelData](#weather). a chunk volume repeats under the same object id in every cell chunk it
overlaps. the entity id's level tag identifies its owner (0 = scene-wide).

`HGEnvironmentVolume` component fields:

| field | type  | meaning                                                                            |
| ----- | ----- | ---------------------------------------------------------------------------------- |
| 0     | int   | `volumeType` (`EnvVolumeType`): 0 global, 1 box, 2 sphere, 3 poly area, 4 cylinder |
| 1     | int   | `blendMode` (`EnvBlendMode`): 0 none, 1 distance, 2 time, 3 manual                 |
| 2     | int   | priority                                                                           |
| 3     | float | blend distance (m)                                                                 |
| 4, 5  | float | fade-in / fade-out duration (s)                                                    |
| 6     | asset | `HGEnvironmentPhase` (Streaming half only)                                         |
| 7     | blob  | polyline shape                                                                     |

shapes:

- **global (0)**: applies everywhere.
- **box (1)**: unit cube under the object's transform (position, Euler rotation, scale), inferred
  from placement scales and names. no shape blob.
- **sphere (2)**: not seen in map02.
- **prism (3, `PolyArea`)**: blob layout is `u32 byteLength`, `f32×3` position, `f32×3` Euler
  rotation, `u32 n`, `n × (x, z)` relative to position, an edge BVH, then trailing `f32 height` and
  `f32 baseHeightOffset`. points transform to world space by yaw and position (inferred: all map02
  volumes store zero rotation). vertical span is `y ∈ [position.y + baseHeightOffset, + height]`;
  volumes are 3D, so a cave volume under a hill does not apply on the hilltop.
- **cylinder (4)**: map02's single instance (a waterfall volume) has no shape blob; where its shape
  lives is unknown.

world layout:

- each scene has one global volume (tag 0).
- each level typically has one broad polygon or box volume (usually priority 200, often named
  `*global*`) under dozens of higher-priority volumes for caves, interiors, and set pieces.
- neighbouring levels' volumes overlap a level's rectangle. map02 has a few hundred chunk volumes,
  most referencing distinct phases.

Unity post-processing `Volume`s share the same rows (fields 0–4: `isGlobal`, priority, blend
distance, weight, and Streaming `VolumeProfile`); local ones add a `BoxCollider` (field 2 centre,
field 3 size). every level has a global post volume (map02's all share one profile at priority 0); a
few add local boxes (Marker Stone, Snowy Forest).

## scene states

a volume in scene state 0's chunk files always loads. otherwise it loads with any MapConfig scene
state whose files contain it ([scene-states.md](scene-states.md)). all map02 volumes live in state-0
files.

## prefab volumes

some volumes live in prefabs placed by DynamicStreaming model rows
([assets.md](assets.md#payloads)), so entity load gates switch them with story progression. prefabs
are named `P_lightingDeco_<entity id>_envvolume`. each carries a Unity-serialized
`HGEnvironmentVolume` MonoBehaviour on an active GameObject with the same fields (`_volumeType`,
`_blendMode`, `_priority`, `_blendDistance`, `_fadeIn/OutDuration`, `_polyLineShape`, `_envPhase`).

differences from chunk volumes:

- `_envPhase` is a direct object reference (often in the prefab's own bundle), not a StringPathHash
  asset; embedded phases have their own names.
- boxes use the GameObject's transform under the placement. polylines store world coordinates
  directly (the GameObject's position does not move them).
- each volume belongs to its placement's level and follows the placement's visibility (load gates,
  scene-state lists, script flag).

example — Power Plateau (`map01_lv007`): its chunk volume applies sunset phase
`Env_map01_lv007_art`. mission `e3m5` (Undying Cinders) swaps two gated prefab entities (and the sky
vortex meshes):

- before completion: `…_2800000002_envvolume` adds two local boxes.
- after completion: `…_2800000003_envvolume` adds a level-wide priority-300 prism with
  `Env_map01_lv007_art_overcast_brightness` (grey overcast) plus local brightness boxes.

## blending at the camera

the environment manager visits applicable volumes containing the camera in ascending priority,
blending each phase's active sections by a factor:

- **none (0)**: 1 inside.
- **distance (1)**: `min(insideDistance / blendDistance, 1)` (global volumes: 1). unverified: for
  prisms, inside distance is the minimum of 2D edge distance and top/bottom distances.
- **time (2)**: ramps up over `fadeInDuration` while inside, down over `fadeOutDuration` after
  leaving. unverified: a single-frame camera move over 5 m (teleports, level switches) snaps fades.
- **manual (3)**: script-driven factor.

unknowns: tie-breaking among equal-priority volumes, and plain-field lerping (integers/enums,
`<effect>PitchYaw` + modes + resolved `rotation*` quaternions, and negative vs positive fog
`rayleighScatteringScale`).

per-section lerp special cases:

- **clouds**: panorama crossfades through `cloudFadeAlpha` (old fades out to ½, new fades in after).
  one-sided clouds fade in by the factor with that side's texture. `drawCloudAfterPlanet` blends as
  a weight. [cloud shadows](lighting.md#cloud-shadows) crossfade through alpha when both sides
  enable them with different textures, placement, or flow, and lerp otherwise.
- **height-fog flow noise**: see [flow noise](sky-and-fog.md#flow-noise).
- **lens flare**: one-sided flare fades in by the factor. unverified: two flares cross through
  nothing at ½ without blending.
- **snow**: between enabled and disabled, intensity fades to/from 0 using the enabled side's
  settings.
- **rain**: wetness blends as under [wetness](#wetness); falling-rain transitions are unrecovered.

## activation

chunk volume rows have no enable field; story-state volumes (night, battle, destroyed-town) are
stored identically to permanent ones. `EnvironmentEnable` script actions control LevelData
[dynamic volumes](#weather), not chunk volumes. what toggles story-state chunk volumes is unknown,
and names (`night`, `zhandou`, `fight`, …) produce both false positives and false negatives.

examples of story-state chunk volumes outranking a level's base look:

- map01 The Hub: a map-wide night volume (priority 320) and a destruction-state volume (priority
  300, time blend, matching the base outline) both outrank the regular volume (200).
- map02 Snowy Forest: a night-named level-wide volume (priority 300; daytime sun with red fog,
  quest-only) outranks the global volume (200).

map02 Si's Painting contains several disjoint painting worlds, each with its own priority-200 global
volume.

## wind

`windConfig` drives `_WindGlobalParams0`, set per camera by the wind manager:

- `.x`: main intensity = `speed · 0.25` (`speed` in m/s; 5–30 in map02).
- `.y`: wind clock, advancing each gameplay update by `prevIntensity · 0.08 · dt` (`speed · 0.02`/s
  steady).
- `.zw`: `direction` X and Z, where `direction` is the unit vector from `horizontalDirectionAngle`
  (degrees from +Z toward +X) and `verticalDirectionAngle`.

the previous frame's values stay in `_LastWindGlobalParams0` for motion vectors.
[swaying cloth](materials.md#swaying-cloth) reads these parameters. the same update scrolls a
wind-noise UV against `direction` by the clock step (`_WindGlobalParams2`), and local wind motors
feed additional parameters (neither described here).

## weather

rain and snow live in `rainConfig` and `snowConfig` and blend with the rest of the phase.
precipitation is active at `intensity` when enabled, else 0; water sensors react to rain only where
the sky is exposed. there is no independent weather schedule: `ChangeEnvironment` is a shipped
no-op, map02 has no `HGTimeOfDayEnvironmentVolume`, and Marker Stone's heavy rain is ordinary
`rainConfig` (no storm mode or thunder).

authored field rules:

- rain/snow requires all three of `m_active`, `enable`, and nonzero `intensity` (0–100). inactive
  sections can store `enable = 1, intensity = 100`, and disabled sections can keep nonzero
  `intensity`.
- wetness (`enableWetness`, `wetness`) is independent and can stay on in dry phases.
- art-named phases carry weather too (e.g. Marker Stone dam-area art phases enable heavy rain on the
  lake islet and disable it at outposts); phase names do not indicate weather state.
- `rainConfig` also stores falling-rain look parameters (not detailed here): speed, streak length,
  horizontal rain level, far-rain alpha multiplier, rain-wave alpha, screen-drop count, and splash
  count (e.g. `5.85, 1.11, 0.22, 0.58, 0.97, 5, 1000` on the lake islet; `6, 0.7` and zeros in
  `Env_map02_lv003_xiaozuquan_01` at intensity 50).

in map02 chunk volumes, `rainConfig` is active in over ⅓ of phases (~2 dozen enable rain) and
`snowConfig` in a few dozen (nearly all enabling snow, some at intensity 0):

| phase                                | section | enabled | intensity   | volume                                      |
| ------------------------------------ | ------- | ------- | ----------- | ------------------------------------------- |
| `env_map02_lv004_daba7_huxindao`     | rain    | yes     | 100         | lake islet, priority 400, distance blend    |
| `env_map02_lv004_daba7_JUDIAN1`      | rain    | no      | 87.4 stored | outpost, 410, time blend; wetness on at 0.7 |
| `env_map02_lv004_daba7_banshichunei` | rain    | yes     | 20          |                                             |
| `Env_map02_lv009_global_bake_2`      | snow    | yes     | 20          | Snowy Forest's global volume, 200           |
| `Env_map02_lv009_forest_bake`        | snow    | yes     | 60          | forest, 300                                 |
| `Env_map02_lv009_cave_snowoverride`  | snow    | no      | 40 stored   | two caves, 340                              |

weather uses two mechanisms:

- **spatial overrides**: ordinary chunk volumes enabling/disabling precipitation (e.g. Marker Stone
  lake islet and dam stairs; Snowy Forest snow with dry cave overrides).
- **dynamic volumes**: LevelData's environment-volume table (phase path, bounds, transform,
  priority, blend mode, fades), loaded/unloaded by volume id via `EnvironmentEnable` script actions.
  these never appear in chunk data; several exist in map02 LevelData (not a full census).

example — Marker Stone dam outpost (`map02_lv004_lv_data_sub_f1m19d2`): two dynamic volumes share
one 6-point, 100 m tall polygon applying `DynamicEnvironment/env_map02_lv004_daba7_JUDIAN_rain`
(rain on, intensity 25.7, time blend) over the dry outpost's priority 410 — priority 420 (2 s
fade-in) and priority 440 (instant fade-in), both with 8 s fade-out. a level script enables one
(plus rainy audio) when the leader enters a 210 m trigger or finishes a dialog during quest
`f1m19d2_q` step 10 or 11 while `bRainy` is true, choosing by `bFirstRain`; a custom event enables
the first without the quest check. leaving the trigger or a stop event disables both and restores
sunny audio. the script starts manually and sets neither property in the file; how it starts and
initialises them is unknown.

### wetness

deferred lighting wets all deferred surfaces (excluding forward-shaded glass and effects) from the
blended `rainConfig`, whether or not rain falls. this is separate from the water-wetness mask and
per-material porosity used by [wetness decals](materials.md#wetness-decals).

- **blend**: when both sides set `enableWetness`, fields lerp. when only one side sets it, the
  result uses that side's settings with `wetness` fading from 0.
- **coverage**: full within the rain occlusion range (`max(|Δx|, |Δz|)` from the camera), fading to
  `farSceneWetnessValue` by `farSceneWetnessDistanceFactor × range`. sheltered surfaces take
  `baseWetnessLevel`; vertical faces take `verticalWetnessScalar` vs 1 for upward faces.
- **porosity**: `saturate(smoothness · wetnessPorosityFactor + wetnessBasePorosity)` (1 for metal).
  porous non-metal, non-down-facing surfaces darken albedo down to ¼ at `wetness = 1`. smoothness
  rises toward `mix(0.9, 0.6, porosity) + mix(−0.6, 0.4, √smoothness)`, capped at 0.99 and never
  lowered.
- **standing water**: when `rippleRoughnessMaskThreshold > 0` (high-quality wetness), flat
  upward-facing ground with high material occlusion turns its normal straight up and cuts roughness
  to 0.1 (near mirror for SSR), fading out over 15–80 m view depth.

a top-down rain occlusion depth map (shared with snow, 100 m extent;
[quality settings](quality-settings.md#values-by-level)) keeps sheltered surfaces at
`baseWetnessLevel`. the coverage range comes from an unlocated rain presetting asset (inferred to
equal 100 m). the shader also breaks up coverage edges with 3D jitter noise, adds animated rain
ripples (ripple normal atlas + wave term), splashes, wall streaks, and floods normal-mapped dips via
a geometric-flatness test. Marker Stone's dam-side volumes keep wetness at 0.5–1 in both dry and
rainy phases.

## open

- what switches story-state chunk volumes, their initial states, and which volumes are permanent vs
  story state.
- falling-rain transitions between enabled and disabled sections.
- quest-driven weather: what starts dynamic-rain level scripts, how their properties are
  initialised, and whether lake-islet / Snowy Forest cave boundaries are purely spatial in game.
- where `volumeType` 4 (cylinder) stores its shape.
- tie-breaking order among equal-priority volumes.
- whether a local post `Volume` replaces or layers over the level's global one.
- plain-field lerping: integers, enums, effect directions, and deferred fog Rayleigh scale.
- exact behavior of cloud flow, `skyMaterialType`, `reflectionType`, `useCustomIVDefaultSH`, and
  `heightFogConfig.enableVolumetricFog` ([environment phases](#environment-phases)).
