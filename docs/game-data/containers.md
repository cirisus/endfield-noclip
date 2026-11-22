# containers and serialization

on-disk container layers and binary serialization formats of the PC client: the VFS catalogs and
chunks, Hypergryph's scrambled UnityFS bundles, Unity SerializedFiles, USPC string pools,
SparkBuffer config tables and MemoryPack payloads.

## the build

the PC client is an IL2CPP build of Unity 2021.3.34f5 (a source-licensed, patched editor). its
`il2cpp_data/Metadata/global-metadata.dat` is version 29 and unencrypted, with one extra `i32` per
type-definition row. the render pipeline (HGRP) is `HG.RenderPipelines.Runtime` over SRP Core, not
URP or HDRP, with native engine modules behind managed shims (`HGGraphicsModule`,
`HGGraphicsCPPModule`, `HGOcclusionCullingModule`, `ClusterRendererModule`). the client also ships
`HG.HLOD.Runtime`, `Google.FlatBuffers`, `MemoryPack` and an IL hotfix VM (`IFixRuntime`).

## VFS

the install has two VFS layers: `Persistent/VFS` (patches) and `StreamingAssets/VFS`, each organized
as `<group hash>/` directories holding a ChaCha20-encrypted `.blc` catalog and `.chk` chunk files.
the game calls a group a VFS block (`VFBlockMainInfo`, with an `EVFSBlockType` such as 11 for
`Bundle`).

- a group's `Persistent` catalog is complete and supersedes the `StreamingAssets` one; its `.chk`
  chunks may live in either layer (`Persistent` first).
- every logical file carries the MD5 of its decrypted bytes.
- main groups: `Bundle` and `InitialBundle` (asset bundles), `BundleManifest` (`manifest.hgmmap`),
  `ExtendData` and `InitialExtendData` (main and initial `StringPathHash` tables), `Streaming` and
  `DynamicStreaming` (world chunk data), `Terrain` (terrain tiles), `JsonData` (pooled
  `LevelConfig`/`LevelData`, scripts, gameplay config), and `Table` (SparkBuffer config tables).
- `Streaming`, `DynamicStreaming` and `Terrain` files are wrapped in a size-prefixed inverted-LZ4
  envelope (a few terrain files are stored raw).
- `Bundle`, `Streaming`, `Terrain` and `ExtendData` files aren't encrypted individually;
  `BundleManifest`, nearly all of `JsonData`, `Table` and the Lua and IFix patch groups are.
- `Persistent/index_main.json` is an obfuscated index superseded by the merged `.blc` catalogs;
  `CompressData.bin` is Brotli-compressed UTF-16 JSON (NodeCanvas AI behaviour trees).

### catalogs and encrypted files

a `.blc` catalog starts with `u32 version` and 8 more bytes, then a ChaCha20 body whose 12-byte
nonce is those first 12 bytes (block counter starting at 1). an encrypted logical file uses the same
key with the nonce `u32 catalogVersion ‖ i64 ivSeed`, where `ivSeed` comes from its catalog entry,
so any 64-byte-aligned slice decrypts independently.

the catalog's `codeVersion` is 4 or 5; version 5 widens each chunk's and file's tag (`VFSFileTag`)
from 4 bytes to 8, and a file's tag follows its optional `ivSeed`.

## HG bundles

Hypergryph's bundle format is UnityFS with the signature, header, block table and directory
scrambled, blocks passed through a keyed XOR pad, and data compressed with a nibble-interleaved
("inverted") LZ4 variant.

- **cipher.** AES-128 with a custom substitution box, chained like OFB except that the next IV is
  derived from the keystream block. it covers only sampled positions (up to 256 bytes whole, else
  `256 / blocks` bytes at the start of each of the first 256 sixteen-byte blocks), so it reduces to
  one 256-byte XOR pad derived once from the keys.
- **compression.** the blocks-info is padded and compressed with standard LZ4; data blocks of type 5
  are padded and compressed with inverted LZ4; type 0 blocks are raw. the encoder may end an LZ4
  block on a match (which strict decoders reject).
- **contents.** bundles contain Unity 2021.3.34f5 SerializedFiles (format version 22, target
  platform 19 / `StandaloneWindows64`) with embedded TypeTrees, plus `.resS` stream data files
  ([assets.md](assets.md)).

## USPC string pools

pooled `JsonData` payloads (`LevelConfig`, `LevelData`, level scripts) store `i32` string ids (`−2`
for null, `−1` for empty) into the USPC v1 pools `Data/Json/StringPool/StringPool<n>.byte`.

a block file is `u32 'USPC'`, `u32 version` (1), `u32 flags` (1 = LZ4), `u32 count`, `u32 rawSize`,
`u32 packedSize`, and the body. uncompressed, the body is `u32 count`, `count` `u32` offsets, and
`count` strings (`u32 byteLength`, UTF-8). block 0 has a `u32` block-file count before its magic.
every block holds as many strings as block 0, so id `i` lives in block `⌊i / blockSize⌋`.

## SparkBuffer config tables

a SparkBuffer table (`Data/TableCfg/*.bytes`) is a typed map:

- **header:** `u32 typesOffset`, `u32 rootOffset`, `u32 dataOffset`
- **types:** `u32 count`, each `u8 kind` (6 enum, 8 bean), pad to 4, `u32 hash`, C string name, pad
  to 4; then for a bean `u32 fieldCount` fields of `(C string name, typeRef)` and for an enum
  `u32 valueCount` values of `(C string name, pad to 4, i32 value)`
- **typeRef:** `u8 type` (`SparkType`: 0 bool, 1 byte, 2 int, 3 long, 4 float, 5 double, 6 enum, 7
  string, 8 bean, 9 array, 10 map); followed for beans/enums by pad to 4 and `u32 typeHash`, for
  arrays by the element's `typeRef`, and for maps by key and value `typeRef`s
- **root:** `u8 10` (map), C string name, key and value `typeRef`s
- **data:** `u32 slotCount`, `slotCount` × `(u32 entriesOffset, u32 entryCount)`. entries are key
  then value, packed with natural alignment: bool/byte `u8`, int/enum `i32`, long `i64`, float
  `f32`, double `f64`. strings (C strings), beans, arrays and maps are `u32` absolute offsets
  (`0xFFFFFFFF` for null); a bean's fields follow the same packing, an array is `u32 count` and its
  elements, and a map field has the root's data layout

confirmed across `MapIdTable`, `LevelDescTable`, `I18nTextTable`,
`SpaceshipAreaUnlockNeedCenterLvTable`, `SpaceshipGrowCabinLvTable`, `DungeonTable` and
`SettlementBasicDataTable` (map fields).

## MemoryPack

`LevelConfig`, `LevelData`, interactive templates, view-state controllers, level scripts and
teleport tables are MemoryPack-serialized payloads whose schema comes from the install's IL2CPP
metadata (`global-metadata.dat`) and `GameAssembly.dll`.

- **objects.** generated wrapper classes named `<Namespace_Type>ForMemoryPack` define the layout: a
  member-count byte (`255` for null) followed by its members in the order of the wrapper's
  `__name__` setter properties, base wrapper first.
- **unions.** a polymorphic base is a tag byte (`250` then `u16` for large tags, `255` for null)
  choosing the subtype from the wrapper's `[MemoryPackUnion(tag, typeof(subtype))]` attributes.
- **collections and strings.** collections are an `i32` count (`−1` for null) and their elements;
  strings are `i32` ids into the [USPC string pool](#uspc-string-pools).
- **unmanaged structs.** copied raw at their in-memory size (padding included), except as `List`
  elements which go through their wrapper: `*Ptr`, `GameplayTag`, `CameraControlStateInitialParam`,
  `PosRot`, `NpcBehaviorTag`, `ConditionValue`, `ValueUnion`, `AudioId`,
  `AbilitySystemData.PlungingAttackData`, `StringPathHash` and `BezierKnot` (confirmed by decoding
  every level script and every `LevelData` file except Dijiang's two to exact EOF).
- **raw dictionaries and optionals.** a `Dictionary` of two unmanaged types (primitives, enums,
  Unity vectors) is copied raw as `KeyValuePair` rows with padding. `Nullable<T>` and `Optional<T>`
  of an unmanaged `T` are a flag byte then `T` at its alignment; `Optional` keeps its value when
  disabled.
- **custom formatters.**
  - `AnimationCurve`: member count 3, pre- and post-wrap modes, then raw 28-byte `Keyframe`s.
  - `SerializeFieldDictionary`: header byte (`255` null, `1` one list of key/value pairs, `2` key
    list then value list).
  - `SendLuaEvent`, `SendLuaEvent1`, `SendLuaEvent2`: member count, id, inline UTF-8 uid, bool, next
    id, bool, `Param<string>` event name, then one inline UTF-8 JSON string per parameter.
  - `AudioBlackScreenBehaviour`: raw 16-byte struct (preset byte, flags byte, fade-in bool, `f32` in
    time at +4, fade-out bool at +8, `f32` out time at +12).
