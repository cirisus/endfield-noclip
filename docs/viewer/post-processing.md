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

## photography

[`render/depth-of-field.ts`](../../packages/viewer/src/render/depth-of-field.ts) adds optional
physical defocus before lens flare and temporal antialiasing. the photography panel controls
aperture (f/1.4–f/32) and focus-plane distance in metres; the existing lens controls still determine
focal length. `Viewer.focusAt` focuses on a world point along the camera's forward axis, rejecting
points behind the near plane. this changes photography settings, not the environment profile.

photography uses a full-resolution circular filter, with separate foreground coverage and background
filtering. the 24 mm sensor height agrees with the focal-length readout at any aspect ratio.
foreground and background radius limits are 10 pixels at a 1440-pixel render height; the temporal
shaping input is 0.3. a separate water-depth pass prevents focusing through water to its bed.
camera-relative reprojection includes the current and previous antialiasing jitter. camera cuts,
lens edits, resizing and disabling the effect invalidate history; disabling it releases its render
targets. no new scene-package fields or downloads are required.

current limits: reprojection accounts for camera motion, not moving-object motion. transparent
materials do not have the game's separate after-DoF classification. the viewer uses half-float
intermediates throughout, so rounding differs from packed colour intermediates. no same-pose in-game
image comparison has established pixel-identical output. these limits are independent of the
existing differences in scene content, lighting and other post effects.
