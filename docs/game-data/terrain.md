# terrain

the terrain tile quadtree, `HGTerrainSurfacesData`, hole cutting, close-up material layer blending
and puddles. world scenes, levels and scenery sit over the terrain as described in
[world.md](world.md).

## tiles and placement

terrain files live in VFS group `F84BF5E6`:

```
Data/Terrain/PC/<scene>/Terrain_<level>_<x>_<z>_<H|N|T|A|S|C>.bytes
Data/Terrain/PC/<scene>/Layers/LAYER_<D|N|C>_<index>.bytes
```

each file is a `u32` clear size and an inverted-LZ4 block (a few are raw, e.g.
`dung02_dg005/Layers/LAYER_C_3`). the clear bytes start with a 20-byte little-endian `TRET` header,
followed by one texture's mip chain filling `payloadSize` bytes exactly:

```
u32 'TRET' | u32 version (1) | u16 width | u16 height | u16 mipCount | u16 graphicsFormat | u32 payloadSize
```

`mipCount` is inferred from layer files, whose payloads equal the sum of their mip chains.

tiles form a quadtree over the scene's terrain square: level `l` splits it into `2^l × 2^l` tiles
(`x` along +X, `z` along +Z). leaf tiles are 64 m (map02 leaf = level 6, map01 = level 5). every
tile with a height page has all six channels at every level.

| channel | size | format    | content                                                             | shader binding     |
| ------- | ---- | --------- | ------------------------------------------------------------------- | ------------------ |
| `H`     | 65²  | R8G8      | LE `u16` heights, 1 m spacing; outer samples shared with neighbours | `_HeightmapAtlas`  |
| `N`     | 132² | DXT5      | baked normal, roughness, occlusion (below)                          | `_NormalmapAtlas`  |
| `A`     | 132² | DXT5      | baked albedo, subsurface curvature (below)                          | `_AlbedoAtlas`     |
| `T`     | 132² | DXT5 sRGB | tint page                                                           | `_TintColorAtlas`  |
| `S`     | 132² | RGBA8     | splat control (`rgb` weights, `a` puddle level)                     | `_SplatCtrlAtlas`  |
| `C`     | 34²  | R8G8      | cliff index for cliff projection                                    | `_CliffIndexAtlas` |

132² pages have a 2-texel border around a 128² core covering the tile edge to edge, and 1 mip level.
per-scene layer textures are bound as texture arrays: `D` diffuse (BC7 sRGB, `_Splats`), `N` normal
(BC7, `_Normals`), `C` cone maps for parallax (R8, `_ConeMaps`).

baked `A` and `N` pages are drawn beyond the close-up layer blend:

| channel | r                   | g                   | b                    | a                          |
| ------- | ------------------- | ------------------- | -------------------- | -------------------------- |
| `A`     | linear albedo r     | linear albedo g     | linear albedo b      | subsurface curvature input |
| `N`     | world normal x ·2−1 | world normal z ·2−1 | perceptual roughness | occlusion                  |

`A` is linear despite its UNorm format. `normal.y = √(1 − x² − z²)`. orientation was verified
against height-derived normals (`r = +X`, `g = +Z`, rows along +Z).

placement comes from `HGTerrainSurfacesData` at
`assets/beyond/dynamicassets/scenes/pc/<scene>/terrain/hgterrainsurfacesdata.asset`:

- `terrainPosition`: world position of the square's minimum corner; `y` is the height of sample 0.
- `heightScale`: metres spanned by the 15-bit height range.
- `terrainSize`: root edge length (power-of-two multiple of 64 m).
- `nodeData`: complete breadth-first quadtree (`index = (4^l − 1)/3 + z·2^l + x`) down to the leaf
  level, regardless of whether tile files exist. each node stores `nodeLevel` (0 for root and levels
  above coarsest tiles), `parent`, `allHole`, min/max height (metres above `terrainPosition.y`), and
  `maxHeightError` (metres).
  - on map02, `localMaxHeight` masks off the hole bit; `localMinHeight` counts holes as 0.
  - `maxHeightError` tracks the page's largest step between neighbouring samples (reaching hundreds
    of metres on map02 leaves), not LOD error against children.
- `layerData`: close-up material layers by ordinal.
- `sectorSplatInfo`: one `u64` per 64 m sector, a bitmask of layer ordinals used by that sector
  (verified against the index map on map02).

## heights and holes

`worldY = position.y + (h & 0x7fff) · heightScale / 32768`. bit 15 marks a hole. on map01 and map02,
~95% of holes have low bits 0 (terrain base); only some beside solid ground retain a height.

- **standard pass (per-vertex cutting)**: the vertex shader outputs no position for a hole sample,
  dropping every touching triangle. a solid sample ringed by holes draws nothing.
- **patch triangulation**: patches are 16 × 16 quads with alternating diagonals: even `x + z` cuts
  min→max corner; odd cuts across. a quad with one hole corner draws the opposite triangle only if
  the diagonal does not end on the hole. (inferred: patch quads align to page samples with page
  parity.)
- **subdivision passes (`TerrainDepthOnlySubdivision` and kin)**: sample the 4 neighbours around a
  vertex, drop it only when all 4 are holes, and compute height from solid samples alone. enabled
  only while terrain deformation is active.

## close-up layers

near the camera, the shader blends tiling material layers instead of baked pages:

- **index**: `terrain/splatindexmap.tga`, an RGBA32 Texture2D of `terrainSize / 8` texels (row 0 at
  min z). each channel stores a layer ordinal × 4 (4 slots per 8 m cell).
- **weights**: leaf `S` page; `rgb` weight slots 0–2, slot 3 gets `1 − r − g − b`.
- **`layerData` fields**:
  - `splatST`: `x` repeats across terrain square, `y` texture index, `zw` UV offset.
  - `packedSplatInfo`: mean albedo, normal xy scale.
  - `diffuseRemapScale`: `rgb` multiplier, `w` height-blend border.
  - `maskMapRemapScale` / `Offset`: scale and offset for occlusion (`y`), height (`z`), roughness
    (`w`); `Offset.x` is a surface type id.
- **textures**: `LAYER_D` = sRGB albedo + height in alpha; `LAYER_N` = tangent-space normal xy,
  roughness in `b`, occlusion in `a`. on map02: 1024² BC7, 11 mips, repeating every 2–9 m.
- **blend**: with `wh = w · h`, each slot gets `w · (max(0, wh − max(wh) + border) + ε)`,
  normalised.
  - albedo = blended `diffuse · diffuseScale` + `(tint − mean) · a⁴` from leaf `T` (`mean` = blended
    mean albedos).
  - tangent normal is oriented on the baked normal with tangent `cross(n, +Z)`.
- **projection**: world position × repeats per metre on the x, y, and z planes; the shader picks one
  plane per pixel at random.

## puddles

`S.a` is a weather-independent puddle level. water stands where `S.a` rises above ground height:
`Σ w · h` close up (or parallax-weighted height for parallax layers), flat `0.5` far away.

with `w = sat((S.a − ground) / 0.46)`:

- albedo × `1 − 0.35 w`
- roughness → 0
- occlusion × `1 − 0.1 w`
- normal bends toward +Y by `0.98 w`

## open

- distance and fade curve where close-up layers give way to baked pages
- how cliff projection (`C` page) and cone-map parallax (`LAYER_C`) shade
- what `maxHeightError` is used for
- which scenes enable terrain deformation (turning on subdivision hole passes)
- whether a patch's 16 × 16 quads align to height-page samples with the page's parity (inferred, not
  traced)
