# environment

how the viewer blends [game-data/environment.md](../game-data/environment.md) volumes at the camera
and applies rain wetness.

## environment phases

package [phase sections](../extraction/environments.md) keep the game's field names and feed
lighting, sky, fog, post-processing, and rain wetness; `wind` only clocks
[swaying cloth](materials.md#swaying-cloth). four unexplained fields
([game-data](../game-data/environment.md#environment-phases)) are packed but unread:
`cloudFlowType`, `skyMaterialType`, `reflectionType`, and `heightFogConfig.enableVolumetricFog` (the
cloud panorama is static, and PC volumetric fog switches on `volumetricFogConfig.enable` alone).

## environment volumes

a level's initial viewpoint is nudged along its view line until the base volume holds it fully and
no neighbouring level's volume overlaps it.

the viewer blends only the chunk and [prefab](../game-data/environment.md#prefab-volumes) volumes in
the package. omitted ([volumes](../extraction/environments.md#volumes)): cylinder volumes, moved
prefab prism volumes, LevelData dynamic volumes, and local post `Volume`s (each level uses its
global post profile only). a scene without levels has no environment.

## scene states

the viewer skips any volume whose visibility group condition fails for the selected scene values.

## blending at the camera

implements the [game's blend](../game-data/environment.md#blending-at-the-camera). a "profile" here
is a phase plus post profile, not a Unity `VolumeProfile`.

- **base profile.** starts from every section of the [current level's](streaming.md#levels) base
  phase (including inactive sections) and its post profile. entering another level's cells switches
  the base while preserving active fades. the scene's global volume and level's base volume then
  apply as normal volumes.
- **caching.** active volumes, factors, and a cache key are re-planned only when eye, volume
  settings, condition results, or fades change; sections re-blend and derive a new look only when
  the key changes.
- **order.** volumes sort by ascending priority, then shape kind (global, box, prism), then list
  order (tie-break among equal priorities is assumed), shared with the extractor's
  [base-environment vote](../extraction/environments.md#the-levels-base-environment).
- **time fades.** time-mode factors snap on camera moves > 5 m in a frame.
- **field blending.** factor ≥ 1 copies the section; below 1, fields follow the environment table's
  `schema` ([schema](../extraction/environments.md#blend-schema)): lerp, lerp+round, or switch at ½.
  cloud panorama, height-fog flow noise, lens flare, and rain wetness follow the game's special
  cases. divergences: cloud shadow fields lerp/switch by schema instead of crossfading;
  `drawCloudAfterPlanet` switches at ½ instead of blending as a weight; falling rain isn't drawn;
  snow isn't packed.
- **inferred lerps.** where the game's lerp is unknown
  ([blending](../game-data/environment.md#blending-at-the-camera)), directions lerp in pitch and
  shortest-arc yaw (staying unit vectors), integer counts round (`round`), and negative
  `rayleighScatteringScale` resolves against its atmosphere's scale before lerping.

the "volumes at camera" toggle disables positional blending so scene-wide global volumes and the
level's base volume apply at full strength. a pinned phase overrides the volume blend using phases
from the current level's listed volumes ([listing](scene-states.md#the-scene-conditions-panel),
including overlapping neighbours).

## activation

each volume's visibility group requires its `environmentVolume` control alongside its scene states,
so volume checkboxes behave like standard scene controls (picks, "Reset", level listing).
manual-blend volumes (`blend.kind === 'scripted'`) default off because scripts aren't evaluated, and
apply at full strength when toggled on. all other volumes default on — including story-state chunk
volumes, which diverges where the game keeps them off
([activation](../game-data/environment.md#activation)).

## weather

rain sections apply wherever their chunk or prefab volumes apply (e.g. Marker Stone's lake islet).
quest-driven rain lives in unextracted LevelData dynamic volumes. falling rain and snow are not
drawn, and `snowConfig` is not packed.

### wetness

mesh and terrain surfaces (including standing water) are wetted matching the
[game's deferred lighting](../game-data/environment.md#wetness), using a one-sided `enableWetness`
blend (profiles without a rain section count as dry).

divergences: no rain occlusion map (all surfaces count as open to the sky over the 100 m range), no
coverage-edge jitter, no ripples or splashes, no wall streaks, and no flooded normal-map dips.
