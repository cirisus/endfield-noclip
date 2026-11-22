# irradiance volume

baked GI uses `HGIrradianceVolume` v3. see [lighting.md](lighting.md#ambient) for ambient sampling
and [scene-states.md](scene-states.md) for scene-state selection.

## files

`Data/IrradianceVolume/PC/<scene>/v3/` contains `index.bytes` and cell payloads
`iv_<stateGroupHash>_<n>.bytes`. the index maps every cell to its payload file and byte range;
payloads store cells back to back.

## index.bytes

little-endian, read sequentially to EOF:

1. **`u32` magic**: `0x03000004` (map02, 8192 m extent) or `0x03000003` (map01, 4096 m extent) —
   identical layout. other magics belong to gacha and legacy indices.
2. **scene-state names**: `u32` count, each `u32` byte length + UTF-16LE (e.g. `Map02_lv002_sunny`).
   these are MapConfig scene states.
3. **state groups**: `u32` count, each `u32 hash` + counted `u32` indices into scene-state names.
   hash `0` with 0 members is the base bake; payload filenames use these hashes.
4. **payload filenames**: counted, length-prefixed UTF-16LE.
5. **top-level spatial hash + pair table**: `u32` table size, `u32 O`, `O³` offset words (same
   spatial hash layout as cells below, keyed `x | y << 10 | z << 20` on cell coordinates to map
   cells to GPU buffer offsets), followed by a counted table of `(u32 value, u32 stateGroupHash)`
   pairs (one per level-2 cell record, likely per-level-2-cell data). neither is needed to read
   cells.
6. **cell directory**: `u32` count, each 9 × `u32`:

   | word | meaning                                            |
   | ---- | -------------------------------------------------- |
   | 0    | cell key (below)                                   |
   | 1    | unknown                                            |
   | 2, 3 | byte offset and stored length in payload           |
   | 4    | decompressed size = word 5 + word 6                |
   | 5    | cell hash-header bytes                             |
   | 6    | probe bytes (16 per probe)                         |
   | 7    | low 16 bits: payload file index; high bits unknown |
   | 8    | unknown                                            |

7. **trailing table**: counted 5-word rows (one per level-2 cell record, meaning unknown), ending at
   EOF.

records tile each payload contiguously from 0 to EOF, and every payload has records. payload index
comes from word 7, not filename order.

**cell keys**: `x | y << 8 | z << 16 | level << 24`. each axis is 8 bits in 32 m units from the
volume's minimum corner, with world 0 at the centre: 128 for `0x03000004` (8192 m) and 64 for
`0x03000003` (4096 m, inferred from map01 level alignment). a level-`n` cell spans `32 · 2^n` m, has
coordinates that are multiples of `2^n`, and spaces probes `0.5 · 4^n` m apart. levels 1 and 2 cover
the map; level 0 (0.5 m probes) is sparse.

## cells and probes

a cell is stored raw when `storedLength == decompressedSize`, otherwise as one block of Hypergryph's
inverted LZ4. decompressed (all `u32`), it is read directly by the GPU update pass:

- **perfect spatial hash over 4³-probe blocks**: `u32 T`, `u32 O`, `O³` offset words (byte triples,
  x lowest), then `T³` entries (both x fastest) of `(blockKey, probeOffset, maskLo, maskHi)`. block
  `b` maps to `(b + offset[b mod O]) mod T` per axis and matches when
  `blockKey == bx | by << 8 | bz << 16`.
- **64-bit probe mask**: marks existing probes in the block. bit index interleaves local
  coordinates: x in bits 0 and 3, y in 1 and 4, z in 2 and 5. probe address = `probeOffset` (bytes
  from cell start) + `16 × popcount(mask below bit)`.
- **probe (16 bytes)**: L0 RGB as `R11G11B10F`, then three `rgba8` words for R, G, B L1 directions
  (unpacked as `· 4 − 2`, relative to that channel's L0) with probe validity in alpha.

about half of level-0 probes are black (L0 = 0, L1 bytes = 128) because they sit inside geometry;
their validity is 0.5 (same as lit probes), so validity does not flag them.

the GPU update pass fills one camera-centred clipmap per level. missing probes (no cell, no block,
or clear mask bit) fall back to the next coarser level's filtered value; the coarsest level falls
back to zero light with full validity. because level 0 is sparse, most of the finest clipmap comes
from level 1.

## scene-state bakes

scene-state bakes (sunny, sunrise, night, damaged, overcast-rainy) are full cell copies with
matching sizes, probe masks, and relit probes (in one Hub cell, ~half of level-0 probes differ), so
states likely replace whole cells rather than overlaying them.

whenever scene states change, the game passes a bitmask (bit = MapConfig state index) to native
irradiance-volume code. the selection code wasn't read, but shipped bakes show an all-states rule (a
group applies only while all its states are active):

- **map01 Hub**: two groups cover the same cells. `001_damaged + 001_overcast_rainy` is the red
  storm-lit Hub (both active until early quests complete). `001_normal + dung01_rdg010_liino` is
  near-black blue (dungeon lighting; its second state has no MapConfig condition and is set only by
  name). if a single state sufficed, the finished open-world Hub (`001_normal`) would go dark; the
  base bake is the bright finished Hub.
- **map02**: single-state groups. the base bake is stormy: in Wuling City (near Unity
  `−884, 250, −40`), base cells are red-amber (L0 hue ~`1.00, 0.54, 0.45`) and `Map02_lv002_sunny`
  is neutral (`0.98, 1.00, 0.91`), active once quest `e6m4_q#44` completes. other groups are
  `Map02_lv005_fields_unrise` and `Map02_lv009_night`.

conflict resolution when two active groups hold the same cell is unknown; no stored pair can both
activate from MapConfig conditions alone.

## region bakes

Dijiang's cabin rooms have per-room-type bakes (`regionIv_<room>_<roomType>.bytes` beside
`index.bytes`, e.g. `regionIv_room_b_1_2` for GrowCabin = 2; ManufacturingStation = 1). the index
does not list them; the game streams one over the scene bake when a cabin is built in a slot
([Dijiang cabins](scene-states.md#dijiang-cabins)). a growth chamber's bake is strongly
yellow-green.

layout (little-endian):

- `u32` `0x1000`, `u32` header size (44)
- `f32×3` world min, `f32×3` world max
- `u32×3` probes per axis
- dense grid of 16-byte probes (same layout as cells), x fastest, then y, then z

the grid sits on level 0's 0.5 m lattice inside the box: probe `i` on each axis is at
`(ceil(2 · min) + i) / 2` m, and the count equals the lattice points in `[min, max]`.

## open

- scene-state bakes: confirming whole-cell replacement vs overlay, and reading the native selection
  behind the inferred all-states rule.
- region bakes: whether they also apply to coarser levels, and how edges blend with the scene bake.
- index pair table, trailing 5-word rows, directory words 1, 7 (high bits), and 8, and other index
  magics.
