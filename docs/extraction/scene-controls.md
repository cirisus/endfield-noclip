# scene controls

the packer turns conditional game content ([scene states](../game-data/scene-states.md)) into one
control/condition system exposed as preview controls in the viewer
([viewer scene states](../viewer/scene-states.md)). spatial
[stream areas](../game-data/world.md#stream-areas) are a separate axis controlled by camera
position. binary/JSON encodings are in [conditions](../package-format.md#conditions).

controls model game state directly (one control per quest, mission, or variable; scene states
derived from them), so contradictory conditions on the same quest (`quest = completed` and
`quest ≠ completed`) never hold simultaneously.

mapping of [game selectors](../game-data/scene-states.md#the-selectors-at-a-glance) to package
controls:

| selector                   | package control                                    | default                                                 |
| -------------------------- | -------------------------------------------------- | ------------------------------------------------------- |
| quest / mission state      | `quest:<id>` / `mission:<id>` (state values)       | completed (finished story)                              |
| map / global variable      | `mapVar:<map>:#<id>` / `globalVar:<name>` (ranges) | highest compared value                                  |
| MapConfig scene state      | `sceneState:<index>` (derived from condition)      | derived under defaults above; condition-less states off |
| mission gate               | requirements on quest/mission controls             | —                                                       |
| variable gate              | requirement on variable control                    | —                                                       |
| progression                | `<kind>:<key>`                                     | highest authored level (finished world)                 |
| facility visual form       | `facility:<interactive id>`                        | last visual form (fully upgraded)                       |
| campfire activation        | `activation:<interactive id>`                      | activated (finished save)                               |
| saved Animator bool        | `activation:<row id>`                              | set (finished save)                                     |
| script's saved property    | `activation:<script id>:<property>`                | set (finished save)                                     |
| player proximity           | `proximity:<interactive id>`                       | follows camera                                          |
| interactive created later  | `created:<level id>` (not created / created)       | not created                                             |
| event photo spots          | `activity:snapshot` (one per scene)                | off                                                     |
| doodad group level         | `doodadGroups:<level id>`                          | highest level named by shells                           |
| graded doodad form         | `domainLevel:<map>` (or `worldLevel`, `innLevel`)  | highest level needed by a crate                         |
| Dijiang cabin slot         | `cabin:<entity id>` (empty / built)                | empty                                                   |
| growth chamber level       | `cabinLevel:<entity id>` (table levels)            | level 1                                                 |
| Dijiang region wall        | `controlNexus:<level id>`                          | level 1                                                 |
| door                       | `door:<interactive id>` (closed / open)            | closed; cabin doors follow their slot                   |
| telescopic bridge          | `bridge:<interactive id>` (retracted / extended)   | retracted                                               |
| tree harvest state         | `harvest:<level tag>` (standing / felled)          | standing                                                |
| script group               | `script:<entity id>`                               | stored default, or derived from activation quest checks |
| script-shown interactive   | `script:<logic id>`                                | shown, or derived from activation quest checks          |
| controller-less logic gate | `logic:<entity id>:<mask>`                         | off                                                     |
| environment volume         | `environmentVolume:<index>`                        | on, except scripted volumes                             |
| water volume fill          | `waterLevel:<id>`                                  | authored fill; drained if a quest requires it drained   |
| fire seed level            | `fireSeed:player` (not carried / levels 1–5)       | highest level                                           |

each control's kind is its id prefix (`door`, `script`, …). `sceneControl`
([scene-control.ts](../../packages/extractor/src/game/state/scene-control.ts)) assigns its UI
category; controls register in any order with
[control-registry.ts](../../packages/extractor/src/pack/control-registry.ts).

interactive poses are in [prefabs and interactives](prefabs-and-interactives.md#view-state-poses);
environment volume and water level controls are in [environments](../package-format.md#environments)
and [water](../package-format.md#water). `fireSeed:player`
([invisible bridges](../game-data/effects.md#invisible-bridges)) is created when scene level scripts
set its level, listed under "Player nearby" with those scripts as drivers and placed at their
midpoint; `PackageManifest.fireSeed` holds per-level reveal radii from `FireSeedGameplayConfig`.

## MapConfig scene states

code: [map-config.ts](../../packages/formats/src/endfield/map-config.ts) (parsing),
[scene-conditions.ts](../../packages/extractor/src/game/state/scene-conditions.ts) (controls),
[game-state.ts](../../packages/extractor/src/game/state/game-state.ts) (quests, variables, required
control values).

condition classes map to `SceneCondition.kind`:

- `SimpleConditionCheckQuestState` → `quest`
- `SimpleConditionCheckMissionState` → `mission`
- `SimpleConditionCheckMapVar` → `mapVar`
- `SimpleConditionCheckGlobalVar` → `globalVar`
- `CombinedConditionRuntime` → `all` / `any`

unknown classes or malformed fields throw.

`WorldIndex` exposes chunk suffixes as `ChunkFile.sceneState` and `ChunkFile.area` (`scene find`
accepts `--scene-state` / `--area`).
[dynamic-scene.ts](../../packages/formats/src/endfield/dynamic-scene.ts) reads visible-state lists
(`states`) and visible-area lists (`areas`) on entities and resource groups; gating uses these
lists, never the resource group's `sceneState` field.

[gated content](../game-data/scene-states.md#what-they-gate) follows one rule (union of chunk file
states; any appearance in an always-loaded file makes it unconditional):

- **static renderers** in non-zero scene-state files pack as conditional detail instances
  ([how the packer files instances](../extraction.md#how-the-packer-files-instances))
- **environment and post volumes** ([volumes](environments.md#volumes); base environment votes only
  over volumes loaded under defaults)
- **water surfaces** ([water-source.ts](../../packages/extractor/src/game/water/water-source.ts),
  [water](../package-format.md#water)) and **local lights** ([lights](../package-format.md#lights))

## defaults

conditional scene states are derived from their quest/variable controls (spelled out in `rule`)
unless overridden by the user. defaults represent a finished story:

- every quest and mission is completed (`3`)
- every variable takes the highest value compared against it ([variables](#variables); assumption:
  the client ships no variable defaults)
- condition-less states default off
- state indices referenced by visibility lists but unnamed in MapConfig get an off control
  (`unnamedSceneStateControl`)

on map01's [example](../game-data/scene-states.md#how-the-game-applies-them), these defaults yield:
`001_normal` on, `001_damaged` off, `001_overcast_rainy` off, `001_sunny` on,
`dung01_rdg008_006_liino` off, `dung01_rdg008_006_liino_hide` on.

## variables

each variable control offers one option per distinguishable range (below, at, between, and above all
compared values) plus "unset" (fails every test;
[variables](../game-data/scene-states.md#variables)).

the default is the highest compared value, assuming story progression moves variables upward. known
exception: at Origin Lodespring (`map01_lv006`), an in-game screenshot matches value `2` of the
light column variable (not default `4`), and red-ringed spires compare against sentinel-like `9999`.

- **keying**: map variables key as `mapVar:<map>:#<id>` when named by MapConfig (`mapVarName2NumId`
  / `mapVarNumId2Name`), sharing one control across scene states and load gates. unnamed map
  variables (all of map01) keep their source key. global variables lack a name table, so named
  MapConfig globals and numbered gate globals stay separate. gates on another map's variable never
  hold and create no control
  ([gates on another map's variable](../game-data/scene-states.md#gates-on-another-maps-variable)).
- **interactive saved properties**
  ([interactive-variables.ts](../../packages/extractor/src/game/state/interactive-variables.ts)):
  labelled from the interactive's template ("Sludge core", "Outfall", "Wuling bridge", or template
  id, plus property name if not `state`) and placed at it. its assumption notes the interactive,
  property, and fresh-world value; default stays highest compared.
- **blight variables** ([blight and its cores](../game-data/scene-states.md#blight-and-its-cores),
  [dynamic-structures.ts](../../packages/extractor/src/game/dynamic/dynamic-structures.ts)): map01
  erosion and map02 sludge variables keep id `mapVar:<map>:#<id>` but label as "Blight core" at the
  core/patch position with two states: present (erosion ≠ 2; sludge = 0) and cleansed (default).
  note: this hides that an active sludge core (`1`) already unloads its sludge. patches and core
  both require present. `GameState.claimVariable` claims the variable only if no other condition
  reads it; otherwise patches keep the generic control and the core stays unconditional.

## dynamic load gates

[dynamic-scene.ts](../../packages/formats/src/endfield/dynamic-scene.ts) decodes
[dynamic load gates](../game-data/scene-states.md#dynamic-load-gates) into `DynamicEntity.gates`;
[game-state.ts](../../packages/extractor/src/game/state/game-state.ts) maps them to quest, mission,
and variable requirements. mission gates become combined conditions (`all`/`any`,
`reverse = !loadWhen`). variables with `controlLoad === 0` are ignored.

server-set variable gates remain plain variable controls: Yinglung Pass's
[outpost tiers](../game-data/scene-states.md#outpost-tiers) (#321–324) and energy point towers
(`defenceFnish`) each get their own control. tier variables default to `1` (highest compared), so
all four tiers show by default.

**outpost upgrade missions**:
[settlement-upgrades.ts](../../packages/extractor/src/game/state/settlement-upgrades.ts) reads
[upgrade missions](../game-data/scene-states.md#outpost-upgrade-missions) from
`SettlementBasicDataTable`. `GameState` rewrites completion tests (`= completed`, `≠ completed`) to
the outpost's level control (complete above the level naming the mission) whenever the outpost is in
the scene and has a higher authored level. tests distinguishing unfinished states keep a mission
control. outposts default to their highest authored level, so upgrade-gated content (e.g. Cardiac
Remediation Station's light column on `f1m19d3`) shows by default. these are factory missions, so
"Main story progress" doesn't move them—only the outpost's level control does.

## progressions

implemented in [scenery-variants.ts](../../packages/extractor/src/game/state/scenery-variants.ts)
([progressions](../game-data/scene-states.md#progressions); inspect with `scene controls <scene>`).

- keyed `<kind>:<key>` (settlement id, POI id, or region level id); a settlement's main and
  secondary controllers share one progression.
- selectable levels are the bits used by its groups; default is the highest (finished world), hiding
  lower-level scaffolding/unbuilt sites by default. each progression is independent.
- a resource group with a non-zero mask on a controller-less entity follows its variable if it reads
  one ([variable-driven view states](#variable-driven-view-states)). otherwise: if bit 0 is set, it
  shows unconditionally; else it gets an off `logic:<entity id>:<mask>` toggle (`entity id` is
  global id, or `<grid>:<ordinal>` without `IdComp`).
- tree standing/felled bits get one `harvest:<level tag>` control per level, defaulting to standing.

## facility visual forms

implemented in
[template-models.ts](../../packages/extractor/src/game/interactives/template-models.ts) and
[facility-forms.ts](../../packages/extractor/src/game/interactives/facility-forms.ts) using
MemoryPack `InteractiveTemplateData`
([facility visual forms](../game-data/scene-states.md#facility-visual-forms)).

- placements deduplicate by id
  ([placed-interactives.ts](../../packages/extractor/src/game/interactives/placed-interactives.ts)),
  with `createState === 0` winning over rows created later.
- rows with `createState !== 0` also require a per-level `created:<level id>` control (default off,
  since server/scripts create them during play).
- each facility placement gets a `facility:<id>` progression over list indices, defaulting to the
  last form (fully upgraded; base model/form 1 stays selectable). labelled "Visual form", not
  "Level".

## Dijiang cabins and region walls

- **cabins** ([cabins.ts](../../packages/extractor/src/game/dynamic/cabins.ts),
  [Dijiang cabins](../game-data/scene-states.md#dijiang-cabins)): each slot gets the largest cabin
  whose row pivots fit its box, else the smallest (putting the growth chamber in the medium slot and
  manufacturing cabins in small slots). assumption: no client data maps cabin types to slots. the
  doorless small slot without a room-table row is included. room type ids (used for room bakes) are
  matched manually to `SpaceshipRoomTypeTable` icons
  (`icon_sapceship_room_icon_manufacturing_station` = 1, `…_icon_grow_cabin` = 2). each slot gets
  `cabin:<id>` (default empty), carrying its [region bake](../package-format.md#irradiance-cells).
- **growth chamber planting boxes**
  ([grow-boxes.ts](../../packages/extractor/src/game/dynamic/grow-boxes.ts)): numbered in
  resource-group listing order. each growth chamber slot gets `cabinLevel:<id>` (default level 1).
  each box emits two rows: saved prefab below its field's unlock level, and shutter-hidden from that
  level on. planted crops and status bars aren't drawn.
- **region walls**
  ([region-walls.ts](../../packages/extractor/src/game/interactives/region-walls.ts),
  [Dijiang region walls](../game-data/scene-states.md#dijiang-region-walls)): one
  `controlNexus:<level id>` control (default level 1) offering level 1 and each area-unlock level.
  each wall shows below its area's unlock level; cabin slots behind locked walls remain selectable.

## doors

implemented in [doors.ts](../../packages/extractor/src/game/interactives/doors.ts) and
[cabins.ts](../../packages/extractor/src/game/dynamic/cabins.ts) using
[door poses](prefabs-and-interactives.md#view-state-poses). each interactive with door poses gets
`door:<interactive id>` (0 closed, 1 open). because unlock triggers aren't in client data:

- doors default closed
- Dijiang cabin doors derive from their cabin slot (open when built, closed when empty), matched to
  the nearest slot origin within 12 m in plan (the spare small slot has none)
- Dijiang's reception room door stays closed by default (server-only unlock)

## bridges

implemented in [bridges.ts](../../packages/extractor/src/game/interactives/bridges.ts)
([telescopic bridges](../game-data/scene-states.md#telescopic-bridges)). each bridge gets
`bridge:<interactive id>` (0 retracted default, 1 extended) with its
[poses](prefabs-and-interactives.md#view-state-poses). unreadable bridge prefabs log to
`unsupported-interactives.json` and draw as saved.

## variable-driven view states

for a DynamicStreaming entity whose current-version view-state controller reads a variable
([view states on dynamic entities](../game-data/scene-states.md#view-states-on-dynamic-entities),
[dynamic-structures.ts](../../packages/extractor/src/game/dynamic/dynamic-structures.ts)):

- values tested against `state` (`testedValues`) register on that variable's control.
- the model emits once per tested value (posed via `settledPose`), plus once as saved for all other
  values and unset. the variable's default (highest tested) gives the finished look (The Hub →
  Valley Pass bridge lowered, magic Wuling bridges extended).
- entities with multiple variables follow their first.
- the same variable drives controller-less logic-state masks (loads when equal to a bit, or none of
  the others for masks >16 levels) without creating a `logic:` toggle.
- old-version controllers (entity type 5), trigger-driven controllers, and script-set states
  (`SetDecorationViewState`) aren't posed.

## doodad groups

implemented in [doodad-shell.ts](../../packages/extractor/src/game/interactives/doodad-shell.ts) and
[doodad-groups.ts](../../packages/extractor/src/game/interactives/doodad-groups.ts)
([doodad groups](../game-data/scene-states.md#doodad-groups)). shells without identity slots are
reported and keep only their own renderers. each level with doodad groups gets
`doodadGroups:<level id>` ("Resource nodes") over all named group levels, defaulting to the highest;
each form places at the interactive's transform under `1 << level`.

## graded doodads

implemented in [doodad-grades.ts](../../packages/extractor/src/game/interactives/doodad-grades.ts)
for plain-model rows ([graded doodads](../game-data/scene-states.md#graded-doodads)). rows with an
upgrade source and >1 distinct model across their four forms emit one placement per distinct model
under `<source>:<map>` (levels = all thresholds referenced in the scene). keyed by map rather than
per level, since each open-world map is one domain.

## script groups

each [script-control entity](../game-data/scene-states.md#script-groups) gets `script:<entity id>`
defaulting to its stored default-load flag
([dynamic-structures.ts](../../packages/extractor/src/game/dynamic/dynamic-structures.ts)), unless
settled by [activation quest checks](#following-quest-checks-on-activation) (event content like
limited-time race courses lands here, usually off).

level interactives shown/hidden by a constant entity pointer in a scene script get
`script:<logic id>` (default shown) added to their visibility
([interactive-row.ts](../../packages/extractor/src/game/interactives/interactive-row.ts)). scripts
are read once before placing interactives; script-slot pointers and computed targets aren't followed
(counted in `scriptVisibilityUntraced`).

script and logic toggles label themselves with the 1–2 most frequent renderer names under them (for
identification only, not activation semantics).

### drivers

[script-drivers.ts](../../packages/extractor/src/game/script-drivers.ts) traces every path from
script headers to show/hide actions (up to 16 guard sets per node, and up to 5 hops back across
custom events and script starts). each root cause becomes a `ControlDriver` with the action's
`visible` flag:

| header / source                                                                                           | driver kind                                      |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| guards and quest events along the path; missions whose objectives check the script (stage/property)       | quest                                            |
| `OnInteractiveStateChanged`, `OnUIInteract`, unlocks, saved-property changes, scanned events              | switch                                           |
| trigger area, script's own area                                                                           | trigger / script area                            |
| script stage, property, and lifecycle events                                                              | server                                           |
| fights, spawners, deaths, dialogues, cutscenes, variable changes, entity starts, custom events            | `event`                                          |
| other levels' scripts referencing the group's id in bytes (e.g. dungeons reusing open-world race courses) | `level`                                          |
| any other header type                                                                                     | `unknown` (logged in `scriptEventTypesUnmapped`) |

the viewer lists each control's drivers and can fly to their positions.

### following trigger volumes

a group follows the camera when all its show/hide actions are reached solely from unguarded,
constant-value trigger crossings (`OnLeaderEnterTriggerVolume` / `…Leave…`) in the scene's own
scripts. its `script:` control gets a [`triggers`](../package-format.md#triggers) test (one trigger
per volume with enter/leave values), keeping its stored flag until crossed (assumption: the script
is running). counted in `scriptGroupsByVolume`.

volumes are built in world space
([volume shapes](../game-data/scene-states.md#trigger-volume-shapes)). a group is not followed if a
volume has:

- an unsupported shape (non-vertical polyline, points outside its box)
- leave-only shapes
- a trigger count limit (one-off events like Very Large Rift's video, not reversible position swaps)
- one crossing that both shows and hides it

### following quest checks on activation

a script checking a quest at activation is authored for both outcomes
([following quest checks](../game-data/scene-states.md#following-quest-checks-on-activation)). when
every path from activation headers (`OnScriptActive`, `…Start`, `…PreActive`) in the scene's own
scripts to a group's show/hide action passes only `CheckMissionOrQuestIsComplete` / `…IsProcessing`
guards (and constants), each path becomes a conjunction of quest/mission tests.

the control is then derived: shown while any show path holds (or, if authored default-on, while no
hide path holds). it falls back to its stored flag if any path lacks a quest test, hits another
guard kind, or allows both show and hide to hold simultaneously. post-activation drivers (switches,
areas, quest events, other levels) are excluded from the formula. under finished-story defaults, the
Power Plateau gate is open and its props show, both tracking "Main story progress".

## quest and mission labels

parsed by [mission-runtime.ts](../../packages/formats/src/endfield/mission-runtime.ts), labelled by
[story.ts](../../packages/extractor/src/game/state/story.ts), and stored as
[story places](../package-format.md#controls):

- rich-text tags (`<@…>…</>`) are stripped
- quest label = first objective's text, else `descriptionOverride`
- off-main-flow quests sit half a step after their predecessors
- hidden quests label as "hidden step" + id suffix
- quests missing their mission keep their raw id; episode labels are inferred from ids

## places

the control registry assigns each control a [place](../package-format.md#controls):

- **position**: explicit spot named by the mechanism (interactive placement for doors, bridges,
  campfires, script-shown interactives; cabin slot; blight core), else the bounding-box centre of
  gated instances (propagated back through derived controls). content >1024 m wide or deep gets no
  place unless named explicitly. lights, water surfaces, and environment volumes don't expand the
  box.
- **label** ([map-labels.ts](../../packages/extractor/src/game/world/map-labels.ts)): owning cell's
  level display name plus nearest [map place name](../game-data/world.md#map-place-names) within 150
  m (e.g. "The Hub · Bridge Approach", "Wuling City · Tianjing Courtyard"). control names then
  describe _what_ ("Door (int_door_common_v2)", "Campfire", "Blight core") instead of coordinates.

## rules

- gate content on stored conditions, never on names; state the assumption behind every default
  ([defaults](#defaults)).
- preserve compound requirements and union alternatives for shared resources
  ([conditional sets](../package-format.md#conditional-sets)).
- treat controls as previews: by-name state writers, script overrides, activity conditions, and
  server state remain incomplete ([status](../status.md#scene-states-and-controls)).
- throw during extraction on unknown condition classes, operators, out-of-range spans, or invalid
  flags.
