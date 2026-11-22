# terrain

the terrain tile quadtree, `HGTerrainSurfacesData`, hole cutting, close-up material layer blending
and puddles. how the world's scenes, levels and static/dynamic scenery sit over the terrain is in
[world.md](world.md).

## tiles and placement

terrain lives in VFS group `F84BF5E6`:

```
Data/Terrain/PC/<scene>/Terrain_<level>_<x>_<z>_<H|N|T|A|S|C>.bytes
Data/Terrain/PC/<scene>/Layers/LAYER_<D|N|C>_<index>.bytes
```

each file is a `u32` clear size and an inverted-LZ4 block (a few are stored raw, e.g.
`dung02_dg005/Layers/LAYER_C_3`), and the clear bytes are a 20-byte little-endian `TRET` header
(magic, `u32` version 1, `u16` width, height, mip count and Unity `GraphicsFormat`, `u32` payload
size) followed by one texture's mip chain, which fills the payload exactly. the mip count field is
inferred from layer files, whose payloads equal the sum of their mip chains.

tiles form a quadtree over the scene's terrain square: level `l` splits it into `2^l × 2^l` tiles,
`x` along +X and `z` along +Z. the finest tiles are 64 m (map02's leaf is level 6, map01's level 5).

| channel  | content                                                                                              |
| -------- | ---------------------------------------------------------------------------------------------------- |
| `H`      | 65² heights, R8G8 read as little-endian `u16`, 1 m spacing; outer samples are shared with neighbours |
| `N`, `A` | baked normal and albedo pages, DXT5                                                                  |
| `T`      | tint page, DXT5 sRGB                                                                                 |
| `S`      | splat control, RGBA8                                                                                 |
| `C`      | 34² cliff index, R8G8, driving the cliff projection                                                  |

pages are 132² with a 2-texel border around a 128² core covering the tile edge to edge, and have one
mip level. every tile with a height page has all six channels, at every level. layers are per-scene
material textures addressed by index ([close-up layers](#close-up-layers)): `D` diffuse (BC7 sRGB),
`N` normal (BC7), `C` cone maps for parallax (R8). the terrain shader binds the tile channels as
`_HeightmapAtlas` (`H`), `_NormalmapAtlas` (`N`), `_TintColorAtlas` (`T`), `_AlbedoAtlas` (`A`),
`_SplatCtrlAtlas` (`S`) and `_CliffIndexAtlas` (`C`), and the layers as the texture arrays `_Splats`
(`D`), `_Normals` (`N`) and `_ConeMaps` (`C`).

the baked `A` and `N` pages are what the game draws where its close-up layer blend doesn't reach:

| channel | r                   | g                   | b                    | a                          |
| ------- | ------------------- | ------------------- | -------------------- | -------------------------- |
| `A`     | albedo, linear      | albedo              | albedo               | subsurface curvature input |
| `N`     | world normal x ·2−1 | world normal z ·2−1 | perceptual roughness | occlusion                  |

`A` is linear despite its UNorm format, and the normal's y is `√(1 − x² − z²)`. the normal's
orientation was checked against normals from the height page (r = +X, g = +Z, rows along +Z).

the terrain's placement comes from the scene's `HGTerrainSurfacesData` MonoBehaviour at
`assets/beyond/dynamicassets/scenes/pc/<scene>/terrain/hgterrainsurfacesdata.asset`:

- `terrainPosition`: world position of the square's minimum corner; `y` is the height of a zero
  sample
- `heightScale`: metres spanned by the 15-bit height range
- `terrainSize`: root edge length, a power-of-two multiple of 64 m
- `nodeData`: a complete breadth-first quadtree (`index = (4^l − 1)/3 + z·2^l + x`) down to the leaf
  level, whether or not a node has tile files, with per-node `nodeLevel` (0 for the root and for
  levels above the coarsest tiles), `parent`, `allHole`, min/max height (metres above
  `terrainPosition.y`) and `maxHeightError` (metres). on map02 `localMaxHeight` is the maximum of
  the node's samples with the hole bit masked off, and `localMinHeight` counts holes as 0. despite
  its name, `maxHeightError` isn't the error of drawing the node instead of its children: leaves
  carry hundreds of metres on map02, and it tracks the node's page's largest step between
  neighbouring samples
- `layerData`: the close-up material layers by ordinal
- `sectorSplatInfo`: one `u64` per 64 m sector, a bitmask of the layer ordinals the sector uses
  (checked against the index map on map02)

## heights and holes

world Y of a sample is `position.y + (h & 0x7fff) · heightScale / 32768`. bit 15 marks a hole. on
map01 and map02 about 95% of holes have no height (low bits 0, the terrain's base); only some beside
solid ground keep one.

holes are cut per vertex: the terrain's vertex shader gives a vertex on a hole sample no position,
so every triangle touching it is dropped whole, and a solid sample ringed by holes draws nothing.
the pass draws patches of 16 × 16 quads cut along alternating diagonals: a quad whose `x + z` in the
patch is even is cut from its minimum corner to its maximum corner, an odd one across. so of a quad
with one hole corner, the triangle away from that corner draws only if the diagonal doesn't end on
the hole. (inferred: a patch's quads align to its page's samples with the page's parity.)

the game's subdivision passes (`TerrainDepthOnlySubdivision` and kin) instead read the four samples
around a vertex, drop it only when all four are holes, and take its height from the solid ones
alone. the pipeline turns them on only while terrain deformation is enabled.

## close-up layers

near the camera the game draws a blend of tiling material layers instead of the baked pages.

- **index:** `terrain/splatindexmap.tga`, an RGBA32 Texture2D of `terrainSize / 8` texels (row 0 at
  the minimum z), names 4 layer ordinals per 8 m cell, each stored times 4.
- **weights:** the leaf's `S` page; `rgb` weight the cell's slots 0–2, slot 3 gets `1 − r − g − b`.
- **layers (`layerData`):** `splatST` (x: repeats across the terrain square, y: texture index, zw:
  uv offset), `packedSplatInfo` (mean albedo, normal xy scale), `diffuseRemapScale` (rgb multiplier,
  height-blend border in w), `maskMapRemapScale`/`Offset` (scale and offset for occlusion in y,
  height in z, roughness in w; the offset's x is a surface type id).
- **textures:** `LAYER_D` is sRGB albedo with height in alpha; `LAYER_N` is tangent-space normal xy,
  roughness in b, occlusion in a. on map02 they are 1024² BC7 with 11 levels and repeat every 2–9 m.
- **blend:** with weighted heights `wh = w · h`, each slot gets
  `w · (max(0, wh − max(wh) + border) + ε)`, normalised. albedo is the blended
  `diffuse · diffuseScale`, plus `(tint − mean) · a⁴` from the leaf's `T` page, `mean` being the
  blended mean albedos. the blended tangent normal is oriented on the baked normal, with tangent
  `cross(n, +Z)`.
- **projection:** world position times the layer's repeats per metre, on the x, y and z planes. the
  game picks one plane per pixel at random.

## puddles

the `S` page's alpha is a puddle level, independent of weather. water stands where it rises above
the ground: close up the ground is the layers' heights weighted by the splat weights (`Σ w · h`),
far away a flat 0.5. with `w = sat((S.a − ground) / 0.46)`:

- albedo × `1 − 0.35 w`
- roughness → 0 and occlusion × `1 − 0.1 w`
- the normal bends towards straight up by `0.98 w`

layers with parallax enabled use a parallax-weighted height instead of `Σ w · h`.

## open

- the distance where close-up layers give way to the baked pages and how they fade
- how the cliff projection (`C` page) and cone-map parallax (`LAYER_C`) shade
- what `maxHeightError` is used for
- which scenes enable terrain deformation (turning on the subdivision hole passes)
- whether a patch's 16 × 16 quads align to the height page's samples with the page's parity
  (inferred, not traced)
