# quality settings

how the PC client maps a quality preset to render settings, plus per-tier values. topic pages
describe PC high (level 4000): [shadows](lighting.md#shadows),
[screen-space reflections](lighting.md#screen-space-reflections),
[streaming layers](world.md#streaming-layers), [texture streaming](world.md#texture-streaming),
[fog](sky-and-fog.md#fog), [post-processing](post-processing.md).

## from preset to settings

settings ship as TextAssets in the initial bundles:

1. **device score (`SettingRules`)**: scores GPUs by name — 500 (RTX 3080 / 4070 / RX 7800+), 400
   (RTX 3070 / 4060 / RX 6800 / 7600), 300 (RTX 3060 / RX 6600–6700), down to 0; unlisted desktop
   GPUs score 100.
2. **level (`WindowsPlayer_QualityMap`)**: maps the five user presets to a level by score:

   | score    | very low | low  | medium | high | very high | default    |
   | -------- | -------- | ---- | ------ | ---- | --------- | ---------- |
   | 500      | 1000     | 2000 | 3000   | 4000 | 5000      | 5000       |
   | 400      | 1000     | 2000 | 3000   | 4000 | 5000      | 4000       |
   | 300      | 1000     | 2000 | 3000   | 3500 | 5000      | 3500       |
   | 200, 100 | 1000     | 2000 | 3000   | 4000 | 5000      | 2000, 1000 |
   | 0        | 1000     | 2000 | 3000   | 3500 | 4000      | 1000       |

3. **tier components (`WindowsPlayer_QualityTierComponent`)**: per level (5000..1000), sets the
   global tier and per-feature tiers (shadows, reflections, AO, scene detail, grass sparsity,
   environment rendering, volumetric fog, volumetric clouds). missing components inherit from the
   nearest level (upward or downward per component). on PC every tier equals its level, except:
   - 5000 has no shadow or AO component (inherits 4000).
   - grass sparsity caps at 2000 from 2000 up.
   - environment rendering caps at 3000 from 3000 up.
4. **INI sections (`HGRenderPipelineSettings`)**: loads `CommonSettings`, then platform settings
   (`DesktopSettings`; also `MobileSettings`, `ConsoleSettings`, `CinematicSettings`). `[Feature@N]`
   applies at tier `≥ N`, higher overriding lower; client defaults fill omissions.
   feature-to-section mapping:
   - shadows → `ShadowMap`
   - reflections → `SSR`
   - AO → `GTAO`, `VisibilitySH`
   - scene detail → `Streaming`, `ArtTags`
   - grass sparsity → `Grass`
   - environment rendering → `RainAndWetness`, `VerticalOcclusionMap`
   - volumetric fog / clouds → `VolumetricFog`, `VolumetricCloud` (assumed)
   - everything else → global tier

## values by level

desktop values; blank cells repeat the cell to their left.

| setting                                                                 | 1000   | 2000      | 3000             | 4000               | 5000      |
| ----------------------------------------------------------------------- | ------ | --------- | ---------------- | ------------------ | --------- |
| reflections: march steps (`ssrRayMarchingSampleCount`)                  | off    | 16        | 32               |                    | 128       |
| reflections: upsampled to full size (`ssrV2Upsample`)                   | no     |           |                  |                    | yes       |
| cascade tile (`CSMTileResolution`)                                      | 1024   |           | 2048             |                    |           |
| cascade reach, fade start (`CSMMaxDistance`, `CSMFadeInnerDistance`), m | 40, 30 | 50, 40    | 60, 50           | 80, 60 (from 3500) |           |
| character shadow map                                                    | 512    |           | 1024             |                    |           |
| local-light shadow tile (`PunctualLightTileMaxSize`)                    | 512    |           | 1024             |                    |           |
| contact shadows                                                         | off    | on        |                  |                    |           |
| GTAO slices × steps (`GTAOQualityLevel`)                                | 2 × 2  |           | 3 × 3            |                    |           |
| visibility SH range scale                                               | off    | 2         | 3.5              | 5                  |           |
| grass sparsity (`GrassGlobalSparsity`)                                  | 0.8    | 1         |                  |                    |           |
| terrain parallax (`TerrainPOM`)                                         | off    | on        |                  |                    |           |
| erosion blend                                                           | off    |           | on               |                    |           |
| volumetric fog cell (`gridPixelSize`), px                               | off    | 16        | 8                |                    |           |
| volumetric fog source cap (`maxSourceRT*`)                              | —      | 1920×1080 |                  |                    | 2560×1440 |
| volumetric fog samples where history misses                             | —      | 8         | 16               |                    |           |
| local-light shadows in the volumetric fog                               | —      | no        |                  | yes                |           |
| cloud downscale (`downResRatio`), march step scale                      | 2, 2   | 2, 2.5    | 2, 3             |                    | 1.5, 3    |
| light shaft downsample                                                  | 4      | 2         |                  |                    |           |
| lens flare occlusion samples                                            | off    | 8         |                  |                    | 32        |
| rain lighting (`EnableRainLighting`)                                    | off    |           | on               |                    |           |
| water prepass texture                                                   | —      | 512       | 1024 (from 2500) |                    |           |
| effect LOD setting (`settingLodLevel`)                                  | 1      |           | 2                | 4                  | 8         |
| factory entity cull distance, m                                         | 60     |           | 80               |                    | 100       |

the 2000 cells of the last two rows are inherited (direction unchecked). crowd caps (spawned /
rendered): 80 / 50 at 4000, 50 / 50 at 2000, 40 / 40 at 1000.

**volumetric fog grid size**: at most `maxSourceRT / gridPixelSize` cells (`240 × 135` at high),
each cell `max(gridPixelSize, ceil(renderSize / cap))`, with `gridSizeZ` (128) depth slices — e.g.
`240 × 135 × 128` at 1920×1080 and `233 × 134 × 128` at 2560×1600 at high.

constant across all desktop levels:

- **resolution**: native render scale with temporal upsampling (history weight 0.95, 0.85 in motion;
  sharpen 0.3); DLSS, FSR, and lower render scales are user options. scene colour copy is full size.
- **shadows**: 3 cascades split at 0.15 and 0.375 of reach (12, 30, 80 m at high), 2×2 atlas, 16-bit
  depth, hardware depth/normal bias 3, re-rendered every frame (cascade cache off, no occlusion
  culling), caster screen-size skips 0.005 / 0.01 / 0.02. far map: 800 m, 256² tiles, ≤ 8
  tiles/frame, skip < 0.01. shadow views use camera LODs (no shadow LOD), shadow proxies on, sun
  shadow resolved to screen-space mask. local-light shadows within 200 m: 40 cached static tiles +
  up to 6 still and 2 moving per-frame dynamic tiles
  ([local light shadows](lighting.md#local-light-shadows)).
- **reflection march**: step count decays with depth by `clamp(2 · e^(−0.07 · depth), 0.125, 1)` to
  a floor of 32 (only very high's 128 steps vary: full to ~10 m, floor by ~30 m).
- **local lights**: max 256 per frame (`PunctualLightMaxCount`; 32 on mobile).
- **culling**: no main-view small-object cull (`CullingViewScreenSizeMin` 0); CPU software occlusion
  culling at 320×160 against authored occluders; GPU-driven grass off.
- **LOD**: LOD streaming off; terrain LOD factor 1200.
- **reflections**: planar reflection stand-ins on; ray-traced reflections off by default (user
  toggle).
- **reflection probes**: 512² octahedral, ≤ 3 updated per frame.
- **rain occlusion map**: 512², 100 m extent.
- **post**: bloom quality 2, DoF quality 1, motion blur on, anamorphic streaks 0.5 (0.3 at 1000),
  chromatic aberration from 2000 up.

## open

- how shadow maps measure caster screen size, and whether characters skip cascade 3
  (`CSMStopRenderCharacterCascade` 2).
- whether software occlusion culling runs on PC, whether map data holds its occluders, and what its
  size threshold (0.05) gates.
- whether the client's GPU-driven meshlet renderer is ever enabled (appears gated by launch
  switches).
- volumetric fog history weight, and cloud downscale's meaning (per-axis inferred from name).
- how LOD bias enters the screen-size test.
