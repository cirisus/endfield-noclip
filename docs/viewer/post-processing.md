# post-processing

viewer implementation of [game-data/post-processing.md](../game-data/post-processing.md); pass
order, resolutions, and targets are in [frame.md](frame.md), full gaps in [status.md](../status.md).

## post chain

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

implements the [game's light shaft bloom](../game-data/post-processing.md#light-shafts), without the
occlusion term or cloud mask.

## lens flare

implements [lens flare](../game-data/post-processing.md#lens-flare) (skipped when disabled in the
environment):

- omitted: polygon elements and inverse SDFs.
- per-light curves (radial screen attenuation, distance) use SRP Core directional-light defaults;
  Unity's random-bit mapping to `Random.Range` is assumed.
- at Origin Lodespring's overview, the flare is fainter than in-game because the crystal mountain
  behind the sun occludes it in the depth buffer.

## auto exposure

follows the [game's metering](../game-data/post-processing.md#auto-exposure):

- reads back the histogram 1–2 frames late, keeps rendering while exposure adapts, and snaps to the
  first reading after load or level switch.
- the stats panel displays the EV adjustment; toggling "auto exposure" off holds 0 EV.
- undrawn content (characters, some effects) is absent from the histogram, so EV differences vs.
  in-game shots may reflect missing content rather than metering.

## bloom

implements the [game's high-quality pixel-shader bloom](../game-data/post-processing.md#bloom) from
the post profile's `bloom` block. omitted: lens dirt, additive upsample mode, character bloom, and
anamorphic stretch.

## colour grading and tonemapping

applies exposure, bloom, and URP vignette (`vignette` block, without the game's extra mode and
fields) in HDR before grading.

evaluates `colorGradingConfig`
([game data](../game-data/post-processing.md#colour-grading-and-tonemapping)) per pixel instead of
via a baked LogC LUT, without colour curves (not packed). Khronos PBR Neutral and a clamp mode are
also available to isolate lighting from grading.
