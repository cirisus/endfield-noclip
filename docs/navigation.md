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

`travel-points -o <file>` exports camp teleport landing positions from the current installation,
resolving scene ownership through level configuration. positions of map icons are not substituted for
landing positions. unmapped levels are reported separately. availability is unknown until supplied
by the caller's player state or explicit planning assumptions. the six non-main industrial-base areas are also exported using the horizontal centre of their
maximum authored expansion bounds. their vertical centre is only a projection seed, never a claimed
ground height. these records are marked approximate and require ground projection; zero-valued
factory-region origins are not used.

all three exports include build GUID/content hash and contain local game-derived data; keep outputs
outside git. Ganglia owns graph search, multi-origin selection and route sampling. Atlos consumes its
packed package. camera headings and baked views belong to this repository's extractor.

## verification and remaining work

current map01 extraction decoded all 1,085 assets / 499,357 polygons. current wall export found 158
map01 and 346 map02 walls. eleven map02 walls have the navigation-obstacle flag disabled, so an AI
navmesh alone cannot be treated as proof of player passage. map travel data yielded 131 mapped camps
and one unmapped test-level entry, plus six industrial-base centre seeds. these counts are extraction evidence, not runtime-state validation.

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
pnpm extract walk-routes --navigation /tmp/navigation.json --walls /tmp/walls.json \
  --travel-points /tmp/travel.json --request /tmp/request.json \
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
