# terrain

viewer implementation of [game-data/terrain.md](../game-data/terrain.md) and
[foliage grids](../game-data/world.md#foliage-grids). page selection and streaming are in
[streaming.md](streaming.md#terrain-selection); the shader is
[`terrain.wgsl`](../../packages/viewer/src/render/terrain/terrain.wgsl).

## terrain

- **baked pages**: draws albedo, normal, roughness, and occlusion as stored
  ([tiles](../game-data/terrain.md#tiles-and-placement)); `A`-page subsurface curvature is omitted.
  patches without a resident page show a slope-based stand-in colour. rain wetness applies on top
  ([wetness](environment.md#wetness)).
- **holes**: each vertex passes a hole flag; fragments discard unless interpolated `in_hole == 0`
  (so any triangle touching a hole vertex is dropped completely). partial retention would hang
  vertical curtains because hole vertices sit at base height hundreds of metres below. triangles
  still rasterize before discard.
- **quad diagonals**: `gridIndices` in
  [`terrain-renderer.ts`](../../packages/viewer/src/render/terrain/terrain-renderer.ts) alternates
  diagonals by sample parity to match the game's hole-edge triangles.

### close-up layers

when a leaf's splat page and layer textures are resident, `detail_surface` blends
[close-up layers](../game-data/terrain.md#close-up-layers) into the baked page by distance:

- **distances**: fades over 96–144 m (`DETAIL_FADE_START`/`END`); leaves within 160 m load splat
  pages (`DETAIL_DISTANCE`, [streaming.md](streaming.md#terrain-selection)). viewer-chosen (game
  values unknown).
- **weights**: `sample_control` clamps filtering half a texel inside the 8 m cell.
- **projection**: blends the three planes by baked-normal `|n|⁸` weights instead of the game's
  stochastic per-pixel pick. explicit gradients skip zero-weight slots and planes.
- **omitted**: cliff projection and cone-map parallax (`C` pages and `LAYER_C` are not packed).
- **cost**: ~7 ms added GPU time over open ground on an Apple M-series GPU at 1600×1000 (individual
  terms unprofiled).

### puddles

`wet_surface` applies [puddle](../game-data/terrain.md#puddles) terms per leaf:

- ground height blends from weighted layer height to flat 0.5 across the close-up layer fade.
- only leaf `S` pages are packed, so puddles stop where splat pages stop loading.
- parallax heights (settings not packed) and ripples are omitted; reflections come from
  [SSR](../game-data/lighting.md#screen-space-reflections).

## foliage grids

grass and tree [foliage grids](../game-data/world.md#foliage-grids) arrive as standard instance rows
carrying cluster bounds, so each cluster culls and switches LOD as a unit
([streaming.md](streaming.md#per-instance-lod)). every instance draws: grass sparsity,
`rendererHalfSize`, per-instance parameters, and column 7 are not packed.
