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
publishing a partial catalog. disjoint scene/partition runs can run in parallel; finish with the
unrestricted command to assemble complete coverage.

publication requires the output and input to share a filesystem: immutable archives are hard-linked,
not modified or copied into another set of model bytes. the release hash includes all pose data.
companions and the catalog receive the new release id; the catalog is written last. old releases
remain intact. generated packages, checkpoints and game-derived companion data stay outside git.

## framing contract

algorithm v3 tries sixteen headings and several elevations while retaining at least 10 m horizontal
viewing distance. it focuses above the target floor, handles cave points beneath the terrain and
ignores small geometry enclosing the collectible itself. all-candidate failures retain the south 10
m / up 6 m view with `clear: false`, so neither the exporter nor UI claims guaranteed visibility.
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
