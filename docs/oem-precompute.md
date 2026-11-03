# offline OEM framing

`oem-views` computes the completed-quests / maximum-facilities view for every point and embeds the
poses in a new immutable companion release. the browser consumes a pose only when the framing
version, package generation, level, target coordinates and effective visibility match its key.
manual state changes and unavailable bindings retain local calculation and its persistent cache.

```sh
pnpm extract oem-views out/releases/<base-release> -o out/releases --cache out/framing/<base-release>
pnpm extract oem-check out/releases/<baked-release>
```

the input is an already verified OEM release. the exporter reads its actual converted geometry and
height pages, and shares pure decode jobs and candidate selection with the viewer. it needs Node,
not WebGPU, textures or an account. points are grouped by scene and tile to reuse decoding. only the
scene's active progression and target streaming areas participate. checkpoint JSON is written
atomically every 100 points and after each partition; restarting rechecks the versioned keys.
`--scenes map01,map02` and `--subregions WL_1,WL_2` restrict a run to checkpoint preparation without
publishing a partial catalog. `--points <id>,<id>` prepares individual regression cases in the
same checkpoint format. disjoint scene/partition runs can run in parallel; finish with the
unrestricted command to assemble complete coverage.

publication requires the output and input to share a filesystem: immutable archives are hard-linked,
not modified or copied into another set of model bytes. the release hash includes all pose data.
companions and the catalog receive the new release id; the catalog is written last. old releases
remain intact. generated packages, checkpoints and game-derived companion data stay outside git.

## framing contract

algorithm v7 compares sixteen headings and several elevations while retaining at least 10 m horizontal
viewing distance. at the first feasible elevation it ranks clear candidates by nearby occlusion
across a 5 by 3 inspection-frustum grid (5 m forward depth). fewer blocked samples win;
oblique headings break ties. all rays share a per-point triangle spatial index. this avoids choosing a wall-hugging view just because the point
itself is visible, without changing the user's lens. v3/v4/v5/v6 catalogs remain readable, but their pose
keys cannot satisfy v7 requests; rebake to restore the zero-computation path.
it focuses above the target floor, handles cave points beneath the terrain and
ignores small geometry enclosing the collectible itself. all-candidate failures compare 32 headings at 10/16/22 m and three elevations, using a
5 by 3 target-neighbourhood grid to favour an enclosure's opening and reject foreground walls.
these context views keep `clear: false`: a useful entrance view does not prove the collectible visible.

for an occluded point, the same pass can check a single source-backed obstruction control: a door
opening, a destructible object, or an independent script group hidden by an extracted switch/combat driver. it requires a
blocked sight line through that group's geometry before interaction and a clear inspection bundle
afterwards. unrelated nearby controls, quest-derived gates, unknown triggers and multi-step puzzles
are not overridden. the bound pose carries the proven control and its before/after values; package
generation and visibility keys still apply. standalone destructible objects with no packed state
remain context-only; this does not reconstruct break animations, debris, explosions or gameplay.
transparent surfaces, unavailable geometry and points embedded in solid objects remain limitations.

`oem-check` validates complete per-point coverage, finite poses, package generations, exact
visibility keys and the 10 m distance. the point panel retains the unconfirmed-view hint.
first-entry camera placement is immediate; continuous same-scene navigation keeps animated flight.

## actual v27 output and frontend cost

the completed-profile release contains 11,396 poses across 19 partitions and seven scenes. all poses
satisfy the distance requirement; 1,388 have unconfirmed visibility and use the explicit fallback.
the views add 2,581,008 bytes to the JSON companions, or 743,526 bytes with gzip compared with the
equivalent unbaked companions. gzip savings require the static host to serve content encoding. the
model archives are unchanged by baking.

poses travel in the companion partition the frontend already needs: no extra pose request and no
all-region startup download. matching poses skip framing-only mesh reads and decoding. ordinary
renderer streaming remains necessary; some geometry bytes would otherwise overlap with its cache.
the earlier synthetic five-number encoding estimate (about 199 kB gzip) excluded binding hashes,
status and full coordinate precision and is not the shipped payload size.

only the default completed profile is baked. including all 65,142 authored presets plus a completed
view per point would mean 76,538 combinations before deduplication, about 6.7 times the default
coverage. there is no need to multiply first-launch data by those manual combinations.

a local Dijiang pilot checked 12 points in 1,711 ms, reading 211 ranges / 4,161,835 stored bytes,
with geometry reuse and no terrain. that pilot is not a large-map runtime forecast. the full run
used checkpoints, parallel partitions and recomputation after distance requirements changed, so its
combined wall time is not a clean cold-run benchmark. v27 particle changes require fresh scene
archives; new generations invalidate old pose bindings automatically.

interaction framing checks the complete original obstruction against a conservative camera frustum
with at least 3 m lens clearance, trying 10, 16 and 22 m target distances. the same pose must see the
target after the state change. destructible placements retain intact/destroyed visibility and explicit
`reward_entities` gates; unrelated nearby boxes are not removed. debris, damage and intermediate
physics are not simulated. ambiguous reward owners remain unresolved.

clear interior views also check nearby obstruction controls. an entrance view takes precedence only
when its complete original obstruction fits, the revealed target is visible, and surrounding wall/ceiling
samples show more open space at the camera than the original interior pose. an already open exterior
view is retained on ties, so a nearby door alone does not pull the camera into another room.

## arrival-route constraints

`--arrival-routes <file>` accepts `{ release, routes: [{ id, status: "complete", points: [[x,y,z], ...] }] }`
from a routing producer. the release must match the exact input catalog; duplicate/unknown point ids,
non-finite positions and routes ending more than one metre from their target fail export. this is a
trusted routing input: the exporter does not infer or certify player reachability from a polyline.

arrival heading generation belongs to the extractor. it measures the final 24 m of route arc length
and tries views 30/45 degrees either side of the direction back toward the arrival path, from beyond
the destination. the longer window avoids a tiny final polygon edge reversing the apparent approach.
the ordinary viewer geometry kernel checks those candidates and ranks final-approach visibility
samples at 2/4/8/12/18/24 m as a tie-breaker, replacing the fixed compass preference; when none is clear it retains existing
framing and interaction handling. input-route content hashes and the arrival algorithm version isolate offline checkpoints, including
when reusing the same cache directory with changed routing inputs. input availability and state
assumptions remain the routing producer's responsibility.

`--rebuild` recomputes selected points even when checkpoint keys match. with no point/scene/partition
filter it rebuilds the whole release; with a filter it remains checkpoint-only. final assembly still
uses the existing immutable release writer and `oem-check`. no option publishes remotely.

local experiments rebuilt point 3500030763 and validated assembly of a local 11,396-view release,
with other matching views reused. the early 133.7-degree candidate used an area-3 corridor whose
player passage semantics remain unverified; it is not an accepted route or final visual result.
ordinary-area-only routing has so far established only a short local approach. no all-point routing
bake, in-game traversal validation or browser screenshot comparison has been completed.
