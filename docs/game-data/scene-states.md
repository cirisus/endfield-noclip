# scene states and conditional content

everything that decides whether authored content is visible: MapConfig scene states,
DynamicStreaming load gates, progression levels, facility visual forms, Dijiang cabins and region
walls, doors, telescopic bridges, resource-node groups, script groups, other runtime mechanisms, and
quest labels. spatial stream areas are in [world.md](world.md#stream-areas), dynamic ECS formats in
[assets.md](assets.md#dynamic-structures), and interactive models/view states in
[interactives.md](interactives.md).

## the selectors at a glance

| selector                   | stored in                                                                                               |
| -------------------------- | ------------------------------------------------------------------------------------------------------- |
| quest / mission state      | read by MapConfig conditions and mission gates                                                          |
| map / global variable      | read by MapConfig conditions and variable gates                                                         |
| MapConfig scene state      | `Data/Json/MapConfig/<map>.json`; referenced by static chunk file names and dynamic visible-state lists |
| mission gate               | `MissionControlComp` on a dynamic entity                                                                |
| variable gate              | `GlobalVarControlComp` / `MapVarControlComp` with `controlLoad` set                                     |
| progression                | resource-group `logicState` bitmask under a settlement / POI / factory-region controller                |
| facility visual form       | interactive template model-upgrade list                                                                 |
| doodad group level         | doodad-shell postmodel's form list                                                                      |
| graded doodad form         | placement's `doodad_form_list`, `upgrade_need_level`; doodad table                                      |
| Dijiang cabin slot         | `ExtraSceneSlot` entity; cabin scenes named by `SpaceshipCabinData.json`                                |
| growth chamber level       | `SpaceshipGrowCabinLvTable` planting fields; planting-box shutters                                      |
| door                       | interactive model view states                                                                           |
| telescopic bridge          | the interactive's `state` property                                                                      |
| tree harvest state         | resource-group `logicState` on tree entities                                                            |
| script group               | script-control component's default-load flag; level scripts                                             |
| controller-less logic gate | resource-group `logicState` on an entity with no controller                                             |

## MapConfig scene states

MapConfig JSON defines `sceneStates` (state name → index) and `sceneStateConditions`, an ordered
list of `{ stateName, condition }`. each condition is a `ConditionRuntimeBase` (the only five
classes used by the installed client):

| `$type` (in `Beyond.Gameplay`)     | fields                                                          |
| ---------------------------------- | --------------------------------------------------------------- |
| `SimpleConditionCheckQuestState`   | `questId`, `compareOperator`, `compareTarget`                   |
| `SimpleConditionCheckMissionState` | `missionId`, `compareOperator`, `compareTarget`                 |
| `SimpleConditionCheckMapVar`       | `belongMapId`, `mapVarName`, `compareOperator`, `compareTarget` |
| `SimpleConditionCheckGlobalVar`    | `globalVarName`, `compareOperator`, `compareTarget`             |
| `CombinedConditionRuntime`         | `conditionOperator` (0 and, 1 or), `reverse`, `subConditions`   |

- `CompareOperator`: 0 =, 1 ≠, 2 >, 3 ≥, 4 <, 5 ≤ (evaluated as `value <op> target`).
- `QuestState` / `MissionState`: 0 none, 1 available (missions only), 2 processing, 3 completed, 4
  failed, 5 disabled.
- `reverse` negates the combined result.

### how the game applies them

the client always enables streaming scene state 0, then sets streaming state `index + 1` to each
condition entry's result, recomputing on input changes:

- **conditioned**: follows quest, mission, or variable state.
- **condition-less**: always off under this MapConfig. a dungeon streaming the open world supplies
  its own MapConfig with conditions for those states (e.g. `dung01_rdg010` conditions
  `dung01_rdg010_liino*` on map01's streaming scene).

level scripts (`SetOverrideSceneState` / `RemoveOverrideSceneState`) and dialogue timelines can
temporarily override a conditioned state by name. the override is unsaved and clears when the
state's condition changes, the MapConfig changes, or the scene rebuilds. overriding a condition-less
state does nothing. examples: `dung01_rdg010` turns `dung01_rdg010_liino_platform` off;
`dung02_bdg002` and `dung02_dg003` turn `Nefarp_dragon_red` and `Nefarp_human_green` on;
map02_lv005's script 23200050005 swaps `Map02_lv005_fields_unrise` for `…_rise`.

the client holds no player state; quest, mission, and variable values come from the server.

example (map01 in one client build):

| index | state                          | condition                    |
| ----- | ------------------------------ | ---------------------------- |
| 0     | `001_normal`                   | quest `e1m8_q#3` = completed |
| 1     | `001_damaged`                  | quest `e1m8_q#3` ≠ completed |
| 2     | `001_overcast_rainy`           | quest `e1m2_q#6` ≠ completed |
| 3     | `001_sunny`                    | quest `e1m2_q#6` = completed |
| 6     | `dung01_rdg008_006_liino`      | none                         |
| 7     | `dung01_rdg008_006_liino_hide` | mission `e0m2` = completed   |

map02's field and flower states share two variables and switch together; its lv009 day/night pair
does not (day tests map variable `State` = 0, night has no condition).

### where states are referenced

- **static chunk files**: `InitChunkData_<x>_<z>_<sceneStateId>_<areaId>`. `sceneStateId` is
  `index + 1` (0 = always loaded); `areaId` is the stream area.
- **dynamic entities**: `RootComp` and each `ResourceGroupWithStateDesc` hold a visible-state span
  (MapConfig indices directly, without +1; distinct from the resource group's `sceneState` field at
  offset 24). each visible-state span is followed by a visible-area span (`VisibleAreaGroup`:
  `RootComp` +60, resource group +64) of stream area ids; any listed area shows the entity, and area
  0 shows everywhere.
- **irradiance volume**: stores bakes for scene states and combinations, selected by active
  scene-state mask ([irradiance.md](irradiance.md)).

### what they gate

- **static renderers**: chunk files with non-zero `sceneStateId` load while that state is on;
  entities in state 0 always load. HLOD clusters exist only in state 0.
- **environment/post volumes and water surfaces**: gated by chunk file the same way
  ([environment.md](environment.md), [water.md](water.md)). volumes inside dynamic prefabs load with
  their placement ([prefab volumes](environment.md#prefab-volumes)).
- **dynamic entities**: both the entity's list and the resource group's list must have at least one
  active state (AND of two ORs), alongside the entity's other gates.

### variables

variables are server state synced on map entry. any test on an unset variable fails regardless of
operator (so `≠ 1` is false while unset). an unsent map variable falls back to a client-only
variable of that name, then MapConfig's `mapVarClientDefaultValues`, before counting as unset. no
level script writes map or global variables (`SetInt`/`SetBool` write script blackboards).

two kinds of map variables:

- **interactive properties**: templates with `useMapVar` publish saved properties as map variables.
  `Data/Json/GameplayConfig/AutoNameMapVarTable.json` lists them per map in parallel arrays: numeric
  key (`mapVarIntKeyList`), owning interactive logic id (`mapVarBelongEntityList`), property
  (`state`, rarely `hp_ratio` or `is_enabled`), and fresh-world default (`mapVarDefaultValueList`).
  a few hundred entries span ten maps (mostly map02): blight/sludge cores, anchor-wave cores, Wuling
  bridges, drawing puzzles, rifts, waterwheels, aqua pipelines, outfalls, monster hearts, and the
  blue sword. defaults are 0 except two map02 sludge cores (1), some drawing puzzles (1), monster
  hearts (2 or 4), anchor-wave cores (`state` 1, `hp_ratio` 100), and indie_dg007's two 18 m Wuling
  bridges (1, extended). the server applies these defaults; the client only loads the key maps.
  other templates' saved properties (e.g. doors, campfires) stay private to the entity.
  `AutoNameGlobalVarTable.json` is empty, and no template sets `useGlobalVar`.
- **named variables**: listed in MapConfig `mapVarNumId2Name` (over half of map02's keys). the
  client ships no values (map02's `mapVarClientDefaultValues` is empty). global variables have no
  client name table.

notable server-only variables:

- map02 gateway blockers (active while = 2; referenced nowhere else in client data): `007to009`
  (#201) blocks Yinglung Pass → Snowy Forest near (−402, 258, 570); `008go010deco_v1d6` (#388)
  places crystal spikes over a North Wuling Exclusion Zone gate near (150, 275, 1205).
- map01_lv006 Origin Lodespring: the crater's light column picks an effect prefab per global
  variable value (0, 2, 3, 4; in-game matches 2). red-ringed spires gate on another variable = 9999
  (sentinel; not shown in game).

MapConfig conditions reference variables by name (`mapVarName`, `globalVarName`), while dynamic
gates use numeric game-variable ids.

## dynamic load gates

all gates on an entity must pass unless a load override is active, which wins outright. the client
sets overrides when an erosion core is destroyed (unloading patches before variable sync), from
cutscene/dialogue/timeline hide settings, and from `ForceShowDecorationWithHandle`.

- **mission gate (`MissionControlComp`)**: list of
  `MissionCondition { id, isQuest, state, isSame }`. a condition holds when quest/mission state
  equals `state` (`isSame` 1) or differs (otherwise). `compareType` 0 requires all conditions; any
  other value requires one. the entity loads when the combined result equals `toBeTrue == 1`.
- **variable gate (`GlobalVarControlComp`, `MapVarControlComp`)**: with `controlLoad` 1, loads while
  `variable <compareType> compareValue` holds (fails if unset; map-variable gates on another map id
  always fail). with `controlLoad` 0, does not gate loading and instead drives entity level and view
  state ([below](#view-states-on-dynamic-entities)).

variable gates use numeric game-variable ids; MapConfig's `mapVarName2NumId` and `mapVarNumId2Name`
map names to ids, and `mapId` (e.g. 85 for map02) identifies the map. MapConfig conditions and
dynamic gates can share a variable (e.g. map02's `map02lv005stateflower` is #125). map01's name
tables are empty.

### gates on another map's variable

a map variable gate checks its map id against the current scene's numeric `mapId`; mismatches fail
and prevent loading. dungeons streaming an open world use this to dress shared levels under their
own MapConfig without leaking into the open world (and vice versa).

example — Snowy Forest cabin (map02_lv009, near unity 0, 195, 474):

- dungeon `dung02_rdg009` (mapId 376, mission `c34m3d5`) gates its after-ritual set (`…yishihou`:
  floor rune `p_fxmap_map02_lv009_big_runes_01`, lights, props, decals) on its own `magic` (#2) = 0,
  so it never loads in the open world.
- open-world looks use map02's `woodhouse` (#295, server-driven): 0 = `…house_light_off` + cobwebs;
  1 = `…house_light_on` + `Env_map02_lv009_house_light_on` volume; 2 = painted rune decal +
  `Env_map02_lv009_house_yishiqian` ("before the ritual") volume.
- day/night rune effects (`p_fxmap_map02_lv009_cottage_rune_02`/`_01`) follow day/night scene
  states. rune decal group 36100050009 shows when script 36100050016 (server task waiting on quest
  `c34m3_q#2`) detects the player entering the cabin.

### view states on dynamic entities

a DynamicStreaming entity with `ModelViewStateControllerNewComp` names a
`ModelViewStateControllerData` file via `modelIdStrId`
([view states](interactives.md#interactive-view-states)). every variable component on the entity
(regardless of `controlLoad`) applies its value on load and on change:

- values 0–31 set the entity's level, selecting resource groups by `logicState` bitmask (the same
  selector used by settlements, POIs, factory regions, trees, and interactive power state).
- the value also sets the view state machine's int key `state` (other interactive properties like
  `hp_ratio` set a key of their own name).
- a global variable additionally sets the entity's Animator to `State_<value>`.
- an unset variable does neither, keeping the starting pose.

every view-state entity has one model row with `logicState` 0, so states change poses and switches
rather than swapping prefabs:

| type                               | owners                       | driver                                                                                                      |
| ---------------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 3 `MVCByTrigger`                   | map02, ~200                  | entity's `TriggerComp` box sets bool `InTrigger` (lotus leaf reaction)                                      |
| 4 `MVCWithoutIdControlByGlobalVar` | map01, 1                     | global variable (The Hub → Valley Pass bridge, raised/lowered)                                              |
| 5 `RefInteractiveState`            | map01, a few dozen; map02, 1 | interactive state (`InteractiveStateComp`) on legacy controller (`state_off`, `state_on`); ids unresolved   |
| 34 `MVCWithIdControlByGlobalVar`   | map02, ~200; map01, few      | global variable (map02: floor tiles sharing a few vars; map01: machine doors)                               |
| 37 `InteractiveMapVarProxy`        | map02, ~100; map01, few      | one map variable per owner (puzzles, magic [Wuling bridges](interactives.md#wuling-bridges), rifts, wheels) |
| 40 `MVCWithIdControlByMapVar`      | map02, a few dozen           | map variable (towers, bridges, dreamcatchers, altar rocks)                                                  |

the server sets these variables. the only script writer, `SetDecorationViewState`, targets map02's
single type-33 entity (`MVCWithIdControlByScript`). a few owners also set `controlLoad` 1 on the
same variable. type-5 interactive ids (`300002576`–`79`, `2100390192`/`97` on map01) aren't
LevelData rows on map01 or map02.

among map02's ~100 variable-driven models, ~2/3 toggle GameObjects by `state`, ~1/4 switch clips,
and the rest play effects (water pipes are driven by `DynamicSceneWaterPipeSystem`,
[below](#water-pipes)). examples: magic bridges (`off`/`on`), drawing puzzles (`Off`/`On`), Si's
Painting Maliang reveals (`dyn_Maliang_*`, `Disable`/`Enable` > 0), align patterns
(`Empty`/`Phantom`/`Entity`), Snowy Forest tower (`off`/`light_on`/`on`), floor tiles
(`off_idle`/`on_idle`), progress towers (0–6), rifts (`Unsuppressed`…`Filled`), waterwheels
(`Stop`/`Rotating`). indie_dg016's type-40 floor owners name models with no layers.

### outpost tiers

Yinglung Pass (`stm_hongs_3`) uses map variables instead of `logicState` bitmasks for per-tier
scenery (beacon beam, boards, screens): four `ResourceWithIdControlByMapVar` owners loading while
`judianEffect1`–`4` (#321–324 on map02) equal 1. their entity ids follow the outpost (`u`) and
factory region (`u + 1`) on consecutive variable ids. no other outpost on map01 or map02 uses this
pattern. no readable client data sets these variables (most Lua scripts are encrypted); their link
to outpost level is inferred from naming and layout.

other server-driven gates work similarly: Yinglung Pass's energy point towers swap red/green sets on
`defenceFnish` (#297, = 0 / = 1), with no client quest, script, or scene-state reference.

### blight and its cores

each clearable blight patch (`P_erosion_map01_dynamic…`, [erosion](materials.md#erosion)) is a
type-36 `ErosionMapVarControl` entity containing:

- `ErosionRootComp`: core's LevelData logic id (`erosionCoreId`), an authored core position (a few
  metres from the core's placement), and piece positions
- `ResourceComp`: patch meshes and smoke effects (`P_fxint_s_erosionsmoke_801`)
- navmesh-area component (blocks navigation while present)
- map variable gate loading while variable ≠ 2

the core is an `int_erosion_core` interactive (`ErosionCoreComponent`, `useMapVar`): `state` 0
inactive, 1 active, 2 destroyed. map01 has a few dozen erosion roots, each paired via
[AutoNameMapVarTable](#variables) (map 2, #3–#44, unnamed in MapConfig; fresh-world default 0) to
its `erosionCoreId` (holds for every root on map01 and dung01_wrdg001). destroying a core triggers
an immediate client unload override before variable sync; while unset, blight doesn't load. map02's
[sludge](#sludge-and-miasma) pairs with its cores the same way.

## progressions

settlements (outposts), POI facilities (Trial of Swordmancy, archery range, inn parts), and factory
regions are DynamicStreaming entities with `SettlementControlComp`, `PoiControlComp`, or
`FactoryRegionControlComp`. the controller's logic state is the progression level.

each `ResourceGroupWithStateDesc` carries a `logicState` bitmask (bit `n` set = shown at level `n`;
0 = ignores logic state) and `levelNum` (LevelConfig `idNum`). all variants sit side by side in the
same scene (no file swaps), mostly exclusive per level, though some span multiple levels and group
counts need not grow monotonically.

- **settlements** have a main and secondary controlling entity. whether bit 0 means "unbuilt" or
  "level 1" is unknown: `RequireSettlementShow` targets levels 1–4 (2–4 at some settlements),
  suggesting bit 0 is pre-first-upgrade.
- **POIs**: Trial of Swordmancy and archery range use bits 0–4 while `SimulationTrainingLevelTable`
  lists 4 levels; Si's Painting's inn table uses 1–4. progress is per facility.
- **controller-less entities**: some carry non-zero masks with no client driver.
- **trees** (entity type 19, no controller): reuse bits 0/1 for standing/felled (runtime harvest
  state, not progression).

### outpost upgrade missions

`SettlementBasicDataTable.settlementLevelMap` defines levels 1–4 (`isFinalMaxLevel` on 4). levels
1–3 each name an `upgradeMissionId` (e.g. Cardiac Remediation Station `stm_hongs_2` lists
`f1m19d1`–`f1m19d3`, "OD Project: Remediation Station I–III"). completing a level's mission moves
the outpost past that level (`unverified:` whether it upgrades immediately or only unlocks the
upgrade). level numbers match `logicState` bits (`lt_Map02_据点_lv2_r`–`lv4_r`).

scenery gated on an upgrade mission acts as per-level outpost scenery: e.g. Cardiac Remediation
Station's green light column (`p_fxmap_map02_lv004_landmark_poi_801`) loads once `f1m19d3` is
complete (level 4).

## facility visual forms

six interactive templates use `InteractiveModelLevelUpComponentData`
([interactives](interactives.md#placements-and-models)): stock redistribution
(`int_system_domain_shop`), depots (`int_system_domain_depot`), recycling stations
(`int_doodad_core_recycle`), monitoring terminals (`int_system_kite_station`, Wuling City and Marker
Stone), farm terminals (`int_system_farm_terminal`), and simulation training
(`int_system_simulation_training`).

they are LevelData interactives, not DynamicStreaming entities. `InteractiveModelComponentData`
names the base model (for recycling stations, form 1), and `modelLevelList` lists ModelTable ids in
authored order, each with its own prefab (e.g. `int_system_kiteStation_<n>_postmodel`). form indices
are list positions; how gameplay upgrade levels (shop channels, depot levels,
`KiteStationLevelTable`) map onto them isn't recovered.

all other interactives have a single model (variant's, else template's), such as Dijiang's guest
terminal desk and screens. [doors](#doors), [telescopic bridges](#telescopic-bridges), and
[region walls](#dijiang-region-walls) follow runtime state; placement existence is server-controlled
([spawning](interactives.md#spawning)).

## event placements

limited-time photo events (`ActivityTable` type 4 `PhotoTaking`, and multi-stage photo stages) use
ordinary LevelData rows (`createState` 0) in per-event layers
(`<level>_lv_data_sub_snapshot_activity_v0d8`, `_v1d1`, `_v1d6`, and
`base01_lv001_lv_data_sub_a1m10` for mission `a1m10`, "Snapshot: Etchings of Our Cosmic Dreams").
LevelConfig lists these layers with no client open/close logic, so the server decides whether spots
exist while an event runs.

spots use template `int_activity_snap_shot` (model `int_system_snapshot_postmodel`, yellow light
column; Dijiang has one in front of the logo wall at unity 12, 1, −16) with
`ActivitySnapshotComponent` (type 2000: `identify`, camera pose, `conflictQuestIds`). every such
placement sits in an event layer. `progressLockCondition` gates interaction, not existence.
`int_snapshot_empty` rows are invisible photo targets.

## destructible props

map01 and map02's type-20 dynamic destructibles hold one resource group (`logicState` 0, no
controller) for the intact model only; destruction removes the prop at runtime. interactive
destructibles (`int_destructible_*`, `int_breakfloor`, `int_steam_blocker`, `int_fire_wall*`,
breakable boxes) are separate LevelData placements whose scripts can test
`CheckInteractiveDestroyed`.

## sludge and miasma

map02's spray-clearable sludge consists of a few dozen type-25 DynamicStreaming entities
(`SludgeComp`, map variable gate, no resource group). each names a LevelData core in the
`int_erosion_sludge_core` family (`empty` variants presumably have no visible core; every drawn core
uses `int_erosion_sludge_core_official` and is named by a patch) and loads while its core's variable
is 0.

`ErosionSludgeCoreComponent` uses the same states as blight cores (0 inactive, 1 active, 2
destroyed), published to AutoNameMapVarTable for every patch on map02 and indie_dg016. thus sludge
unloads once its core is activated (before destruction). two map02 cores (#30, #35) start a fresh
world at 1 (sludge hidden). active core visuals in game aren't checked.

sludge is not a mesh: each `SludgeComp` carries a 64×64 BC7 heightmap (`texGuidHash` →
`Slu__<level>__<local id>.png`: RG octahedral normal, B normalised height `0..1`, A coverage),
`sludgeSize` / `sizeY`, a local-to-world frame (`originW`, `up`, `right`, `forward`), two packed
clip planes (`encodedClipPlane0/1`), and a material (`matGuidHash` → `M_sludgeV2` or
`M_sludgeV2_high`, shader `HGRP/SludgeV2`). the vertex stage displaces a grid over that heightfield
with radial wave motion, and the fragment stage blends scrolling textures, pulsing polar veins, edge
highlights, and emissive cores. sprayed sludge regrows (`rebornTime`) until its core is cleared.

North Wuling Exclusion Zone's blight miasma (map02_lv008) is five type-51 entities whose resource
groups hold smoke, dust, fog walls, and small fires, each loading while its map variable (#191–195)
is 0.

## Dijiang cabins

Dijiang (`base01_lv001`) has four cabin slots (`ExtraSceneSlot`, type 29), each stored on two
entities with identical `ExtraSceneComp` (bounding box with per-axis swapped corners, origin,
direction). cabins are separate model-row-only scenes at
`Data/DynamicStreaming/PC/Extra/<scene>/fb_main_*`, named by `Data/Json/SpaceshipCabinData.json`
(`cabinSpawnInfos.<type>.dynamicSceneUniqueId`: manufacturing cabins and growth chambers).

a built cabin places its rows at the slot origin, rotated by `direction` in quarter turns of yaw.
its entrance (NPC walkway start at local +x) meets the slot door, and the medium slot's box matches
the growth chamber. each built cabin uses its own irradiance bake
([region bakes](irradiance.md#region-bakes)).

room mapping (one cabin type per room; slots don't name rooms and their ids collide with LevelData
ids, so doors link them via `system_inst_key`):

| room       | size   | construction area     | slot position                                               |
| ---------- | ------ | --------------------- | ----------------------------------------------------------- |
| `room_a_1` | small  | `construction_area_1` | near (15, 5, 85)                                            |
| `room_b_1` | medium | `construction_area_1` | medium slot                                                 |
| `room_a_2` | small  | `construction_area_2` | near (−13, 5, 130)                                          |
| (none)     | small  | —                     | near (12, 5, 130); no door or `SpaceshipEmptyRoomTable` row |

growth chamber planting boxes:

- each box prefab has a shutter (`nonTransparentPlate`) closing the lower tank, hidden once
  unlocked.
- `SpaceshipGrowCabinLvTable` unlocks fields 1–3 at level 1, 4–6 at level 2, and 7–9 at level 3
  (`SpaceshipGrowCabinBoxIdToUnlockLevelTable` is the inverse). `unverified:` field numbers match
  resource-group box order (this opens the three tanks facing the console at level 1, matching the
  game).
- planted crops, box status bars, room nameplates, and operator panels are runtime UI, not scene
  meshes. manufacturing cabin levels change runtime state only.

## Dijiang region walls

Dijiang's "no entry" walls (`int_system_spaceship_region_wall`, `SpaceshipRegionWall`) block
construction areas named by placement parameter `system_inst_key`. the game hides the whole wall
once its area unlocks per `SpaceshipAreaUnlockNeedCenterLvTable`: `construction_area_1` at Control
Nexus level 1, `construction_area_2` at level 3. `construction_area_3` and `_4` have no table row,
so their walls always show.

## doors

door poses are in [interactives.md](interactives.md#interactive-doors). doors open from server and
gameplay state not held by the client. for example, Power Plateau's U.W.S.T. door (2800000227, near
−80, 175, 626) opens when script 2800000050 receives `TLCall_e3m3_1` from mission e3m3's timeline
and calls the server. script-to-interactive links live in LevelData's `levelScriptBriefDataDict`
(`interactiveActiveRiskEntityIdList`, `refWorldEntityIdList`), not in script files.

- **Dijiang cabin doors**: open when their slot is built, closed (`unlocked` shows
  `P_fxmap_base01_lv001_ship_door_06_01`; `locked` shows `…_08_01`) when empty. slots don't name
  their doors; small-slot doors stand 9 m from slot origin, medium-slot doors 10.2 m.
- **Dijiang reception room door (`system_inst_key` `guest_room`)**: opens via server-only unlock.
  `SpaceshipRoomLvTable` level 1 has no condition (only text "Progress through the main story to
  unlock this cabin"), and no Control Nexus table, mission, or script unlocks it (mission `f1m22` at
  Control Nexus level 3 places an NPC inside, so it's open by then).

## telescopic bridges

telescopic bridges ([interactives.md](interactives.md#telescopic-bridges)) retract (0) or extend (1)
by entity `state` (template default 0). runtime drivers (switches, scripts, server) aren't traced.
map01 places about ten, half in The Hub.

## doodad groups

resource nodes (ore outcrops, rabbit-hole plant mounds, special stones) are `int_doodad_core_*`
interactives whose model is an empty shell. a root script names one ModelTable id per group level
1–4 and lists one slot GameObject per level (slot 0 empty) where the form attaches. all shipped
shells have identity slots; which slots are saved active varies (level 4 only or all four) and does
not indicate the shown level. form postmodels carry the same script with all forms empty.

group levels come from unrecovered runtime progression.

## graded doodads

breakable crates (`int_doodad_grade` and variants) and supply boxes swap their template model for
one of four forms on start and on source-level change:

- placement `doodad_id` → `DoodadGeneralTable.upgradeSource`: 0 none (keep template model), 1 world
  level, 2 domain development level, 3 inn level.
- entity property `upgrade_need_level` (5 entries; entry 0 unread, entries 1–4 = thresholds for
  forms 1–4): picks the highest form whose threshold is met (below entry 1 indexes form 0, which
  fails and keeps the template model).
- entity property `doodad_form_list`: four ModelTable ids. placements can override both lists (e.g.
  map02 crates need `0,1,6,9,15` in lv001–lv005, `0,1,2,3,4` in lv006, and `0,1,9,15,24` in
  lv007–lv010).

Wuling crates follow domain development level (server-saved): form 1 (`int_doodad_artificial_1`) is
a cardboard box, 2 a taped plank crate, 3–4 a framed crate (same mesh and material). supply boxes
(`int_doodad_food_*`) list one model for all four forms (upgrade source and food component loader
unread). the swap runs through the model component's view-state proxy, which exists even for models
without view-state data.

## script groups

an entity with a script-control component stores a default-load flag (0 or 1; 0 requires a script to
enable it). scripts address it by `IdComp.uniqueId`. the client caches the last scripted value per
id for the scene's lifetime (even before the entity streams in) and clears it on map reset; before
any script writes, the default-load flag applies. leading digits of `uniqueId` are the authoring
level's `idNum` (`228…` Wuling City, `404…` racing dungeon), not necessarily the level it sits in.

event example: Runners' Steeplechase (`ActivityTable` `activity_parkour`, type 50, mission `a1m15`)
runs in four dungeons (`dung02_rcdg001`–`004`) streaming map02 with no scene-state conditions. each
course is a hidden-by-default script group in Wuling City (a few thousand renderers each:
40400000002 Pavilion Hop, 40600000002 Wind Step, 40700000002 Cloud Stroll, 42100000002 Bastion
Trek). each dungeon script shows its own course and hides the other three; open-world script
22801170008 hides all four on activation.

### what sets a script group

level scripts (`Data/Json/LevelScriptData/<level>/<script id>.json`) toggle groups with
`ShowSceneDecorationNew`, `ShowSceneDecorationNewWithHandle`, or `ForceShowDecorationWithHandle`
(`targetDynamicEntity`, `visible`).

a script is a graph of `actionList` and `headerList` nodes keyed by `ID`:

- **edges**: `nextID`, `IfElseAction.onTrueID`/`onFalseID` (guard `condition`),
  `CheckBoolIfTrue`/`CheckBoolIfFalse` (`nextID` guarded by `value`), switch
  `caseIDList`/`defaultID` (guard `value`), branch `idList`, and other `…ID` fields. example: Wuling
  City's dragon eye glow (map02_lv002, entity 22800080003) shows on activation past a
  `CheckBoolIfTrue` checking mission e10m4 complete.
- **header guards**: a header fires only while its `validate` param holds.
- **params**: constant (`paramSource` 0), current script (1002), getter node
  (`CheckMissionOrQuestIsComplete`, `CompareQuestState`, … via `idRef`, `paramSource` −1), or
  `$<id>@_<field>` referencing another node's output.

header event kinds:

- `ScriptEvent_OnScriptActive` (`…OnScriptStart`, `…OnScriptPreActive`): script running. the server
  sets script state by progress; a script runs while the player is inside `startShapeList` /
  `activeShapeList` (`offset`, `radius`), or via `ManualStartLevelScript`.
- `ScriptEvent_OnLeaderEnterTriggerVolume` (and leave, list): player entering/leaving
  `triggerVolumes` (`triggerSlotIdFilter`). a volume's `shapeList` is a union of shapes
  ([trigger volume shapes](#trigger-volume-shapes)); `exitShapeStartIndex` is −1 in all seen volumes
  (presumably splits exit shapes; unverified).
- `EntityEvent_*`: interactive event on `targetEntity` (script's `interactives` slot with
  `entityDataIdKey` and `position`, or LevelData logic id; see
  [placements and models](interactives.md#placements-and-models)).
- `LevelEvent_OnQuestStateChanged` / `…OnMissionStateChanged`: quest/mission event
  (`filtedQuestId`).
- `ScriptEvent_OnCustomEvent` / `LevelEvent_OnCustomEvent`: raised by `RaiseCustomScriptEvent` or
  `RaiseCustomLevelEvent` with matching key.
- stage/property/other events: driven by the server (no client node writes script stages or
  properties).

scripts toggle LevelData interactives via `EntityShow`/`EntityHide` (`entityPtr`),
`EntityShowList`/`EntityHideList` (`entityListPtr`), and `SetEntitiesVisibility` (`targetEntities`,
`isVisible`, `resetVisible`, `visibleSource`). pointers target LevelData `logicId` (`useSlotId` 0)
or a script `interactives` slot. map01 and map02 scripts reference a couple hundred such targets
(~half LevelData rows); placements have no stored hidden flag, so pre-script visibility isn't known.

cross-level scripts can target a scene's groups (e.g. racing dungeons). missions whose objectives
read a script's stage or property cause the server to run that script as the mission progresses.

### groups that follow the player

some scripts toggle scenery strictly on entering/leaving a trigger volume. in Jingyu Valley's tree
cave (map02_lv001, near unity −1046, 229, −1400), script 10100030016 (active shape 350 m around
−910, 249, −1255, no quest checks; unknown whether server starts it unconditionally) hides skylight
roof rocks (group 10100030008) inside volume 80003 (three 78–92 m spheres) and shows group
10100030005 only inside volume 80004 east of the cave.

### trigger volume shapes

`LevelScriptTriggerVolumeShapeData` defines a local frame (`position`, Unity Euler `rotation` in
degrees). testing transforms the player into that frame:

| `shapeType` | kind     | inside test                                                                                                                                          |
| ----------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1           | box      | within `±size / 2` per axis (tests player capsule radius)                                                                                            |
| 2           | sphere   | within `radius` of origin (tests player capsule radius)                                                                                              |
| 3           | polyline | within `±size / 2` box (`size.y` = height centred on `position`) and local (x, z) inside `polyLinePoints` (split into convex parts; point test only) |
| 4           | infinite | everywhere                                                                                                                                           |

groups set only on volume entry (no leave events) keep the last entered volume's state. Snowy
Forest's sky aurora (map02_lv009, script 36100010049, active within 397 m of unity 26, 175, 453)
uses three same-yaw polyline volumes:

- 80001 (western cliffs, x −295 to −131, y 140 to 266): shows far aurora (36100010036,
  `p_fxmap_map02_lv009_aurora_02`), hides near (36100010035, `…_aurora_near_02`)
- 80002 (valley east up to y 234): shows near, hides far
- 80003 (high ground north-east, y 252 to 407): hides both (both authored hidden)

`triggerCountLimit` is 0 for reusable swaps and positive for one-off events (decompilation unread;
inferred firing cap). in Wuling Very Large Rift (dung02_dg005), script 37000020007's volume 80005
(150 m sphere at 19.9, 100, 0, limit 1) plays `cs_video_e11m7_3` and swaps the rift behind a black
screen: hides portal/black hole (37000020003), swaps dark lights/beams (37000020002 off, 37000020001
on), and shows 37000020006.

### following quest checks on activation

some scripts set groups from quest state on every activation: Power Plateau's fortress gate scripts
show the open gate and hide the closed one when `validate` = mission `e3m5` complete; another shows
construction props if mission `e3m6` is complete and hides them otherwise.

### level scripts

level scripts are [MemoryPack](containers.md#memorypack) payloads whose schema comes from IL2CPP
metadata (`global-metadata.dat`) and `GameAssembly.dll`. every shipped level script decodes to its
exact byte length.

## other runtime state

runtime scenery mechanisms beyond the selectors above (from a census of DynamicStreaming scenes and
all few thousand shipped level scripts). outfalls and anchor-wave proxies are standard
[variable gates](#dynamic-load-gates); scripts, the player, or the server drive the rest:

| mechanism                  | stored in                                                                                                                                                                                               | driven by                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| water pipes                | entity type 30 with `WaterPipeComp` and view-state controller (`dyn_waterPipe_postmodel`); six on map02 (`map02_lv001`), four in `dung02_cdg004`                                                        | `int_aquapipeline` `state` mapVar; `SetWaterPipeRotateState` |
| outfalls                   | entity type 35, loading while its `int_outfall`'s `state` variable is 1 (dung02_cdg004)                                                                                                                 | pipe chain                                                   |
| anchor-wave cores          | `int_anchor_wave_core` (`state`, `hp_ratio`, `is_enabled` as map variables) with three type-37 proxies loading while `state` ≠ 0 (map01)                                                                | player; `RefreshAnchorCoreDecoration`                        |
| bamboo puzzles             | `int_move_bamboo`'s saved `current_pos_index`; `MoveBambooNext` (~200 uses, mostly map02), `SetBambooPosIndex`, `MoveBambooLast`; `BambooRaftWideConfig` names a raft and spline                        | scripts and player                                           |
| rune columns               | script module `RunePuzzleData`; `SetRuneColumnUnstableState`, `SetRuneColumnShowHide`, `MoveRuneColumns…`                                                                                               | scripts                                                      |
| entities moved by script   | `EntityMoveToWithDuration` (commonest, several hundred uses), `SetEntityPosition`, `EntityMoveToWithSpeed`, `SetEntityEulerAngles`, `EntityRotate*`, `EntityAttachToParent`, `AttachEntityToDecoration` | scripts, mostly transient                                    |
| scripted Animators         | `SetAnimatorInt` and `SetAnimatorTrigger` (a few hundred uses) on interactives, dungeons only; [decoration animators](animation.md#decoration-animators)                                                | scripts                                                      |
| scripted factory buildings | `FacChangeBuildingTemplate` (map01 and map02), `FacPlayBuildEffect`                                                                                                                                     | scripts and quests                                           |
| conveyors                  | entity types 10, 11, 12 (belt, box, group with spline and speed; dozens on map01); belt view states scroll UVs by factory `speed`                                                                       | always moving                                                |
| water look override        | `WaterConfigOverride` (map02_lv010 script 37900070004): swaps water material slot 21 for `Config_water_Map02_29` over 1 s, then releases                                                                | script                                                       |
| water progress sync        | script module `WaterProgressSyncData` (mostly map02): decrease ratio and cooldown over listed entities                                                                                                  | runtime                                                      |
| energy point volumes       | LevelData `environmentVolumes` (`LevelEnvironmentVolume`: `Env_EnergyPoint_<level>`, blend mode 2, polyline, priority 300; map01 and map02)                                                             | presumably energy point state (`WorldEnergyPointTable`)      |
| Dijiang perform objects    | `SetSpaceshipPerformObjectActive` (base01_lv001 script 9800280001) by `SpaceshipGameLevelObjectType`                                                                                                    | script                                                       |
| dynamic occlude areas      | LevelData `dynamicOccludeAreas` (map01 and map02): quest condition and factory grid lines (reads as build blocking, not scenery)                                                                        | quests                                                       |
| cutscene hides             | `PlayLevelSequenceAndControlSceneObjects` (commonest), `PlayDialogAndHideSceneObject`, `StartCutsceneAndControlSceneObject`, `StartCutsceneAndHideSceneObject`                                          | scripts, during cutscene only                                |
| extra streaming            | `LoadExtraStreamingAction` and its clear: position to preload around                                                                                                                                    | scripts                                                      |

uninspected: rune columns, water progress sync, Dijiang perform objects, and map01's
`FogNestControllerData` and `SpecialSightControllerData` modules. no time-of-day volume or weather
table exists (map02_lv009's night is a scene state). `LevelConfig.enableFactoryBuildingSnowCoverage`
is set only on map02_lv009; no level sets `isDimensionLevel`. seats (type 6) hold no resources, and
snowfall trees (types 50, 52) only react to the player.

### water pipes

a rotatable water chute (`int_aquapipeline`, entity type 30) carries `WaterPipeComp` (48 B:
`initialAngle`, `targetAngle`, `isConnectedToWaterWheel`, `interactiveId`, `upstreamInteractiveId`,
`delayActivateDownStream`, `heightToDownStream`, `heightToGround`, `isOutFall`), a
`MapVarControlComp` (`controlLoad` 0) reading its `int_aquapipeline` `state` variable (fresh-world
default 0 in `AutoNameMapVarTable`), and `ModelViewStateControllerNewComp` naming
`dyn_waterPipe_postmodel`. an outfall (`int_outfall`, entity type 35, `isOutFall` 1, in
`dung02_cdg004`) carries `WaterPipeComp` and loads while its `state` variable is 1.

`DynamicSceneWaterPipeSystem` drives each non-outfall pipe from its `state` variable and upstream
chain:

- **rotation**: on `OnModelViewStateLoad`, sets the child `Animator` Transform (`RotateRoot` in
  `int_waterPipe_postmodel`) world rotation to `Euler(0, targetAngle, 0)` when `state` is 1, or
  `Euler(0, initialAngle, 0)` for any other set value (leaving it as authored while unset).
- **upstream water**: water is present if `upstreamInteractiveId` is 0 (fed directly by a
  waterfall), else if the upstream entity is an active outfall (`state` 1), else if the upstream
  pipe is rotated to its `targetAngle` and itself has water.
- **effects (`dyn_waterPipe_postmodel`)**:
  - no upstream water → `waterState` 0 (`NoWater`), switching `Effect` off (`effectLength` −1)
  - has water, not at `targetAngle` → `waterState` 2 (`Ground`), switching `Effect` on with
    `effectLength = heightToGround` on `WaterFall` and `Splash` (`VFXAdjustLength`)
  - has water, at `targetAngle` → `waterState` 1 (`DownStream`), switching `Effect` on with
    `effectLength = heightToDownStream` (and `toWaterWheel` true when `isConnectedToWaterWheel`,
    audio only)

hittable switches (`int_switch_attack_multi_state`, `TargetPipe` property) fire level scripts that
call `SetWaterPipeRotateState` and `CallServer`; the server updates each pipe's `state` variable and
the downstream waterwheel's (`int_waterwheel` / `int_big_waterwheel`) separate `state` variable.

## quest and mission labels

missions live in `Data/Json/MissionRuntimeAsset/<missionId>.json` (plain JSON; companion `_meta`
holds accept mode and reward). quest ids follow `<missionId>_q#<step>` (`e1m8_q#3`,
`e1m1_q#Deco_showLandslide`); `d` denotes a decimal (`e1m9d5` = 9.5). text keys resolve via
`TextTable` (key → text id) and `I18nTextTable_EN` (id → string with `<@…>…</>` rich-text tags).

- **mission**: `missionName.key` names it. `missionType` (0 Main, 1 Char, 2 Factory, 4 Hide, 5 Misc,
  7 World, 8 WeekRaid, 9 FakeMain, 10 Side, 11 Activity, 12 TBCMain) selects the quest-log tab
  (grouped into main, side, discovery, events, other). internal flag missions (`hidden*`, `dm*`)
  have no name. `levelId` is the mission's level, though its quests can switch other levels' scenery
  (e.g. Valley Pass's fort mission switches The Hub). character missions store `charId`.
- **chapter**: `missionChapterBitmask` bit 1 = chapter 1, bit 2 = chapter 2 (`chapter<n>_num`,
  `chapter<n>_name`); bit 4 = indie (no text). prologue missions (`e0m…`) carry bit 1 and are marked
  `chapter0` only by id.
- **episode**: no data links missions to episodes; main-story ids `e<n>m…` match `ep<n>_name`.
- **quest**: `questDic[<quest id>]` holds objectives and `descriptionOverride`. `mainPathQuests`
  orders the main flow (including hidden steps); side branches (`flowIndex` 1) start when
  `prevQuestIdList` completes. hidden quests (`showMode` 1000, no objectives) exist solely to drive
  scenery.
- some ids referenced by conditions are absent from the client (stale or unreleased). event day
  locks (`a1m3_q#Day2Lock`) are server-timed stages.

missions never mutate the world directly; their actions are presentation (radio, guides, chapter
panels) and most objectives are server-evaluated. scenery reads quest state through scene-state
conditions, mission gates, and level scripts.

## open

- named and global variables' offline values (global variables have no known name table; server
  values unavailable)
- an entity's level before any variable arrives (0 vs `RootComp` state), and behaviour of a
  view-state variable component (`controlLoad` 0) whose map id mismatches the current MapConfig
- `ActivityControlComp` gates: on map01 and map02 every component has no conditions
  (`compareType` 255) and no level script reads activity state, so limited-time events reach the
  world only via missions, event-dungeon scripts, and [event placements](#event-placements)
- mapping event photo spots to specific events (placements name only `identify` and sometimes event
  mission quests, not an activity)
- script groups with no client driver: over a third of map01/map02's several hundred groups fall
  into four sets of a few dozen each — id matching a level script's id, ghost-wall decorations
  (`GhostWallModuleData.outerEffectDecoId`), animator/attach-only targets, and unreferenced groups
- what enters steeplechase course dungeons (no client script or mission names them)
- gameplay-level → visual-form mapping for shops and depots, and runtime state of other interactives
- meaning of progression bit 0 per controller kind, and which entity's state the server sets
