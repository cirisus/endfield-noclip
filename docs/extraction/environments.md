# packing environments

how `pack` converts [environment phases and volumes](../game-data/environment.md) into the package's
environment table ([environments](../package-format.md#environments)) and picks each level's base
environment.

code: [hg/environment-phase.ts](../../packages/formats/src/hg/environment-phase.ts),
[game/environment.ts](../../packages/extractor/src/game/environment.ts),
[pack/tables/environments.ts](../../packages/extractor/src/pack/tables/environments.ts).

## sections

the extractor reads these `HGEnvironmentPhase` sections (`ENVIRONMENT_SECTIONS`) and renames them in
the package:

| phase field           | package key     |
| --------------------- | --------------- |
| `lightConfig`         | `light`         |
| `skyConfig`           | `sky`           |
| `atmosphereConfig`    | `atmosphere`    |
| `fogConfig`           | `fog`           |
| `heightFogConfig`     | `heightFog`     |
| `volumetricFogConfig` | `volumetricFog` |
| `cloudConfig`         | `cloud`         |
| `windConfig`          | `wind`          |
| `lightShaftConfig`    | `lightShaft`    |
| `colorGradingConfig`  | `colorGrading`  |
| `autoExposureConfig`  | `autoExposure`  |
| `shadowConfig`        | `shadow`        |
| `celestialConfig`     | `celestial`     |
| `starConfig`          | `star`          |
| `rainConfig`          | `rain`          |
| `lensFlareConfig`     | `lensFlare`     |

the `light` section omits fields the game derives from others (`DERIVED_LIGHT_FIELDS`: precomputed
intensities, `forwardDirect`, `localToWorld`, and effects' `rotation*` quaternions), which can be
stale ([sun](../game-data/lighting.md#sun)).

to add another section (`snowConfig`, `volumetricCloudConfig`, …), update `ENVIRONMENT_SECTIONS` and
`mapSections` in `environment-phase.ts`, `SECTION_KEYS` in `pack/tables/environments.ts`, and the
interface in [package-format/src/environment.ts](../../packages/package-format/src/environment.ts).

### values

section values keep the game's field names. colours stay raw (no sRGB decode; HDR values exceed 1),
matching how shaders read them. `SphericalHarmonicsL2` is stored as 27 channel-major floats. `m_*`
editor fields, `*ForEdit` previews, and object references other than textures, materials, and lens
flare data are dropped.

- **textures**: converted to texture-table ids. in practice these are the sky reflection cubemap
  (BC6H), cloud panorama, cloud flow map, cloud-shadow texture, and lens flare images.
- **materials (celestial bodies)**: flattened to shader name, keywords, shader-declared float and
  colour properties (material value or declared default; leftover properties from earlier shaders
  are dropped, matching the [material table](../package-format.md#materials)), and texture-table ids
  with scale/offset per declared slot.
- **lens flares**: `LensFlareDataSRP` references expand to their element list
  ([lens flare data](../extraction.md#asset-classes)), with each image as a texture-table id.

the pipeline's `HeightFogFlowNoise` texture ([flow noise](../game-data/sky-and-fog.md#flow-noise))
is packed once as `flowNoise` on the environment table.

## blend schema

the environment table's `schema` tells the viewer how to blend each section field between phases.
the extractor builds it from TypeTree types (`plainKinds` in
[unity/plain-object.ts](../../packages/formats/src/unity/plain-object.ts)), merged across all packed
phases:

- floats, colours, vectors, SH: lerp
- booleans, strings, references (textures, materials, lens flares): switch at ½
- integers: round, except fields named `…Mode` or `…Type`, which switch (assumption: Unity
  serializes C# enums as plain integers without type info)

## volumes

`loadSceneVolumes` deduplicates volumes across overlapping cell chunks by object id.
[endfield/environment-volume.ts](../../packages/formats/src/endfield/environment-volume.ts) decodes
the component, rotating prism points by yaw and making them absolute (untested on real data: every
map02 volume stores yaw 0).

volumes are read from the default stream area's chunk files across all scene states. each volume is
filed in a visibility group (owning level + loading condition;
[scene states](../game-data/environment.md#scene-states)): states are unioned across every chunk
file holding the volume, and any appearance in state 0 makes it unconditional.

problems logged to `debug/environments.json`: volumes dropped for shape or unknown blend mode,
volumes kept without a readable phase, unreadable phase references, ray-traced planets missing their
material or textures, and a missing flow noise texture.

not packed:

- cylinder volumes (`volumeType` 4): only global, box, and prism shapes are supported
- prefabs containing a prism volume under a non-identity placement: all of that prefab's volumes are
  skipped and logged in `debug/unsupported-prefabs.json`
- LevelData's dynamic `environmentVolumes` (framed and skipped by the interactives reader)
- local post `Volume`s (read, but only global ones become post profiles)

each packed volume with a phase gets an `environmentVolume` scene control required by its visibility
group. it defaults on, except for manual-blend volumes (`blend.kind === 'scripted'`), whose scripts
aren't followed ([activation](../game-data/environment.md#activation)).

a scene with no levels gets an empty environment plan.

## prefab volumes

the packer detects [prefab volumes](../game-data/environment.md#prefab-volumes) by component (an
`HGEnvironmentVolume` MonoBehaviour on an active GameObject), not by the
`P_lightingDeco_<entity id>_envvolume` name.

a box volume's transform composes placement and ancestor rotations and scales per axis rather than
via matrices (exact for the unrotated or uniformly scaled hierarchies authored). embedded phases
pack like chunk phases. the level base vote counts a prefab volume only if its placement's
visibility holds under the [default scene values](scene-controls.md#defaults).

## the level's base environment

the game has no per-level base environment, so `resolveLevelEnvironment` derives one volume per
level (stored in `LevelInfo.environment`) to seed the viewer's blend. it samples a 32 m grid (4 × 4
per 128 m cell) over the level's `levelGrids`, considering only volumes owned by that level that
load under default scene states:

1. at each sample, find the topmost volume whose 2D footprint contains the point (boxes tested at
   their centre height), ordered by `compareVolumes` in
   [`package-format/environment-volumes.ts`](../../packages/package-format/src/environment-volumes.ts)
   (its equal-priority tie-breaker is an assumption).
2. pick the volume covering the most samples among those that win at least once (lower priority wins
   ties). a volume beaten everywhere cannot be the base.
3. if none wins, fall back to the scene's global volume.

the vote is 2D on footprints and treats every loaded volume as enabled
([activation](../game-data/environment.md#activation)).

at runtime, the viewer seeds its blend with every section of the base phase (including inactive
ones), then applies the scene's global volume over it like any other. a section therefore resolves
to: level active → global active → level inactive (assumption: game behavior when no active phase
sets a section is unknown). `composeEnvironment` records these per-section sources in
`debug/environments.json`.

each level's post profile (`LevelInfo.environment.post`) is its own global `Volume`, or the scene's,
highest priority first. its `Bloom`, `GTAmbientOcclusion`, `Vignette`, and
`ScreenSpaceReflectionVolume` components become a `posts` entry. `toPlainObject` strips
`overrideState` and keeps authored values, so unoverridden parameters use their authored value
rather than the component default or a lower-priority volume
([status](../status.md#lighting-and-post-processing)).

the pack report lists each level's base volume, coverage, where it wins, and inherited sections.
`scene env` explains the vote over the same chunk and prefab volumes (marking prefab ones), and
`scene env <scene> --at x,y,z` shows the volume stack at one point.
