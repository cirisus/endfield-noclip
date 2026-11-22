# post-processing

viewer implementation of [game-data/post-processing.md](../game-data/post-processing.md); pass
order, resolutions, and targets are in [frame.md](frame.md), full gaps in [status.md](../status.md).

## post chain

[`post-process.ts`](../../packages/viewer/src/render/post/post-process.ts) runs the post passes.
each pass module beside its shader owns its pipelines and targets;
[`post-uniforms.ts`](../../packages/viewer/src/render/post/post-uniforms.ts) packs shared `Post`
uniforms (environment lanes on change, frame lanes per frame).
[`settings.ts`](../../packages/viewer/src/render/post/settings.ts) toggles passes and debug views
without mutating the profile.

omitted game passes: depth of field, motion blur, sharpening, fisheye, frosted glass, and cutscene
effects.

## ambient occlusion

follows [game GTAO](../game-data/post-processing.md#ambient-occlusion) (high tier), with reach
capped at 48 half-res pixels and falloff radius shrunk to match. when `custom` is set, it reads the
volume's `radius * radiusMultiplier`, falloff range, distribution power, and thin-occluder
compensation. composite applies AO to diffuse ambient only (not specular;
[ambient](lighting.md#ambient)).

divergences: marches half-res depth without mips, derives normals from depth, and uses one
depth-aware blur during upsample (instead of depth mips, GBuffer normals, temporal filtering, and
two spatial passes).

## light shafts

[`light-shafts.ts`](../../packages/viewer/src/render/post/light-shafts.ts) implements the
[game's light shaft bloom](../game-data/post-processing.md#light-shafts), without the occlusion term
or cloud mask.

## lens flare

[`lens-flare-look.ts`](../../packages/viewer/src/environment/lens-flare-look.ts) reads the
[flare](../game-data/post-processing.md#lens-flare),
[`lens-flare-layout.ts`](../../packages/viewer/src/render/post/lens-flare-layout.ts) lays it out on
the CPU each frame, and [`lens-flare.ts`](../../packages/viewer/src/render/post/lens-flare.ts) draws
it (skipped when disabled in the environment).

- omitted: polygon elements and inverse SDFs.
- per-light curves (radial screen attenuation, distance) use SRP Core directional-light defaults;
  Unity's random-bit mapping to `Random.Range` is assumed.
- at Origin Lodespring's overview, the flare is fainter than in-game because the crystal mountain
  behind the sun occludes it in the depth buffer.

## auto exposure

[`exposure.ts`](../../packages/viewer/src/environment/exposure.ts) and
[`auto-exposure.ts`](../../packages/viewer/src/render/post/auto-exposure.ts) follow the
[game's metering](../game-data/post-processing.md#auto-exposure).

- reads back the histogram 1–2 frames late, keeps rendering while exposure adapts, and snaps to the
  first reading after load or level switch.
- the stats panel displays the EV adjustment; toggling "auto exposure" off holds 0 EV.
- undrawn content (characters, some effects) is absent from the histogram, so EV differences vs.
  in-game shots may reflect missing content rather than metering.

## bloom

[`bloom.wgsl`](../../packages/viewer/src/render/post/bloom.wgsl) implements the
[game's high-quality pixel-shader bloom](../game-data/post-processing.md#bloom) from the post
profile's `bloom` block. omitted: lens dirt, additive upsample mode, character bloom, and anamorphic
stretch.

## colour grading and tonemapping

[`tonemap.wgsl`](../../packages/viewer/src/render/post/tonemap.wgsl) applies exposure, bloom, and
URP vignette (`vignette` block, without the game's extra mode and fields) in HDR before grading.

[`color-grading.ts`](../../packages/viewer/src/environment/color-grading.ts) packs
`colorGradingConfig` ([game data](../game-data/post-processing.md#colour-grading-and-tonemapping))
without colour curves (not packed). grading and tonemapping evaluate per pixel instead of via a
baked LogC LUT. Khronos PBR Neutral and a clamp mode are also available to isolate lighting from
grading.
