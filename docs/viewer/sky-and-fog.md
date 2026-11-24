# sky and fog

how the viewer draws the sky, celestial layers, and fogs described in
[game-data/sky-and-fog.md](../game-data/sky-and-fog.md). pass ordering is in [frame.md](frame.md)
and [post-processing.md](post-processing.md#post-chain).

## sky

builds the transmittance, multiple-scattering, and per-frame sky-view LUTs of the
[atmosphere model](../game-data/sky-and-fog.md#sky). `skyViewScale` applies when sampling the LUT
rather than during LUT rendering (equivalent).

divergences: the sky-view LUT omits ground bounce below the horizon (only the multiple-scattering
LUT uses ground albedo), and the global colour adjustment is omitted. Power Plateau's overcast sky
renders 15–20 sRGB levels brighter than in-game; Wuling City's matches.

the cloud panorama draws in the celestial pass ([beyond the atmosphere](#beyond-the-atmosphere))
with authored contrast/rotation, raw tint, `cloudFadeAlpha` always used (one of the game's two
paths), and no cloud flow (static).

## sun disc

draws the sun disc following the [game's lobe](../game-data/sky-and-fog.md#sun-disc). unchecked
against an in-game shot facing the sun.

## beyond the atmosphere

instead of shading celestial layers in a sky-dome draw, the viewer renders them per sky pixel in
`celestial` and composites them before fog as `sky · (1 − cover) + layers`. the cloud panorama draws
in the same pass to preserve the
[game's layer order](../game-data/sky-and-fog.md#beyond-the-atmosphere).

- **ray-traced planet**: linearises `HGRP/Planet/PlanetBillboard` parameters; lit by the pre-exposed
  sun (or the material's own colour; space-level lighting is unchecked). skipped if any of its four
  textures is missing (listed in `debug/environments.json`).
- **sky planets**: swaps right and forward vectors into the shader, matching the game. divergences:
  always additive regardless of `_BlendMode`, omits global colour adjustment on the first slot, and
  does not thin stars behind rings.
- **omitted**: the moon's sky-wide ring and the aurora.

none of these layers has been checked against an in-game shot.

## fog

**analytic fog.** runs in `composite` (opaque surfaces and sky at `skyDistance`), `water`, and
`transparent` ([glass](materials.md#glass) and fogged [effects](effects.md#blending)). converts
base-2 height fog units, pulling layers from the volumetric section when
`volumetricFogConfig.enable` is set and on/off from `heightFogConfig.enable`, matching the game.
(while volumetric fog is on, height fog's start distance and inscatter belong to far fog; drawing
height fog alone with them would place a bright fog wall inside caves.)

**volumetric fog.** scatters sun, ambient probe (carrying `indirectDiffuseFactor`), and packed
[local lights](lighting.md#local-lights) through sun and
[local-light shadow maps](lighting.md#local-light-shadows) on a fixed 160 × 90 × 64 froxel grid
(game scales up to 240 × 135 × 128 at PC high and 320 × 180 × 128 at very high;
[quality settings](../game-data/quality-settings.md#values-by-level)).

- uses Unreal defaults of 32 slices/doubling and 90% temporal history (game values unrecovered).
  history is required because coarse froxels (a dozen pixels wide on a 2000 px view) snap shadow
  edges to fully lit or dark without it.
- divergences: no local fog volumes, no volumetric flow noise, reflections fall back to height fog
  only, and froxels outside last frame's grid take a single sample (game averages 16 jittered
  samples at PC high).

## flow noise

sways fog on opaque surfaces only (not sky, water, or transparent layers; the game applies it in
deferred lighting after all fog). the noise texture is packed once as the environment table's
`flowNoise`. toggled by "drifting fog" and driven by the animation clock (pauses when idle or with
"animate" off; [performance](performance.md)).
