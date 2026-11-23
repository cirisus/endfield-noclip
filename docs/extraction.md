# extraction

`packages/extractor` is a node CLI that reads a local Endfield install and writes packages in the
[package format](package-format.md). for game formats and behavior, see [game-data](game-data/).
per-topic pack stages have dedicated pages:

| page                                                               | covers                                                                |
| ------------------------------------------------------------------ | --------------------------------------------------------------------- |
| [prefabs and interactives](extraction/prefabs-and-interactives.md) | prefab hierarchies, dynamic structures, interactives and poses, clips |
| [environments](extraction/environments.md)                         | phase sections, blend schema, volumes, per-level base environment     |
| [scene controls](extraction/scene-controls.md)                     | turning conditional content into controls and choosing defaults       |

## running it

node and pnpm come from mise (`mise.toml`). node executes TypeScript sources directly with no build
step.

```sh
pnpm extract init --game <install root or Endfield_Data> [--keys-from <dir>...]
pnpm extract pack map02 [--level map02_lv001]
pnpm run dev    # viewer lists packages under out/
pnpm extract --help
```

`cli.ts` loads every file in `commands/` as a subcommand exporting `summary`, `usage`, and
`run(args)`; shared argument helpers live in `cli-args.ts`. running any command with no args or
`--help` / `-h` prints its usage without requiring a config or install. every command accepts
`--config <file>` (default `endfield.local.json`). all commands except `init` open the install via
`withContext` (`context.ts`), which mounts the VFS, builds the world index, and creates the asset
resolver lazily.

| command   | purpose                                                                                                                                                               |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `init`    | writes `endfield.local.json` with `Endfield_Data` path and validated keys                                                                                             |
| `pack`    | writes a viewer package for one streaming scene, optionally filtered by `--level` or `--bounds`                                                                       |
| `scene`   | browses scenes/dungeons (`list`), `levels`, spatial placements (`find`), single chunks (`chunk`: entities, HLOD stats, foliage), `env` (level or `--at`), `controls`  |
| `inspect` | decodes and summarizes a `prefab` (hierarchy + packer output), `material` (declared props + surface), `mesh`, `texture`, or `water-config`                            |
| `audit`   | queries packed packages under `out/` without opening the install: `list`, `tree`, `instances`, `materials`, `geometries`, `stand-ins`, `interactives`, `water`, `env` |
| `data`    | path catalog `paths`/`resolve`, SparkBuffer `tables`/`table`, and MemoryPack level `scripts`/`interactives`                                                           |
| `vfs`     | lists VFS groups/files and extracts one logical file                                                                                                                  |
| `bundle`  | inspects bundles: header, per-class counts, object JSON, stream data, container path and class search in main/initial bundles                                         |

only `init` and `pack` are needed to build packages; the rest are for research and debugging.

### finding assets and scenery

```sh
pnpm extract data paths 'water.*material' --limit 50 --json
pnpm extract scene find map02 --near=-476.6,181.8,734.3 --radius 20 --max-size 50 --no-hlod
pnpm extract scene env map02 --at=-1072.4,197.0,-1410.9
pnpm extract inspect prefab main/dcd0a8888ee70d437e1d553e.ab
pnpm extract audit materials map02 --unsupported --group
pnpm extract bundle find --class Shader --group initial --limit 20
```

- **`data paths`**: regex-searches both StringPathHash catalogs (case-insensitive). prints hex hash,
  full path, and matching manifest bundles. identical hash/path pairs deduplicate; distinct hashes
  for the same path stay separate. an empty bundle list means no manifest asset; use `data resolve`
  for dependency details.
- **`scene find`**: searches all placements in a scene across every scene state and stream area,
  reporting what gates each row. `--kind` selects sources (default all):

| kind       | source                                                                                          | visibility from                     |
| ---------- | ----------------------------------------------------------------------------------------------- | ----------------------------------- |
| `static`   | chunk entities ([world](game-data/world.md))                                                    | chunk file's scene state and area   |
| `dynamic`  | ECS entities of [dynamic structures](extraction/prefabs-and-interactives.md#dynamic-structures) | owner's gates, states, and areas    |
| `model`    | DynamicStreaming prefab rows                                                                    | same as `dynamic`                   |
| `effect`   | DynamicStreaming effect prefab rows                                                             | same as `dynamic`                   |
| `facility` | [interactives](extraction/prefabs-and-interactives.md#interactives), incl. unfound models       | facility, door, and bridge controls |
| `cabin`    | built [Dijiang cabins](extraction/scene-controls.md#dijiang-cabins-and-region-walls)            | slot's cabin control                |
| `light`    | chunk local lights ([local lights](game-data/lighting.md#local-lights))                         | chunk file's scene state and area   |
| `water`    | placed water surfaces and gameplay water volumes ([water](game-data/water.md))                  | always                              |
| `env`      | chunk environment volumes ([environment](game-data/environment.md))                             | chunk file's scene states           |

visibility prints as package scene controls under default game state: alternatives joined by `|`,
requirements by `&`, each `control=values` (or `always` when ungated). `static` rows also show their
[streaming layer](game-data/world.md#streaming-layers), and rect decals show their material
(accepted by `inspect material`).

- `--name`: matches entity names, mesh/material paths (including rect decals), prefab paths, and row
  sources.
- `--near x,y,z --radius n`: keeps rows whose world bounds (or pivot/placement) lie within `n` m in
  Unity coordinates; sorted nearest first, then smallest bounds first among containing boxes.
  `--max-size n` drops rows whose longest bound side exceeds `n` m (and global env volumes);
  `--no-hlod` drops static `HLOD0`/`HLOD1`/`HLOD2` layers; `--hlod-links` reads `StreamingChunkData`
  to show each static entity's HLOD parent/child link. prefab rows have positions only, no bounds.
- **`scene chunk <scene> <chunk>`**: inspects one `InitChunkData` + `StreamingChunkData` pair (e.g.
  `-13_-10_0_0`, `-13_-10`, or `Global_0_0`) for entities and HLOD links, `--hlod-stats` (per-layer
  parent/cluster/no-HLOD counts, filterable with `--name`), or `--foliage` (grass/tree grids).
- `--scene-state` and `--area`: filter static chunk files and chunk lights; other kinds are
  unaffected.
- if `out/<scene>/debug/stand-ins.json` exists, rows drawn as
  [stand-ins](package-format.md#stand-ins) are annotated with their reasons (prefab renderers by
  asset path; placed cubes by name within 2 m).
- all kinds except `static`, `light`, `water`, and `env` come from the packer's placement sources
  ([survey.ts](../packages/extractor/src/pack/survey.ts)), including level scripts. load failures
  print to stderr and static rows still run.
- text output lists distance, kind, level, position, name, size, visibility, first draw's
  mesh/material/material bundle (or prefab path/bundle; or component ids if no renderer), and source
  chunk/row. `--json` adds all draws, matrices, bounds, raw visibility alternatives, and prefab
  rotation/scale.
- both `data paths` and `scene find` default to 100 results (`--limit` must be positive). summaries
  and limit notices go to stderr so `--json` emits one JSON array (`[]` if empty). without `--near`,
  hitting `--limit` stops scanning early; with `--near`, all sources are scanned to keep the
  nearest.
- **`bundle find`**: searches `m_Container` paths (`bundle find <re>` or `--filter <re>`) and/or
  objects of a `--class` (listing bundle, SerializedFile node, path id, class, name, and container
  paths ready for `bundle dump` or `inspect`). `--group` takes `main` (default), `initial`, or
  `all`; `--limit` caps output rows; `--scan` caps bundles.
- **`bundle dump`**: dumps objects from one bundle by `--path-id`, `--class`, and/or `--name <re>`.
  `--text` prints a `TextAsset`'s `m_Script` directly (headers between multiple matches); `--json`
  wraps the output in a single JSON array.
- **`audit`**: reads `out/<scene>/` directly (no game install opened): `list` summarizes every
  packed package under `out/` (filterable with `--has water-volumes|stand-ins|errors`), `tree`
  inspects `core.czar` tile nodes and distances (`--at`, `--from`, `--blob`, `--level`), `instances`
  traces `debug/instances.jsonl` rows to their owning tile node and decoded LOD chain, and
  `materials` / `geometries` / `stand-ins` / `interactives` / `water` / `env` query `debug/`.

## local config and keys

`endfield.local.json` stores `gameData` (the `Endfield_Data` path) and container keys (`keys.vfsKey`
for catalogs and encrypted logical files; `keys.bundle` for the bundle cipher). it matches
gitignored `*.local.json` and is written mode 0600 ([decisions](architecture.md#decisions)).
`config.ts` validates its shape on load and key lengths when opening the install.

`pack` also reads `Endfield_Data/il2cpp_data/Metadata/global-metadata.dat` and `GameAssembly.dll`
(beside `Endfield_Data`) to derive the [MemoryPack](#memorypack-data) schema at runtime (<1 s, never
saved to disk).

`init` builds keys in three steps (`hg/key-derive.ts`):

1. **derive from install**: recover the bundle cipher's S-box, key, and IV from the client, and
   search for `chainXor`.
2. **import missing keys (`--keys-from`)**: `hg/key-import.ts` reads keys not recoverable from the
   install (VFS key, and `chainXor` when not found, as in the current client) from local tool
   checkouts (Endfield-map-extractor for VFS key, AnimeStudio for bundle cipher). without
   `--keys-from`, `init` fails naming the missing key.
3. **validate before saving**: verify `vfsKey` decrypts a `.blc` catalog into a valid layout, and
   the bundle cipher decrypts/decompresses the first data block of several small bundles into a
   valid SerializedFile header. any failure aborts. `init` then reopens the VFS with the final keys
   and mounts the Bundle group.

## container layers

the install is read through three nested layers (formats in
[containers.md](game-data/containers.md)). `formats` decodes bytes; `extractor` adds file handles,
caching, and cross-file lookups:

| layer          | decoder                                                                       | extractor side                        |
| -------------- | ----------------------------------------------------------------------------- | ------------------------------------- |
| VFS            | `formats/src/hg/vfs-catalog.ts`, `payload.ts`                                 | `extractor/src/hg/vfs.ts`             |
| HG bundle      | `formats/src/hg/bundle.ts`, `bundle-cipher.ts`, `binary/lz4.ts`               | `extractor/src/hg/bundles.ts`         |
| SerializedFile | `formats/src/unity/serialized-file.ts`, `type-tree.ts`                        | `extractor/src/game/assets/assets.ts` |
| tables & data  | `formats/src/hg/string-pool.ts`, `spark-buffer.ts`, `endfield/memory-pack.ts` | `extractor/src/game/`                 |

- **VFS (`hg/vfs.ts`)**: `VfsGroup` holds group hashes; `VfsFile` implements `ByteSource` for
  random-access reads and `readVerified()` for MD5-checked whole-file reads. `Vfs.read` and
  `Vfs.tryRead` verify MD5 by default; pass `{ verify: false }` for large or high-volume files whose
  own framing already validates them (StringPathHash tables, LZ4-framed chunk payloads).
  `Persistent/index_main.json` and `CompressData.bin` are unused.
- **bundles (`hg/bundles.ts`)**: `UnityBundle` reads headers/directories and decodes only blocks
  overlapping a requested byte range. descrambling is ported from AnimeStudio. `loadBundleManifest`
  caches the decompressed `manifest.hgmmap` in `out/.cache/install/` keyed by its catalog MD5 so
  repeated CLI runs skip Brotli decompression (~430 ms).
- **IL2CPP metadata (`il2cpp/metadata.ts`)**: detects the extra `i32` per type-definition row by row
  size and feeds the MemoryPack schema reader.

### asset resolution

world data references assets by 64-bit path hash. StringPathHash tables map hashes to paths (main
table first, then initial); the bundle manifest maps paths to bundles and dependency closures
([lookup tables](game-data/assets.md#lookup-tables)).

because the [path hash function](game-data/assets.md#open) isn't ported, path → hash
(`WorldIndex.hashesOf`) decodes paths of matching length in both tables (first lookup indexes by
length in <1 s; later lookups take ~1 ms). `data resolve <path|hash>` prints both directions, the
holding bundle, and its dependencies. code:
[string-path-hash.ts](../packages/formats/src/hg/string-path-hash.ts),
[bundle-manifest.ts](../packages/formats/src/hg/bundle-manifest.ts),
[world-index.ts](../packages/extractor/src/game/world/world-index.ts).

`AssetResolver` ([assets.ts](../packages/extractor/src/game/assets/assets.ts)) resolves a hash or
PPtr into an `ObjectRef` (bundle index, SerializedFile, object info) following
[how a reference reaches an object](game-data/assets.md#how-a-reference-reaches-an-object):

- opens dependency directories in batches and caches CAB locations.
- sub-asset lookup checks the main asset and same-bundle preload pointers, skipping dependency
  preloads. `findUnique` requires exactly one match; missing containers, class mismatches, ambiguous
  sub-assets, and invalid preload ranges fail and record into the debug index.
- PPtrs into Unity built-in files resolve to the bundled copy of a
  [built-in mesh](game-data/assets.md#built-in-meshes) (Cube and Quad;
  [builtin-resources.ts](../packages/extractor/src/game/assets/builtin-resources.ts)), looked up on
  first use; any other throws `FormatError` with its path id.
- an `AssetRef` reached via a prefab carries an `ObjectLocator` (bundle, CAB, path id), bypassing
  path lookup. `objectKey` (`CAB-<hex>:<pathId>`) keys deduplication and caching.

### objects

`type-tree.ts` decodes any object generically from its SerializedFile's TypeTree, so Hypergryph's
custom fields decode automatically:

- integers ≤32-bit and floats → `number`; 64-bit integers (`m_PathID`) → `bigint`; `bool` →
  `boolean`
- byte arrays (`UInt8`, `TypelessData`, `SInt8`) → zero-copy `Uint8Array` / `Int8Array` views
- other numeric arrays → aligned typed-array copies; `bool` arrays → plain arrays; classes → objects
  in serialized field order
- `readTypeTreeField` materializes a single field (used by the shader reader for `m_ParsedForm`)

class decoders read fields via narrowing accessors in `values.ts` (`numberField`, `pptrField`,
`aabbField`, …), throwing `FormatError` naming the field on mismatch. `toPlainObject`
(`plain-object.ts`) converts config objects (`HG*Config`) to plain JSON with Unity math structs as
arrays and `UInt8` bools as booleans. code:
[serialized-file.ts](../packages/formats/src/unity/serialized-file.ts),
[type-tree.ts](../packages/formats/src/unity/type-tree.ts),
[values.ts](../packages/formats/src/unity/values.ts),
[plain-object.ts](../packages/formats/src/unity/plain-object.ts).

## decoders

`formats` modules validate layouts during decoding and throw on mismatch.

### asset classes

[asset-decode.ts](../packages/extractor/src/game/assets/asset-decode.ts) binds each decoder to
`AssetResolver` to follow stream data and cross-bundle PPtrs.

- **mesh** ([mesh.ts](../packages/formats/src/unity/mesh.ts)): decodes `Mesh` (class 43) vertex
  channels/streams, index buffer, and submeshes into typed arrays (reading `m_StreamData` if
  present). `unpackHgNormal` decodes packed normals ([mesh](game-data/assets.md#mesh)) while
  preserving raw words in `packedNormals`. skinned meshes expose weights, bone indices, and bind
  pose counts in `skin`. fails on unseen packing nibbles, partial triangles/quads in submeshes,
  collision-only meshes (`m_CollisionMeshBaked`), or `m_CompressedMesh` vertices.
  - **tangents**: f32 tangents are kept as is. for packed-normal meshes, the packer generates
    MikkTSpace tangents from the UV set used by normal-mapped materials (lowest set if materials
    disagree; [geometry blob](package-format.md#geometry-blob-mesh-efgm)). disagreements are counted
    in the report and listed in `debug/assets.json` (`tangentUvs`).
  - **sway & vertex offset**: meshes drawn with swaying materials use the strongest sway (weights in
    position W, grown bounds); meshes with texture vertex offsets use the farthest offset
    ([swaying geometry](package-format.md#geometry-blob-mesh-efgm)).
  - **VAT baking** ([vat-skin.ts](../packages/extractor/src/pack/convert/vat-skin.ts)): meshes drawn
    with a [vertex animation texture](game-data/materials.md#vertex-animation-textures) bake into
    skeletal meshes. the worker creates a bone per rigid piece (distinct UV1 + pivot) or soft point
    (distinct UV1 + rest position), or copies bone-animation matrices using UV2/UV3 bones and
    weights (bone 0 holds static vertices). soft-body moving vertices get `+y` normals and `-x`
    tangents turned by their bones. sampling at each baked frame's midpoint makes negative speeds
    play backwards. meshes whose draws disagree on the animation, or that a renderer poses/animates,
    stay static with the reason in `debug/assets.json` (`unanimated`).
- **skin pose** ([skin-pose.ts](../packages/formats/src/unity/skin-pose.ts)): bakes linear blend
  skinning (bone matrix × bind pose per bone) into a static mesh. throws on missing influences, bad
  bone indices, or singular transforms. skinned prefab renderers use this for their authored pose
  unless a [looping clip](extraction/prefabs-and-interactives.md#looping-clips) animates their
  bones.
- **texture** ([texture.ts](../packages/formats/src/unity/texture.ts)): decodes `Texture2D`,
  `Cubemap`, `Texture2DArray`, `CubemapArray`, and `Texture3D` into KTX2 level-major mip order,
  passing BC blocks unchanged. sRGB-ness comes from the texture, never the material slot. alpha-only
  textures (`TextureFormat` Alpha8, `GraphicsFormat` 54) store as `r8unorm` (shaders read red).
  formats without a WebGPU equivalent fail conversion and appear in the report and `assets.json`.
- **material and shader** ([material.ts](../packages/formats/src/unity/material.ts)): copies
  serialized `Material` state (shader PPtr, keywords, custom queue, tags, texture slots with
  scale/offset and HGRP `m_UVSetIndex`, floats, colours;
  [material and shader](game-data/assets.md#material-and-shader)). the packer overrides
  `m_UVSetIndex` with Lit shader UV-set floats where declared
  ([lit layers](game-data/materials.md#lit-layers)). `summarizeShader` reads shader name,
  first-subshader tags, and declared properties from `m_ParsedForm`. in the extractor (kept outside
  `asset-decode.ts` and the conversion worker's import graph so edits preserve the
  [pack cache](#pack-cache)):
  - `loadMaterial` ([material-load.ts](../packages/extractor/src/game/materials/material-load.ts)):
    resolves shader and textures and classifies the material. unresolvable texture PPtrs leave the
    slot empty, count as a `texture slot` failure, and appear in the material's debug row.
  - `classifyHgrpMaterial`
    ([material-classify.ts](../packages/extractor/src/game/materials/material-classify.ts)): derives
    shader family (from shader name), blend kind, queue, alpha-test threshold, cull mode, and Lit
    normal/MRO layout. refines Unity's queue boundaries (≥2450 alpha test, ≥3000 transparent) using
    HGRP properties. reads only properties declared by the shader (falling back to shader defaults),
    ignoring leftover properties from previous shaders (e.g. map02 Lit materials retaining
    LitTransparent's `_SurfaceType` and blend factors).
  - `describeMaterial`
    ([material-describe.ts](../packages/extractor/src/game/materials/material-describe.ts)): maps
    the material to its [surface](package-format.md#materials) via a dispatch table of per-shader
    describers in [surfaces/](../packages/extractor/src/game/materials/surfaces/) and
    [effects/](../packages/extractor/src/game/materials/effects/). describers read properties via
    [material-values.ts](../packages/extractor/src/game/materials/material-values.ts) and share
    helpers in [describe-steps.ts](../packages/extractor/src/game/materials/describe-steps.ts),
    [effect-steps.ts](../packages/extractor/src/game/materials/effects/effect-steps.ts), and
    [texture-stack.ts](../packages/extractor/src/game/materials/effects/texture-stack.ts). adding a
    shader means adding a describer module, a table entry in `describeMaterial`, and (for surface
    shaders) its keywords in
    [surface-keywords.ts](../packages/extractor/src/game/materials/surfaces/surface-keywords.ts).
- **transform** ([transform.ts](../packages/formats/src/unity/transform.ts)): builds column-major
  TRS matrices using the game's Unity Euler order ([transform](game-data/assets.md#transform)).
- **lens flare data** ([lens-flare-data.ts](../packages/formats/src/unity/lens-flare-data.ts)):
  reads `LensFlareDataSRP` (which has no TypeTree;
  [lens flare](game-data/post-processing.md#lens-flare)) in SRP core 12 field order with 4-byte
  padded bools. curves store as keys; gradients store as colour and alpha keys.

### world

- **LevelConfig** ([level-config.ts](../packages/formats/src/endfield/level-config.ts),
  [LevelConfig](game-data/world.md#levelconfig)): verifies member counts (18 root, 3 `defaultState`)
  and exact EOF.
- **MapConfig** ([map-config.ts](../packages/formats/src/endfield/map-config.ts),
  [MapConfig](game-data/world.md#mapconfig-and-the-ownership-grid)): scene-state conditions are
  covered in [MapConfig scene states](extraction/scene-controls.md#mapconfig-scene-states).
- **InitChunkData and StreamingChunkData**
  ([init-chunk-data.ts](../packages/formats/src/endfield/init-chunk-data.ts),
  [streaming-chunk-data.ts](../packages/formats/src/endfield/streaming-chunk-data.ts),
  [static scenery](game-data/world.md#static-scenery-initchunkdata-and-streamingchunkdata)):
  `WorldIndex.chunkFiles()` parses chunk filenames. `InitChunkData` accepts only versions 47 and 49
  ([layout](game-data/world.md#initchunkdata-layout)). `readChunkEntities` builds `ChunkEntity` rows
  (id, tag, name, matrix, bounds, decal flag, `StaticRenderer` draws with StringPathHash keys,
  submesh, flags, LOD range) and throws on stride/count mismatches. kind-1 objects use
  [mono-objects.ts](../packages/formats/src/endfield/mono-objects.ts); local lights use
  [chunk-lights.ts](../packages/formats/src/endfield/chunk-lights.ts).
- **foliage grids** ([foliage-grids.ts](../packages/formats/src/endfield/foliage-grids.ts),
  [foliage grids](game-data/world.md#foliage-grids)).
- **stream areas** ([stream-area.ts](../packages/formats/src/endfield/stream-area.ts),
  [stream areas](game-data/world.md#stream-areas)).
- **terrain** ([terrain.ts](../packages/formats/src/hg/terrain.ts),
  [terrain-source.ts](../packages/extractor/src/game/world/terrain-source.ts),
  [terrain](game-data/terrain.md)): validates that the mip chain fills the payload exactly.

**level partition**: `buildLevelPartition`
([level-partition.ts](../packages/formats/src/endfield/level-partition.ts)) cross-checks MapConfig
`levelIds`, LevelConfig `levelGrids`, and entity-id level tags
([the level partition](game-data/world.md#the-level-partition)), collecting disagreements as
`issues` (`scene levels <map>`). `scene levels <map> --verify` checks tags by pivot majority vote
(excluding backdrop cells so skyline props don't outvote small levels). because ownership follows
tag, not position:

- `--level` filters by tag (clipping by cells or rects cuts real scenery)
- unowned cells are kept under their tag's level
- MapRegionTable polygons are UI overlays only, never clip volumes

`classifyEntity` returns a bucket (`level`, `shared` for tag 0, `unassigned`) and grid placement
(`own`, `neighbour`, `backdrop`, `unplaced`).

### water

decoders for [water data](game-data/water.md):

| source                                               | decoder                                                                                                    |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| InitChunkData component 30                           | `readWaterSurfaces` in [water.ts](../packages/formats/src/endfield/water.ts)                               |
| StreamingChunkData property tables                   | [streaming-chunk-data.ts](../packages/formats/src/endfield/streaming-chunk-data.ts)                        |
| `WaterConfig` / `Global_Water_Config` MonoBehaviours | `readWaterSurfaceConfig`, `readWaterGlobalConfig` in [water.ts](../packages/formats/src/endfield/water.ts) |
| scene-wide join and asset loading                    | [water-source.ts](../packages/extractor/src/game/water/water-source.ts)                                    |
| LevelData water volumes and floaters                 | [water-volumes.ts](../packages/extractor/src/game/water/water-volumes.ts)                                  |
| scripted fills from level scripts                    | [water-volume-scripts.ts](../packages/extractor/src/game/water/water-volume-scripts.ts)                    |

- **surfaces**: component layout ported from An1X3R/Endfield-map-extractor (MIT,
  `extractor_core/water.py`). `readWaterSurfaces` rejects zero masks, non-finite values, or missing
  bindings. `readSceneWater` deduplicates by id (first copy in filename order), unions chunk scene
  states, and resolves meshes with `AssetResolver.findUnique(…, UnityClass.Mesh)`.
- **configs**: `readWaterSurfaceConfig` keeps top-level numeric fields under serialized camelCase
  names, flags as 0/1, and Unity math structs as arrays. configs bind by asset key, never
  `materialIndex` ([surface `WaterConfig`](game-data/water.md#surface-waterconfig)).
  `readWaterGlobalConfig` keeps sectors with `sectorDataExists`, parses `(x, z)` from the path
  (`…/Sector/T_<x>_<z>.asset`) rather than array index, and converts signed `sectorDataAssetHashes`
  to unsigned 64-bit keys.
- **volumes**: decoded whole from LevelData via the [MemoryPack schema](#memorypack-data)
  (`waterVolumes` sits past the interactives prefix). `water-volumes.ts` reads volumes and floaters
  (interactives with component 39), skipping files the schema can't decode whole (only Dijiang's,
  whose spaceship data contains an unwrapped tuple).
- **scripted fills**: `water-volume-scripts.ts` extracts constant target fills (and the fill speed
  set immediately before a smooth move) from level scripts decoded for
  [script groups](extraction/scene-controls.md#script-groups). runtime-computed actions are skipped
  and counted (`waterScriptActionsComputed`). `WaterVolumeSetAmount` is treated as moving at the
  volume's speed (assumption: move vs snap is unverified).

`scene find <scene> --kind water` lists placements and volumes, `inspect water-config <ref>` dumps
configs, and `audit water <scene>` summarizes packed counts and errors. package layout is in
[water](package-format.md#water).

### irradiance

[hg/irradiance.ts](../packages/formats/src/hg/irradiance.ts) parses the
[irradiance volume](game-data/irradiance.md) (`parseIrradianceRegion` reads Dijiang's
[room bakes](game-data/irradiance.md#region-bakes)). compressed cells use one inverted-LZ4 block
(`decodeInvertedLz4Block` in [binary/lz4.ts](../packages/formats/src/binary/lz4.ts)). the parser:

- accepts only index magics `0x03000004` and `0x03000003` (rejecting gacha/legacy indices) and skips
  the spatial hash header and pair table
- verifies records tile each payload contiguously from 0 and every payload has records (the packer
  also checks payload EOF)
- reads payload index from directory word 7, never filename order
- normalizes cell keys to the 8192 m layout (`0x03000004`, world 0 at 128)

package storage is in [irradiance cells](package-format.md#irradiance-cells).

### MemoryPack data

[memory-pack.ts](../packages/formats/src/endfield/memory-pack.ts) decodes
[level scripts](game-data/scene-states.md#level-scripts), interactive templates, and LevelData using
the runtime schema from IL2CPP metadata and `GameAssembly.dll`
([il2cpp/](../packages/formats/src/il2cpp); [MemoryPack](game-data/containers.md#memorypack)). every
level script and interactive template in the client decodes to exact EOF.

LevelData files with populated blackbox settings (factory puzzles) are skipped and listed in
`unsupported-interactives.json`.

## pack

one package holds one streaming scene
([scenes, maps and levels](game-data/world.md#scenes-maps-and-levels)). `scene list` lists all
scenes. `scene list --dungeons`
([game/world/dungeons.ts](../packages/extractor/src/game/world/dungeons.ts)) lists DungeonTable
entries with their level, streamed scene (`=` if own), operator, and referencing missions (unlisted
entries come from menus, NPCs, or are unused). `--level` accepts only levels of the scene's own map,
so cross-map levels like `dung02_rdg012` on `dung02_rdg008` cannot be selected
([status](status.md#scene-states-and-controls)).

`pack <scene>` ([pack/packer.ts](../packages/extractor/src/pack/packer.ts), `packScene`) writes to
`out/<scene>` or `out/<scene>-<level>` (override with `-o <dir>`). the target directory must be
absent, empty, or contain a previous package (plus at most `.DS_Store`), or `pack` aborts. output is
staged in a hidden sibling and atomically renamed on success ([layout](package-format.md#layout)).

- `--level <id>`: keeps content owned by that level plus terrain under its cells (recorded in
  manifest).
- `--bounds`: keeps content whose centre lies inside an x/z world rectangle (recorded in manifest).
- `--no-assets`: skips mesh, material, and texture conversion (leaves table entries pending) for
  fast iteration.

### phases

phases run in order and are timed individually in the report:

| phase                  | work                                                                                                                                                       |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| setup                  | validate/stage output dir, open cache, index scene (level partition, terrain, tile grid, subset, scene states, chunk files)                                |
| entities               | read chunk files (with read-ahead), dynamic structures + level scripts, interactive facilities, cabins, and prefabs; intern draw chains and file instances |
| terrain                | encode/store terrain height, surface, splat pages, and layer textures (or recall from cache)                                                               |
| environments and water | plan per-level environment profiles, volumes, and water surfaces/sectors concurrently                                                                      |
| irradiance             | assign visibility groups and controls to volumes/water/lights; store base and scene-state irradiance cells (cached) and Dijiang room bakes (uncached)      |
| instances              | encode/store instance blocks and attach detail/HLOD blocks to the tile tree                                                                                |
| materials              | decode materials and build shader/material tables (replaced with one `assets` phase listing pending entries under `--no-assets`)                           |
| geometry               | convert meshes                                                                                                                                             |
| textures               | convert textures                                                                                                                                           |
| states                 | build manifest levels and scene controls                                                                                                                   |
| write                  | build tile tree and tables; write archives, hard-linking unchanged archives from the previous package ([reuse](package-format.md#layout))                  |
| debug                  | write `debug/`; rename staged package into place                                                                                                           |
| cache sweep            | record package root and delete unreferenced cache entries                                                                                                  |

### code layout

`packScene` ([packer.ts](../packages/extractor/src/pack/packer.ts)) orchestrates the phases from
modules under [pack/](../packages/extractor/src/pack/):

| module                                                                                                                                                                                                                                                                                                                                   | role                                                                                                           |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| [scene-index.ts](../packages/extractor/src/pack/scene-index.ts)                                                                                                                                                                                                                                                                          | setup: partition, terrain, tile grid, HLOD grid fit, chunk file order, `--level`/`--bounds` subset             |
| [content/](../packages/extractor/src/pack/content/)                                                                                                                                                                                                                                                                                      | entities phase: one module per content source, invoked in fixed order by `collectEntities` (`entities.ts`)     |
| [environments.ts](../packages/extractor/src/pack/tables/environments.ts), [water.ts](../packages/extractor/src/pack/tables/water.ts), [lights.ts](../packages/extractor/src/pack/tables/lights.ts), [terrain.ts](../packages/extractor/src/pack/tables/terrain.ts), [irradiance.ts](../packages/extractor/src/pack/tables/irradiance.ts) | core tables: planned, gated (visibility groups/controls), then finalized once texture and control ids exist    |
| [instance-blocks.ts](../packages/extractor/src/pack/instances/instance-blocks.ts)                                                                                                                                                                                                                                                        | encodes/stores collected instance rows ([collector.ts](../packages/extractor/src/pack/instances/collector.ts)) |
| [particles.ts](../packages/extractor/src/pack/tables/particles.ts)                                                                                                                                                                                                                                                                       | particles table, interned as content sources add particle draws                                                |
| [states.ts](../packages/extractor/src/pack/states.ts)                                                                                                                                                                                                                                                                                    | scene controls (quests, progressions, stream areas, scene states), finalized and indexed                       |
| [write.ts](../packages/extractor/src/pack/write.ts), [debug.ts](../packages/extractor/src/pack/debug.ts), [report.ts](../packages/extractor/src/pack/report.ts)                                                                                                                                                                          | writes `core.czar`, `debug/` files, and pack report                                                            |

every content source writes through `PackContent`
([pack-content.ts](../packages/extractor/src/pack/content/pack-content.ts)), which interns draws
into chain/geometry/material/particle tables, files rows (`addStructure`, `addStandInCube`),
registers controls and lights, and tracks report counts and failures.

**extending the packer**:

- **new placed prefab source**: emit `StructureModel`s and add it to `collectPlacementSources`.
  [prefab-placements.ts](../packages/extractor/src/pack/content/prefab-placements.ts) handles
  renderers, lights, environment volumes, and stand-ins (reading each prefab root once), and
  `scene find` / `scene env` pick it up automatically via
  [survey.ts](../packages/extractor/src/pack/survey.ts).
- **new prefab component**: add a reader, step, or candidate source to the renderer walk, or a
  visitor to `walkPrefab`
  ([hierarchy walks](extraction/prefabs-and-interactives.md#hierarchy-walks)).
- **new content source**: add a module under `content/` and call it at a fixed spot in
  `collectEntities`.
- **new core table / debug file / count**: add the type + `CORE_PATHS` entry in `package-format`, a
  table module in `pack/tables/`, and an entry in `packScene`'s core member list (or debug file
  list; counts via `PackContent.count` print automatically).

**determinism**: source call order is explicit because geometry/material ids follow first reference,
synthetic entity ids (`PackContent.nextSyntheticId`) follow call order, and chunk entities win over
dynamic duplicates by running first. parallel steps commit results in id order so cold, warm, and
uncached packs produce byte-identical archives.

**stable chain ids**: `ChainTable.stableOrder`
([pack/instances/chains.ts](../packages/extractor/src/pack/instances/chains.ts)) preserves chain ids
across repacks into an existing directory using content-key hashes recorded in `debug/chains.json`
(keyed by asset identities, not shifting table ids). surviving keys keep their ids; new keys fill
freed slots then append, both in key order; unused slots hold empty chains. unchanged shard archives
therefore keep identical hashes and are reused. fresh directories start in key order.

### how the packer files instances

[static-chunks.ts](../packages/extractor/src/pack/content/static-chunks.ts) reads chunk files in
fixed order: always-loaded before scene-state files, default area before stream areas, then by name.
an entity first seen in an always-loaded default-area file stays unconditional; otherwise it loads
whenever any file holding it has both its scene state and stream area active. DynamicStreaming
entities' area lists ([stream areas](game-data/world.md#stream-areas)) gate them the same way.
entities without a renderer, matrix, or bounds are tallied in `debug/skipped-entities.json` (lights
and water surfaces are packed separately); rect decals draw the shared decal cube
([rect decals](package-format.md#materials)).

every row belongs to one visibility group (level tag + loading condition;
[visibility groups](package-format.md#visibility-groups)):

| destination | contents                                                                                                                                                 | storage                             |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| HLOD        | scene-state-0 HLOD clusters (named as cluster, with linked children), gated by stream areas; attached to their named cell's tile at `hlodLevels[t]`      | one block per group, in `core.czar` |
| global      | other `Global` chunk entities (including childless clusters), with their files' condition                                                                | one block per group, in `core.czar` |
| detail      | other scene-state-0 entities, gated by stream areas, filed under the 64 m leaf containing their bounds centre; same-area HLOD clusters stand in for them | one block per `(leaf, group)`       |
| conditional | scene-state cell entities, dynamic structures, and facilities with a visibility expression; dynamic rows keep their loading `fb_main` grid               | one block per `(leaf, group, grid)` |

- **load grids**: dynamic model/effect rows keep their own grid; ECS entities take the coarsest grid
  among resource groups naming their component group
  ([dynamic load grids](game-data/world.md#dynamic-load-grids)). facilities and Dijiang cabins have
  no grid.
- **LOD and HLOD** ([LOD and HLOD](game-data/world.md#lod-and-hlod)):
  - per-entity LOD chains and thresholds are preserved whole (foliage cards are ordinary chain
    draws).
  - HLOD clusters require both a cluster name and linked children; childless clusters pack as global
    scenery (e.g. `indie_dg005` city backdrop). HLOD links aren't packed—the viewer swaps clusters
    and detail by tile ([instance selection](viewer/streaming.md#instance-selection)). HLOD clusters
    are excluded from a level's instance count.
  - setup fits the scene's HLOD grid to Global chunk cluster names (reported with match counts).
    ambiguous cluster names (clamped coords or straddling cells) assign to the tile containing the
    most of their detail instances
    ([hlod-cells.ts](../packages/extractor/src/pack/instances/hlod-cells.ts),
    [tile tree](package-format.md#tile-tree)).
- **[foliage grids](game-data/world.md#foliage-grids)**: each grass/tree instance is an ordinary row
  carrying its cluster's bounds so the cluster culls and LODs as a unit.

for prefabs, dynamic structures, and interactives, see
[prefabs and interactives](extraction/prefabs-and-interactives.md).

### asset conversion and workers

[pack/convert/assets.ts](../packages/extractor/src/pack/convert/assets.ts) converts materials first
on the main thread (bounded concurrency) because materials determine required mesh tangents and used
textures. meshes and textures then convert on worker threads
([convert-pool.ts](../packages/extractor/src/pack/convert/convert-pool.ts),
[convert-worker.ts](../packages/extractor/src/pack/convert/convert-worker.ts)):

- each worker opens the install itself, writes blobs directly to the blob store, and returns small
  metadata. the bundle manifest is decompressed once into shared memory for all workers.
- workers spawn lazily (a fully cached pack starts none) and hold at most two jobs in flight to
  bound decoded texture memory.
- texture objects with identical content merge into one table entry after conversion (counted in the
  report).
- an asset reached both by path hash (static entities) and by object (prefabs) is interned under
  both keys and converts twice (`AssetIds` in `pack/convert/asset-ids.ts`).

**flags and tuning**:

- `--jobs`: defaults to `cores - 1`, capped at 8. each worker holds ~150–200 MB of catalogs and
  block caches before in-flight assets; a cold `map02` pack peaks at several GB RSS.
- `--zstd-level` (default 19): geometry, instance blocks, terrain height/splat pages.
- `--texture-zstd-level` (default 9): textures, terrain surface pages, layer textures (main lever on
  cold pack time with minimal size/decode impact).
- irradiance cells and core JSON tables always use level 9. blobs omit zstd framing when compression
  doesn't pay ([codec](package-format.md#containers-and-blobs)).

### pack cache

enabled by default at `out/.cache` (`--cache <dir>` to relocate, `--no-cache` to disable),
implemented in [pack/store/pack-cache.ts](../packages/extractor/src/pack/store/pack-cache.ts):

| entry    | contents & invalidation                                                                                                                                                                                                                                                                                                       |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `blobs/` | shared blob store streamed into archives (without cache, lives in staging `.spool` and is deleted after pack)                                                                                                                                                                                                                 |
| `memo/`  | **mesh/texture conversions:** keyed by job (asset, tangent UV set, sway, vertex offset, VAT, zstd level) + converter fingerprint (transitive imports of `convert-worker.ts`, extractor `package.json`, node zstd version) + read bundle MD5s. keep anything affecting conversion output in `convert-worker.ts`'s import graph |
| `memo/`  | **material loads:** V8-serialized (preserves bigints and non-finite numbers) per material + `material-load.ts` import graph + bundle MD5s; shader summaries stored once per shader + bundle MD5; shader/texture bundles re-located by name on recall (warm `map02` materials drop from >10 s to 1–2 s)                        |
| `memo/`  | **prefabs:** V8-serialized per `(prefab, pose, locked, effectLod)` for renderers and per prefab for lights and local-space environment volumes, keyed by the corresponding prefab module's import graph + read bundle MD5s, relocating mesh/material/phase bundles by name on recall                                          |
| `memo/`  | **dynamic structures, scripts, interactives, and water volumes:** V8-serialized per dynamic ECS chunk, per view-state model, and per scene/level for level scripts, interactive facilities (without looping clip samplers), and water volumes, keyed by module import graph, VFS group catalog hashes, and read bundle MD5s   |
| `memo/`  | **static chunks, HLOD layout, and environments:** V8-serialized per scene/subset for static chunk rows (foliage stored per cluster), HLOD grid fit, and planned environments, keyed by module import graph, Streaming catalog hash, and read bundle MD5s                                                                      |
| `memo/`  | **whole steps (terrain, irradiance):** keyed by module import graph, options, subset tiles/cells, and catalog data MD5s of read files (warm `map02`: ~10 s → <1 s each)                                                                                                                                                       |
| `memo/`  | **packer-compressed blobs (e.g. instance blocks):** keyed by raw-byte hash, zstd level, and node zstd version; avoids re-running level-19 zstd on unchanged blocks                                                                                                                                                            |
| `roots/` | one file per package dir listing its blobs and memos; after each pack, roots missing `core.czar` are dropped and unreferenced entries swept. deleting a package dir frees its cache on next pack; deleting the whole cache is always safe                                                                                     |
| `lock`   | holds packer PID; serializes cache access (stale locks from dead processes are taken over)                                                                                                                                                                                                                                    |

**not cached**: turning loaded materials into table entries (fast), script driver linking, and
failed conversions/material loads (always retried, so warm packs may still spawn workers).

### report and debug outputs

`pack` prints a summary (sizes, phase timings, entity/instance counts, asset readiness, conversion
failures by reason, per-level environments, water, cache hits, peak RSS); `--json` emits the full
`PackReport`. each package also writes a `debug/` directory ignored by the viewer:

| file                            | contents                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `assets.json`                   | per geometry/material id: path hash, path, locator, failure reason; per material: shader, unsupported/invisible reason, undrawn keywords, broken texture slots ([unsupported materials](viewer/materials.md#unsupported-materials)); per texture: table id, name, failure reason, unsupported sampler settings (mirror-once drawn as mirror-repeat) |
| `instances.jsonl`               | one line per instance block: blob hash and per-row entity id, name, and chunk-file index (−1 for dynamic structures and prefab renderers, which use synthetic ids)                                                                                                                                                                                  |
| `chains.json`                   | chain key per chain id (empty for free slots), preserved across repacks ([code layout](#code-layout))                                                                                                                                                                                                                                               |
| `chunk-files.json`              | chunk files read, indexed by `instances.jsonl`                                                                                                                                                                                                                                                                                                      |
| `environments.json`             | `levels` (base environment and per-section sources) and `problems` (dropped/phaseless volumes, unresolved phase refs, missing resources)                                                                                                                                                                                                            |
| `water.json`                    | packed vs present surfaces and sectors, sectors naming no tile, failed asset loads                                                                                                                                                                                                                                                                  |
| `terrain.json`                  | tiles missing surface pages, leaves missing splat pages, channel pages without height pages, failed layer textures (omitted without terrain)                                                                                                                                                                                                        |
| `unsupported-interactives.json` | skipped LevelData files and unresolved templates/models                                                                                                                                                                                                                                                                                             |
| `unsupported-prefabs.json`      | prefabs that failed instantiation, with reasons                                                                                                                                                                                                                                                                                                     |
| `stand-ins.json`                | [stand-ins](package-format.md#stand-ins): owner, name, reason, and centre position for placed cubes (prefab renderers listed once per prefab)                                                                                                                                                                                                       |
| `skipped-entities.json`         | chunk and DynamicStreaming entities producing no instance row, grouped by reason and [component set](game-data/world.md#initchunkdata-layout) with count and sample names                                                                                                                                                                           |

when something is missing in the viewer, trace it with `instances.jsonl` (block → entity/chunk) and
`assets.json` (why an asset didn't convert). extractor gaps are listed in
[status.md](status.md#packaging).
