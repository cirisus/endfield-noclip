# containers and serialization

on-disk container layers and binary formats of the PC client: VFS catalogs and chunks, Hypergryph's
scrambled UnityFS bundles, Unity SerializedFiles, USPC string pools, SparkBuffer config tables and
MemoryPack payloads.

## the build

- **engine**: IL2CPP build of Unity 2021.3.34f5 (source-licensed, patched editor).
- **metadata**: `il2cpp_data/Metadata/global-metadata.dat` is v29, unencrypted, with one extra `i32`
  per type-definition row.
- **render pipeline (HGRP)**: `HG.RenderPipelines.Runtime` over SRP Core (not URP or HDRP), backed
  by native engine modules behind managed shims (`HGGraphicsModule`, `HGGraphicsCPPModule`,
  `HGOcclusionCullingModule`, `ClusterRendererModule`).
- **libraries**: `HG.HLOD.Runtime`, `Google.FlatBuffers`, `MemoryPack`, and the `IFixRuntime` IL
  hotfix VM.

## VFS

the install has two VFS layers: `Persistent/VFS` (patches) and `StreamingAssets/VFS`. each layer
stores `<group hash>/` directories containing a ChaCha20-encrypted `.blc` catalog and `.chk` chunk
files. the game calls a group a VFS block (`VFBlockMainInfo`, typed by `EVFSBlockType`, e.g. 11 =
`Bundle`).

- a group's `Persistent` catalog is complete and supersedes `StreamingAssets`; its `.chk` chunks may
  live in either layer (`Persistent` checked first).
- every logical file stores the MD5 of its decrypted bytes.
- `Persistent/index_main.json` is an obfuscated index superseded by the merged `.blc` catalogs.
- `CompressData.bin` is Brotli-compressed UTF-16 JSON (NodeCanvas AI behaviour trees).

| group                             | contents                                          | encrypted  | envelope                               |
| --------------------------------- | ------------------------------------------------- | ---------- | -------------------------------------- |
| `Bundle`, `InitialBundle`         | asset bundles                                     | no         | HG bundle                              |
| `BundleManifest`                  | `manifest.hgmmap`                                 | yes        | Brotli                                 |
| `ExtendData`, `InitialExtendData` | main and initial `StringPathHash` tables          | no         | raw                                    |
| `Streaming`, `DynamicStreaming`   | world chunk data                                  | no         | size-prefixed inverted LZ4             |
| `Terrain`                         | terrain tiles                                     | no         | size-prefixed inverted LZ4 (a few raw) |
| `JsonData`                        | pooled `LevelConfig`/`LevelData`, scripts, config | nearly all | raw                                    |
| `Table`                           | SparkBuffer config tables                         | yes        | raw                                    |
| Lua, IFix patch groups            | scripts and hotfixes                              | yes        | —                                      |

### catalogs and encrypted files

- **`.blc` catalog**: starts with `u32 version` and 8 more bytes, then a ChaCha20 body. those first
  12 bytes are the nonce (block counter starting at 1).
- **encrypted logical files**: use the same ChaCha20 key with nonce
  `u32 catalogVersion ‖ i64 ivSeed` (`ivSeed` from the catalog entry). any 64-byte-aligned slice
  decrypts independently.
- **tag width**: catalog `codeVersion` is 4 or 5. version 5 widens each chunk's and file's
  `VFSFileTag` from 4 bytes to 8; a file's tag follows its optional `ivSeed`.

## HG bundles

Hypergryph's bundle format is UnityFS with scrambled metadata, XOR-padded blocks, and inverted LZ4.

- **structure**: signature, header, block table and directory are scrambled.
- **cipher**: AES-128 with a custom S-box, chained like OFB except the next IV derives from the
  keystream block. it touches only sampled positions (up to 256 bytes whole; otherwise
  `256 / blocks` bytes at the start of each of the first 256 16-byte blocks), reducing to one
  256-byte XOR pad derived once from the keys.
- **compression**: blocks-info is padded and compressed with standard LZ4; type 5 data blocks are
  padded and compressed with nibble-interleaved ("inverted") LZ4; type 0 blocks are raw. the encoder
  may end an LZ4 block on a match (strict decoders reject this).
- **contents**: Unity 2021.3.34f5 SerializedFiles (format v22, target platform 19 /
  `StandaloneWindows64`) with embedded TypeTrees, plus `.resS` stream data ([assets.md](assets.md)).

## USPC string pools

pooled `JsonData` payloads (`LevelConfig`, `LevelData`, level scripts) store `i32` string ids (`−2`
null, `−1` empty) into `Data/Json/StringPool/StringPool<n>.byte` (USPC v1).

```
[block 0 only: u32 blockCount]
u32 'USPC' | u32 version (1) | u32 flags (1 = LZ4) | u32 count | u32 rawSize | u32 packedSize
body (uncompressed):
  u32 count | u32 offsets[count] | strings[count]: (u32 byteLength, UTF-8)
```

every block holds as many strings as block 0 (`blockSize`), so id `i` lives in block
`⌊i / blockSize⌋`.

## SparkBuffer config tables

a SparkBuffer table (`Data/TableCfg/*.bytes`) is a typed hash map:

- **header**: `u32 typesOffset`, `u32 rootOffset`, `u32 dataOffset`.
- **types**: `u32 count`, then entries: `u8 kind` (6 enum, 8 bean), pad to 4, `u32 hash`, C string
  name, pad to 4.
  - bean: `u32 fieldCount` × `(C string name, typeRef)`.
  - enum: `u32 valueCount` × `(C string name, pad to 4, i32 value)`.
- **typeRef**: `u8 type` (`SparkType`: 0 bool, 1 byte, 2 int, 3 long, 4 float, 5 double, 6 enum, 7
  string, 8 bean, 9 array, 10 map).
  - bean/enum: pad to 4, `u32 typeHash`.
  - array: element `typeRef`.
  - map: key `typeRef`, value `typeRef`.
- **root**: `u8 10` (map), C string name, key `typeRef`, value `typeRef`.
- **data**: `u32 slotCount`, `slotCount` × `(u32 entriesOffset, u32 entryCount)`. each entry is key
  then value with natural alignment:
  - scalar: bool/byte `u8`, int/enum `i32`, long `i64`, float `f32`, double `f64`.
  - reference: string (C string), bean, array, or map stored as a `u32` absolute offset
    (`0xFFFFFFFF` = null). bean fields follow the same packing; an array is `u32 count` + elements;
    a map field uses the root data layout.

confirmed across `MapIdTable`, `LevelDescTable`, `I18nTextTable`,
`SpaceshipAreaUnlockNeedCenterLvTable`, `SpaceshipGrowCabinLvTable`, `DungeonTable` and
`SettlementBasicDataTable` (map fields).

## MemoryPack

`LevelConfig`, `LevelData`, interactive templates, view-state controllers, level scripts and
teleport tables use MemoryPack. schemas come from `global-metadata.dat` and `GameAssembly.dll`.

- **objects**: generated `<Namespace_Type>ForMemoryPack` wrappers define layout: a member-count byte
  (`255` = null) followed by members in the order of the wrapper's `__name__` setter properties,
  base wrapper first.
- **unions**: a polymorphic base starts with a tag byte (`250` + `u16` for large tags, `255` = null)
  selecting the subtype from `[MemoryPackUnion(tag, typeof(subtype))]`.
- **collections and strings**: collections are `i32` count (`−1` = null) + elements; strings are
  `i32` ids into [USPC string pools](#uspc-string-pools).
- **unmanaged structs**: copied raw at their in-memory size (padding included), except as `List`
  elements (which serialize through their wrapper): `*Ptr`, `GameplayTag`,
  `CameraControlStateInitialParam`, `PosRot`, `NpcBehaviorTag`, `ConditionValue`, `ValueUnion`,
  `AudioId`, `AbilitySystemData.PlungingAttackData`, `StringPathHash`, `BezierKnot` (confirmed by
  decoding every level script and every `LevelData` file except Dijiang's two to exact EOF).
- **raw dictionaries and optionals**: a `Dictionary` of two unmanaged types (primitives, enums,
  Unity vectors) is copied raw as padded `KeyValuePair` rows. `Nullable<T>` and `Optional<T>` of an
  unmanaged `T` store a flag byte then `T` at its alignment; `Optional` keeps its value when
  disabled.
- **custom formatters**:
  - `AnimationCurve`: member count 3, pre- and post-wrap modes, then raw 28-byte `Keyframe`s.
  - `SerializeFieldDictionary`: header byte (`255` null, `1` one list of key/value pairs, `2` key
    list then value list).
  - `SendLuaEvent`, `SendLuaEvent1`, `SendLuaEvent2`: member count, id, inline UTF-8 uid, bool, next
    id, bool, `Param<string>` event name, then one inline UTF-8 JSON string per parameter.
  - `AudioBlackScreenBehaviour`: raw 16-byte struct (preset `u8`, flags `u8`, fade-in bool, `f32` in
    time at +4, fade-out bool at +8, `f32` out time at +12).
