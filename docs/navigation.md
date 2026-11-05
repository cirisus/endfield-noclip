# ground navigation extraction

Ganglia alpha.22 builds consecutive ordinary steps through local support-span
connections and preserves directed tile-passage intervals. Physical routing
publishes an atomic walking candidate before optional airborne optimization.

`player-route --ground-only` ends after walking feasibility, before airborne
collision indexing. Full queries keep a provisional result with `optimizing`
until action comparison finishes. Stage costs are exported in
`diagnostics.timingMs`. Interactive shortcut comparison uses a 512-candidate
budget when a complete walking baseline exists, while unresolved reachability
retains the 8000-candidate budget. Search truncation remains explicit.

Ground routing can recover a continuous clear support corridor when obstacle
checks block its polygon representatives. Every reconstructed segment must pass
the same exclusions before the candidate is accepted.

The selected default planning snapshot assumes all level tasks completed.
`air-walls` records a source-bound control interpretation with model
`wall-controls-v2`. it scans the scene's level scripts and other-level references
to wall groups. owned slots and group-id writes are both included, with controller
identity, stage interpretation and resulting state retained in each record.
the level brief supplies the declared maximum stage and parameterized global
wall references. the completed snapshot selects that stage, falling back to an
explicit contiguous stage domain when the brief does not supply one. this is a
planning assumption. a script resolves only when its reachable writes consistently
establish or preserve the selected state. known completed-mission, stage and boolean
guards prune paths. unresolved guards keep effects possible without establishing
that a write executes. conflicting writers and undecoded inputs remain unknown.
other-level activation requires its own snapshot before changing a wall's base
state. `groundData` applies these records only with explicit
`progression: 'completed'`. re-export walls and ground datasets after changing
this policy.

Completed-world mission conditions treat empty rise/down lists as having no
activation reason. This preserves their initialized false result and allows a
resolved completed down condition to disable its wall.
the level-script check type can be controlled through a group id even when its
stored owner is zero. its default switch is a base state, and is used only after
the explicit controller scan. legacy level-script exports without that scan
remain unknown. completion-disabled encounter and fog-nest modules supply an
inactive state for their explicit wall references in this completed snapshot.
independent script writes are still checked. repeating and unsupported modules
remain unknown. unresolved computed targets are recorded and keep scene wall
states unknown, since the affected group cannot be excluded. dynamic
properties, player-trigger state and server-only controls still need snapshot
input. an authored-default assumption does not establish live runtime state.

the current two-scene audit covers 504 walls. the selected snapshot resolves 347
inactive and 43 active, with 114 unknown, down from 196 before module and brief
resolution. map01 has 112 inactive, 16 active and 30 unknown. map02 has 235 inactive,
27 active and 84 unknown. the remaining controls include dynamic properties,
trigger occupancy, event callbacks, owner activation, conflicting writers, three
owners without client action graphs and one invalid mission reference. wall usage
tags supply no independent permanent-boundary classification. the three additional
elevated route examples retain complete walking routes with these exclusions.
the fixed reference-positive population also retains 31/31 complete walking
routes, including all 13 measured step-profile cases.

`interaction-points <scene> -o <file>` exports placed trigger rules, retaining source build,
template paths, transforms and override provenance. direct values resolve in base, selected
variant and placement order. supported sphere/direction rules produce an explicit standing
goal volume for Ganglia. unresolved shapes, transforms and referenced parameters remain
separate from resolved authoring. see [interaction authoring](game-data/interaction.md).

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
is inactive. the current client directly enables unaddressed zones without conditions, bypassing
the addressed-area default switch. these export as `active`; addressed or conditional zones
retain `unknown`. upright polygon zones include a world XZ footprint checked against the authored
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

optional `progression: "completed"` explicitly evaluates mission-controlled air walls with quest and
mission state 3, matching the OEM viewer's completed-progress default. the current client tests rise
reasons first, then down reasons, then the default switch. any/all reason combinations and equality
inversion follow those source checks. empty lists carry no activation reason.
script controls follow the completed snapshot described above. unsupported or
malformed conditions remain unresolved and blocked. runtime wall overrides require snapshot input.
this setting does not disable reset volumes. the client enables unaddressed unconditional function
areas directly, including reset zones whose addressed-area `defaultOff` field is true.

navigation, wall and optional teleport exports must share source identity. `walk-routes` emits a
binding hash over the selected dataset and request, successful routes for `oem-views`, and separate
unresolved outcomes. the data output can be supplied to Atlos's `planWalkingRoute`; it is local input,
not automatically uploaded or attached to the public catalog. Atlos's wrapper rejects stale bindings
and exposes timed playback positions. Atlos's development route panel opens from point detail,
retains the point camera, draws the candidate route and shows its planar minimap projection.

full map import retains gaps in AI coverage, state variants and dynamic obstacles. matching partial
edges and authored directed chunk seams are imported within verified step limits. player ground is
handled by the separate physical pipeline below. base centre seeds remain approximate; do not enlarge vertical tolerance to silently
jump onto another floor. publication and all-point route baking have not been performed.

## collision-based player mesh

Ganglia provides an offline `@oem/ganglia/build` entry point. it accepts world-space
collision triangles and an explicit player profile, slope, step and voxel resolution,
returning the existing surface contract with sampled detail heights. factory floors do
not require AI NavMesh coverage. ordinary connections use the smaller upward/downward
step allowance; larger drops and jumps remain separate directed transitions.

`player-ground <scene> --bounds <minX,minZ,maxX,maxZ> --scene-state <n> --area <n>
--movement-settings <file> -o <ground> --collision-output <geometry> --config <config>`
collects selected global and neighbouring streamed collision inputs. source-bound per-cell
caches are optional with `--input-cache`. the player's collidable/walkable layer masks,
body, slope and ordinary step limits come from the matching movement export. actor and
local shape poses, mesh scale, terrain holes, boxes and sphere envelopes feed the world
geometry. capsules currently use conservative axis-independent sphere envelopes. complex
shapes and absent cells remain explicit coverage gaps. collision-only meshes with an
empty cooked payload can retain their authored local bounds as conservative obstacle
enclosures in this selected-solid pipeline. those enclosures carry unknown world-volume
exclusions and remain non-walkable. they can substantially overblock. malformed nonempty
cooks still fail decoding.

the alpha.13 packed builder constructs padded tiles, clips their cores and connects
directed seams. near-boundary Float32 vertices snap to exact core planes while retaining
detail-plane heights. a real VL2 build produced 69,963 surfaces and 7,114 validated seams,
but its test arrival remains disconnected. native build failures abort the result.

`player-route --ground <file> --collision <file> --movement-settings <file> --request <file>
-o <result>` accepts a matching scene/source, arrival, target, optional interaction volume
and wall exclusions. Ganglia's `planJumpRoute` compares bounded ground, jump and drop
action combinations, including intermediate platforms, with physical support, capsule
sweeps and air-wall checks. a successful ground route remains an incumbent while jump
alternatives are searched. only a faster complete, resource-timed result replaces it.
arcs exceeding the ordinary-run air speed require paid sprint entry. the full route then
receives acceleration and resource scheduling. results retain source, coverage, model and
truncation diagnostics. sampled discovery and prior corridor selection can miss valid routes.

shortcut discovery covers exposed ledges before spending its budget on fine pullbacks.
landings include continuous surface interiors, including large floors below a platform.
ground-reachable transfers and isolated intermediate surfaces retain separate sampling
and connection shares. slower, directly ground-visible airborne transfers are discarded.
retained movement edges enter the same directed graph, with continuous supported ground
visibility between action endpoints. limits bound candidate work and retained edges,
while successive jumps have no separate fixed hop-count cutoff. the graph and candidate
set remain approximations to globally fastest continuous motion.

the feasibility stage passes the complete interaction goal to Ganglia. unresolved queries
first propose region chains using broad cheap boundary-pair coverage and separately
bounded physical arc validation. landing witnesses include diagonal boundary pullbacks,
continuous surface interiors and intersections with the optimistic flight envelope.
each still needs corrected support, actual timing and complete swept-body checks.
verified action frontiers expand from reached ground and backward into goal-connected
surfaces. charged work is balanced between both sides. bounded passes reuse standing support, ledge
approaches, air openings and trajectories while increasing coverage. source-height and
goal-height landing queries preserve intermediate steps. recursive spatial scheduling
visits coarse regions before body-scale offsets. the remaining frontier and shortcut
work share a bounded query budget. the initial region proposal has separate bounded
seed, pair and physical arc limits. continuous ground transfers are reused for the
current target. overlapping patches
can participate through proven supported ground approaches even without a shared
navigation edge. immutable graph, wall checks and spatial hierarchies are prepared
once. eligibility views prune spatial branches for each action frontier without
sorting the same geometry again. query-specific endpoints and movement edges remain isolated between planning passes.
action edges retain their validated support faces so a later projection cannot change graph attachment.

source air acceleration and no-input deceleration bound early, late and braking control
primitives. collision-checked air openings also allow outward-and-returning jumps below
an overhang. supported walk-offs follow the rounded capsule's contact with triangle edges
before free fall. bounded cubic air controls also permit turning back beneath a low
roof after leaving its edge, with continuous entry velocity and full curved-body checks.
the collision index retains the selected build extent, including empty air beyond
walkable surface extrema. curved sweep envelopes refine near contacts, and indexed air-wall queries
reuse their validated records with per-interval inflation. complete collision coverage and
the game's live air-control response remain independent validation requirements.

the packed normal command produced a three-segment candidate for the supplied descent
example with one sprint-required jump. that verifies the package/command pipeline. complete
collision coverage, game air-control behaviour and device state still require validation.

## movement devices

`traversal-devices <scene> -o <file>` exports placed `int_rope_port*`, `int_jumpmachine*`
and `int_accelerate_buff` families. the output retains build identity, placement transforms,
creation/progression conditions and separate template, variant and placement parameter scopes.
these scopes are not flattened into an assumed runtime state. automatic-spawn references are
counted separately; selected devices retain whether they are referenced by that list.

rope pairs require reciprocal authored `target` references in the same level, with distinct
heights. no proximity matching is used. each pair names ascent by rope and descent by drop,
following the requested traversal rule; ground attachment, unlock state, trajectory and
landing validation are separate from this catalogue. pivots and rope render anchors are
not automatically player stand positions.

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

`player-route --devices <traversal-export>` now imports fixed device macro-actions
from that matching scene/build. the selected snapshot assumes all exported
vertical ropes enabled and unlocked, regardless of authored enable/lock flags or
progression gates. motion parameters, reciprocal references, interaction geometry,
support and collision still require validation. launch devices combine completed
mission/quest gates with authored enabled/unlocked states. power and unresolved
motion overrides require their own input. the pure `--ground-only` stage still
measures walking alone.

reciprocal vertical ropes provide directed ascent actions with approach, a timed
startup pause, upward travel and a supported exit. entry candidates use the shared
effective interaction-trigger resolver. the standing capsule, full polyline and
active/unknown wall exclusions are checked. endpoint projection stays within body
radius. travel uses the configured speed and startup duration. this finite entry/exit
sampling is a model of the complete macro-action, pending in-game motion validation.

ordinary fixed-target bounce devices use their own target and height, with a
minimum three-metre apex margin above the target in the supported height-limited
model. the matching movement gravity, falling gravity and apex interval supply
flight timing. neutral input supplies a fixed trajectory. the imported jump-machine
component override can disable air input without disabling the device. both support
ends and the swept capsule are checked even when the device allows collision bypass.
free-direction, electric, vertical-only and other unsupported device models retain
explicit unresolved outcomes. no reverse launch edge is inferred.

the actions enter Ganglia's existing connection interface and participate in
reachability, resource timing, shortcut comparison and timed replay. a feasible
device route is published before optional jump optimization. diagnostics retain
the device id, selected snapshot, accepted trajectories and rejected device reasons.

validation on the current build includes a physical rope route from point
300020256 to 300020282, with walking before and after ascent through the reciprocal
pair. walking alone has no verified route in that rectangle; the device route takes
5.93 model seconds. the normal Atlos nearest-arrival query for point 3500070545
selects device 3500031283 and a small jump, totaling 22.16 model seconds. its physical
walking baseline takes 27.64 seconds. the initial normal query returned a candidate
at 0.74 seconds and completed physical construction/action comparison at 39.36
seconds. these are computed candidates, with in-game operation still unverified.

the all-enabled rope policy admits a normal nearest-anchor route for point
10100023101 through pair 10100023065 / 10100023064. its timed sequence is
walk/rope/walk, at 5.97 model seconds. the exported maps contain 218 reciprocal
pairs; 93 lacked explicit enabled flags on both endpoints under the earlier policy.

Ganglia alpha.23 shares prepared topology, normalized portals, ground visibility
and projection between walking, device checks and action search. bounds hierarchy
construction uses median partitions. the fixed profiled input above drops from
58.39 to 23.76 command seconds, with action search dropping from 33.18 to 11.22.
the returned route remains 22.39 model seconds with the same discovery limits.
`diagnostics.timingMs.devices` now reports device admission separately. these
single-run comparisons reuse physical ground and retain CPU profiling overhead.

`player-route --devices-only` ends after ground and known-device feasibility,
before free jump/drop discovery. it preserves supported trajectories and emits a
completed candidate or an explicit unavailable result. Atlos runs this stage in
the foreground when walking fails, publishes a feasible device route immediately,
and continues optional action optimization independently. queries over ready ground
precede additional queued physical builds.

the small physical rope input above completes this stage in 1.45 command seconds,
without a jump-search phase. a normal query for 10100023101 with physical ground
cached returns its 5.97-model-second walk/rope/walk route after 13.54 seconds,
including scene loading and foreground preparation. larger first builds and active
foreground work can still add waiting time.

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

## fully enabled traversal and sparse physical construction

`groundData` accepts `progression: 'fully-enabled'` as an explicit planning assumption.
controllable air walls are open, including mission gates and walls with an owned or
recovered script controller. uncontrolled boundary defaults remain in force, and
reset exclusions retain their normal behavior. this policy is separate from inferring
the actual completed-game state. `openTraversalPicks` applies the corresponding viewer
preset to doors and activations while retaining derived controls and physical supports.

`player-route` now assumes all supported rope and fixed-target launch devices are
enabled, unlocked and powered. ordinary and electric fixed-target devices share the
same supported-endpoint and swept-trajectory checks. unsupported motion controls,
unknown geometry and blocked trajectories do not become executable connections.

local goal-access refinement uses the same selected collision and body at finer
horizontal resolution. it adds only wholly missing support components. combining
partial detail meshes can invalidate portal ownership, so overlapping components are
excluded until a stitched replacement is available. restored narrow tops still need
stationary clearance and complete motion validation. the ordinary three-box example
returns a 33.80-second launch-and-jump route, against its earlier 51.19-second rope
detour. the matching cached-ground command takes 66.80 seconds rather than 173.71;
these are model and single-run computation measurements, not in-game observations.

`player-ground --tiles <x,z;x,z>` selects physical tiles on the existing global grid.
the complete collision selection and rectangular collision scope remain available,
while only the proposed corridor receives detailed ground construction. unselected
tiles remain unmapped. per-tile progress includes completed and total counts. this
supports coarse direction proposals before fine support, collision and action work.
