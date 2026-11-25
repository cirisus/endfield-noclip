# assets: meshes, textures, materials and prefabs

Unity assets referenced by world data: StringPathHash and PPtr resolution,
mesh/texture/material/transform layouts, prefabs, and dynamic ECS structures. see also
[world.md](world.md) (entity data), [scene-states.md](scene-states.md) (visibility gating),
[materials.md](materials.md) (shading), [interactives.md](interactives.md) (interactives and view
states), and [animation.md](animation.md) (clips and Animators).

## Unity objects

Endfield ships Unity 2021.3 SerializedFiles (format v22) with embedded TypeTrees, describing
Hypergryph's added fields alongside Unity's own.

a `PPtr` is `(m_FileID, m_PathID)`: `m_FileID == 0` is the same SerializedFile, `n ≥ 1` is
`externals[n − 1]`, and `m_PathID == 0` is null.

## resolving assets

world data references assets in two ways:

- **StringPathHash keys** (InitChunkData draws, StreamingChunkData properties, dynamic model rows,
  LevelConfig `levelDataPathHashes`): 64-bit hash of the lowercased path. paths are
  `<container path>` or `<container path>##<sub-asset name>` (for FBX sub-assets).
- **PPtrs**: used inside prefabs, materials and renderers once an object is reached.

names alone do not identify objects: sub-asset names repeat across FBX containers, LOD and collision
meshes (`*_COL*`) sit beside render meshes with near-identical names, and prefab variants share
renderer names. canonical identities are `hash → bundle → container` and `PPtr → CAB → path id`.

### lookup tables

| file                                                                                        | maps                                                                                                             |
| ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `Data/ExtendData/Main/StringPathHash.bin`, `Data/ExtendData/Initial/InitStringPathHash.bin` | hash → path (main and initial tables)                                                                            |
| `Data/Bundles/Windows/manifest.hgmmap`                                                      | hash → `AssetInfo` (bundle index, size, compressed path); bundle → name, direct dependencies, transitive closure |

both use little-endian hash tables with `(u32 offset, u32 count)` slots indexed by
`unsignedKey % slotCount`, pointing to a run of fixed-size rows scanned for the key.

- **`StringPathHash.bin`**: `u32 stringsOffset` (`= 8 + 24 · count`), `u32 count`, `count` slots
  (absolute offsets), `count` 16-byte buckets `(u32 unknown, u64 hash, u32 pathOffset)`, then paths
  at `stringsOffset + pathOffset` (`u32 byteLength`, UTF-16LE, `u16 0`). a hash's buckets usually
  name one path (sometimes repeated).
- **`manifest.hgmmap`**: one Brotli stream containing five sections:
  1. **header (156 bytes)**: `u32 0xFF11FF11` + build guid, `u32 0xF1F2F3F4` + manifest content hash
     (each `u32` UTF-16 unit length + UTF-16LE chars), `u32 0`.
  2. **asset dictionary**: `u32 size`, `u32 capacity`, `capacity` slots (offsets relative to the
     capacity word), `capacity` 24-byte `AssetInfo` rows
     `(i64 pathHashHead, u32 path, i32 bundleIndex, i32 assetSize, u32 0)`. multiple rows may share
     a hash.
  3. **bundle dictionary**: same shape over 48-byte bundle rows keyed by `hashName` (`bundleIndex`
     stored as 0).
  4. **bundle array**: `u32 size`, `u32 count`, `count` 48-byte rows:
     `(i32 bundleIndex, u32 name, u32 dependencies, u32 directReverseDependencies, u32 directDependencies, u32 bundleFlags, i64 hashName, i64 hashVersion, i32 category, u32 0)`.
     `hashName` hashes `main/<hex>.ab` or `initial/<hex>.ab`; `hashVersion` folds it with every
     dependency's `hashName`; `category` is `RootCategory` (0 `Main`, 1 `Initial`, matching the
     prefix).
  5. **data region**: `u32 size`, payload, `u32 size`. names: `u32 byteLength`, UTF-16LE, `u16 0`.
     dependency lists: `u32 count`, `u32` bundle indices, `u16 0`. asset paths: `u32 length`,
     Brotli-compressed UTF-16LE, `u16 0`.

### how a reference reaches an object

- **hash → bundle**: `manifest.hgmmap`'s `AssetInfo` rows for the hash name the bundles holding it.
- **path → object**: in the bundle, `AssetBundle`'s container maps the lowercased container path to
  a main-asset PPtr and a preload range. a sub-asset is the main asset or a preload pointer with the
  matching class and case-insensitive `m_Name`. sub-assets ship in their container's bundle, so
  relevant preloads stay in that bundle.
- **PPtr → object**: external CAB names (`archive:/CAB-<hex>/CAB-<hex>`) are not derivable from
  bundle names, but always live inside the referencing bundle's dependency closure, as does
  `m_StreamData` (`.resS`). Unity built-ins (`library/…`, `resources/…`) ship in the player, not in
  bundles.

## asset classes

### mesh

`Mesh` (class 43) stores vertex channels/streams, index buffer, submeshes, and optional
`m_StreamData`.

- **packed normals and tangents**: most meshes pack normal + tangent into one `u32` (channel
  dimension byte `0x31`: low nibble = real dimension 1, high nibble = packing flag 3). the Lit
  vertex shader decodes as packed when bit 30 is set (otherwise plain `f32×3`):
  - bits 0–9, 10–19: signed 10-bit octahedral normal `n` (`÷ 511`)
  - bits 20–29: signed 10-bit tangent parameter `a` (`÷ 511`); bit 31: bitangent sign
  - tangent decode: `t0 = normalize(n.yzx − n.zxy` orthogonalised against `n)`,
    `t1 = normalize(cross(n, t0))`, `s = sign(a)`, `u = 1 − 2·a·s`,
    `tangent = [t0 t1] · normalize(u, s·(1 − |u|))`
  - instance normals transform by the inverse transpose (rows scaled by `1 / |row|²`).
- **plain tangents**: meshes with plain `f32` normals carry `f32×4` tangents (`w` = bitangent sign).
  packed-normal meshes have no separate tangent channel (unverified across the full install).
- **other channels**: uv0/uv1 `f32×2`; vertex colour `unorm8×4`; uv2/uv3 `snorm8×4` with dimension
  byte `0x24` (high nibble 2, meaning unknown).
- **dimension byte high nibble**: also 3 on HLOD cluster `snorm8×4` normals, 2 on `unorm16×4` bone
  weights, 1 or 2 on `uint8×4` bone indices (likely influences per vertex). all read as their
  declared format says.
- **compression**: `m_MeshCompression` is only an import setting; non-zero values with an empty
  `m_CompressedMesh` store vertices in standard channels.
- **collision-only meshes**: when `m_CollisionMeshBaked` is set, meshes carry cooked PhysX data and
  omit `m_CompressedMesh` from their bytes despite the TypeTree listing it unconditionally.
- **skinning**: skinned meshes carry weights, bone indices and bind poses. rigid skins
  (`m_BonesPerVertex == 1`) omit the weight channel (single influence = 1).

#### built-in meshes

some prefabs reference Unity's built-in `library/unity default resources`, which no bundle holds:

- **Quad** (path id 10210): used by `int_collection_common_postmodel` icon/glow cards. 1 m in XY
  plane, facing −Z, `UV = position + 0.5`.
- **Cube** (path id 10202): used by `int_balloon_postmodel*` balloons. 1 m cube, each face's UVs
  spanning 0–1 (whether face UV orientation matches Unity's built-in is unchecked).

HGRP bundles its own copies at
`Packages/com.hg.render-pipelines/Runtime/RenderPipelineResources/Mesh/{Quad,Cube}.fbx`.

### texture

texture classes: `Texture2D`, `Cubemap`, `Texture2DArray`, `CubemapArray`, `Texture3D`.

- `Texture2D`-family classes use `TextureFormat` + `m_ColorSpace` (1 = sRGB).
- array and 3D classes use `GraphicsFormat` (which encodes sRGB directly).
- sRGB-ness belongs to the texture, not the material slot.
- scenery textures are predominantly BC7 with full mip chains, plus BC5 normals, a few BC1, and
  RGBAHalf vertex-animation textures. alpha-only textures (`TextureFormat` Alpha8 /
  `GraphicsFormat` 54) store 1 byte per texel.

### material and shader

- `Material` stores shader PPtr, keywords, custom queue, tags, texture slots (scale/offset and
  HGRP's per-slot `m_UVSetIndex`), floats and colours. the Lit shader also declares its own UV-set
  floats ([lit layers](materials.md#lit-layers)).
- `Shader` stores its name, first-subshader tags and declared properties in `m_ParsedForm`.
- beyond Unity's queue boundaries (`≥ 2450` alpha test, `≥ 3000` transparent), HGRP materials carry
  explicit surface, blend, alpha-test and cull properties.

### transform

Unity Euler angles (degrees) apply in Z, then X, then Y order. dynamic model rows use this order.

## prefabs

a prefab is a GameObject hierarchy connected by PPtrs, placed by its root.

- **UI nodes**: world-space `Canvas` (class 223, `m_RenderMode == 2`) and child Images/Text use
  `RectTransform` (class 224) instead of `Transform`. it keeps the same local TRS and children, so
  prefabs can mix both (e.g. Dijiang's weapon wall displays with their counter canvas).
- **activity**: a GameObject draws only if it and all ancestors are active. an active skinned mesh
  may still use bones under an inactive GameObject.
- **renderers**: enabled `MeshRenderer`s (with a `MeshFilter`), enabled `SkinnedMeshRenderer`s, and
  [particle systems](particles.md#particle-systems) draw.
- **LODGroup (class 205)**: when enabled, selects one LOD's renderers by `screenRelativeHeight`
  (`m_Size` at `m_LocalReferencePoint`, scaled by quality LOD bias, with optional cross-fade; bias
  and fade are unchecked).
- **material slots**: order is preserved. a null slot draws nothing for that submesh; slots past the
  last submesh draw the last submesh again. `m_CastShadows` 3 or 4 (`ShadowsOnly`,
  `ShadowsOnlyTwoSided`) marks shadow-only renderers.
- **skinning pose**: each bone's prefab-space matrix × its bind pose.
- **other components**: prefabs can carry [environment volumes](environment.md#prefab-volumes),
  [particle systems and spline movers](particles.md), and
  [one-shot effects and effect LOD tables](effects.md#one-shot-effects).

### billboards

an enabled `VFXBillBoard` MonoBehaviour (identified by `billboardMode`, `rotateInLateTick`,
`rotation`) updates its GameObject's world rotation from the camera each frame:

| `billboardMode` | world rotation                                                                          |
| --------------- | --------------------------------------------------------------------------------------- |
| 0               | camera rotation × `rotation` (Euler degrees offset)                                     |
| 1               | `rotation` with camera heading (Euler y) added to its y                                 |
| 2               | forward = camera forward projected orthogonal to initial up; up = initial up; no offset |
| 3               | same as 2 about parent's up axis, × `rotation`                                          |

examples: snapshot points' yellow light column (`int_system_snapshot_postmodel` in Dijiang) and the
glare on the corroded planet from Dijiang's deck (`P_fxmap_base01_lv001_planetcorrode_01`).

## dynamic structures

`Data/DynamicStreaming/PC/Scene/<scene>/` holds progression-gated scenery: initial structures,
alternative forms, and gated props.

### fb_main grids

each `fb_main_<L>_<i>_<j>` file is a FlatBuffer with grids in root slot 3 and a string table in root
slot 4 (settlement, POI, level, quest and model ids). a grid stores its id in slot 0 and fixed-width
component vectors in its remaining slots.

- an entity is a `RootComp` row whose `Comps` slice lists `DataIndex` entries `(type, grid, index)`.
  referenced rows may live in another grid of the same file.
- `DataGroup` (24 bytes): `i32 invalid, i32 type, u32 grid, i32 index, i32 num, i32 total` — a typed
  slice of the vector for `type` in `grid`. `DataIndex` (16 bytes) is its first four fields.
- a resource group with `logicState == 0` ignores logic state; otherwise bit `n` shows it when the
  entity's logic state is `n` ([scene-states.md](scene-states.md)).

| record                            | slot | type | bytes | fields                                                                                                                                                                                                    |
| --------------------------------- | ---- | ---- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DataIndex`                       | 5    |      | 16    | `invalid, type, grid, index`                                                                                                                                                                              |
| `RootComp`                        | 33   |      | 84    | `u32 entityType` +0, `u32 state` +4, `Comps` DataGroup +8                                                                                                                                                 |
| `ResourceComp`                    | 32   | 30   | 132   | `Res` DataGroup +0 (slice of resource groups), `LodInfo` DataGroup +100 (`LodGridResource` swap chains)                                                                                                   |
| `LodGridResource`                 | 57   | 59   | 92    | `GridChain` (`u32` lod0–2 grids) +0, `ResourceChain` (3 × `DataIndex` to `ResourceGroupWithStateDesc` lod0–2) +12, `VisInfo` +60, `u32 ValidMask` +84, `i32 LodGroupExclusiveId` +88                      |
| `ResourceGroupWithStateDesc`      | 12   | 10   | 88    | `Group` DataGroup +0 (model 5 / effect 6 / ECS 7 rows), `u32 sceneState` +24, `u32 logicState` +28, `i32 levelNum` +32, `i32 factoryIndex` +36; also carries scene-state and stream-area visibility lists |
| `IdComp`                          | 17   | 15   | 16    | `u64 uniqueId` +0, `u64 overrideId` +8 (0 on every entity seen)                                                                                                                                           |
| `SettlementControlComp`           | 29   | 27   | 20    | `i32 settlement` (root string) +0, `bool controlLoad` +4, `i32 compareType` +8, `i32 compareValue` +12, `bool isMain` +16                                                                                 |
| `FactoryRegionControlComp`        | 30   | 28   | 8     | `i32 region` (root string, level id) +0, `i32` +4                                                                                                                                                         |
| `PoiControlComp`                  | 55   | 55   | 8     | `i32 poi` (root string) +0, `i32 domainType` +4                                                                                                                                                           |
| `MissionControlComp`              | 27   | 25   | 32    | `Conditions` DataGroup +0 (`MissionCondition` rows), `i32 compareType` +24, `i32 toBeTrue` +28                                                                                                            |
| `MissionCondition`                | 16   | 14   | 16    | `i32 id` (root string), `i32 isQuest`, `i32 state`, `i32 isSame`                                                                                                                                          |
| `GlobalVarControlComp`            | 28   | 26   | 40    | `i32 globalKey` +0, `u8 controlLoad` +4, `i32 compareType` +8, `i64 compareValue` +16, `i32 extra1`–`4` +24                                                                                               |
| `MapVarControlComp`               | 52   | 51   | 48    | `i32 mapKey` +0, then same fields as global, `i32 mapId` +40                                                                                                                                              |
| `ModelViewStateControllerNewComp` | 37   | 35   | 36    | `i32 modelIdStrId` (root string) +0, `bool useOldVersion` +4, `keyStateToNameMap` DataGroup +8, `i32 keyState` +32                                                                                        |
| `ErosionRootComp`                 | 36   | 34   | 48    | `u64 erosionCoreId` +0, `PosList` DataGroup +8, `Vector3 erosionCorePos` +32                                                                                                                              |
| `SludgeComp`                      | 44   | 42   | 264   | `Vector3 pos` +96, `u64 coreId` +248                                                                                                                                                                      |
| `ExtraSceneComp`                  | 46   | 44   | 40    | `Vector3 minPos` +0, `maxPos` +12, `currentPos` +24, `u32 direction` +36                                                                                                                                  |

a script-control component also holds a default load flag for script-enabled entities.
`ResourceComp` stride, `DataIndex` type-to-slot pairings, and `ErosionRootComp` stride (on map01)
were measured on the client. `SludgeComp` offsets follow `FBDynamicSceneSludgeComp` IL2CPP field
order and natural alignment.

### payloads

| row type | `DataIndex` type | bytes | layout                                                                                                                                                                                                                                                                                                                                                 |
| -------- | ---------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| model    | 5                | 104   | prefab StringPathHash key, position, Unity Euler rotation, scale; grid chain at +52; visibility record at +72; `bool UseLoadFade` at +96 (padded to 8-byte alignment). places prefab under TRS                                                                                                                                                         |
| effect   | 6 (grid slot 8)  | 144   | `Dis` +8 (prefab effect LOD cull distance, 80–500), pos +12, Euler rot +24, scale +36, prefab StringPathHash +48, grid chain +56, `UseBBox` +85, `BboxMin` +88, `BboxMax` +100 (offset to pos), `UseQualitySetting` +112, visibility record +116. places prefab like model rows (all map02 rows name prefabs, e.g. Wuling City's pillar-array threads) |
| ECS      | 7                | 36    | `(sceneIndex, chunk, index)` naming component group `index` in `fb_init_<ss>_<chunk>` / `fb_streaming_<ss>_<chunk>`; visibility record at +8                                                                                                                                                                                                           |

- `fb_init` uses [InitChunkData](world.md#initchunkdata-layout) component-group layout;
  `fb_streaming` stores matching entity ids and [StreamingChunkData](world.md#streamingchunkdata)
  property tables (rect decals bind materials under `0xff010000`, e.g. Jingyu Valley's cliff moss).
- **visibility record (`FBDynamicSceneVisibilityInfo`, 24 bytes)**: centre, base radius, `MinDis`,
  importance. model and effect rows also carry a grid chain (near and far grid ids for their LOD
  proxy). usage is in [dynamic load grids](world.md#dynamic-load-grids).
- one model or ECS group can be referenced by multiple resource groups; some ECS entities also
  appear in static chunks. ECS renderers with a spin component rotate
  ([spinning scenery](animation.md#spinning-scenery)).

## open

- meaning of the uv dimension byte's high nibble 2
- whether any packed-normal mesh also ships a separate tangent channel (unverified across the full
  install)
- path hash function: diverges from XXH3 at 128 UTF-8 bytes
- whether Unity's built-in Cube's face UV orientation matches the pipeline's bundled `Cube.fbx`
  (unverified)
