# lighting

viewer implementation of [game-data/lighting.md](../game-data/lighting.md) and
[game-data/irradiance.md](../game-data/irradiance.md); full gap list in [status.md](../status.md).

## units

the viewer lights in pre-exposed physical units: `preExposure = 1 / (1.2 · 2^directEV100)`. sun,
ambient probe, and fog colours are pre-exposed so shaded values reach the tonemapper around 0–2.

blended profiles are derived into lighting parameters matching the game's CPU packing where known
and approximating it elsewhere ([open](../game-data/lighting.md#open)). packages without profiles
use a built-in default.

## sun

- pre-exposed sun illuminance is `light.directLux · preExposure`.
- every effect's direction comes from its pitch, yaw, and mode, so
  [blending](environment.md#blending-at-the-camera) lerps angles. the package omits derived light
  fields that some phases store stale ([sun](../game-data/lighting.md#sun)).
- surface shading evaluates GGX with height-correlated Smith visibility (scaled by
  `directSpecularIntensity`) plus Lambert diffuse times `(1 − F)`, both with `1/π` and the sun
  colour as illuminance. compared to local lights, this divides by π, adds `(1 − F)` on diffuse, and
  omits clamps and multiple scattering; the sun may be π too dark because the game's CPU scaling is
  unknown ([open](../game-data/lighting.md#open)).
- foliage uses the game's two-sided model.

## shadows

the viewer renders the game's four layers ([shadows](../game-data/lighting.md#shadows)) as 2048²
depth maps. layers are fitted once per frame to the render aspect before mesh selection; layer
assignment and redraw cadence are in [frame.md](frame.md).

- **fit**: sharp cascades fit bounding spheres of frustum slices (stable under camera rotation). the
  far layer fits an 832 m radius around the camera (game's 800 m plus one grid cell), centre snapped
  to a 32 m light-space grid. all layers snap to world texels.
- **casters**: main-pass draws plus off-screen instances inside the view frustum swept towards the
  sun (by the shadow layers' 1500 m caster reach) and intersecting the fitted shadow layers'
  volumes. casters below each layer's native screen-size threshold (`CSMScreenSizeMin` /
  `ASMScreenSizeMin`) are skipped; off-screen terrain does not cast.
- **shadow-only renderers**: draw into shadow layers only, in view or not, with normal back-face
  culling (enough for Dijiang's roof; `_ShadowCullMode` is unread).
- **flags**: `CastsCascades` casts into sharp cascades; `CastsStatic` casts into the far layer
  ([chains](../package-format.md#binary-encodings); leaves ~2/3 of shadow draws in dense Jingyu
  views). CPU-listed rows cannot exclude the far layer, so realtime-only casters there also cast
  into it.
- **selection and filtering**: a fragment picks the first containing cascade sphere, dithered with
  the next over the outer 10% of the radius. sharp cascades filter like the game in a 2×2 atlas UV
  and fade into the far layer over 64–80 m by squared camera distance. the far layer uses a 3×3
  bilinear comparison grid (instead of the game's tent-filtered cached map) and fades near its
  sphere edge.
- **bias and gaps**: receivers offset along the normal by ~1 texel and casters use slope-scaled
  depth bias (instead of the game's sun-direction push). contact shadows are omitted. `shadow`
  profile fields apply as in the game.

### cloud shadows

cloud shadows darken both surface sun and volumetric fog sun
([cloud shadows](../game-data/lighting.md#cloud-shadows)); without the fog term, caves with alpha 1
(e.g. Marker Stone) wash out near-white. `enableFarCloudShadowTexture` is unread (no shipped phase
sets it).

## ambient

- **diffuse probe**: `sky.skyAmbientSH * light.indirectDiffuseFactor`, converted to Unity `ShadeSH9`
  vectors and pre-exposed, used by volumetric fog and the reflection-map fallback. sky reflection
  normalisation uses a separate unscaled pure-L1 luminance vector (matching
  `_ReflectionProbeGlobalParam3`). irradiance volume samples apply `indirectDiffuseFactor` in the
  shader so all diffuse ambient scales once. the volume's default SH (`_IVDefaultSHAr/g/b`) packs
  `sky.customIVDefaultSH` when `sky.useCustomIVDefaultSH` is set, else `sky.skyAmbientSH`, as pure
  L1 SH scaled by `sky.skyDirectIntensity * light.indirectDiffuseFactor`.
- **irradiance sampling**: blends clipmap levels near edges with validity fill-in and vertical
  correction, without jitter or forward-shifted centres.
- **occlusion**: multi-bounce AO uses albedo luminance rather than per-channel fits. specular
  occlusion uses material occlusion only (no GTAO).
- **specular**: Karis analytic split-sum BRDF scaled by `light.indirectSpecularFactor`. surfaces and
  water blend the nearest 32 frustum-visible local reflection probes front-to-back in
  importance-then-distance order with box/sphere falloff, optional box projection, and per-probe
  luminance L1 SH normalisation, falling back to the sky cubemap (or the ambient probe while the sky
  cubemap streams). cubemaps stream on demand into a 32-slot 128² `bc6h-rgb-ufloat` cube array with
  LRU eviction.

### screen-space reflections

runs the game's [SSR](../game-data/lighting.md#screen-space-reflections) as half-resolution
fullscreen passes (march, temporal filter, pyramid, resolve; ~0.5 ms at 2560×1600), reading the
previous TAA history for hit colour. the composite bilinearly upsamples the resolved radiance and
fade and applies each full-resolution pixel's environment BRDF and sky reflection, matching
`HGRP/DeferredLighting`.

- reprojects with depth and previous camera instead of motion vectors (scenery is static).
- needs no rain-wetness variant because surfaces already carry wet roughness
  ([wetness](../game-data/environment.md#wetness)); only ripple normals are missing.
- relit decals supply their output surface ([decals](materials.md#decals)); reflection-only effects
  do not write march inputs. off-screen rays keep the sky reflection.

## irradiance volume

cells from base and scene-state bakes are stored in the game's GPU layout
([package-format.md](../package-format.md#irradiance-cells)) and uploaded unchanged.

### scene-state bakes

each cell picks the first bake whose visibility group is active
([scene-state bakes](../game-data/irradiance.md#scene-state-bakes)). the cell window rebuilds every
frame so toggling a scene state swaps cells and refills affected levels.

### clipmaps

maintains three 128 × 64 × 128 3D clipmaps at 0.5, 2, and 8 m probe spacing, centred on the camera:

- **layout**: texture A stores L0 RGB; texture B stacks three Y slabs for per-channel L1. levels
  stack along Z in one A and one B texture, with wrapped border slices (last slice before, first
  after) so toroidal sampling filters across wraps.
- **streaming and updates**: each level streams cells in its window into one storage buffer (coarse
  levels first, ahead of scenery). a compute pass refills a whole level (instead of partial updates)
  when the camera moves >4 texels or a cell arrives/leaves, looking up cells in the window rather
  than the game's top-level hash.
- **cascade**: levels refill coarse-to-fine; refilling a level refills every finer level because
  probe-less texels copy it ([cells and probes](../game-data/irradiance.md#cells-and-probes)). each
  level writes to scratch textures and copies into its stacked slab.
- **lifetime**: one volume persists per session; loading a package swaps cells, resets the buffer,
  and clears all levels.

### region bakes

the finest level overlays active resident [region bakes](../game-data/irradiance.md#region-bakes)
(overriding cell probes inside a region's grid) and refills when that set changes. coarser levels
keep the scene bake, so rooms beyond ~29 m light as if empty.

## local lights

the `lights` table ([JSON tables](../package-format.md#json-tables)) packs spot, point, and tube
lights (omitting directional, shadow-only, and character-only lights), matching the game's
[lobe](../game-data/lighting.md#local-lights) and foliage two-sided model without multiple
scattering, cookies, or flicker.

- lights inherit their file, structure, or placement visibility (chunk-file lights keep their files'
  conditions); prefab culling boxes rotate with their placement.
- each frame filters visible lights within culling distance and frustum, sorts by camera distance
  then priority, keeps the nearest 256 (PC cap), and bins them into tiles and slices on the CPU
  using conservative bounding spheres.
- uploads are skipped when camera, render size, and visible lights are unchanged. volumetric fog
  reuses the same light lists per froxel.

### local light shadows

the viewer implements the game's cached atlas
([local light shadows](../game-data/lighting.md#local-light-shadows)) for static-caster lights that
carry `shadow`; per-frame dynamic tiles are omitted.

- ranks casters as in the game (nearest first, 200 m and cull distance; 12 × 1024², 12 × 512², 16 ×
  256² tiles in a 4096² atlas), draws one tile per frame, evicts identically, and fades strength
  near cull distance.

divergences from the game:

- **streaming casters**: tiles draw immediately with resident geometry and redraw as content arrives
  until idle. waiting lights (up to 8 at a time) add their cone bounding sphere to the caster
  selection volume. settled tiles redraw only when the camera moves within half the distance they
  were drawn from (for nearer LODs).
- **shared caster set**: tiles draw the sun's far-layer casters (camera LODs and small-instance
  culling, not culled to the light's box) and disable when sun shadows are off.
- **bias and filter**: casters use the sun passes' slope-scaled bias; receivers add ~1.5 texels to
  the game's normal offset. a 3×3 bilinear comparison grid replaces the game's 5×5 tent filter.
- **shadow-only lights**: not packed, so they darken nothing.
