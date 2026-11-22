# open-world water

open-world water combines surface placements, per-surface `WaterConfig` assets, and a scene-wide
`Global_Water_Config`. gameplay [water volumes](#water-volumes) and [WaterDecal](#waterdecal) foam
boxes render through the same pipeline. see [scene-states.md](scene-states.md) for scene states,
[lighting.md](lighting.md) for shared lighting, and [effects.md](effects.md#waterfalls) for
waterfall sheets.

three sources join per surface: an InitChunkData placement row, a StreamingChunkData record (same
entity id) binding mesh and `WaterConfig`, and a per-level object binding `Global_Water_Config`.

## placements: InitChunkData component 30

all water surfaces live in **Global** chunks (never cell chunks), so water is always resident.
groups carry bounds columns 0–5, 24-byte column 7 (generic render-object info: layer mask, flags,
scene mask, art tag, squared sorting distance), name column 21, and 104-byte component 30:

| offset | type   | field            | notes                                                                              |
| ------ | ------ | ---------------- | ---------------------------------------------------------------------------------- |
| 0      | u32    | render type mask | `HGWaterRenderType` bits: 1 proxy, 2 LOD (below)                                   |
| 4      | i32    | runtime mesh id  | always 0 (filled at load)                                                          |
| 8      | f32×16 | object-to-world  | column-major, translation at floats 12–14                                          |
| 72     | f32×4  | param0           | `(materialIndex, 0, 0, 0)`; filled at load from bound config                       |
| 88     | f32×4  | param1           | `(wetnessOffset m, heightLayer 0–3, sortByDistance 0/1, wetSurroundingGround 0/1)` |

every shipped row has a nonzero mask, finite values, and both bindings. map02's LOD surfaces are
open water; proxy-only surfaces are mostly paddy-field pools. `wetnessOffset` raises the surface
when darkening contacted ground.

surfaces have no materials of their own: the pipeline draws them with `HGRP/WaterProxy` and
`HGRP/WaterRendering`, indexing configs by `materialIndex`. level tag is `id >>> 27` (0 = shared
across all levels). surfaces in scene-state-0 files always load; others load with any matching
MapConfig scene state (e.g. map02 paddy-field pools).

### how surfaces are drawn

- **mesh pass**: every camera-visible surface draws into the water G-buffer using its own mesh
  normals.
- **LOD grid pass**: LOD surfaces also render top-down into the height layer named by `param1.y`,
  writing oct-encoded world normals (`_WaterPrepassNormalTexture`). near the camera, a
  camera-centred grid reads those normals and displaces vertices by waves, preserving steep mesh
  slopes (e.g. falls).
- **stencil split**: the grid draws first and writes stencil `3`; the mesh pass draws only where
  stencil ≠ `3`, so near water uses the grid and far water uses the mesh (exact grid extent
  unrecovered, see [`Global_Water_Config`](#global_water_config)).
- **state (from pass states, unchecked in game)**: both passes cull back faces, depth-test
  `LessEqual`, and write depth.

## bindings: StreamingChunkData

the paired `StreamingChunkData_*` file holds a kind-2 record per surface id with u64 StringPathHash
bindings (property type 15):

| key          | binds                                                                                   |
| ------------ | --------------------------------------------------------------------------------------- |
| `0xff000000` | surface mesh                                                                            |
| `0xff010000` | surface `WaterConfig` MonoBehaviour                                                     |
| `0x20000000` | scene's `Global_Water_Config`, on a kind-1 object named `Water#<tag>_…` (one per level) |

keys encode `component << 24 | field << 16 | index`. component `0xff` is archetype-specific (e.g.
rect decals bind materials on `0xff010000`), so these keys are water bindings only on entities with
component 30. `0x20` is `HGWaterGlobalConfig`.

## surface meshes

| mesh                                                          | transform                                 | notes                                 |
| ------------------------------------------------------------- | ----------------------------------------- | ------------------------------------- |
| `com/water/models/s_waterquad.fbx`                            | scales 0.1 m quad to surface size         | 4 vertices, uv0                       |
| pipeline `plane.fbx`                                          | scales 0.1 m Unity plane                  | 121 vertices; paddy fields            |
| `<map>/water/water_<map>_pcgwater…_lod0.fbx`, `s_river_*.fbx` | mostly identity (authored in world space) | river meshes, uv0                     |
| `<level>/Water/PolygonMeshes/S_polygon_water_*.asset`         | identity                                  | flat world-space polygons, **no UVs** |

shading operates in world `(x, z)`, so only positions are required. some polygon meshes contain
downward-facing normals.

## surface `WaterConfig`

one MonoBehaviour per water look (`…/WaterData/WaterConfigs/Config_water_<Map>_<n>.asset`, plus
shared `Config_paddy_filed_water.asset`):

- **flow & waves**: `useFlowMap`, `flowDirectionVector2`, `flowSpeed`, `flowFullCycle`,
  `normalTilling`, `normalScale`, `smallWaveNormalType`, `largeWaveNormalType`,
  `largeWaveFlowSpeed`, `largeWaveNormalTilling`, `largeWaveNormalScale`, `flowFullCycleLarge`,
  `largeWaveInvDir`, displacement scalers.
- **optics**: `waterRayleighScatteringMeter`, `waterRayleighAbsorptionMeter`,
  `waterRayleighAbsorptionMeter2`, `absorptionTint(2)`, `scatterTint`, `absorptionScale`,
  `scatterScale`, `safeFullAbsorpDistance`, `envLightIntensity`, `sceneColorEnvInfluence`,
  `rayleighMieLerpFactor`, `distanceEdgeBlendFactor`.
- **appearance**: `roughness`, `specular`, `waterIOR` (screen-space distortion strength, not
  physical IOR), `flowBaseColor`, `foam*`, `distanceFade`, `envLightSpecularIntensity`,
  `punctualLightSpecularIntensity`, `emissiveStrength`.
- **caustics**: `causticTilling`, `causticOpacity`, `causticDistort`, `causticSpeed`,
  `causticStartDepth`, `causticEndDepth`.
- **interaction**: `interactive*`, `ripple*`.

**slot collisions**: each surface binds its config via StreamingChunkData, not
`Global_Water_Config.hgWaterConfigs` (which omits the paddy config, whose `materialIndex` collides
with another config). at load, the game uploads each config into static slot `materialIndex` (32
slots total); colliding indices overwrite each other so both shade with whichever loaded last.

## `Global_Water_Config`

one per scene with water (`…/<Map>/ReleaseData/WaterData/Global_Water_Config.asset`), referenced by
every level's `Water#<tag>_…` object:

| field                                                                           | meaning                                                                                                                                                                |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sceneCenterOffset` `{x, y}`                                                    | world `(x, z)` grid centre                                                                                                                                             |
| `mapSize`                                                                       | global flow map / sector grid edge length (m)                                                                                                                          |
| `sectorSize`                                                                    | single sector edge length (m)                                                                                                                                          |
| `flowmapPrecision`                                                              | metres per texel of sector flow tiles                                                                                                                                  |
| `useSectorData`, `sectorDataPaths`, `sectorDataAssetHashes`, `sectorDataExists` | parallel arrays over sector grid cells                                                                                                                                 |
| `hgWaterConfigs`                                                                | PPtrs to surface configs (incomplete, see above)                                                                                                                       |
| `flowMap`                                                                       | global 2D flow map, linear BC7, 1 mip                                                                                                                                  |
| `causticMap`                                                                    | caustic pattern, sRGB BC7                                                                                                                                              |
| `rainMap`                                                                       | rain ripple map, linear BC7                                                                                                                                            |
| `normalMapArray`                                                                | 2-layer wave normal `Texture2DArray`, linear BC7                                                                                                                       |
| `lodNum`, `meshNumPerLOD`, `meshSize`, `heightMap*`                             | camera-centred LOD grid (map02: 4 rings of 16² × 2 m cells), displaced by `waveVertexDisplacementScaler` (mostly 0 on map02); top-down prepass view bounds unrecovered |

**sector tiles**: present where `sectorDataExists` is set. path `…/Sector/T_<x>_<z>.asset` gives
`(x, z)`; `sectorDataAssetHashes` stores signed i64 StringPathHash keys. sector `(x, z)` spans
`[center.x + x·sectorSize, +sectorSize) × [center.z + z·sectorSize, +sectorSize)`. each sector's
`waterSectorTexture0` (256², linear BC7, 1 mip) stores flow at `flowmapPrecision`, though some
flagged sectors leave it null (a handful on map01, ~2 dozen on map02). near the camera, the shader
samples sector tiles and blends to `flowMap` at the edge of a 3×3 sector window (lookup assumes 128
m sectors, map02's size).

## shading

water writes normal, roughness, and foam to its own G-buffer before SSR, then shades in a
full-screen pass after opaques using sun + shadows, [irradiance volume](irradiance.md), and sky/SSR
reflections.

- **flow**: global map at `uv = (world.xz − center) / mapSize + 0.5` stores direction in `rg`
  (`· 2 − 1`, green negated → `−z`), foam in `b`, wave amplitude in `a`. without `useFlowMap`,
  `flowDirectionVector2` uses the same encoding. `a` scales waves unless `FlowmapOption == 1`
  (coverage; unused on map02).
- **waves**: two normal-array layers (`rg` normal, `a` small-layer foam shape) with independent
  tiling, speed, and cycle (`largeWaveInvDir` reverses large layer). with a flow map, each
  cross-fades two cycle-offset phases; without one, scrolls continuously. sampled with mip bias
  `(0.5 − envSpecularDesaturation) · 10`. fade
  `1 − saturate(distance · saturate(1 − N·V) / distanceFade)` attenuates small waves (also `× N·V`)
  and large waves down to `distanceNormalMinStrength`. layers combine via reoriented normal mapping
  around the mesh/grid normal.
- **roughness & foam**: roughness interpolates from config toward 0.01 as fade rises, and toward
  `foamRoughness` under foam. foam = `flow.b × smallFoamShape / foamShapeOffset × foamOpacity`,
  fading over `foamFadeDistance`, coloured by authored `foamColorG`. lit by diffuse sun, backlit
  transmission (`waterBaseColorSubsurfaceScaler`), irradiance volume, and `emissiveStrength`.
- **refraction**: offsets sample point laterally against waves (`xz × waterIOR`, max 0.5 m, reduced
  near screen edges and camera) and reads scene behind unless it lies in front of the water. column
  direction and thickness follow the refracted ray (beyond ~20 m, depths under ~0.5–1 m keep
  straight-through thickness).
- **water column (max 50 m)**: per-metre absorption blends `waterRayleighAbsorptionMeter2` (shallow)
  → `waterRayleighAbsorptionMeter` (deep) toward `safeFullAbsorpDistance`. in-scattering integrates
  over the column with slant-lengthened extinction (`1 + 1.394 |V.y|` ambient; `1 + 20 |V.y|` risen
  sun). sources: irradiance volume (`× envLightIntensity`), shadowed sun (raw colour × intensity;
  shadow sampled 2 m off surface along horizontal wave tilt for dappling; phase mixes
  Henyey-Greenstein `g = 0.854` to Rayleigh via `rayleighMieLerpFactor`, attenuated at grazing
  incidence), plus scene behind (`× sceneColorEnvInfluence`).
- **caustics**: `causticMap` projected planar in world `xz` on underwater ground (twice, second
  mirrored in `z`, wave-distorted), brightening scene behind by fog sun × `causticOpacity` between
  `causticStartDepth` and `causticEndDepth`, fading out by 50 m view depth.
- **sun highlight**: GGX using normal with vertical component scaled by `dirSpecNormalScaler`, aimed
  at nearest point on sun disc, times sun specular intensity, plus multiple scattering.
- **reflection**: runs through [screen-space reflections](lighting.md#screen-space-reflections) (ray
  stretched to screen edge, no metre cap, with edge/head-on fades). misses fall back to sky
  reflection (normalised as on opaque surfaces, scaled by `envLightSpecularIntensity`), weighted by
  environment BRDF (`f0 = 0.08 · specular`, `f90 = saturate(4 · specular)`).
- **fog & composition**: surface light (highlight, foam, reflection, column) fogs at surface
  distance; already-fogged scene behind shows through column transmittance; fog in-scatter covers
  the rest. on SSR hits, colour leans toward reflection by
  `reflectionWeight × columnOpacity × fogTransmittance`.
- **shore**: `distanceEdgeBlendFactor` fades shallow water into background; at distance, thickness
  counts less at grazing angles.

## water volumes

movable gameplay water lives in LevelData `waterVolumes` (and identical `riftVolumes`). present in
map02 (~60 volumes, ~⅕ script-moved), Suiming, one race, three dungeons, and factory puzzle scenes
(`blackbox_*`); absent in map01.

| field                                                      | meaning                                                                                   |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `id`                                                       | entity id referenced by scripts and floaters (`0` = static, builds no mesh)               |
| `pivot`                                                    | volume floor (`pivot.y` = zero height)                                                    |
| `points`                                                   | outline in world space at `pivot.y`; triangulated in `(x, z)` into a flat surface mesh    |
| `heightMax`                                                | metres from pivot to full                                                                 |
| `amountCurrent`, `amountMax`                               | authored fill; surface height = `pivot.y + heightMax · amountCurrent / amountMax`         |
| `isInfinite`                                               | fill is a script-driven 0–1 fraction (`WaterVolumeInfiniteSetHeight`), not a fluid amount |
| `fillSpeed`                                                | fixed-speed rate: m/s (infinite) or amount units/s (finite)                               |
| `flowSpeed`, `flowDirection` (degrees)                     | surface flow                                                                              |
| `isUseLunaConfig`, `lunaConfigPathHash`                    | overrides water type's `WaterConfig`                                                      |
| `waterItemType`, `meshPathHash`                            | liquid type (selects surface prefab) and optional prebuilt surface mesh                   |
| `obbCenter`, `obbRotation`, `obbSize`                      | gameplay OBB (swimming, hazard)                                                           |
| `waterNameLangKey`, `isPrototype`, nav-mesh & audio fields | gameplay metadata; `isPrototype == false` marks [factory water](#depletable-pools)        |

**prefab & config resolution**: `waterItemType` maps via `FactoryItemTable` to `FacItemSubType`
(`item_liquid_acid` 0, `item_liquid_sewage` 3, `item_liquid_water` 4, xiranite 7), then through
`…/GameMech/WaterVolumeManagerConfig.prefab`:

1. `waterTypeToSurfaceDict` remaps borrowed types (Plant2 13 → Plant 2).
2. `waterSurfaceSettingDict` yields `surfacePrefab` (`…/GameMech/WaterVolumeSurface_<name>.prefab`:
   acid, dirty, clear, foliage, xiranite, hyper_xiranite), optional foam `decalPrefab`, and
   per-level flow-cycle / large-wave / displacement multipliers.
3. unlisted or null entries fall back to `waterSurfaceMissingFallback` (water prefab on map02).

each surface prefab holds a `MeshFilter`, `MeshCollider`, and `HGWaterRendererV2` (proxy render type
1, wetness offset 0.25 m, standard `WaterConfig`). mesh comes from `meshPathHash`
(`…/Gameplay/Water/<itemType>#<volumeId>_WaterSurface.asset`, ~half of map02 volumes) or runtime
`(x, z)` triangulation of `points`. `isUseLunaConfig` swaps in `lunaConfigPathHash` (most map02
volumes leave it off). non-default flow speed/direction allocates a dedicated config slot; default
shares the type's slot.

**script actions**:

- `WaterVolumeInfiniteSetHeight`: sets 0–1 fill — instant without `isSmooth`, linear at `fillSpeed`
  with end-ease when `isSmooth + isFixedSpeed`, or timed ease derived from distance and `fillSpeed`
  when `isSmooth` alone (e.g. map02 switch drain at speed 50 takes ~1 s).
- `WaterVolumeSetFillSpeed`: updates `fillSpeed` before a move.
- `WaterVolumeSetAmount`, `WaterVolumeTransfer(All)`: set or transfer finite amounts;
  `…PauseHeightChange` freezes movement.

**script examples**:

- **Marker Stone pit (map02)**: one-use switch `int_switch_wltech01` (`23400083108`) runs script
  `23400083014`, draining volume `23400080003` from full to half.
- **Suiming (`indie_dg016`)**: script `46300000013` reads server-driven map variable `timer`
  (inferred 1 step = 1 minute from stage speeds) and lowers pit `46300000002` (floor `y = 51.19`,
  height `110 m`) in stages (snapping to stage start, then receding at fixed speed):

  | minutes | level (y)                  | speed (m/s) | takes |
  | ------- | -------------------------- | ----------- | ----- |
  | 0 → 2   | 0.50 → 0.37 (106.2 → 91.9) | 0.119       | 120 s |
  | 2 → 5   | 0.37 → 0.31 (85.3)         | 0.0367      | 180 s |
  | 5 → 8   | 0.31 → 0.13 (65.5)         | 0.11        | 180 s |
  | 8 → 11  | 0.13 → 0.07 (58.9)         | 0.0367      | 180 s |

  the adjacent lily-pad pool (`46300010001`) recedes from `y = 107` to `91` over the first few
  minutes; server events drain the pit to 0.08 on solve and reset all volumes.

gameplay waterfalls use component 168 (`InteractiveWaterFallComponent`) to spawn named
waterfall/splash effects bound to a volume; scenery waterfalls are [effects](effects.md#waterfalls)
over river surfaces.

### depletable pools

volumes with `isPrototype == false` are **factory water** (all map02 and `blackbox_*` volumes);
dungeon script-only volumes (`dung02_cdg004`, `dung02_cdg009`, `dung02_cdg013`, `indie_dg016`,
`indie_race001`) are prototypes.

- **server state**: the factory server tracks liquid type and amount, overriding `amountCurrent` on
  report (map reset restores only prototypes). infinite volumes ignore server amounts.
- **pumping & filling**: finite pools drain via Fluid Pumps (`pump_1`: water, sewage, plant,
  xiranite, copper; `pump_2`: also acid; 1 round/s, amount per round unlocated) and fill via Fluid
  Supply Units (which reject sewage). no client code refills a pool; an empty pool's surface stays
  at `pivot.y` (unchecked in game).
- **animation**: surface moves at `fillSpeed · heightMax / amountMax` m/s (e.g. 6 m/s in Test Area
  pits, 0.026 m/s in Wuling City's Tianjing Courtyard pond). client code builds the surface once
  reported by the server and waits until sinking finishes before clearing liquid (unchecked in
  game).
- **child basins**: volumes with `parentId` match their parent's surface height, clamped to their
  own `[pivot.y, pivot.y + heightMax]`.
- **other transfers**:
  - `int_water_volume_transferer(_short)` (component 82: `water_volume_from`, `water_volume_to`,
    `is_do_once`, `progressLockCondition`): pours between volumes (fails if source empty, target
    full, or liquids differ).
  - `int_water_volume_switch` (component 83, `water_volume_inst_id`): Jingyu's two 0.5 m volumes
    (`10100023001`, `10100033001`).
  - scripts: `WaterVolumeSetAmount`, `WaterVolumeTransfer(All)` (map02 scripts only call
    `WaterVolumeInfiniteSetHeight`).
- **events**: changes fire `OnWaterVolumeChanged` (`water_volume`, `value_old`, `value_new`). only
  two map02 scripts listen: Qingbo `23300000064` (after transferer `23300000037` empties
  `23300000004` into `23300000005`, drops infinite `23300000001` to 0.2) and Sword Vault Dale rune
  puzzle `25000060001`.
- **unrelated**: `WaterProgressSync` and `int_switch_water_progress` (component 87) belong to
  water-drone wheels despite colliding ids.

map02 finite volumes (all map02 acid volumes and all lv004/lv010 water volumes are infinite):

| level             | volumes                                                  | role                                                                                                  |
| ----------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| lv005 Test Area   | 23200010000 (Pool 1), 23200010003 (Pool 2), sewage       | pumped; pivots near −462, 251.4, −464 and −502, full at y 263.4; basins 23200010001, …004 follow them |
| lv002 Wuling City | 22800060004, water                                       | Tianjing Courtyard pond, pumped; pivot −797, 240.6, −530; 22800060019 and …020 follow it              |
| lv002             | 22800060005 (0 of 1000, 28 m deep, under pond)           | nothing found filling it                                                                              |
| lv002             | 22800060002, 3, 6–11, 16 (near −830, 268–285, −690…−745) | terrace transferer puzzle, locked until `e5m3_q#3`                                                    |
| lv002             | 22800330000, 1, 6, 7 (near −1465, 314–320, −165…−195)    | short-transferer puzzle (`e5m3_q#3`)                                                                  |
| lv002             | 22800060012, …013, …017 (full)                           | no transferer or quest found                                                                          |
| lv002             | 22800030000 (4 of 45, at −1229, 261.9, 135)              | guide script 22800090011 waits for ≥ 5 poured by supply unit                                          |
| lv003 Qingbo      | 23300000003 (sewage, 800); 23300000004 → …005 (2000)     | no quest found; once-only transferer above, after `e7m1`                                              |
| lv001 Jingyu      | 10100030000–4                                            | transferer puzzles (`e5m1_q#4`, `e5m2_q#22`)                                                          |
| lv006 Sword Vault | 25000060001, 3, 4, 5, 6 (near 330, 220–226, −1850…−1920) | rune-column short-transferer puzzle (`sm2l6m1_q#14`)                                                  |
| lv008             | rift volumes (xiranite, 0 of 5000)                       | filled, not drained                                                                                   |

mission `CheckFluidVolume` conditions (`level, volume, operator, amount`):

| pool                                                            | quest                                                       |
| --------------------------------------------------------------- | ----------------------------------------------------------- |
| Tianjing Courtyard pond, Wuling City (22800060004, 40000, 35 m) | `gm02m10` "Treasure Beneath the Pond", q#2: `≤ 800`         |
| Pool 1, Test Area (23200010000, sewage, 4000, 12 m)             | `gm02m14` "Divvy Up the Trouble", q#2 "Drain Pool 1": `< 1` |

the pond's check is a fallback for q#2 ("Connect the Fluid Pump to the pond"); q#3 ("Wait for the
pond's water to be drained") uses a server-evaluated `≤ 800` progress check naming no volume. "Drain
Pool 1" can also complete via dialog or interactive state. submerged bed content (pond gate, statue
keys, chests; Test Area valve wheels) is always placed — no scene state, script group, load gate, or
`OnWaterVolumeChanged` listener depends on draining. Pool 2 (`23200010003`) drains identically
without a quest.

### floaters

interactives with component 39 (`BelongToWaterVolume`) ride a volume's surface (lily pads
`int_water_volume_floater*`, ice floes, lotus groups):

| key               | meaning                                                              |
| ----------------- | -------------------------------------------------------------------- |
| `water_volume`    | volume id                                                            |
| `lock_offset`     | `(x, z)` offset from volume pivot (`authoredPos − pivot`)            |
| `surface_offset`  | height above surface when following (absent → 0 on checked floaters) |
| `ground_distance` | unrecovered; values near pit floor suggest a minimum height          |
| `is_locked`       | whether it starts locked to the surface                              |

floaters start at their authored height (up to 0.5 m above the surface). once the water moves, they
follow with distance-dependent lag using `surface_offset` (0) instead of their authored height.

## WaterProxy and WaterDecal

no static InitChunkData renderer uses `HGRP/WaterProxy` or `HGRP/WaterDecal`; both arrive via
prefabs, and WaterDecal boxes also via InitChunkData component 31
([world.md](world.md#initchunkdata-layout)): 347 renderer-less entities on map02, each a 172-byte
`HGWaterDecalComponent` row holding a matrix and two `animParam` vectors
(`(tiling, speed, opacity, brightness)` and `(displacement, tint.rgb)`), with pipeline cube mesh and
material in StreamingChunkData. most rows are neutral (all 1); others dim, slow, stop, or tint (e.g.
Si's Painting pool falls `waterdecal_01#10_1115149`: speed 0, brightness 0.535, displacement 0.354).

`HGRP/WaterProxy` contains only water-pipeline passes (top-down prepass, wetness mask, depth, water
G-buffer) and never draws in the main scene pass; a few map02 river meshes carry it
(`M_river_proxy_22`).

### WaterDecal

foam boxes placed at waterfall feet/lips (`Cube` `MeshRenderer` + `HGWaterDecalRenderer`). after the
water G-buffer, pass `WaterDecalDeferred` draws them into the 8-bit foam target (`R8G8B8A8_UNorm`:
`rgb` foam colour, `a` config index), which the water lighting pass then shades (diffuse
sun/ambient, transmission, `emissiveStrength`; [shading](#shading)). boxes therefore appear only on
water pixels, saturating at 1.

each fragment reconstructs world position from `depthWithWater` (copied as water depth) and
transforms it into box-local space:

- **UVs**: `local.xz + 0.5` through `_UVScaleOffset`. switches (`_BaseColorSwitchUV`,
  `_DisturbSwitchUV`, `_MaskUVSet`, `_DissolveSwitchUV`) select: `0` box UVs, `1` polar
  (`angle / 2π`, `2 · radius`), `2` `world.xz / 10`, `3` mesh UV0 (fractional values blend
  neighbours).
- **distortion (`_USE_DISTURB`)**: `_DisturbTex1.r` (UV scrolled by `_DisturbUVSpeed1.xy`, then
  `_ST`, remapped by `_Bi_Disturb`, scaled by `_DisturbU/VIntensity1`, plus an unnamed mip-bias
  parameter) offsets base, mask, and dissolve UVs by their `_…UseDisturb` fractions.
- **mip bias**: base map uses `floor(_MinMipLevel) + floor(_Bias)`; mask uses `floor(_Bias)` (bamboo
  raft wake has `_Bias = 2.3`).
- **colour**: `_BaseColorMap` (UVs scaled by `_ST` × placement tiling, scrolled by
  `_BaseColorSpeed.xy` × placement speed). `a' = _UseAChannelAsAlpha ? a : 1`;
  `colour = (_BaseColor + rgb · a' · _BaseColorTint) · mask` (`_USE_MASK`: UVs rotated about 0.5 by
  `_MaskTexUVRotateMatrix`, `_ST`, scrolled; alpha applied if `_UseMaskTexAsAlpha`). final output
  multiplies by `(1 + a')`, edge fade, `_OverallOpacity`, and placement opacity/brightness/tint.
- **dissolve (`_USE_DISSOLVE`)**: `_DissolveTex.r` at mip `floor(_Bias)` (scrolled, then `_ST`)
  minus `_DissolveScheduleOffset · 2.02 − 1.01` scales colour/alpha and adds
  `_DissolveEmissiveColor` at the edge (same as VFXBaseV2).
- **fades**: `_UseEdgeFade`: `saturate(1 − |abs(uv − 0.5) + _EdgeFadeRange.xy| · √2)` (0 at
  corners). `_USE_SOFTBLEND`: `saturate((saturate(water − face) + _SoftBias) / _SoftDistance)`
  (reversed-Z device depths). `_MeshType != 0` clips outside the box.
- **render state**: fixed premultiplied blend `(One, OneMinusSrcAlpha)` into RGB only; alpha
  `(1 + a') · (1 − _BlendMode)` (all map02 materials set `_BlendMode = 1`, additive foam). stencil
  `Equal 1` on bit 0 (set by water passes). culled by `_CullMode`, depth-tested by `_ZTest` against
  `depthWithWater` without writing depth (`4` LessEqual for most; `5` Greater + front-cull for
  `M_fx_map02_lv001_waterfall_2105_05`, covering all water in front of back faces; `8` Always for
  bamboo raft wake `M_fx_interactive_bambooraft_waterdecal_802`).

`HGWaterDecalRenderer` stores `tilling`, `speed`, `opacity`, `brightness`, `tintColor`,
`displacement` (used by `WaterDecalDisplacement` into the LOD top-down height view), `useSH`,
`anchorOffset`, `enableMovement`, `renderType`, `heightLayer`, `sortingOrder`, and
`waterStreamingType`. all map02 prefab renderers use neutral tiling/speed/opacity/brightness (1) and
white tint; only `displacement` and `enableMovement` vary.

map02 prefab decals use `_BLEND_BASECOLOR`, `_USE_DISTURB`, `_USE_MASK`, plus `_USE_SOFTBLEND`,
`_USE_DISSOLVE`, or `_USE_WATER_EROSION`. other shader variants: `_USE_SEQUENCE_FRAME`,
`_USE_TWO_LAYER_FLOATING_MAP`, `_BLEND_BASECOLOR2`, `_USE_BUBBLE`.

#### water erosion

`_USE_WATER_EROSION` renders the red tide's flowing front over foam. used only by Wuling City's
`M_fxmap_waterdecal_03` on an 810 × 360 m sheet (`S_fx_chichao_2102_1` in
`p_fxmap_map02_lv002_shuiqingshi_03`, shown after The Breach `e9m3`). all textures sample mesh UV0
(`uv`), `t = _Time.y`:

- **noise**:
  `n = _FlowmapNoiseTex.r(uv · _ST + _FlowmapNoiseMovement.xy · t) · _FlowmapNoiseStrength`.
- **flowmap**: `F = _FlowmapTex(uv · _ST + (n · _FlowmapUVNoiseStrength, 0))`; front
  `E = saturate(F · _FlowDistance + n + _FlowOffset)`.
- **gradient**: `G = _FlowGradienteTex` at
  `u = saturate(saturate(uv.x · _FlowDistance + n + _FlowOffset) · _ST.x + _ST.z)`,
  `v = uv.y · _ST.y` (no `v` offset). `F` and `G` always use linear clamp; other textures use linear
  repeat.
- **edge layers (1..3)**:
  `L_i = _EdgeSharpColor_i · saturate(E.{y,z,w} − _EdgeSharp_i) · N_i · G.a`, where
  `N_i = saturate(_FlowGradientNoiseTex_i.rgb)` at
  `uv · _FlowGradientMovement_i.zw + _FlowGradientMovement_i.xy · t` (mip bias −3, ignores `_ST`).
- **colour**: masked foam × `(1 − |F.rgb|)`, layered over by `L₂` (weight `saturate(|L₂|)`), then
  `L₃`, then `L₁`, plus `G.rgb · _EdgeColor · F.r`, then `(1 + a')`, edge fade, and opacities as
  usual (no dissolve).

`M_fxmap_waterdecal_03` sets distortion strengths to 0 and leaves mask unset; its flowmap `_ST`
(`15 × 1.29`, offset `−11.75`) and gradient `_ST` (`300 × 1`, offset `−297.4`) place one front
across `u ≈ 0.78–0.85`.

## open

- clipmap LOD grid extent and top-down prepass view bounds (unrecovered).
- [water volumes](#water-volumes): `ground_distance`, server starting amount vs authored amount on
  depletable pools, whether an empty pool's surface still draws, and confirming the inferred
  1-minute `timer` step.
- [WaterDecal](#waterproxy-and-waterdecal): unnamed distortion texture mip-bias material parameter.
- visual checks against in-game shots: Wuling falls grey-teal vs white, Test Area sewage/acid
  opacity, Suiming lily pad depth at stage 1, and overlapping volume + placed surface draws.
