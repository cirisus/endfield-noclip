# world: maps, levels and streaming

streaming scenes and coordinate frames, levels as 128 m cell sets, entity level tags, static and
dynamic streaming chunks, stream areas, LOD/HLOD, and layer streaming. terrain is in
[terrain.md](terrain.md); scene-state, quest and variable gating is in
[scene-states.md](scene-states.md).

## scenes, maps and levels

the world is split into three units:

- **scene**: a streaming scene (`Data/Streaming/PC/<scene>/`, described by `StreamingSceneConfig`),
  e.g. `map01`, `map02`, `base01_lv001` (Dijiang), `indie_dg007`, and ~100 more. each scene has one
  Unity coordinate frame shared by LevelConfig rects, entity matrices, terrain tiles and MapRegion
  shapes; nothing is relocated per level.
- **map**: a MapConfig (`mapIdStr`) defining the ownership grid and scene states of a playable
  space. open-world maps `map01` and `map02` share their scene name; their `domainName` (`domain_1`,
  `domain_2`) is shown as Valley IV and Wuling.
- **level**: a LevelConfig (`map02_lv001`, …) representing an area inside a map, not a separate
  scene.
  - open-world levels are `isSeamless` and share their map's streaming scene.
  - non-seamless levels are usually their own map but may stream another scene (`dung02_gdg001`
    streams `map02`; `base01_lv003` streams `base01_lv001`). a level's scene always comes from
    `defaultState.exportedSceneConfigPath`, never `mapId`.
  - interiors, arenas and Dijiang are separate scenes with their own coordinate frames (even when
    coordinates look world-like).

### scene names

scene ids follow `<owner>_<kind><number>`:

- **owner**: `map01`/`map02` (open-world regions), `base01` (Dijiang), `dung01`/`dung02` (instances
  tied to region 01/02), `indie` (neither region), `blackbox01/02_dg001` (AIC tutorials).
- **kind**: not stored directly, but aligns with `dungeonCategory` in `Data/TableCfg/DungeonTable`
  (which maps `dungeonId` → `sceneId`/`levelId` + `dungeonCategory`):

| kind    | `dungeonCategory`                         | what it is                                                          |
| ------- | ----------------------------------------- | ------------------------------------------------------------------- |
| `dg`    | `dungeon_story`, `dungeon_train`, or none | story interiors and cities; base01 training rooms                   |
| `cdg`   | `dungeon_challenge`, `dungeon_actmonster` | puzzle and mechanic stages                                          |
| `rdg`   | `dungeon_char`, a few `dungeon_story`     | operator story dungeons, e.g. `dung02_rdg008` is `dung_lizhiyan_01` |
| `bdg`   | `dungeon_bossrush`                        | boss-rush arenas                                                    |
| `gdg`   | `dungeon_archery`                         | archery stages                                                      |
| `rcdg`  | `dungeon_wuling_racing`                   | Wuling tracks                                                       |
| `sdg`   | `dungeon_resource`                        | Protocol Space resource stages                                      |
| `ssdg`  | none (`dungeon_ss` rows point at levels)  | Protocol Space advanced progression                                 |
| `ttdg`  | `dungeon_takestwo`                        | wave arena                                                          |
| `swdg`  | `dungeon_gamblingdungeon`                 | Arena of Games                                                      |
| `wrdg`  | `dungeon_weeklyraid`                      | weekly raid                                                         |
| `hdg`   | `dungeon_highdifficulty`                  | high-difficulty boss arenas                                         |
| `ccdg`  | `dungeon_contract`                        | Contingency Contract                                                |
| `check` | `dungeon_worldlevel`                      | Zoetic Session level checks                                         |
| `race`  | `dungeon_race`                            | race                                                                |
| `tower` | `dungeon_seasontower`                     | season tower                                                        |

- **number**: sequential within owner + kind; carries no other meaning.
- a scene can serve many dungeon entries (`indie_tower001` serves dozens) or none: story quests send
  the party directly via `Data/Json/MissionRuntimeAsset/<mission>.json` (`sceneId`, `_mapId`), e.g.
  `e11m5` enters `dung02_rdg008`. dungeons and quests can share display names (`dung02_cdg005` and
  `e11m7` are both "Homecoming").
- a dungeon id names a level, not necessarily a scene (`dung02_rdg009`/`rdg015` stream `map02`;
  `dung02_rdg012` streams `dung02_rdg008`). `rdg` rows leave `dungeonName` and `relatedCharId`
  empty; the operator comes from character missions (`charId`, `c<n>` matching `chr_00<n>`).
  missions name levels in `levelId`, quests' `levelIdOverride`, tracking entries' `sceneId`, and
  conditions' `_mapId` (`{ constValue }`).
- inferred: `dung02_rdg012` (`dung_lizhiyan_02`, unnamed by any mission) is Deep Dale Street's
  post-chapter-11 revisit — it streams `dung02_rdg008`, spawns in the ruined plaza, and holds only a
  checkpoint, a rope-port pair, and an `e11m8d5` sub-file.

### LevelConfig

`Data/Json/LevelConfig/<level>.json` is a binary MemoryPack payload (18 root members, 3
`defaultState` members, ending at exact EOF) with strings pooled in
`Data/Json/StringPool/StringPool<n>.byte`.

| field                                             | meaning                                                                                                                |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `id`, `idNum`                                     | string id and numeric id stored in MapConfig's grid                                                                    |
| `mapId`                                           | level's map (stored as `mapIdStr`, e.g. `map02`); not always its streaming scene                                       |
| `defaultState.exportedSceneConfigPath`            | streaming scene asset, e.g. `map02/map02_streaming.asset`                                                              |
| `defaultState.sourceSceneName`                    | level's art sub-scene, e.g. `map02_lv001_art`                                                                          |
| `levelGrids`                                      | 128 m cells owned by the level                                                                                         |
| `levelDataPathHashes`                             | StringPathHash keys (stored as `levelDataPaths`) of LevelData files (interactives, [interactives.md](interactives.md)) |
| `rectLeftBottom`, `rectRightTop`, `playerInitPos` | playable rect and player spawn point                                                                                   |

### MapConfig and the ownership grid

`Data/Json/MapConfig/<map>.json` is plain UTF-8 JSON (with BOM).

- `levelIds`: row-major `sideGridNum × sideGridNum` grid of LevelConfig `idNum`s centred on the
  origin (`0` = unowned).
- cell `(x, z) = (floor(worldX / 128), floor(worldZ / 128))` sits at index
  `(z + N/2)·N + (x + N/2)`.
- grid sizes: map02 is 32² (4096 m); map01 is 16² (2048 m).
- also stores `sceneStates` and `sceneStateConditions` ([scene-states.md](scene-states.md)).

### the level partition

three sources track level membership:

1. MapConfig `levelIds` (level per cell)
2. LevelConfig `levelGrids` (cells per level; agrees exactly with `levelIds` on map01 and map02)
3. entity id top 5 bits (`id >>> 27`), the **level tag** (which level authored the entity)

tag assignment:

- 1-based ordinal of the level among the map's grid-owning levels sorted by id (not the `lvNNN`
  number: map02 has lv001–lv010 so they coincide; map01 has no lv004, so lv005–lv007 carry tags
  4–6).
- tag 0: small map-wide shared set. in single-level scenes (dungeons, Dijiang), everything is tagged
  0 and owned by that level.
- tag 31: generated colliders.
- verified by majority vote of entity pivot cells (excluding backdrop cells, whose skyline props
  would outvote small levels).

**ownership follows the tag, not position**:

- a level's scenery can sit in a neighbour's cell or in an unowned cell (backdrop/skyline; map02 has
  more unowned cells than owned ones). clipping by cells or rect cuts real scenery.
- border cells hold entities from multiple levels without duplicating them; entities spanning cells
  repeat by id in each touched cell's chunk.
- `MapRegionTable` polygons are UI overlays (mist, toasts); they do not tile levels and overhang
  level cells.

### map place names

- **map labels**: `Data/Json/UILevelMapLoadConfig/<level>.json` static elements of type 2 hold a
  `textId` (`scene_<level>_…_location_tips_<n>`, via `TextTable`) at world `position`
  `(x, z; y = 0)`, e.g. "Bridge Approach" (The Hub) and "Tianjing Courtyard" (Wuling City).
  `basic.needInverseXZ` swaps x and z (unset on map01/map02).
- **interior floors**: `tierNames` (`scene_<level>_layer_tips_<n>`) and per-tier bounds
  (`tierInfos`); relation to stream areas is unestablished.
- **level display names**: `LevelDescTable.showName`.

## static scenery: InitChunkData and StreamingChunkData

static scenery streams per 128 m cell (called a "grid" by the game):

```
Data/Streaming/PC/<scene>/Streaming/InitChunkData_<x>_<z>_<sceneState>_<area>.bytes
Data/Streaming/PC/<scene>/Streaming/InitChunkData_Global_<sceneState>_<area>.bytes
Data/Streaming/PC/<scene>/Streaming/StreamingChunkData_…   (same suffixes)
```

suffixes are `GridIdentifier` fields (`pos`, `sceneStateId`, `areaId`):

- `<x>_<z>`: 128 m cell. most pivots fall inside their file's cell; large objects are filed by
  bounds and repeat in each cell they touch. `Global` has no cell and holds layers that don't load
  by cell (`Persistent`, `HLOD0`–`HLOD2`, `Water`); only its `Persistent` entities are always
  resident.
- `<sceneState>`: 0 = always loaded; `n` = active only while MapConfig scene state `n − 1` is active
  ([scene-states.md](scene-states.md)).
- `<area>`: stream-area id from `FBStreamArea` (0 = default).

each file is a `u32` clear size + inverted-LZ4 block wrapping a FlatBuffer.

### InitChunkData layout

the root table has 8 slots: version (47 and 49 seen), chunk origin (`x·128, z·128`; `Global` stores
`INT32_MAX, INT32_MIN`), object rows (ids, union kinds, tables; slot 0 = full object name, slot 1 =
`StreamingLayer` byte omitted for `Default`), and parallel vectors of per-group entity ids and
**component groups**.

a component group is a column-major ECS archetype: a descriptor list of `(componentId, stride)` and
one blob of `count · Σ stride` bytes.

| id    | content                                                                                                                                                                                                                                    |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0–5   | world AABB: centre xyz, extents xyz (`f32` each)                                                                                                                                                                                           |
| 6     | `RenderObjectLODInfoComponent` (20 B): LOD centre (world), half size², dither `u8`, culling options `u8` (0 on all map02 entities)                                                                                                         |
| 7     | generic render-object info (24 B): layer mask, flags, scene mask, art tag, squared sorting distance                                                                                                                                        |
| 8–14  | draw infos for capacity `2^(id − 8)`: count, 24 B `RendererInfo`s (submesh, `renderFlags`), then `(max², min²)` LOD bounds                                                                                                                 |
| 18    | 256 B instance constants starting with object-to-world matrix                                                                                                                                                                              |
| 21    | 64 B name prefix (root object name wins when present)                                                                                                                                                                                      |
| 27    | rect decal constants (160 B): matrix, inverse, UV scale/offset, RGBA8 colour, intensity, unread angle (270/90 seen), flags (0 seen); material in StreamingChunkData under `0xff010000` ([decals](materials.md#decals))                     |
| 28    | terrain decal constants (same layout as 27); material in StreamingChunkData (`HGRP/TerrainDecalLit`)                                                                                                                                       |
| 30    | water surface placement ([water](water.md#placements-initchunkdata-component-30))                                                                                                                                                          |
| 31    | `HGWaterDecalComponent` box (172 B; [WaterDecal](water.md#waterproxy-and-waterdecal))                                                                                                                                                      |
| 42    | local light runtime data, zero-filled in file (244 B); values sit in object row below                                                                                                                                                      |
| 44    | collider-only entities (`…_COL1`, `P_box_collider`, `MergedCollider_…`), always with 21 alone (tens of thousands on map02); content unread                                                                                                 |
| 52    | constant spin about own origin (16 B): non-negative speed (rad/s), local unit axis; originium hub frames only ([spinning scenery](animation.md#spinning-scenery))                                                                          |
| 54    | constant spin (92 B): non-negative speed (rad/s), unit axis, world pivot, 6 unchecked floats (likely local box), position, rotation quat xyzw, scale; Qingbo Stockade waterwheels only ([spinning scenery](animation.md#spinning-scenery)) |
| 58    | 1 B (0 seen) on map02 light-art entities (~1250 mist cards/boxes, light beams): draw LOD bounds are [camera distances](#lod-and-hlod)                                                                                                      |
| 60    | cloth hash (`u32`) linking vertices to a [cloth group](#cloth-groups) ([cloth simulation](materials.md#cloth-simulation))                                                                                                                  |
| 61    | oriented box (44 B): `u32 0`, centre xyz, size xyz (half/full unchecked), rotation quat xyzw; paired with 21 and 1 B col 62 on map02 `shadowOC_CAVE_*` entities only                                                                       |
| 63    | local light settings, zero-filled (448 B)                                                                                                                                                                                                  |
| 67    | LOD ranges: LOD count and cumulative draw count per LOD                                                                                                                                                                                    |
| 68–74 | draw refs for capacity `2^(id − 68)`: `(u64 materialHash, u64 meshHash, …)`                                                                                                                                                                |

object row kinds (by census):

- **1**: GameObjects rebuilt as MonoBehaviours (environment/post volumes, probes, water, terrain
  root; see [environment.md](environment.md), [water.md](water.md)).
- **2**: component-group entities.
- **3**: proxies — audio, [foliage grids](#foliage-grids), [cloth groups](#cloth-groups), surface
  data.

**local lights** (~1k on map01, ~2k on map02; shading in [lighting.md](lighting.md#local-lights))
are kind-2 entities with columns 42 and 63. their Init row slot 3 is a keyed property table holding
two blobs:

runtime block (key `0xff000000`, 236 bytes):

| offset | type   | content                                                       |
| ------ | ------ | ------------------------------------------------------------- |
| 0      | f32×4  | sRGB colour as authored                                       |
| 16     | f32    | intensity                                                     |
| 20     | f32    | colour temperature (K)                                        |
| 24     | u32    | use temperature                                               |
| 28     | f32×4  | position, 1                                                   |
| 44     | f32×4  | direction (transform +z), 0                                   |
| 60     | f32×4  | linear colour · intensity · temperature tint (rgb), intensity |
| 76     | f32    | range (m)                                                     |
| 80     | f32    | `25 / range²`                                                 |
| 84     | f32    | spot angle (degrees; −1 for point lights)                     |
| 88     | u32    | Unity `LightType`: 0 spot, 1 directional, 2 point             |
| 92     | f32×4  | copy of +60                                                   |
| 108    | f32×16 | object-to-world, column-major                                 |
| 172    | f32×16 | world-to-object                                               |

settings block (key `0xff010000`, 448 bytes):

| offset | type  | content                                                                                                                                |
| ------ | ----- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 12     | u32   | `LightType` (as in runtime block)                                                                                                      |
| 20     | f32   | specular intensity                                                                                                                     |
| 24     | f32   | range                                                                                                                                  |
| 36     | f32   | spot angle (full cone, degrees)                                                                                                        |
| 40     | f32   | inner spot angle                                                                                                                       |
| 48     | f32   | `cot(spot / 2)`                                                                                                                        |
| 52     | f32   | `1 / cos(spot / 2)`                                                                                                                    |
| 80     | u32   | Unity `LightmapBakeType`: 4 realtime, 1 mixed, 2 baked                                                                                 |
| 91     | u8    | shadow only                                                                                                                            |
| 92     | u8    | culling box on                                                                                                                         |
| 94     | u8    | culling distance on                                                                                                                    |
| 100    | f32×3 | culling box offset                                                                                                                     |
| 112    | f32×3 | culling box half extents                                                                                                               |
| 124    | f32×3 | culling box rotation (Euler degrees)                                                                                                   |
| 136    | f32   | culling box falloff threshold                                                                                                          |
| 140    | i32   | priority                                                                                                                               |
| 144    | f32   | tube length (−1 or 0: not a tube)                                                                                                      |
| 148    | f32   | soft source radius                                                                                                                     |
| 152    | f32   | culling distance                                                                                                                       |
| 156    | f32   | falloff distance                                                                                                                       |
| 160    | u32   | shadows: 0 none, 2 soft                                                                                                                |
| 172    | f32   | shadow strength                                                                                                                        |
| 176    | f32   | shadow depth bias (rasteriser's)                                                                                                       |
| 180    | f32   | shadow normal bias                                                                                                                     |
| 184    | f32   | shadow near plane                                                                                                                      |
| 256    | f32   | shadow far plane                                                                                                                       |
| 260    | f32   | shadow cull distance                                                                                                                   |
| 264    | f32   | shadow fade ratio                                                                                                                      |
| 268    | f32   | shadow guard angle (degrees)                                                                                                           |
| 272    | i32   | point light shadow faces (bit per face, −1 all)                                                                                        |
| 276    | i32   | shadow caster properties (1 moving light, 2 static casters, 4 dynamic casters; [local light shadows](lighting.md#local-light-shadows)) |
| 436    | u8    | character only                                                                                                                         |
| 440    | f32   | volumetric scattering intensity                                                                                                        |
| 444    | f32   | falloff exponent (negative: inverse square)                                                                                            |

both layouts come from a census over map01/map02 against Unity `Light` defaults (30° and 21.80208°
angles, 6570 K temperature) and HG light property order; shadow fields match prefab
`Light.m_Shadows`.

#### render flags

`RendererInfo.renderFlags` (`HGRenderFlags`). shadow bits were verified against shadow-map draws;
other bits come from enum names (unchecked):

| bit                      | name                   | meaning                                                        |
| ------------------------ | ---------------------- | -------------------------------------------------------------- |
| `0x2`                    | `ShadowTwoSided`       | casts shadows from both faces                                  |
| `0x10`                   | `AlphaTest`            | alpha-tested material                                          |
| `0x100`                  | `Opaque`               | set at runtime for opaque-queue materials                      |
| `0x200`                  | `Transparent`          | transparent material                                           |
| `0x400`                  | `ShadowOnly`           | casts shadows without drawing (shadow proxies)                 |
| `0x80000`                | `CastShadow`           | casts shadows at all                                           |
| `0x100000 << i`, i = 0–3 | `CSMShadowCascade<i>`  | casts into sharp cascade `i` (all four or none on chunk draws) |
| `0x1000000`              | `StaticShadowCaster`   | casts into cached far map                                      |
| `0x2000000`              | `RealtimeShadowCaster` | casts into sharp cascades                                      |
| `0x8000000`              | `RayTracing`           | included in ray tracing                                        |
| `0x20000000`             | `MaterialTwoSided`     | two-sided material                                             |

map02 chunk draws fall into two families: `0x0bf80000` (ray tracing, both caster kinds, all
cascades, cast) and `0x08080000` (ray tracing and cast only — ~10k draws casting into no sun shadow
map; see [shadows](lighting.md#shadows)). prefab renderers lack this word and use `m_CastShadows`,
`m_StaticShadowCaster` and `m_RealtimeShadowCaster` (no per-cascade field).

### StreamingChunkData

sibling of each InitChunkData file sharing root layout and object ids, adding per-object keyed
property tables pointing at assets by StringPathHash. keys pack as
`component << 24 | field << 16 | index`. kind-1 properties split between Init (name, inline values)
and Streaming (asset refs, some nested blobs).

a property table is three parallel vectors in slots 3–5: `u32` keys, `u8` value types, and value
offsets.

| kind | row layout                                                                                                                                |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | 5 slots: 0 name (Init; empty in Streaming), 1 streaming layer, 3 inline `u64` `StreamingComponentType` mask, 4 vector of component tables |
| 2    | 6 slots in Streaming: 3 property table, 4 sixteen zero bytes, 5 empty vector. lights also store a property table in Init slot 3           |
| 3    | 4 slots: 3 property table ([foliage grids](#foliage-grids), [cloth groups](#cloth-groups))                                                |

a kind-1 component table is a property table with its single-bit component type (`u32`) in slot 0.
its key's `component` is that bit index (0 `Transform`, 4 `BoxCollider`, 14 `HGEnvironmentVolume`,
15 `Volume`, 32 `HGWaterGlobalConfig`), `field` is the class field index, and `index` is the fixed
array element (matrix rows, curve keys). `0xff` keys are per entity archetype. verified against
`Env_*` volumes (`EnvParse/Env_*.asset`) and Global Volumes.

| value type | value                                                                                                    |
| ---------- | -------------------------------------------------------------------------------------------------------- |
| 1          | bool (`u8`)                                                                                              |
| 2, 3       | `i32`, `u32`                                                                                             |
| 4          | `f32`                                                                                                    |
| 6          | `u64`                                                                                                    |
| 9, 10      | `f32×3`, `f32×4`                                                                                         |
| 13         | `i32×4` (only seen as renderer [HLOD link](#lod-and-hlod) under `0xff000000`)                            |
| 14         | bounds: centre and extents (`f32×3` each)                                                                |
| 15         | asset: `u64` StringPathHash key + `u32` kind code (6 = ScriptableObject; 1, 3, 4, 7, 8 seen)             |
| 16         | string: table whose slot 0 holds the bytes                                                               |
| 17         | blob: table holding a table holding raw struct bytes (polylines, probes); empty structs omit inner slots |

### foliage grids

small vegetation lives in kind-3 proxies named `GrassGrid_<x>_<z>#<level tag>_<id>` and `TreeGrid_…`
(one per 64 m cell and file; row slot 2 = `ProxyEntityType`: 7 grass, 9 tree). each serializes ECS
archetypes in its property table:

| key                    | file      | content                                                                             |
| ---------------------- | --------- | ----------------------------------------------------------------------------------- |
| `0xff000000`           | Init      | archetype count                                                                     |
| `0xff01xxxx`           | Init      | archetype bounds                                                                    |
| `0xff02xxxx`           | Init      | entity count                                                                        |
| `0xff03xxxx`           | Init      | column descriptors (8 B each): `u16 componentId, u16 stride, u32 0`                 |
| `0xff04xxxx`           | Init      | column-major blob (same as component groups)                                        |
| `0xff050000`           | Streaming | batch table length                                                                  |
| `0xff06xxxx`–`0xff09…` | Streaming | per batch entry: `u32` key (value type 3), material, mesh (StringPathHash), submesh |

archetypes reuse columns 0–5 (bounds), 6 (20 B: point + squared size), 7 (24 B render-object info),
and 8–14 (draw infos). there is no LOD-range column: a draw's LOD is the rank of its upper
threshold.

- **draws**: reference batch entries instead of asset keys.
  - `GrassRendererInfo`: `u16` keywords (+0), batch key (+4), sparsity (+8), renderer flags (+12).
  - tree `RendererInfo`: submesh `u8` (+2), batch index (+12), flags (+16).
- **instances (96 B each)**: column-major object-to-world matrix + two `vec4` params (second param
  is grass per-instance colour, [foliage](materials.md#foliage)).
  - grass entity = cluster of nearby instances (`column 37 + k`,
    `GrassClusterK{4,8,16,32}Component`: count + capacity `4 · 2^k`).
  - tree entity = 1 instance (`column 80`, `HGTreeComponent`).
- **census & runtime**: map02 has ~1M grass/bush instances (tens of thousands of clusters) and <20k
  trees; map01 has a few hundred thousand grass instances and no tree grids. grids repeat under one
  id in every overlapping file. cluster LOD uses `rendererHalfSize`; sparsity thins grass by quality
  setting. layout from map01/map02 census, component names from IL2CPP metadata.

### cloth groups

[cloth simulation](materials.md#cloth-simulation) input sits in kind-3 proxies named
`ClothGroupInfo_<group hash>#<level tag>_<id>` (`ProxyEntityType` 8) in the cloths' cell files. a
group holds up to 4 cloths (512 nodes total); Streaming holds only the group hash under
`0xff050000`.

| key          | content                                                                                                          |
| ------------ | ---------------------------------------------------------------------------------------------------------------- |
| `0xff000000` | `ClothGroupMeta` (80 B): cloth count, group hash, world XZ, then 4 each of cloth hashes, node/batch/cache counts |
| `0xff010000` | `ClothMetaData` (176 B per cloth)                                                                                |
| `0xff020000` | `ClothNodeData` (192 B per node, cloths concatenated)                                                            |
| `0xff030000` | batch records (`4 × i32` each, all zero in cells read)                                                           |
| `0xff040000` | batch cache records (`4 × i32` each, all zero in cells read)                                                     |

- **cloth (`ClothMetaData`)**: node range (`u32` start, end), `u32` first batch, `u32` iterations (3
  seen), `f32` damping / wind frequency factor / wind balance factor / wind intensity scale,
  `4 × i32` runtime-filled, `vec4` (`x` = longest anchor distance), cloth normal, and rows of 3×4
  local-to-world and world-to-local matrices.
- **node (`ClothNodeData`, world space)**: 2 anchor indices (−1 none) + rest distances; UV; 2
  collision-plane floats; rest pos (`w` = weight growing from anchors), normal, tangent; previous
  pos, current pos, current normal (starting at rest); 8 neighbour indices (−1 none) + rest
  distances (`1e7` none).

an entity's [component 60](#initchunkdata-layout) holds its cloth hash. verified against one Sword
Vault Dale cell (node positions lie on its canvases); batch records and unnamed fields are unread.

## stream areas

`Data/DynamicStreaming/PC/Scene/<scene>/FBStreamArea.bytes` is a FlatBuffer
(`FBStreamAreaTotalData`) defining scene areas, default visibility (`RootVisible`), and XZ polygon
trigger volumes:

| slot | content                                                                                             |
| ---- | --------------------------------------------------------------------------------------------------- |
| 0    | `TotalAreas`: `i32` area ids (including 0)                                                          |
| 1    | `RootVisible`: `i32` area ids                                                                       |
| 2    | `AreaVisibleGroups`: `i32` area ids, sliced by slot 4                                               |
| 3    | scene bounds (24 B inline): min/max (`f32` world x, z each), `f32` min/max height                   |
| 4    | areas (12 B each): `i32` area id, `i32` start and count in slot 2                                   |
| 5    | triggers (36 B each): `i32` area id, `i32` start and count in slot 6 (closed ring), bounds          |
| 6    | points (8 B each): `f32` world x, z                                                                 |
| 7–9  | `HlodUnloadBounds`, `HlodUnloadTriggers`, `HlodUnloadPoints` (same layout, carrying an unload mask) |

- **area visibility**: when the streaming centre is inside one or more triggers, the game shows the
  union of those areas' visible slices; otherwise it shows `RootVisible`. area ids match chunk file
  `<area>` suffixes and DynamicStreaming visibility groups.
- **HLOD unload volumes (slots 7–9)**: while inside one or more volumes, the game unloads meshes of
  HLOD clusters matching the union of their masks — even if not [hidden](#lod-and-hlod), leaving
  them nothing to draw. a mask bit matches a per-cluster sub-scene byte (storage location not
  found).
- **usage**: areas aren't interiors only — e.g. map02's Si's Painting cliff/floating-rock backdrop
  (area `701638228` in one build) loads only in a zone west of the inn so it doesn't block the inn's
  view. among map01, map02, base01_lv001 and base01_lv002, only map02 has non-default static areas
  (purely additive to area 0, no duplicate ids). ~1 in 20 map02 DynamicStreaming area lists names a
  non-default area ([scene-states.md](scene-states.md#where-states-are-referenced)), including the
  falls over Si's Painting's cliff.

## dynamic streaming

`Data/DynamicStreaming/PC/Scene/<scene>/` holds `fb_main_<L>_<i>_<j>` grid files, paired
`fb_init_*`/`fb_streaming_*` ECS chunks, and `FBStreamArea.bytes`. it carries prefab placements,
interactives, and gated scenery ([assets.md](assets.md#dynamic-structures)).

### dynamic load grids

dynamic scenes stream by `fb_main` grids, not static layers. grid id = `L << 16 | z << 8 | x`. level
`L` has `32 · 2^L` m cells on a 4096 m frame (`[−2048, 2048]` in x and z). levels 0–5 and 7 exist
(no level 6); level 7 is one cell covering the frame.

- **load**: per level, the 3×3 block of cells around the clamped streaming centre loads. a row
  enters within 1.5 cells of its cell centre (XZ Chebyshev): 48, 96, 192, 384, 768, 1536 m for
  levels 0–5; level 7 is always loaded.
- **unload**: stays loaded until the centre leaves a square of side `min(3 · cell + 20, 3.2 · cell)`
  around the cell centre (~10 m hysteresis). rescans every 0.1 m of movement.
- **centre**: same streaming centre as static streaming (likely the player); a second centre can
  load extra blocks.
- **level choice**: large/far content sits in coarse grids (Dijiang's corroded planet = level 4,
  satellites = level 7, props = level 0). an entity's owner sits in a grid at least as coarse as its
  rows (levels 2–7 on map02 and base01_lv001), so a row's own grid is binding.
- **per-row radius**: each row carries a [visibility record](assets.md#payloads). importance 3 is
  always visible; importance 0 is untested; others show while a centre is within XZ radius
  `max(baseRadius, distToFarthestCornerOf3x3_128mBlock) + clamp(0.1 · that, 2, 30)` (corner distance
  is 181–362 m). shipped base radii already reach the far corner of the row's 3×3 block (within ~1 m
  on >99% of rows, larger on the rest), so the test rarely hides loaded rows. map02 rows are mostly
  importance 1, far fewer 0 and 3. whether untested rows start visible and the retest threshold (5 m
  by setting name) are unchecked.
- once loaded, prefab renderers cull only by their own LODGroups and
  [effect LOD tables](effects.md#effect-lod-tables); dynamic LOD proxies never hide them.

## LOD and HLOD

- **per-entity LOD chains**: static draws carry a LOD index and `(minSquared, maxSquared]`
  screen-relative height² range (Unity LODGroup style; `maxSquared = FLT_MAX` on nearest LOD). the
  final (cull-out) LOD stores its threshold negated as `−k²` with `k ∈ [0.005, 0.05]` (`−0.000225`
  on many map02 draws, `−0.0001` on all map02 HLOD clusters, `−0.0025` on all indie_dg005 clusters,
  `−0.0004`, `−0.000025`); the game culls below `|minSquared| = k²`.
- **distance LODs**: entities with component 58 (~1250 map02 mist cards/boxes and volumetric light
  beams) store squared camera distances in metres instead (cards 20–74 m out to 180–685 m, most
  boxes out to 255 m, `(0, FLT_MAX]` never culls). all other map02 bounds are `≤ 0.7225`, so the two
  never overlap. distance measured from component-6 LOD centre (bounds centre on those seen) is
  inferred.
- **foliage cards**: imposter meshes (`…_cardmesh`) appear as ordinary LODs — usually last, though
  thousands of map02 card draws are earlier LODs with a size cull (LOD 3 of 5, 4 of 6).
- **shadow proxies**: draws with `ShadowOnly` ([render flags](#render-flags)) only cast shadows.
- **HLOD clusters**: auto-generated per-level clusters in 3 tiers (`pc` variant only), placed in
  Global chunks on their tier's [streaming layer](#streaming-layers) as
  `HLOD<tier>_<i>_<j>_Cluster_<hash>…`. `i`/`j` is the tier's grid cell with negative coords clamped
  to 0; one large member can stretch bounds hundreds of metres past the cell. draw range is
  unbounded (visibility comes from HLOD links). trailing `_250`/`_600` is height rounded to 50 m,
  not switch distance. Jingyu's tiers span a few hundred meshes (~450k tris, HLOD0) to a few dozen
  (~45k tris, HLOD2).
- **HLOD links**: stored in StreamingChunkData under `0xff000000` (`HLODInfo`, `i32×4`):
  `(entityId, parentClusterId, childCount, indexInParent)` (`parent = 0`, `index = −1` if none; all
  zero outside any tree). hierarchy: `HLOD2 → HLOD1 → HLOD0 →` cell renderers (`Default` and
  `RendererWithCollider`). top tiers may be absent (map01 has no HLOD2), and some clusters have no
  parent. visibility rules:
  - a cluster hides once all its children are loaded, and shows again when any unloads.
  - a child hides while its parent is loaded and any sibling is unloaded; it shows when its parent
    is unloaded.
  - a child that never loads (a few HLOD1 clusters count more children than exist, or children sit
    in inactive scene-state/area files) keeps its cluster shown and its siblings hidden.
- **unlinked clusters**: clusters with all-zero `HLODInfo` are never hidden (ordinary scenery on
  their layer). indie_dg005 has ~240 `Persistent` HLOD0 clusters (Wuling City outside office
  windows, source buildings unshipped); map02 and dung02_rdg008 have a handful on their tier layers.
- **HLOD grids**: each tier doubles the previous tier's cell size, but tier-0 cell and origin vary
  by scene (storage location not found). fitted to cluster names (>95% agreement per axis):
  - 64 m cells, origin at terrain square corner: map01, map02, indie_dg002, indie_dg016, and 1024 m
    dungeons except dung02_rdg008.
  - dung02_rdg008: origin `(−256, −256)` inside its `(−512, −512)` square.
  - dung02_dg002: origin `(−1664, −832)` on a 4096 m square (HLOD1 offset half a cell from terrain
    quadtree).
  - indie_dg005: 128 m cells from `(−1728, −832)` (offset half a cell from terrain quadtree).

## streaming layers

static scenery streams by layer around a streaming centre (likely player, not camera). 128 m cells
are the unit of file I/O; each layer's grid cell is the unit entering the scene. the game calls an
HLOD tier an HLOD level.

| layer                  | grid  | file   | priority |
| ---------------------- | ----- | ------ | -------- |
| `Persistent`           | —     | Global | 0        |
| `HLOD2`                | 256 m | Global | 1        |
| `HLOD1`                | 128 m | Global | 2        |
| `HLOD0`                | 64 m  | Global | 3        |
| `Collider`             | 64 m  | cell   | 4        |
| `RendererWithCollider` | 64 m  | cell   | 5        |
| `Lighting`             | 64 m  | cell   | 6        |
| `Audio`                | 32 m  | cell   | 7        |
| `Water`                | 128 m | Global | 8        |
| `Default`              | 64 m  | cell   | 9        |
| `Tiny`                 | 32 m  | cell   | 10       |

lower priority loads first, then nearer cells. entity layer is a byte in its
[object row](#initchunkdata-layout). HLOD layers also hold unlinked far-field scenery (~17k map02
entities including most `farmod` assets, rest `Persistent`/`Default`; nearly all indie_dg005 static
renderers on `HLOD1`). `Tiny` holds ~70k small map02 renderers.

load radii from `DesktopSettings` `[Streaming@<preset>]` over code defaults (inheritance as in
[quality settings](quality-settings.md#from-preset-to-settings); bracketed values assumed
inherited):

| radius (m)  | 1000 | 3000 | 4000  | 5000  | code default |
| ----------- | ---- | ---- | ----- | ----- | ------------ |
| chunk files | 128  | 128  | 160   | 256   | 256          |
| `Default`   | 96   | 128  | 160   | 256   | 128          |
| `HLOD0`     | 256  | 384  | 512   | 640   | 256          |
| `HLOD1`     | 1024 | 1024 | 1024  | 1024  | 512          |
| `HLOD2`     | 2048 | 2048 | 2048  | 2048  | 1024         |
| `Collider`  | 128  | 128  | 128   | 128   | 128          |
| `Tiny`      | 96   | 128  | (128) | (128) | 32           |
| `Lighting`  | 96   | 128  | (128) | (128) | 128          |

- `Water` (128 m) and `Audio` (16 m) use code defaults. `RendererWithCollider` uses
  `max(Collider, Default)`. scenes can override `Default`.
- **low-memory devices**: forced to preset 1000 for streaming, LOD streaming and texture streaming;
  unload before load; on maps setting `useLowMemoryHLODLoadParameter` (map02 yes, map01 no), HLOD
  radii are 256 / 1024 / 2048 m (code default 256 / 512 / 1024). mobile INI preset 1000: `Default`
  64, `HLOD0` 128, `HLOD1` 896, `HLOD2` 1280 m.
- **selection**: XZ distance only. every 128 m file intersecting the chunk radius loads (all its
  scene-state and area variants), plus Global; every layer cell intersecting its layer's radius
  loads (`Persistent` is 1 cell). a layer can be disabled for the default area; a second source can
  stream around another position (seamless/extra loads).
- **hysteresis**: add pass runs after 4 m movement; remove pass after 20 m (12 m code default and
  mobile), so cells unload up to 20 m past their radius.
- **HLOD rings**: clusters hide via [HLOD links](#lod-and-hlod) once all children load, forming
  concentric rings (at preset 5000: detail ≤ 256 m, HLOD0 ≤ 640 m, HLOD1 ≤ 1024 m, HLOD2 ≤ 2048 m,
  nothing beyond). swapping waits for the farthest child.
- **HLOD resources**: a hidden cluster unloads its meshes when the camera (3D distance to a
  per-cluster point) is within the next finer layer's radius, and reloads beyond it. visible
  clusters keep meshes unless inside an [HLOD-unload volume](#stream-areas).
- **time budget**: 1.5 ms load / 2.5 ms unload per frame (code default 3.5 / 0.5), scaled by
  `clamp(smoothedFrameTime / 33.3 ms, 0.1, 2)` (~0.75 / 1.25 ms at 60 fps); unlimited on teleports.
- **why 128 m**: unstated; at lower presets the chunk radius is 1 cell, letting finer layer grids
  filter entities without reading many files.
- PC renderer screen-size cull is off. LOD bias: 2 (preset 1000), 1.5 (2000), 1 (3000+).

### texture streaming

PC settings enable Unity texture streaming (`TextureStreaming`: 256 renderers/frame, 512 from preset
3500; 32 file reads in flight, 36 from 2000, 48 from 3500). `streamingMipmapsMemoryBudget` (MB) is
for textures alone (`TextureQuality_<n>GB`), capped at 5500 MB (with 5500 MB reserved for meshes and
render targets):

| VRAM  | preset 1000 | 2000 | 3000+ |
| ----- | ----------- | ---- | ----- |
| 6 GB  | 1000        | 1300 | 1500  |
| 8 GB  | 2000        | 2300 | 2500  |
| 10 GB | 2500        | 3000 | 3500  |
| 12 GB | 3000        | 3500 | 4500  |
| 16 GB | 3500        | 4500 | 5500  |

effect textures skip 1 mip on 6 GB cards. Unity drops mips when requested mips exceed the budget
(`streamingMipmapsMaxLevelReduction` not found in game settings).

## teleport points

five MemoryPack tables in `JsonData`,
`Data/Json/GameplayConfig/<source>TeleportValidationDataTable.json` (`TeleportValidationDataTable`:
id → level id, position, Euler rotation, reason, permitted deviation):

| source        | ids                                                               |
| ------------- | ----------------------------------------------------------------- |
| `Map`         | `TpForMap_ent_<interactive id>`: map fast-travel points           |
| `LevelScript` | `TpForLs_…`: level script teleports (not decoded, see open)       |
| `Cinematic`   | `TpForCs_<guid>`: cutscene player placements (often no level)     |
| `Guide`       | `TpForGd_<guide group>_…`                                         |
| `CommonSys`   | `TpForComSys_Mp:/CabinPoints/<room>`: Dijiang's three cabin rooms |

a `Map` id names the target interactive, and its position is the arrival point a few metres away
facing the stored yaw (e.g. `TpForMap_ent_2100000031` in map01_lv001 arrives 4.3 m from its
campfire). `GameplayConfig/LevelMapMark.json` holds the map marks referencing these ids (unread).

## named places

HUD place toasts ("Wuling City · Fangxing Avenue") come from LevelData `functionArea` volumes, not
map configs. each LevelData file (or dedicated `*_lv_data_sub_RegionToast.json` sub-file) stores
parallel lists: `baseData` (type, shape, position, Euler rotation, size/outline, unique id),
`specificDatas`, `ranges` (world AABB), and `functionAreaConditions` (quest-state conditions per
unique id).

a volume with `SceneToastUIData` defines a place:

- `mainTitle`, `subTitle`, `depthText`: `TextTable` keys (`scene_map02_lv002_regiontoast_tips_8`) —
  level name, place name, flavour line ("Depth: 0.0461±0.0057").
- `priority`: 1 for places; each open-world level has one priority 0 fallback covering the whole
  level ("Wuling · Test Area").
- shape: box (`shapeType == 1`: `size` around `postion`, rotated by `euler`) or polygon (3:
  `posList`, x/z relative to `postion`). `ranges` provides height span so places stack (e.g.
  Yuanyuan Manor's two floors).

map02 has ~120 place volumes, map01 ~80, story interiors a handful (Suiming, Marker Stone), most
dungeons none.

other spatial data in LevelData:

- `mapVolumeDatas` (`LevelMapRegionData`, also in `GameplayConfig/MapRegionTable.json`): unnamed map
  screen regions (`mapRegionType`: fog-of-war mist, multi-floor containers/tiers, oxygen zones).
- `worldWayPointData`: ambient NPC navigation graph (points + neighbour links; several hundred each
  in Wuling City and Marker Stone); NPCs, interactives, spawners and patrol points stand on it.
- `airWalls`: polylines with height ranges fencing playable ground.

## open

- what writes the streaming centre (inferred: player character, not camera)
- size that LODGroup thresholds are authored against (object bounds, LODGroup size, …)
- HLOD generated-material channel layout
- where a scene's HLOD grid (cell and origin used by cluster names) is defined, why it leaves the
  terrain quadtree in some scenes, and how it relates to HLOD layer grids
- where a cluster's sub-scene index is stored for HLOD-unload volume masks
  ([stream areas](#stream-areas))
- dynamic rows' `Dis` and `MinDis` (unread at runtime); a third LOD proxy kind that culls by the
  visibility record is untraced
- what dungeon levels reusing an open-world scene add of their own (map02 chunks only carry tags 0,
  31 and lv001–lv010, so additions must come from LevelData and DynamicStreaming)
- [teleport points](#teleport-points): `LevelScript` table (the largest) does not decode with the
  other four tables' layout; `LevelMapMark.json` mapping to destinations is unread
