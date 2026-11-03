# status

what the extractor and viewer cover, where they knowingly differ from the game, and what is still
unknown. topic pages carry the detail; this page is the index of gaps. update it in the same commit
that closes or opens one.

map01 and map02 are the tested scenes. a scene listed by `world scenes` is not evidence that it
packs or renders correctly.

## covered

- container-aware asset resolution, conversion workers and the pack cache
  ([extraction](extraction.md))
- one level at a time over shared terrain, with level-owned streaming, LOD and HLOD
  ([world](game-data/world.md), [viewer](viewer/index.md))
- initial and alternative dynamic structures, active prefab hierarchies and skinned meshes in their
  authored pose ([assets](game-data/assets.md))
- quest, mission and variable state as preview controls, with scene states derived from them and
  dynamic load gates reading them; story progress picked per mission or across the main story;
  progressions, facility visual forms (shops, depots, recycling stations, monitoring terminals),
  Dijiang cabins and Control Nexus level (region walls), tree harvest state, stream areas and
  script/event groups as controls, each listed for the levels it gates; script groups list what sets
  them in game (quests, switches, areas, dungeons), from the level scripts, follow the quests their
  scripts check when they run, and follow the camera where a script swaps them as the player enters
  and leaves a spherical trigger volume ([scene states](game-data/scene-states.md))
- static and dynamic stream areas switched by the camera through the game's trigger zones
  ([world](game-data/world.md#stream-areas))
- terrain heights, baked surface pages and the close-up layer blend
  ([world](game-data/world.md#terrain))
- environment profiles and volume blending, water, post-processing, baked irradiance with its
  scene-state bakes (plus the bakes of Dijiang's rooms with a cabin built) and local point, spot and
  tube lights ([environment](game-data/environment.md), [lighting](game-data/lighting.md),
  [water](game-data/water.md))

## look and lighting

- photographic depth of field and authored post-focus transparency are available; moving-object
  reprojection, per-particle transparency sorting and packed intermediate precision still differ
  ([photography](viewer/post-processing.md#photography))
- photo filters: exported colour LUTs, vignette and high-quality bloom overrides render, along with
  Black and Gold's additive sprite particles. particle noise and character-specific lighting volumes
  remain unsupported. external-LUT colour-space parity still needs an in-game comparison
  ([photo filters](viewer/post-processing.md#photo-filters))

- baked GI brightness is unverified against in-game shots; the native ambient scale is missing, and
  the lighting lookup has no jitter or forward-shifted clipmap centres. next: compare GPU clipmap
  samples with the bake at one point, and check clipmap seams (L0 repeats, L1 clamps)
- several ambient and sky-LUT constants are computed in native engine code and not yet recovered
- irradiance: room bakes reach only the finest clipmap; which
  [scene-state bake](game-data/irradiance.md#scene-state-bakes) applies is inferred from the bakes,
  not read from the game's native selection; partial clipmap updates, the game's forward-shifted
  centres and jitter, fallback textures for cells without probes, the meaning of two index tables,
  and other index magics
- the game's own vignette (the viewer uses URP's); bloom's compute-shader variant, dirt, additive
  upsampling, character bloom and anamorphic stretch; colour curves in the phase sections are not
  packed ([bloom](game-data/post-processing.md#bloom))
- auto exposure can sit off in-game shots where characters or effects the viewer doesn't draw would
  count ([auto exposure](game-data/post-processing.md#auto-exposure))
- weather: snow isn't packed and precipitation (streaks, splashes, ripples) doesn't render; rain
  wetness ignores shelter, since the rain occlusion map isn't rendered, assumes a 100 m occlusion
  range, and has no jittered coverage edges, water running down walls or flooding of normal-mapped
  dips ([environment](game-data/environment.md#wetness)). the weather-script activation and property
  initialization are unknown, so weather stays a manual preview
- environment phases ([environment](game-data/environment.md#environment-phases)): `windConfig`
  drives only the [wind clock](viewer/materials.md#swaying-cloth) (wind motors aren't read), and
  `snowConfig`, `volumetricCloudConfig` and other sections aren't extracted; blending is a generic
  per-section lerp without the game's special cases (precipitation transitions), and its rules for
  directions, integers and the fog's deferred Rayleigh scale are the viewer's
  ([blending](viewer/environment.md#blending-at-the-camera)). fields set in shipped phases but
  unread: the cloud flow (`cloudFlowType`, `cloudFlowMap`, `flowSpeed`, so the panorama never
  moves), `skyMaterialType` 1 and its `skyboxCubeMap` (three boss phases), `reflectionType`,
  `useCustomIVDefaultSH` and `heightFogConfig.enableVolumetricFog` (the viewer switches the PC fog
  path on `volumetricFogConfig.enable` alone)
  ([environment phases](game-data/environment.md#environment-phases))
- environment volume initial enablement and `EnvironmentEnable` script conditions, needed before any
  automatic gating: every loaded, non-manual volume counts as enabled, which is visibly wrong at The
  Hub (night and destruction volumes) and Snowy Forest (night volume), and the base-environment vote
  is wrong wherever level scripts switch volumes. dynamic LevelData volumes aren't extracted,
  cylinder volumes (`volumeType` 4) aren't packed (listed with other dropped volumes and unreadable
  phases in `debug/environments.json`), local post `Volume`s are read but not applied, a prefab
  prism volume under a non-identity placement is rejected, `world env` votes on chunk volumes only,
  and scenes without levels get no environment
  ([environment](game-data/environment.md#environment-volumes))
- sky ([sky](game-data/sky-and-fog.md#sky)): its absolute brightness is the viewer's `sky_scale`
  approximation; the sky planets are always added (the game's blend is unchecked), and their ring
  thinning the stars and the ray-traced planet's light brightness are unchecked
- volumetric fog: local fog volumes and the volumetric light's flow noise (`enableVLFlowNoise`)
  aren't drawn, the grid size, depth distribution and history weight are Unreal's defaults rather
  than the game's quality preset, and its sky term lacks the native diffuse-ambient scale. the
  height fog's [flow noise](game-data/sky-and-fog.md#flow-noise) is unchecked on water and glass,
  and its volume blend is read from the height-fog section's and assumed for the volumetric one
- local lights ([lighting](game-data/lighting.md#local-lights)): no shadows (on surfaces or in the
  volumetric fog), cookies, flicker or multiple-scattering term; directional, shadow-only and
  character-only lights aren't packed; [light beams](viewer/effects.md#light-beams) lack their 3D
  noise, a per-renderer scale and a global tint, and aren't checked against an in-game shot
- the sun may be π too dark against local lights and the game (the two conventions differ);
  unchecked
- interiors, in order of impact:
  - per-draw emission overrides set at runtime aren't known (see the tower lamps below)
  - meshes without tangents draw their normal map flat (what the game's bump does there is
    unchecked); normals are transformed by the model matrix rather than its inverse transpose, and
    every material lights the side facing the camera
  - off-screen casters reach only 250 m, so the sun can leak past that reach, and `_ShadowCullMode`
    isn't read
  - outside the game's sun-off volumes, rooms get the outdoor sun wherever no drawn geometry shadows
    them. map02's 61 `shadowOC_CAVE_*` entities, oriented boxes over caves (InitChunkData component
    61, [world](game-data/world.md#initchunkdata-layout)), are likely the game's cave shadow
    occluders; they aren't packed and what they do is unchecked
  - local reflection probes, GTAO in specular occlusion, contact shadows; the AO multi-bounce fit
    uses the albedo's luminance rather than each channel, and the specular ambient falls back to the
    ambient probe until the reflection cubemap streams in
  - the far shadow layer filters with a 3×3 bilinear grid rather than the game's tent, and acne is
    biased by a normal offset rather than the game's push towards the sun
    ([shadows](game-data/lighting.md#shadows))
  - GTAO takes normals from depth and one depth-aware blur instead of the game's temporal and two
    spatial filters ([ambient occlusion](game-data/post-processing.md#ambient-occlusion))
- the packed tangent frame isn't decoded; tangents are regenerated
- terrain close up: smooth triplanar replaces the game's random plane choice, and the cliff
  projection (`C` page) and cone-map parallax aren't drawn, nor the `A` page's subsurface curvature;
  the blend's GPU cost is unprofiled. the blend's fade distances are the viewer's own
  ([viewer](viewer/terrain.md#close-up-layers)), since the game's aren't recovered. terrain LOD uses
  the viewer's own sample-spacing rule, since the game's per-node `maxHeightError` isn't an error
  bound and what the game uses it for isn't known ([world](game-data/world.md#terrain))
- puddles ([world](game-data/world.md#puddles)) stop past the leaf splat pages' load distance (only
  leaf `S` pages are packed), ignore the parallax layers' height (their settings aren't packed), and
  have no ripples
- screen-space reflections ([lighting](game-data/lighting.md#screen-space-reflections)): the rain
  wetness variant's ripple normals aren't drawn, the GPU cost is unprofiled, and off-screen
  reflections fall back to the sky cubemap.
  [reflection-only effects](game-data/effects.md#reflection-only-effects) don't write the normal,
  roughness and depth the reflections march from; two materials use them (the Very Large Rift
  portal's `quan_ad_01_pass` in dung02_dg005, `zhuangfangyi_shu_04_03_pass` in indie_dg005). next:
  compare the reflections behind the rift's portal ring with an in-game shot before drawing them
- glass ([glass](game-data/materials.md#glass)): refraction, Fresnel opacity and subsurface
  scattering aren't drawn, overlapping transparent layers share one fog distance (their weighted
  mean), and nothing checks whether the game lets glass cast shadows
- emission ([emission](game-data/materials.md#emission)): `_EMISSIVE_NOMAP` (the sweep animation)
  isn't drawn, `_EMISSIVE_ANIM`'s flicker variant and the emissive map's scrolling
  (`_EmissiveSpeed`; Dijiang's shaft cargo rings scroll theirs) are drawn still, and the emission
  Fresnel term is left out
- the white lamp cubes on Wuling's and Marker Stone's towers (`M_module_tylight+1_001_03`) glow
  green and red in the game (always, per level) but white in the viewer. the colour isn't in any
  client data we read: it's a per-draw emission override set at runtime
  ([emission](game-data/materials.md#emission)), and what sets it for static scenery is untraced
- foliage ([foliage](game-data/materials.md#foliage)): wind, the grass's per-instance colour and
  terrain albedo blend (`_BLEND_TERRAIN_ALBEDO`), the card LOD's normal decoding (so it takes
  neither the bend nor the masks), trunk ramps and vertex AO (trunks take only Lit's texture layout,
  so their detail map and top and mask layers aren't drawn either), sphere-shadow proxies, the
  vertical-normal AO boost, broadleaf indirect transmission, contact shadows and the per-instance
  leaf tint; layered materials. grass and tree grids ([world](game-data/world.md#foliage-grids))
  draw every instance at the cluster's LOD, without the game's sparsity thinning; the cluster LOD
  measure (`rendererHalfSize`), the per-instance parameters and column 7 aren't read
- Lit layers ([lit layers](game-data/materials.md#lit-layers)): tri-channel switch textures (only R
  blends), the tri-channel mask on MRO-layout materials (untinted, sharing the MRO map's slot),
  `_UseMaskRUVSetAndTilingScale`, the parallax glow's global highlight, separate mask
  (`_UseParallaxMask`; such materials don't glow) and world-space, PBR and deform variants, the top
  layer's `_BaseHeightMap` (read as grey) and UV set 2, the noise and parallax mask blends, mask
  layers on emissive-mapped materials, and `_TERRAIN_BLEND`'s fade into the terrain.
  `HGRP/LitEffect` (98 map02 materials) draws as Lit without its dissolve and disturb effects
- surface keywords the viewer ignores, which `pack` lists per material in `debug/assets.json`
  ([unsupported materials](viewer/materials.md#unsupported-materials)). besides those named above,
  on map02: Lit's macro normal map (`_MACRO_NORMAL_MAP`, 92 materials), subsurface profiles and
  thickness maps (`_SUBSURFACE*`), fake glints, cracks, dust, volume and refraction (`_FAKE*`),
  interior parallax and mapping, [matcaps](game-data/materials.md#lit-layers) (also the campfires'
  originium crystal on every map, whose glow draws without its sheen), `_ZWRITE_OFF`, and vertex
  animation other than `HGRP/Lit`'s [swaying cloth](viewer/materials.md#swaying-cloth)
  (`_SIMPLE_VERTEXANIM_PENDULUM`, `_SIMPLE_VERTEXANIM_ROPE`, `HGRP/LitTransparent`'s cloth,
  `_VAT_*`, `_COMMONVAT_*`, `_GPU_CLOTH`, `_MOVING_BAMBOO`). the cloth sway is unchecked against an
  in-game shot, each pass's `_DisableAnimateVert` is taken as 0, and no environment means still air;
  glass's refraction, planar and high reflections; the card LODs' view culling, height culling,
  trunk cover and sphere-shadow proxies, and all of `HGRP/Foliage/TreeFoliageCardMeshLod`'s own
  inputs (467 materials, shaded as plain alpha-tested foliage)
- shaders without a look, shown as [unsupported](viewer/materials.md#unsupported-materials) and
  counted per shader by `pack`: on map02 `Hidden/HGRP/Effect/VFXInkWashPaint`,
  `HGRP/Effect/VFXRadialBlur`, `HGRP/CharacterNPR` and `…_VFX`, `Hidden/HGRP/LitEffectBlend`,
  `HGRP/Effect/VFXTransparentDepthOnly`, `HGRP/Foliage/Glow`, `HGRP/LitForward` and the factory
  placement and outline shaders (28 materials)
- matte paintings ([matte paintings](game-data/materials.md#matte-paintings)): `_UseMainTexAsAlpha`
  isn't read (no map01 material sets it)
- erosion rock ([erosion](game-data/materials.md#erosion)): the soft blend into what lies behind
  (`_ObjectBlend*`), fake translucency, and `HGRP/ErosionDynamic` (only on clearable patches, hidden
  by default; drawn as a flat tint)
- water ([water](game-data/water.md#global_water_config)): sector flow tiles (packed but unread;
  flow and foam come from the global map), each sector's `rippleLayerBuffer`, the LOD surfaces'
  displaced wave grid, the rain map (packed but unread), rain and character ripples and ground
  wetness around water; `FlowmapOption` 1's coverage is read as plain amplitude, the sun highlight
  isn't aimed at the nearest point of the sun's disc and has no multiple scattering, additive
  effects below the surface show over it ([viewer](viewer/water.md#shading)), and water entities'
  render-object column 7 isn't read. [foam boxes](viewer/water.md#foam-boxes) (`HGRP/WaterDecal`)
  ignore their per-placement `HGWaterDecalRenderer` values (neutral on every map02 prefab) and their
  displacement; which depth the game tests them against is unconfirmed, their WaterDecal variants
  beyond `_USE_DISTURB`, `_USE_MASK`, `_USE_SOFTBLEND` and `_USE_DISSOLVE`, and those with a
  `_ZTest` other than 4 or 5, show as [unsupported](viewer/materials.md#unsupported-materials) (2 of
  map02's 22), and the Wuling falls' foam is unchecked against an in-game shot; map02's 248
  `P_waterdecal_01` chunk entities (InitChunkData component 31,
  [world](game-data/world.md#initchunkdata-layout)) aren't packed at all, listed in
  `debug/skipped-entities.json`; other fluid types are unverified
- water volumes ([viewer](viewer/water.md#water-volumes)): volumes that don't name a `WaterConfig`
  (54 of map02's 61, listed in `debug/water.json`) aren't drawn. the game draws them through a
  surface prefab per water type (`WaterVolumeManagerConfig.waterSurfaceSettingDict`,
  `…/GameMech/WaterVolumeSurface_<type>.prefab`), and per-volume
  `…/Gameplay/Water/<item type>#<volume id>_WaterSurface.asset` files exist but aren't read; sewage,
  acid and xiranite volumes are among them. moves are linear (no ease-in, and non-fixed-speed moves
  use the fill speed as metres per second); floaters keep their authored height above the surface
  rather than `surface_offset` and don't lag; `ground_distance`, `isPrototype`, flow speed and
  direction, amount-based volumes' transfers and the volumes' render type aren't read; each map02
  volume that coincides with a placed surface (five lv006 pools, lv010's 37900010002, several
  lv002/lv003 ones) draws twice, unverified against the game; Suiming's lily pads end 0.9 m under
  the pit's surface at the first stage, as the data says, unverified in game; a volume's surface has
  no shoreline wetness
- waterfalls missing: Jingyu's pool falls (near unity −763, 209, −1190) and the small cascades
  beside it show white in game, but the viewer's VFXWater sheet there sits inside the rocks in front
  of it, and the steep river surface running down the lip draws as clear water. what the game draws
  there is unknown
- scene effects ([scene effects](game-data/effects.md)): only VFXBaseV2, VFXDecal, the mist
  (FogSimple, VFXFakeVolumeFog), VFXWater's waterfall sheets, VFXDitherAlpha's plain variant and its
  unlit distortion, dissolve, red mask and polar or screen UV variants, with or without a vertex
  offset (blended rather than dithered, and writing no depth; the Very Large Rift's escaping trails
  are unchecked against an in-game shot), VFXRefract's mask, polar UV, colour offset, soft blend and
  dissolve variants, and [six-way smoke](game-data/effects.md#six-way-smoke) with its lightmaps
  (without the shadow's ramp texture, local lights or a main texture, and unchecked against an
  in-game shot) draw; other effect shaders (VFXAdvance, …) and materials in these shaders' undrawn
  variants show as [unsupported](viewer/materials.md#unsupported-materials); reflection-only effects
  aren't drawn, as in the game (their part in the reflections is under screen-space reflections).
  VFXRefract's blend, saturation, spread, Fresnel mask and trail aren't drawn, and its copy of the
  scene includes the water and fog, unchecked against the game's; Deep Dale Street's fog-wall haze
  and the balloons' glitch over their "connecting" sign aren't compared with an in-game shot.
  VFXBaseV2's breathing pulses every placement in step, without its per-draw time scale and offset,
  and Dijiang's clue board is unchecked against an in-game shot, as is its edge colour, not yet
  looked at in the viewer. undrawn: for the first two, additive blend states, `_BlendMode` 2 outside
  a multiplying blend state, the vertex-offset mask, particle-data terms, the sixth sample texture
  together with a vertex offset, screen UVs relative to the object, brightening that is a scan line
  or centred on a fixed point (the player-centred one is left out), rigid-body, fluid and particle
  vertex animation textures, soft bodies that are lit, take a Fresnel term or a vertex offset or
  play from particle data (the drawn Aurelyne blob is unchecked against an in-game shot), water
  blending (fragments below the authored height show the checker, and the height a water surface
  would set isn't followed), flipbook and particle inputs, and VFXDecal's lighting, parallax,
  3D-texture and particle variants; local lights and the post-exposure division on lit effects; for
  VFXWater, `VFX_WATER_REFRACT`, `_VAT_SOFTBODY`, punctual lights, matcaps and the
  `VFX_WATER_SIMPLE_LIGHT` probe; VFXDitherAlpha's other keyword variants, and in its dither the
  vertex alpha, the near-camera fade, `_USE_MAIN2` and the edge mode. across effects: their own fog
  (`_USE_FOG`), the mist boxes' depth prepass and vertex colour, and the game's global scene-effect
  colour adjustment (`_VFXParams1`, set by native code; the Jingyu blight reads less saturated than
  in game, and Suiming's [cave-exit light card](game-data/effects.md#mist) is unchecked against an
  in-game shot). stencil [portals](game-data/effects.md#portals) draw without their masks' own
  colour and depth, stencil operations other than keep and replace are unsupported, and none draw
  unless the GPU has `depth32float-stencil8`
- effect distance bands ([effect LOD tables](game-data/assets.md#effect-lod-tables)) switch without
  the game's fade, and a billboarded renderer's offset from the effect's origin doesn't turn with
  the camera; only prefab renderers take them (whether static scenery has distance-banded effects is
  unchecked); the quality-level half of an entry (`settingLodLevel`, `platformLayer`) is ignored, as
  for the highest preset, and what the game fills in for a band an entry has no info for is
  unchecked (read as on)
- particles ([particle systems](game-data/assets.md#particle-systems),
  [viewer](viewer/particles.md#particles)): mesh particles frozen in place lose their start colour
  and their drift and spin over lifetime, and take the midpoint of random start values. other
  systems, meshes and billboards alike, play without the force, noise, collision, trigger,
  sub-emitter, light, trail, custom-data and by-speed modules, from the viewer's own random values,
  and move only while frames render; velocity-aligned particles roll about their motion by the
  viewer's choice, not traced to the game's; systems that don't play on awake, or use a start delay
  curve, a per-axis speed limit or one alongside drag, drag or rate curves, orbital or radial
  velocity curves, speed-modifier curves alongside drag or a speed limit, sprite-mode sheets, sheet
  time modes other than lifetime or frames per second, or sheets over 64 tiles a side, show as one
  [stand-in](package-format.md#stand-ins) at the emitter (the swirling green motes around Qingbo
  Stockade's bamboo tubes use orbital and radial velocity curves). drag is approximated (it slows
  the start velocity and the fall alone), quads' normals ignore an `m_NormalDirection` below 1,
  cones and circles pick each particle's place around their arc at random whatever its mode (the
  Loop, Ping-Pong and Burst Spread modes and the arc's spread are ignored; about 20 map02 systems
  set one), sphere and hemisphere arcs aren't applied, Unity's `Facing` alignment turns to the
  camera's plane like `View` rather than towards its position, an emitter keeps at most 1024 live
  particles (two map01 systems can hold up to 1201; the rest aren't drawn), stretched billboards
  ignore the camera's velocity and the freeform mode, and colours above 1 and custom data never
  reach the shaders. all copies of one flipbook step in phase. Marker Stone's low mist banks over
  the valley are still missing; their source is unknown.
  [spline movers](game-data/assets.md#spline-movers) (Dijiang's shaft cargo) take their lifetime
  span as the spline's length over the speed, which isn't verified, and draw each LOD group's
  renderers at the group's origin; those with noise, rotation over lifetime or an alpha fade stand
  in
- decals ([decals](game-data/materials.md#decals)): `HGRP/DecalLit` shows its wetness, sludge,
  footprint, UV-noise and arc variants, and placements without their colour and UV, as
  [unsupported](viewer/materials.md#unsupported-materials), and draws overlaps without the game's
  `_DrawOrder`; decals that write no albedo relight the surface from an estimate of its colour, as a
  dielectric, leave its screen-space reflections and ambient occlusion as they were, don't write
  metallic, and add their emission over the surface's instead of replacing it; under a laid-over
  decal that doesn't write them, the surface's own occlusion and metallic are taken as 1 and 0;
  terrain decals (`HGRP/TerrainDecalLit`, InitChunkData component 28) and `HGRP/DecalUnlit` aren't
  packed. prefabs' decal projectors (`HGDecalProjector`, such as the 20 and 18 on the Qingbo
  waterwheels' prefabs) aren't read, and their drop isn't reported in `debug/`
- temporal smoothing of effects
- light shafts ([light shafts](game-data/post-processing.md#light-shafts)): the occlusion term and
  the cloud mask aren't drawn; unchecked against an in-game shot facing the sun. the
  [sun disc](game-data/sky-and-fog.md#sun-disc) is unchecked against one too
- lens flare ([lens flare](game-data/post-processing.md#lens-flare)): polygon elements and inverse
  SDFs aren't drawn, and the flare component's own settings (when the environment's flare is off)
  aren't known; per-light curves take SRP core's directional-light defaults. at Origin Lodespring's
  overview the viewer's flare is fainter than the game's: the crystal mountain behind the sun
  occludes it in the viewer's depth buffer (the game may not write it there), and Unity's
  random-number mapping is assumed
- the sky's celestial layers are unchecked against in-game shots, and the moon's sky-wide ring
  (`HG_RING`) and the aurora aren't drawn
  ([beyond the atmosphere](game-data/sky-and-fog.md#beyond-the-atmosphere)); `cloudBrightness`,
  `lightAffectCloud` and `enableFarCloudShadowTexture` are ignored
  ([sky](game-data/sky-and-fog.md#sky), [cloud shadows](game-data/lighting.md#cloud-shadows))
- HLOD/detail, LOD and mip swaps pop without cross-fade; ground-blend and decal meshes z-fight
  without the game's depth offsets

## renderer and performance

- GPU culling and indirect draws
- per-cascade shadow caster culling and cascade caching
- terrain pass cost, budget churn in dense areas
- temporal antialiasing sharpening
- per-subtree level masks in the tile tree so traversal skips other levels
- terrain outside the shown level is drawn bare; clipping or dimming it is undecided
- teleport points as viewpoints: where the game stores them is unknown

## coverage and conditional content

- separate scenes (interiors, offices, arenas) are unvalidated
- interactives ([assets](game-data/assets.md#interactives)) with view states
  (`ModelViewStateControllerData`) draw the pose their state machines settle in, and ignore
  per-placement component properties. [one-shot effects](game-data/assets.md#one-shot-effects) and
  the effects a state's `EffectBehavior` plays (the talosites' activation burst) aren't drawn, since
  the viewer can't play them. a settled loop clip plays only where it moves a skinned mesh's bones
  ([interactives](extraction.md#interactives)); what else it animates (rigid renderers, including
  ones parented to its bones, material values, activity) holds its last frame, every placement of a
  geometry plays in step from the viewer's clock (the game's start per placement is unknown), the
  animation moves only while frames render, each LOD stores its own frames, and the balloon's sway
  is unchecked against an in-game shot. facility visual forms settle with every key false, so a form
  whose look the player's presence would change isn't followed. looks the player's presence changes
  follow the camera ([keys the player sets](game-data/assets.md#keys-the-player-sets)); a campfire's
  `InZone` sphere uses the template's 2.5 m radius, though the game swaps the trigger's radius for
  runtime values once inside (unread), and the `Distance` measure is assumed to be a plain 3D
  distance (the helper isn't decompiled). keys only fights or the server set (`InBattle`, `isDead`)
  stay false. doors draw open or closed
  ([interactive doors](game-data/assets.md#interactive-doors)), closed by default except a Dijiang
  cabin's, since what opens each in game (a level script reacting to a mission's cutscene, the
  server) isn't followed. campfires draw not activated or activated
  ([campfires](game-data/assets.md#campfires)), activated by default; their fight look and the color
  layer's VAT clips aren't drawn. an interactive whose template sets one Animator bool from a saved
  property (The Hub's comm terminal, `fixed`) draws unset or set
  ([scenery animators](game-data/assets.md#scenery-animators)), set by default; when the server sets
  it isn't in client data, and int and trigger parameters aren't set. telescopic bridges likewise
  draw retracted or extended ([telescopic bridges](game-data/assets.md#telescopic-bridges)),
  retracted by default. rows created later (`createState` ≠ 0) draw only with their level's "created
  during play" toggle, off by default; one toggle covers a level's rows, since which of them the
  server or a script creates isn't followed. interactives whose model id is missing from the model
  table, templates without a data file of their own (weapon-wall racks, some doors), templates where
  zero or several positions frame the variant table, door models with an ambiguous open-idle state
  (not drawn as doors), and LevelData with any populated field or condition the reader doesn't
  implement (the blackbox scenes' blackbox settings; LevelData members after the interactive list
  aren't decoded) are reported in `out/<map>/debug/unsupported-interactives.json`; those whose
  template or model wasn't found are [stand-ins](package-format.md#stand-ins), the rest omitted
- entities controlled only by `ActivityControlComp` aren't gated
  ([dynamic load gates](game-data/scene-states.md#dynamic-load-gates))
- resource nodes (doodad groups) share one level control per level; the game's per-group level and
  its source in LevelData aren't read ([scene states](game-data/scene-states.md#doodad-groups))
- interactive facilities are gathered from levels whose map is the packed scene, so a scene streamed
  by levels of other maps (`base01_lv001`, streamed by `base01_lv003` and `indie_dg014`) probably
  loses their facilities; select levels by `defaultState.exportedSceneConfigPath` instead
- global variables gates number and MapConfig names stay separate controls (no name table is known);
  map variables map01's MapConfig doesn't name show as numbers, except each blight's, named after
  its core ([blight and its cores](game-data/scene-states.md#dynamic-load-gates); that the variable
  holds the core's state is inferred, and map02's sludge cores aren't linked to anything); Yinglung
  Pass's server-set outpost tier variables are separate controls, so all four tiers show by default
  ([outpost tiers](game-data/scene-states.md#dynamic-load-gates)); variables that drive entity level
  or animator state (doors, bridges, puzzles: `ModelViewStateControllerData` state machines) aren't
  controls yet. the magic [Wuling bridges](game-data/assets.md#wuling-bridges)' DynamicStreaming
  rows draw their prefab as saved, not posed by their interactive's `state`; whether the empty model
  override alone keeps the game from loading the template's drawbridge there is inferred from the
  data, not read in the model component
- whether completing an outpost's `upgradeMissionId` raises its level at once or only unlocks the
  raise is unverified; the viewer treats them as one, reading the mission as complete exactly above
  the level that names it ([upgrade missions](game-data/scene-states.md#outpost-upgrade-missions))
- scene states that scripts set by name (`SetOverrideSceneState`) and map02's sprayable sludge
  aren't represented; script-driven water levels are picked by hand: their controls list what sets
  each fill but don't follow it; scripted environment volumes (blend mode 3) default off and preview
  at full strength rather than following their script's factor; fills a script computes at runtime
  aren't offered (`waterScriptActionsComputed`); a set amount is assumed to move the surface rather
  than snap it; the shop, depot and terminal level → visual form mapping, and the resource-node
  level's link to regional development, aren't recovered
- script-group drivers are found from client scripts only: stages, properties and events the server
  sets show as "server", and groups no client script names have none. groups swapped by trigger
  volumes follow the camera only when every shape is a sphere and nothing else sets them; box and
  polyline volumes, and groups also set by other events, are picked by hand, and the volume script
  is assumed to be running
- interactives level scripts show and hide default to shown, since whether they start hidden isn't
  known; show and hide targets that are a script's own slots or computed at runtime aren't followed
  (counted as `scriptVisibilityUntraced` in the pack report). LevelData function areas that hide
  entities by type while the player is inside aren't applied (listed in
  `unsupported-interactives.json`)
- story-state expressions and script relationships beyond what client data proves; event and server
  conditions may never be recoverable
- control labels still show internal identifiers or representative mesh names in many places
- runtime world-space UI, including Dijiang's cabin nameplates and assigned-operator panels, is not
  drawn ([cabins](game-data/scene-states.md#dijiang-cabins)); neither are the Images and Text of
  world-space canvases inside prefabs, such as the counters on Dijiang's weapon wall displays
- skeletons the reader can't pose and nonzero blend shapes (meshes with them are stand-ins);
  characters' skeletal animation isn't played. prefab
  [scenery animators](game-data/assets.md#scenery-animators) play their controllers' default states.
  a looping clip moves skinned and rigid renderers alike, but its material values and GameObject
  switches hold their end values, and each moving renderer stores every frame of its own (Qingbo's
  octagonal waterwheels: 44 renderers × 1500 frames). of
  [ACL-compressed clips](game-data/assets.md#acl-compressed-clips) only the Transform tracks play:
  float tracks (material values, activity) and root motion aren't decoded, and buffers with a
  database, non-trivial default values or Euler bindings hold their end pose. blend-tree states,
  additive or partial-weight layers, override controllers and the Animators of models with view
  states hold their saved pose. vertex-animation-texture meshes (`_vat`, e.g. floating rocks) draw
  their rest pose. [spinning scenery](game-data/assets.md#spinning-scenery) (Qingbo's other
  waterwheels) turns from its stored pose at the viewer clock's zero rather than at the game's
  gameplay-clock phase, and how the native system turns it is inferred from the data, not read.
  renderers under MonoBehaviour rotators (`DynamicSceneSimpleRotate`, `TransformRotateAroundAxis`)
  in prefabs hold still; whether any placed prefab has such renderers isn't surveyed (the
  waterwheels' rotators turn only colliders and decals)
- the game's HLOD-unload triggers (`FBStreamArea` root slots 7–9) and HLOD layer load radii
  (`hlod0LayerLoadRadius`, …) aren't read ([world](game-data/world.md#stream-areas))
- HLOD clusters never stand in for Global chunk content, which always draws, so wherever a cluster
  covers Global scenery both draw until the cluster's tile refines. in indie_dg005 every static
  renderer is Global, so its clusters only ever double what's there. the game likely streams each
  entity by its layer's load radius, Global ones included, so its detail would give way to HLOD;
  making Global content refinable needs each entity's streaming layer, whose storage isn't found
  ([LOD and HLOD](game-data/world.md#lod-and-hlod)). HLOD tiers whose grid sits half a cell off the
  tile tree (indie_dg005, dung02_dg002's HLOD1) are filed under one of the two tiles each cell
  straddles ([tile tree](package-format.md#tile-tree))
- billboards turn only mesh renderers; skinned meshes and particle systems under a `VFXBillBoard`
  stay as authored; a renderer away from the `VFXBillBoard`'s origin turns in place instead of
  swinging around it, and modes 2–3 turn about the world's vertical rather than their own up, so
  tilted placements face wrong ([billboards](game-data/assets.md#billboards))
- the AIC buildable-grid data (`factorygrids/fbgrids_*.bytes`, a FlatBuffer of per-1 m column height
  spans and buildable/water flags on the 128 m cells) has no decoder
- some mesh/material references are missing from the install's path-hash table. failed exact lookups
  stay explicit

## packaging

- cache material conversion; remember failed conversions so a warm pack starts no worker; skip
  compressing duplicate textures
- the entities pass (~7 s on map02) re-reads every chunk file on a warm pack; it could be remembered
  like terrain and irradiance
- prefab LODGroups switch on each renderer's own bounds rather than the LODGroup's size and
  reference point, and without its fade or the game's LOD bias
- a mesh or material reached both by path hash (static entities) and by object (prefabs) gets two
  table entries and converts twice
- texture zstd level and a max-texture-size option for a lite package (textures dominate package
  size)
- place global scenery by its own bounds instead of pulling it all into `assets/common`
- port the game's path hash so lookups stop reverse-scanning the path-hash table (about a second
  each)
- render meshes: collision-only meshes (`m_CollisionMeshBaked`) and vertices in `m_CompressedMesh` are
  rejected, leaving their instances as streaming boxes. a separate `asset collision` decoder reads
  supported cooked triangle meshes for routing investigation; PPtrs into Unity's built-in resources
  resolve only for the Quad and Cube ([built-in meshes](game-data/assets.md#built-in-meshes));
  prefabs that fail with a `FormatError` are listed in the unsupported-prefab report and drawn as
  [stand-in](package-format.md#stand-ins) cubes ([assets](game-data/assets.md#mesh))
- move the viewer's environment-agnostic package loading into `package-format` so packer tests read
  packages through the viewer's code
- the terrain shader assumes 65² pages

## open unknowns

- HLOD switch distances (the package uses a placeholder error) and the HLOD material/atlas mapping
- per-controller meaning of progression bit 0 ("unbuilt" versus "level 1")
- weather/time state ids
- runtime: BC texture support in Safari, the texture-array layer limit on Apple GPUs

## ground routes and arrival framing

- navigation topology, current air-wall geometry and teleport/base seeds can be exported and fed to
  the Ganglia alpha package; route-bound camera candidates and forced cache rebuilding are available
  ([navigation](navigation.md), [precompute](oem-precompute.md#arrival-route-constraints))
- player area masks, dynamic-state selection, partial portals, detail heights and missing industrial
  ground coverage remain unresolved. an AI navigation path is not proof of complete player passage;
  the example point's distant arrival and full visual acceptance are still unverified
- version 2 exclusions also block reset-zone bounds, including payload-free temporary zones; current
  full-map extraction found 400 volumes. exact trigger shapes and activation remain unresolved
- movement settings and 34 character capsule proxies can be exported separately from AI bake settings. directed jumps/drops still need
  player collision geometry, capsule/modifier resolution and trajectory/landing validation; they are
  not inferred from AI jump heights or admitted by vertical endpoint projection
- the most common capsule is the default when importing matching movement settings; explicit dimensions
  can override it. factory regions are player-accessible and require physical ground coverage where
  AI navigation omits them; the AI exclusion is not a player barrier
- cooked collision decoding passed 107 triangle-mesh assets / 43,900 triangles in the example cell,
  with bounds matching the asset records within 0.000006 m. its remaining convex asset now decodes
  to a closed, outward-facing hull of 8 vertices / 12 triangles;
  collider transforms, primitive shapes, filtering and full-scene coverage are not yet validated

- player ground build: Ganglia alpha.4 provides a separate offline collision-to-surface
  builder with profile clearance, slope and conservative ordinary step limits. packed
  import and type declarations are verified. game collision placement and full factory
  coverage are still pending; the current route CLI continues using selected Unity
  navigation surfaces. no implicit jump/drop links or view-cache rebuild were added.
  explicit XZ bounds now keep large actors from expanding a local build; native contour
  failures remain errors with diagnostics. a 64 × 64 m real geometry probe built 33,891
  detail triangles. this does not validate full collision coverage or crossing region edges.

- movement devices: `traversal-devices` exports authored rope targets, launch/acceleration
  parameter scopes and unresolved state. reciprocal rope pairs are explicit; the exporter
  does not convert device pivots into ground or grant traversal without validation.

  current exports contain 218 reciprocal rope pairs, 158 launch devices and 40 acceleration
  devices across map01/map02; all selected rope endpoints pair by authored reference.

- directed movement API: the packed Ganglia dependency accepts grounded rope/jump/drop/launch
  connections with sample times, and exposes timed journey sampling. unknown connections and
  air-wall intersections remain blocked. the extractor does not yet generate validated game
  trajectories, and has not rebuilt view caches using movement devices.

- streamed collision inputs now decode actor/local shape poses, compound mesh ordering,
  primitive dimensions, enabled/trigger flags and separate terrain bindings. the new
  `collision-inputs` command requires an explicit cell/state/area and reports incomplete
  world coverage. 134 real sample actors / 1,008 shapes decode. cooked triangle/convex
  geometry and RG16 collision heightfields are now included, with collision-specific height
  normalization, alternating diagonals and complete hole-quad removal. four real heightfields
  yield 31,092 triangles and omit 838 hole quads. world geometry assembly, layer policy and
  traversal collision validation are still pending.
  the same command accepts `global` to include global chunk inputs separately (19 actors
  in the map01 default global chunk); neither selection claims complete collision coverage.
