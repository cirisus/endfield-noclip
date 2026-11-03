# ground navigation extraction

navigation for region switching remains distinct from walkable topology. `navmesh <scene> -o <file>`
exports version-16 Unity navigation tile vertices, polygon indices, neighbour codes and metadata,
plus the source asset transform and build settings. `--limit` is diagnostic and marks partial output.
state-dependent assets remain separate: consumers must select a consistent scene state before
building connectivity. unsupported binary versions, sizes and indices fail instead of falling back
to visible render meshes. detail-surface height reconstruction, off-mesh links and player clearance
validation are not implemented by this topology export.

`air-walls <scene> -o <file>` uses the existing metadata-driven MemoryPack decoder on current LevelData.
it exports every authored wall's bounds, polyline, collision-height range, usage, navigation-obstacle
flag, push distance, default switch, script/group/slot identity and condition data. visibility/effects
are not the reachability criterion. exported state is `unknown`: a routing consumer must block it
until its state resolver proves it inactive. Ganglia narrows these bounds using the exported XZ polyline and height range, expanded by player
radius/height and push distance. runtime state evaluation and other collision constraints remain
necessary before claiming complete player routing.

version 2 of this export also includes `hazards`: conservative bounds of ordinary and temporary
reset zones. payload references are resolved independently of range slots; temporary zones can have
no specific payload. the importer blocks these volumes even on otherwise connected navigation
faces. default-off flags and condition records are retained without assuming that a scripted zone
is inactive. upright polygon zones now include a world XZ footprint checked against the authored
bounds. Ganglia uses the filled prism, including concave outlines, rather than its enclosing box.
tilted/offset polygons and other shapes retain conservative bounds; their exact shape and state
resolution remain pending. version 1 exclusions are rejected because they omit these hazards.

`movement-settings -o <file>` exports current player settings and modifiers, world settings, and
AI navigation settings as separate, build-bound asset records. it intentionally reports unresolved
motion validation. `characters` follows each character template's managed component references to
export its capsule proxy and movement overrides; unused reference records are ignored. current
extraction resolves 34 templates with five distinct capsule sizes. selecting a character does not
yet resolve runtime collider overrides or active movement modifiers.

the default planning capsule is the most common size in that build's character templates, exported
as `defaultProfile`. equal counts prefer larger radius, then height. `walk-routes --movement-settings
<file>` uses it when the request omits `profile`; explicit dimensions still override it. the movement
export must match the navigation build, and the resolved dimensions are embedded in Atlos's bound
dataset. Ganglia does not hardcode Endfield character sizes.

a jump-height limit alone cannot establish a valid directed connection: the
trajectory, player capsule, landing slope/support, swept collisions and reset zones must all pass.
AI link limits are not player movement limits. descending and ascending connections must be verified
independently; no implicit reverse jump or unlimited downward drop is added.

`travel-points -o <file>` exports camp teleport landing positions from the current installation,
resolving scene ownership through level configuration. positions of map icons are not substituted for
landing positions. unmapped levels are reported separately. availability is unknown until supplied
by the caller's player state or explicit planning assumptions. the six non-main industrial-base areas are also exported using the horizontal centre of their
maximum authored expansion bounds. their vertical centre is only a projection seed, never a claimed
ground height. factory regions are player-accessible; absence from an AI navigation bake is missing
coverage, never a player exclusion. buildings, holes, air walls and other physical constraints still
apply inside those regions. these records are marked approximate and require ground projection; zero-valued
factory-region origins are not used.

these exports include build GUID/content hash and contain local game-derived data; keep outputs
outside git. Ganglia owns graph search, multi-origin selection and route sampling. Atlos consumes its
packed package. camera headings and baked views belong to this repository's extractor.

## verification and remaining work

current map01 extraction decoded all 1,085 assets / 499,357 polygons. current wall export found 158
map01 and 346 map02 walls. eleven map02 walls have the navigation-obstacle flag disabled, so an AI
navmesh alone cannot be treated as proof of player passage. map travel data yielded 131 mapped camps
and one unmapped test-level entry, plus six industrial-base centre seeds. these counts are extraction evidence, not runtime-state validation.
the reset-volume export additionally found 108 map01 and 292 map02 volumes (including two temporary
zones without payloads). full exports completed with the current metadata layout. player movement
has not yet been reproduced or validated against a collision scene.

for point 3500030763, the tested local area had no state-prefixed navigation assets within 180 m of
the target. an initial graph found a long corridor, but it included area 3, whose player passage semantics
have not been established. restricting the selection to area 0 produces only a short local route;
it does not verify the distant eastern approach. the three valley base centres also failed vertical
projection onto this ordinary-area/base-asset selection. neither result establishes a shortest continuous
route: partial portals, detail heights, funnel/string-pulling and movement-specific links remain
unimplemented. no false gap bridges or floor snaps are introduced to hide those missing connections.

algorithm reference: [Detour query API](https://github.com/recastnavigation/recastnavigation/blob/main/Detour/Include/DetourNavMeshQuery.h)
separates polygon path search from straight-path extraction. Ganglia currently uses heap-based
Dijkstra because arbitrary entry/travel costs do not always admit a Euclidean A* lower bound.


## reproducible route export

install the checked-in Ganglia alpha archive with the workspace dependencies. then run:

```sh
pnpm extract navmesh map01 -o /tmp/navigation.json --config endfield.local.json
pnpm extract air-walls map01 -o /tmp/walls.json --config endfield.local.json
pnpm extract travel-points -o /tmp/travel.json --config endfield.local.json
pnpm extract movement-settings -o /tmp/movement.json --config endfield.local.json
pnpm extract walk-routes --navigation /tmp/navigation.json --walls /tmp/walls.json \
  --travel-points /tmp/travel.json --movement-settings /tmp/movement.json --request /tmp/request.json \
  -o /tmp/routes.json --data /tmp/ground-data.json
pnpm extract oem-views out/releases/INPUT_RELEASE -o out/releases --cache out/framing \
  --arrival-routes /tmp/routes.json --rebuild
```

the request contains `release`, a nonempty `state` identifier, explicit `assets` names and `areas`
whitelist, `profile: {radius, height}`, `speed`, `maxVertical`, `arrivals` and `targets`. each arrival is
`{id, position, cost, state}`; omit position only when its id resolves in the matching travel export.
locked/unknown arrivals are excluded. target records are `{id, position}`. all coordinates are Unity
world metres, costs are seconds. the state identifier records the caller's chosen snapshot; it does
not automatically resolve game progress. no area other than the whitelist is admitted, and imported
polygon neighbour codes must allow a shared edge. requested dimensions cannot exceed baked clearance.

navigation, wall and optional teleport exports must share source identity. `walk-routes` emits a
binding hash over the selected dataset and request, successful routes for `oem-views`, and separate
unresolved outcomes. the data output can be supplied to Atlos's `planWalkingRoute`; it is local input,
not automatically uploaded or attached to the public catalog. Atlos's wrapper rejects stale bindings
and exposes arc-length playback positions. the interactive route panel is not implemented.

full map import is not yet a player navigation solution. partially overlapping portals, moving/state
variants, detailed ground heights, non-air-wall dynamic colliders and incomplete AI navigation coverage
still require work. base centre seeds remain approximate; do not enlarge vertical tolerance to silently
jump onto another floor. publication and all-point route baking have not been performed.

## collision-based player mesh

Ganglia provides an offline `@oem/ganglia/build` entry point. it accepts world-space
collision triangles and an explicit player profile, slope, step and voxel resolution,
returning the existing surface contract with sampled detail heights. factory floors do
not require AI NavMesh coverage. ordinary connections use the smaller upward/downward
step allowance; larger drops and jumps remain separate directed transitions.

the dependency is installed and its packed builder has been exercised. `walk-routes`
still imports the selected Unity navigation surfaces: complete world-space collision
placement, layer/trigger selection and region ownership must be implemented before the
new builder can replace that input. synthetic slope, step, headroom and gap checks do
not establish complete game-world reachability. the runtime package root does not
import the offline generator or WASM.

alpha.4 accepts explicit XZ build bounds while keeping the full vertical extent of all
input geometry. an actor's origin is not an overlap test: its mesh may cross several
cells. dense regions can exceed the native contour limit even below the voxel budget;
the error includes the native diagnostic instead of emitting partial surfaces. a local
64 × 64 m placement probe built 33,891 detail triangles from 465,157 collision triangles,
and projected the original preview marker onto a surface near its authored height.
this verifies a bounded build, not complete coverage, tile stitching or a safe arrival route.

## movement devices

`traversal-devices <scene> -o <file>` exports placed `int_rope_port*`, `int_jumpmachine*`
and `int_accelerate_buff` families. the output retains build identity, placement transforms,
creation/progression conditions and separate template, variant and placement parameter scopes.
these scopes are not flattened into an assumed runtime state. automatic-spawn references are
counted separately; selected devices retain whether they are referenced by that list.

rope pairs require reciprocal authored `target` references in the same level, with distinct
heights. no proximity matching is used. each pair names ascent by rope and descent by drop,
following the requested traversal rule; ground attachment, unlock state, trajectory and
landing validation remain unresolved. pivots and rope render anchors are not automatically
player stand positions. this catalogue does not add passable graph edges yet.

launch device parameters retain height, free-jump/input controls and collision flags when
authored; acceleration parameters retain their own duration/cooldown scopes. an acceleration
buff is a timed movement state, not a permanent increase to all walking speeds. jump/launch
segments will need time-based motion and collision policy; constant-speed ground sampling
cannot be used as their physical animation. unknown parameters remain typed source values.

regression references supplied by the user: [camp](https://oem.re/0jBW2ZB) to
[target](https://oem.re/0mpNfFm), with a direct southward descent. this is a directed
player traversal example, not permission to connect every cliff or add the reverse jump.

current full-scene exports read 221 map01 files and 367 map02 files: 218 reciprocal rope
pairs (60 / 158), 158 launch devices (59 / 99), and 40 acceleration devices (9 / 31).
all selected rope endpoints have reciprocal targets. map02 has 32 automatic-spawn
references; none name a selected movement device in this install. these are authored
input counts, not proof that every device is unlocked or that its landing is safe.

## streamed collision inputs

`collision-inputs <scene> <x> <z> --scene-state <n> --area <n> -o <file>` exports
ECS collider actors for an explicit chunk selection. actor poses are in Unity world
coordinates; compound shape poses are local to the actor. primitive dimensions already
belong to collision geometry, so renderer scale must not be applied again. mesh shapes
retain their own scale and ordered asset bindings, separately from the render mesh.

use `<scene> global` instead of `<scene> <x> <z>` to export the global chunks for the
same explicit state/area selection. a cell export does not implicitly include them:
consumers must combine global and intersecting cell inputs for their selected active
states. the current map01 default global chunk contains 19 collider actors.

`--layers <uint32>` selects an explicit actor-layer mask (all 32 layers by default).
the mask is retained in `selection.layerMask`; excluded actors retain their poses,
filters and asset bindings in `excludedActors`, without loading their geometry. use a
matching movement export to determine the mask for the requested player mode. this
does not infer runtime state or settle per-shape query options. malformed included
geometry still fails, with its asset identity in the diagnostic. an empty cooked mesh
is not silently replaced with render geometry.

box, capsule, sphere, single mesh, compound and terrain records are decoded. enabled,
trigger, surface and raw option fields are retained independently: a trigger is not a
solid obstruction, and an absent AI polygon does not invalidate a collision floor.
compound complex-mesh inputs remain separate from regular shapes; their query policy
must be resolved before baking. malformed counts, missing bindings and unsupported cooked
geometry fail the export.

the `geometries` table contains deduplicated local triangle/convex meshes and collision
heightfields. each actor's `shapeGeometry` array parallels its shapes (`null` for primitives);
`complexGeometry` and `terrainGeometry` remain separate. mesh geometry still needs its
shape scale and actor/local poses applied. terrain geometry already includes its collider
scale and needs only the actor pose, never a second scale or renderer transform.

collision heightfields read RG16 base-level samples, normalize the low 15 bits by 32766,
and alternate quad diagonals. this differs from rendered terrain's 32768 normalization.
a hole bit at any of a quad's four corners removes both triangles, including the triangle
without that corner. no flat ground is inserted at holes or missing data.

one current cell sample decoded 134 actors with 1,008 shapes (869 mesh and 139 box),
four complex-mesh records and four terrain records. this verifies record framing, not
world navigation. its four 65 × 65 heightfields produce 31,092 triangles and omit 838 hole
quads. the exported coverage is explicitly incomplete: global chunks, Mono
colliders, interactive prefabs, foliage and player layer/option
policy still need integration. do not interpret this cell catalogue as a complete collision
world or use missing coverage to authorize a jump/drop.

a separate placement probe expanded the sample's regular shapes to 434,065 world-space
triangles using 106 cooked meshes. the original preview target's vertical ray intersects
an upward-facing surface near its marker height. this is a local placement cross-check;
complex-mesh collision policy and complete world coverage still require separate validation.

the southward descent example now has selected-layer collision inputs from both intersecting
cells: 349 actor records, 273 after duplicate placements are merged, produce 874,000 regular
shape/terrain triangles. a bounded build places the teleport and target on different connected
surfaces. initial candidate arcs collide with the platform railing; moving takeoff behind the
edge and using the reset zone's polygon admits geometric candidates. these are motion-model
trials, not validated game routes: air-control dynamics, complete scene collision and landing
state still require verification. no directed connection or view cache is published from them.

## continuous ground queries and sustained sprint

Ganglia alpha.7 prepares reusable topology and a support BVH with `createGroundPlanner`.
`walk-routes` shares this preparation across target queries. Ground runs are traced through
open 3D portals, with reconstructed support heights and wall checks. Coplanar centre and
portal detours collapse, while terrain height breaks and required obstacle turns remain.
Takeoff and landing split the ground runs. This is bounded any-angle simplification of
selected corridors, with no proof of globally shortest continuous paths.

A request may supply `locomotion: {speed, sprintSpeed, sprintAcceleration, stamina?}`.
With a matching movement export, its default movement asset supplies run/sprint speeds
and sprint acceleration. Sprint activation and natural recovery require an explicit resource policy; absence of a per-frame drain does not establish free activation.
An explicit stamina policy contains capacity, initial, sprintDrain, recoveryRate,
recoveryDelay and reserve, with an optional activationCost. Ganglia carries resource and recovery state
through the whole journey and compares sprinting now with saving an activation for
a later ground run;
it does not infer costs from the separate evasive dash resource. Custom gameplay states
and movement modifiers remain caller-owned. The scheduler is feasible, not globally
optimal across every route and resource allocation.

The development-only Atlos route inspection panel now consumes these continuous results,
uses the shared host panel and displays English labels. The descent example remains a
candidate: physical ground projection differs slightly from exact collision support,
and complete collision coverage, air control and landing validation remain unresolved.
Its preview has been refreshed independently of the point-view cache.


The movement export now reads the current `GlobalConst` root-bean configuration using
shared Spark decoding. `sustainedSprint` contains build-bound speed, acceleration and
maximum-capacity activation/recovery inputs. The planning seed starts full, as requested.
Regional movement/resource buffs are not applied. Normalized energy is measured in
activation charges. Recovery during sprint and movement is explicit in the exported
policy. Sustained gait pays one entry charge; a new activation pays again after a gait
interruption. A `sprintThrough` whitelist preserves gait only for supported modes.
Allocation search compares run-level choices with nondominated resource labels, capped
at 256 with an explicit truncation flag. Interior activation-time optimization and
resource-optimal selection across all spatial corridors remain unresolved.
