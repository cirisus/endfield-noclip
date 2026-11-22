# post-processing

passes after the main pass and their environment-profile inputs: ambient occlusion, light shafts,
lens flare, auto exposure, bloom, colour grading, and tonemapping. see
[lighting.md](lighting.md#screen-space-reflections) for SSR, [sky-and-fog.md](sky-and-fog.md) for
sky/fog, and [environment.md](environment.md) for profiles/blending.

post-lighting pass order (after lighting, fog, and transparents):

1. light shafts
2. `Parafin` (purpose unknown)
3. depth of field
4. motion blur
5. post-DoF transparents
6. lens flare
7. temporal antialiasing + upscaling
8. sharpening
9. fisheye
10. grading LUT
11. bloom chain
12. frosted glass
13. exposure histogram
14. cutscene effects
15. uber pass

## ambient occlusion

XeGTAO at half render resolution. the graphics quality setting selects the kernel (ignoring the
volume's `qualityLevel`): Low/Medium `2 × 2`, High `3 × 3`, Ultra `9 × 3`; shipped PC presets cap at
High ([quality settings](quality-settings.md#values-by-level)).

unless `ambientOcclusion.custom` is set, the march ignores volume settings for a fixed preset:
radius 4 m, falloff range 1, sample distribution power 1, thin-occluder compensation 2 (scales depth
differences by `1 + thin` in falloff distance); only `finalValuePower` reads from the volume (6 on
map02).

pass chain (at AO resolution until upsample):

1. depth prefilter (5 mips via XeGTAO `DepthMIPFilter`)
2. main march (64×64 Hilbert + R2 noise, GBuffer octahedral normals,
   `max(0.03, (vis / S)^finalValuePower) / 1.5`)
3. temporal reprojection (3×3 min/max clamp)
4. two 3×3 edge-aware spatial denoises (pass 2 restores ×1.5)
5. unweighted 5-tap bilinear upsample

result occludes both diffuse and specular ambient via `min(gtao, materialAO)`
([ambient](lighting.md#ambient)).

## light shafts

Unreal's light shaft bloom, added before TAA so auto exposure meters it. runs when
`lightShaft.enable` is set and `rotationLightShaft` is in front of the camera (projected without
clamping, so a sun just off screen still casts shafts):

- **extract (half res, `lightShaftDownSampleFactor` 2 on PC)**:
  `colour / luminance · clamp(luminance − bloomThreshold, 0, bloomMaxBrightness) · 2 · bloomScale · bloomTint`,
  masked to view depth past `0.5 · occlusionDepthRange` (ramping in over the range), faded near
  screen edges and by `(1 − 2·|sun − uv|)²`.
- **blur**: 3 passes (`lightShaftBlurPassCount`), each averaging 12 samples (`lightShaftSampleNum`)
  toward the sun, reaching `min(blurIntensity · 0.1 · 4.8^pass, 1)` of the distance.
- **composite**: adds the last blur to scene colour.

without a [sun disc](sky-and-fog.md#sun-disc), only bright fog and sky near the sun pass the
threshold. the shader also supports `enableOcclusion` and `enableLightShaftCloudMask`.

## lens flare

SRP core v12 data-driven lens flare, drawn after light shafts (invisible to them) and before TAA
(seen by bloom and auto exposure). when `lensFlare.enable` is set, the sun's flare reads the
environment section (asset, intensity, scale, occlusion, off-screen flag), using direction
`rotationLensFlare` and raw `directColor`. when off, the runtime-created sun flare component's own
settings apply (unknown, [open](#open)). Origin Lodespring's overview
(`Env_map01_lv006_art_entry_overview_01`) enables it while the level's phase disables the
[sun disc](sky-and-fog.md#sun-disc).

- **asset**: `LensFlareDataSRP` ships without a TypeTree; bytes follow SRP core 12 field order with
  every bool padded to 4 bytes.
- **layout**: CPU projects sun to screen (y down, −1..1) and lays out elements along the
  sun-to-centre ray (uniform, curve, or seeded Unity random), rotated by angular offset, sized
  `0.1 · sizeXY · uniformScale · scale` in screen-height units, scaled toward target size by radial
  distortion, rotated toward centre if `autoRotate`, and tinted by element colour, gradient, and
  flare intensity.
- **shapes**: images sample their texture; circles fade from `edgeOffset` to rim with exponent
  `e^(4 · (1 − fallOff))`. `blendMode` selects additive, screen, premultiplied, or lerp.
- **occlusion**: tests `sampleCount` points on a disc around the sun (radius
  `tan 0.0576 · occlusionRadius` projected to viewport) against the far plane in the depth buffer;
  the fraction hitting sky scales every quad. off-screen points count only when off-screen display
  is enabled.

no checked flare in map01, map02, dungeon, base, or race scenes uses polygon elements or inverse
SDFs.

## auto exposure

adapts a post exposure on top of fixed [pre-exposure](lighting.md) from the blended `autoExposure`
section:

- **histogram**: 16 bins of log2 luminance over `autoExposureEv100Range`, sampling 1 pixel per 16×16
  block of antialiased pre-bloom colour (split between two nearest bins).
  `autoExposureMeteringMode == 1` weights toward screen centre by `1 − 0.75 · (1 − 2^(−170.6 · r²))`
  (`r` in UV from centre).
- **average**: counts each bin at its lower edge clamped to `autoExposureEv100HistogramRange`, keeps
  samples between `autoExposurePixelLuminanceRange` percentiles (5%–95%), and divides by total
  samples.
- **target**: `2^autoExposureManualEvCompensationAuto · 0.18 / clamp(2^average, 0.01, 8)` (or
  `2^autoExposureManualEvCompensationManual` when `autoExposureMode == 1`), clamped to
  `2^autoExposureEvClampRange`. most map01/map02 profiles clamp to 0…8 EV (Hub: −0.2…8 EV), keeping
  daylight at fixed exposure while brightening dark interiors; a few allow darkening.
- **adaptation**: moves `clamp(speed · dt)` toward target per frame (`autoExposureLerpUpSpeed`
  brightening, `autoExposureLerpDownSpeed` darkening). histogram readback lags 1–2 frames.

## bloom

HDRP-structured bloom driven by high-quality profile fields:

- **chain sizing**: sized as if view height ≤ 1080 px; level 0 is half that, halving down to
  `log2(longestSide) − 2` levels (`resolutionHighQuality` quarter drops one level).
- **prefilter**: 5-tap average weighted by `1 / (1 + luma)` (anti-firefly), keeping energy above
  `thresholdHighQuality` (sRGB → linear) with soft knee `0.5 · threshold`.
- **downsample / upsample**: each downsample runs a 9-tap horizontal Gaussian (halving width) then a
  5-tap vertical Gaussian. upsamples run coarsest-to-finest using a cubic B-spline blended over the
  finer level by `lerp(0.05, 0.95, scatterHighQuality)`.
- **composite**: adds `(2^intensityHighQuality − 1) · (bloom · tint)` with tint luminance normalised
  to 1. non-add modes (`blendMode == 2` everywhere on map01/map02) also subtract the scene's own
  above-threshold part by the same factor; add mode compresses bloom past 0.3 instead.

the client also contains a compute-shader variant, lens dirt, additive upsample, character bloom,
and anamorphic stretch.

## colour grading and tonemapping

the uber pass applies exposure, adds bloom, applies HDR vignette, then grades:

- **vignette**: post profile's `vignette` extends URP's fields (colour, centre, intensity,
  smoothness, roundness, rounded) with `mode`, `blink`, and `opacity`; the shader also has an
  aspect/ellipse variant (selection and extra fields unread).
- **grading & tonemapping**: `colorGradingConfig` maps to URP colour utilities (white balance,
  colour adjustments, channel mixer, shadows/midtones/highlights, lift/gamma/gain, split toning,
  colour curves; disabled subsections use neutral defaults). these bake into a LogC LUT with
  HG-specific contrast and `ACES_modified` (`tonemappingMode` 5 in every shipped profile; modes 1–4
  `Neutral`, `ACES`, `Custom`, `External` are hidden from the inspector; external LUT unused),
  followed by ½ 8-bit step dithering.

## open

- vignette's extra mode and fields (`mode`, `blink`, `opacity`).
- whether PC uses the compute-shader or pixel-shader bloom variant.
- runtime sun flare component's own settings when `lensFlare.enable` is off.
- unverified: at Origin Lodespring's overview, the flare appears unoccluded by the crystal mountain
  behind the sun, as if the mountain were absent from its depth buffer.
