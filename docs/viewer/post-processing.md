# post-processing

how the viewer draws the passes after the main pass that
[game-data/post-processing.md](../game-data/post-processing.md) describes. pass order, resolutions
and targets are in [frame.md](frame.md).

## post chain

[`render/post-process.ts`](../../packages/viewer/src/render/post-process.ts) orchestrates the
[frame's post passes](frame.md). toggles and debug views change rendering without changing the
profile. the sections below cover each pass's inputs and implementation differences.

## ambient occlusion

the march follows the [game's GTAO](../game-data/post-processing.md#ambient-occlusion) at its high
tier, with the reach capped at 48 half-resolution pixels and the falloff radius shrunk to match. the
composite applies the result to the ambient part of the radiance.

the viewer derives normals from depth and filters with one depth-aware blur while upsampling, where
the game reads GBuffer normals and filters temporally and twice spatially.

## light shafts

[`render/light-shafts.ts`](../../packages/viewer/src/render/light-shafts.ts) follows the
[game's light shaft bloom](../game-data/post-processing.md#light-shafts). the occlusion term and the
cloud mask aren't drawn.

## lens flare

[`render/lens-flare-layout.ts`](../../packages/viewer/src/render/lens-flare-layout.ts) lays the
[game's flare](../game-data/post-processing.md#lens-flare) out on the CPU each frame, and
[`render/lens-flare.ts`](../../packages/viewer/src/render/lens-flare.ts) draws it. the per-light
curves (radial screen attenuation, distance) take SRP core's directional-light defaults, and Unity's
mapping of random bits onto `Random.Range` is assumed.

at Origin Lodespring's overview the viewer's flare is fainter than the game's: the crystal mountain
behind the sun occludes it in the viewer's depth buffer.

## auto exposure

[`render/exposure.ts`](../../packages/viewer/src/render/exposure.ts) and
[`render/auto-exposure.ts`](../../packages/viewer/src/render/auto-exposure.ts) follow the
[game's metering](../game-data/post-processing.md#auto-exposure). the viewer reads the histogram
back a frame or two late, as the game does, renders while the exposure moves, and jumps straight to
the first reading after loading or switching levels. the stats panel shows the adjustment; the "auto
exposure" toggle holds it at 0 EV. missing scene content can change the histogram; an EV difference
alone does not establish whether content or metering caused it.

## bloom

[`bloom.wgsl`](../../packages/viewer/src/render/shaders/bloom.wgsl) reads the post profile's `bloom`
settings and follows the [game's bloom](../game-data/post-processing.md#bloom) at high quality, in
its pixel-shader variant.

## colour grading and tonemapping

[`tonemap.wgsl`](../../packages/viewer/src/render/shaders/tonemap.wgsl) applies exposure, bloom and
URP's vignette (post profile `vignette`) in HDR before grading.

[`render/color-grading.ts`](../../packages/viewer/src/render/color-grading.ts) packs
`colorGradingConfig` as [described](../game-data/post-processing.md#colour-grading-and-tonemapping).
where the game bakes grading and curve into a LogC LUT, the viewer evaluates them per pixel. it also
offers Khronos PBR Neutral and a clamp, for separating lighting errors from grading.

### photo filters

`pnpm extract filters --config endfield.local.json -o out/photo-filters.json` exports an optional
photo library from the same install. open the viewer with
`?package=map02&filters=/packages/photo-filters.json` to load its picker. `none` restores the
scene's grading. the LUT contribution slider multiplies the authored lookup contribution only; it
does not fade grading, bloom, vignette or particle effects. filters remain selected when changing
levels.

the final pass samples the exported colour strip after grading and tonemapping, in sRGB display
space, interpolating adjacent blue slices. this follows URP's external-LUT convention; a pixel
comparison with the game's photo mode remains outstanding. the linear BC7 format does not cause an
automatic sRGB decode. only the selected LUT is allocated; changing contribution reuses it. debug
material views bypass the post chain as before.

active grading sections replace scene grading after spatial volume blending. supported vignette and
high-quality bloom parameters keep the scene's non-overridden values, including bloom tint. the
scene's bloom and vignette toggles still apply. Warm and Pale now use their authored bloom
overrides; their character-only lighting volume needs a character shading path and remains
unsupported.

Black and Gold also exports its additive particle emitter and BC7 sprite atlas. the viewer reuses
the scene particle evaluator for emission, lifetime curves, size, rotation, colour and atlas frames.
the effect is anchored at the camera's first selection pose; switching away and back resumes that
anchor rather than making the particles follow the camera. its clock is the viewer's rendered-frame
animation time; the Animate switch pauses it with the scene. it draws depth-tested HDR
billboards before temporal AA, bloom and grading, cancelling post exposure when the source material
requests it. only selected emitters allocate textures and buffers; animation reuses scene selection
unless visible scene particles need updating too. the shared evaluator's 1024-particle cap still
applies. Unity's noise module is not evaluated and remains in the filter's partial-support notice.
this path accepts only simple additive, view-aligned billboards without gravity, speed limits,
bursts, pivot offsets or extra motion modules; other materials and emitters are reported by the
extractor.

the underlying scene renderer's existing grading, bloom and vignette differences still apply.

the library uses the separate `endfield-noclip.photo-filters` contract, version 2, in
`package-format/photo-filters.ts`. its JSON contains names, grading, vignette and optional bloom
overrides, optional particle emitters and texture mips, unsupported-feature notes and base64
GPU-ready LUT blocks. version 2 uses the v49 particle motion union, emission bounds, per-emitter
delay and resolved scale. version-1 libraries are rejected and must be re-exported. the loader checks
supported particle layouts and bounds texture dimensions,
mip sizes and samplers before GPU allocation. it does not alter scene archives or their package
version. extracted libraries are game content and remain outside git; a static host must serve the
exported JSON separately. the viewer never reads game files or imports decoders.
