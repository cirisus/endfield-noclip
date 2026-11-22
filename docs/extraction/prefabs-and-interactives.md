# prefabs, dynamic structures and interactives

how `pack` places non-chunk geometry: prefab hierarchies,
[dynamic structures](../game-data/assets.md#fb_main-grids), and level interactives with their poses.
see [scene controls](scene-controls.md) for their controls and
[how the packer files instances](../extraction.md#how-the-packer-files-instances) for instance
storage.

## prefabs

`readPrefabRenderers` ([prefab.ts](../../packages/extractor/src/game/prefabs/prefab.ts)) returns a
prefab's drawable renderers relative to its root; callers supply the root placement. it follows
[prefab rules](../game-data/assets.md#prefabs) and walks inactive subtrees to collect their
Transforms.

### hierarchy walks

all prefab readers use `walkPrefab`
([prefab-walk.ts](../../packages/extractor/src/game/prefabs/prefab-walk.ts)):

1. read each GameObject and lazily resolve its components by exact PPtr (cached per object).
2. place its Transform (or RectTransform) in prefab space with the root at identity.
3. stop on cycles; visit children in authored order so walk order stays deterministic.

each reader is a visitor with three hooks: `enter` (prune a GameObject or derive child state such as
Animator path or inactive ancestor), `local` (override local transform for a pose), and `visit`
(collect once world matrix is known). light, environment-volume, and Animator-default readers prune
inactive subtrees; others walk them. clip binding paths and posed transforms live in
[pose-paths.ts](../../packages/extractor/src/game/prefabs/pose-paths.ts).

the renderer walk ([renderer-walk.ts](../../packages/extractor/src/game/prefabs/renderer-walk.ts))
runs per GameObject:

1. check whether the GameObject is switched off.
2. dispatch each component to the first matching reader (`VFXAdjustLength`, root
   `UnlockEffectConfigMono`, raft post-model, emission overrides, view-state controllers,
   `EffectSetting`s, Animators).
3. after computing its matrix, run matrix-dependent steps (followers, force fields, distance
   origins, billboards).
4. if drawing, run candidate sources
   ([renderer-candidates.ts](../../packages/extractor/src/game/prefabs/renderer-candidates.ts)) in
   keep order: LODGroups, skinned/mesh renderers, decal projectors, particle systems, spline movers.
   - decal projectors
     ([decal-projector.ts](../../packages/extractor/src/game/prefabs/decal-projector.ts)) draw the
     shared decal cube inside the GameObject's box; they skip clip, skin, and billboard paths and
     stay at their saved placement.
5. after the full hierarchy is placed, settle cross-node passes (followers, force fields) in
   [renderer-passes.ts](../../packages/extractor/src/game/prefabs/renderer-passes.ts).

skinned poses and looping-clip frames live in
[skin-pose.ts](../../packages/extractor/src/game/prefabs/skin-pose.ts); pose material values live in
[material-values.ts](../../packages/extractor/src/game/prefabs/material-values.ts). adding a
component kind means adding one reader, step, or candidate source.

### what the renderers carry

- **LODGroups**: under an enabled `LODGroup`, each LOD's renderers (matched by object identity,
  never name) get the screen-relative height span they show at (consecutive LODs merge into one
  span). distance bands override LODGroup thresholds when both exist.
- **skinned renderers**: bounds are the union of mesh bounds across all bones. renderers bake to
  their authored pose ([skin pose](../extraction.md#asset-classes)) unless a
  [looping clip](#looping-clips) animates their bones.
- **locked looks**: a root `UnlockEffectConfigMono` that swaps models draws its locked model for
  placements with a mini-game or submit lock, and its unlocked model otherwise
  ([gameplay locks](../game-data/interactives.md#gameplay-locks)); the inactive model is omitted,
  not a stand-in. lock types come from LevelData's `interactiveLockData`
  ([level-locks.ts](../../packages/formats/src/endfield/level-locks.ts)), decoded whole. if a
  level's LevelData fails MemoryPack decoding (Dijiang), it reports `gameplay locks` in
  `unsupported-interactives.json` and treats placements as unlocked.
- **raft wakes**: the two wake subtrees named by a root `InteractiveSummonTeamPostmodelMono` only
  show while moving ([bamboo rafts](../game-data/interactives.md#bamboo-rafts)) and are omitted (not
  stand-ins).
- **emission overrides**: an enabled `AnimationProperties_Emissive` on an active GameObject folds
  its colour into listed renderers' `_EmissiveColor`
  ([emission](../game-data/materials.md#emission),
  [emissive-override.ts](../../packages/extractor/src/game/prefabs/emissive-override.ts)), creating
  a material variant. emissive configs set by settled view states
  ([emission view states set](../game-data/interactives.md#emission-view-states-set)) override saved
  colours (last config along each layer's path wins). any non-trivial albedo tint passes through as
  `perDraw.emissiveAlbedoColor` (`PER_DRAW_EMISSIVE_ALBEDO`), which the Lit describer turns into
  `LitEmission.albedoTint`. breathing animation isn't read.
- **resolution**: prefabs resolve from their StringPathHash key, which must match exactly one
  manifest path.
- **other prefab contents**: environment volumes
  ([prefab-environment.ts](../../packages/extractor/src/game/prefabs/prefab-environment.ts),
  [prefab volumes](environments.md#prefab-volumes)) and lights
  ([lights](../package-format.md#lights)) are read separately. particle systems become particle
  draws ([particles](../package-format.md#particles)); billboarded renderers become billboard chains
  ([chains](../package-format.md#binary-encodings)).

## dynamic structures

the [fb_main grids](../game-data/assets.md#fb_main-grids) reader
([dynamic-scene.ts](../../packages/formats/src/endfield/dynamic-scene.ts)) validates every slice and
throws on layout mismatches instead of truncating. it checks effect rows' repeated position (+116)
to confirm stride, and `parseDynamicChunk` decodes ECS `fb_init`/`fb_streaming` pairs with the
InitChunkData group decoder.

for each model or effect row ([payloads](../game-data/assets.md#payloads)), the packer resolves the
prefab and places its renderers under the row's TRS. prefab renderers, prefab lights, and stand-ins
lack game entity ids, so each gets a synthetic id: the level tag over an index counting down from
the top of the 27-bit id space.

`loadDynamicStructures`
([dynamic-structures.ts](../../packages/extractor/src/game/dynamic/dynamic-structures.ts)):

- deduplicates models and ECS entities by stored reference, unioning visibility alternatives across
  all groups that show them
- assigns each structure its resource group's `levelNum` level tag
- prefers the static copy when an ECS entity already exists in static chunks; keeps local lights of
  selected ECS groups the same way ([lights](../package-format.md#lights))
- reads rect decal materials from `fb_streaming` and draws the shared decal cube
- converts entities with a spin component (column 54,
  [spinning scenery](../game-data/animation.md#spinning-scenery); static or dynamic) into spinning
  rows, expanding tile/level bounds by the swept cylinder (`sweptBounds` in
  [bounds.ts](../../packages/extractor/src/pack/instances/bounds.ts))

## interactives

code: [level-interactives.ts](../../packages/formats/src/endfield/level-interactives.ts),
[interactive-model.ts](../../packages/formats/src/endfield/interactive-model.ts),
[animation-clip.ts](../../packages/formats/src/unity/animation-clip.ts),
[interactive-facilities.ts](../../packages/extractor/src/game/interactives/interactive-facilities.ts),
[view-state-poses.ts](../../packages/extractor/src/game/interactives/view-state-poses.ts),
[animator-defaults.ts](../../packages/extractor/src/game/prefabs/animator-defaults.ts),
[door-poses.ts](../../packages/extractor/src/game/interactives/door-poses.ts),
[telescopic-bridge.ts](../../packages/extractor/src/game/interactives/telescopic-bridge.ts),
[prefab.ts](../../packages/extractor/src/game/prefabs/prefab.ts).

`loadInteractiveFacilities` runs in fixed order:

1. read placed rows, decode each placed template once for models (`template-models.ts`) and traits
   (`template-traits.ts`), and read doodad shells.
2. pass each single-model template's traits to every `InteractiveKind.prepare` in first-placement
   order.
3. load region-wall unlock tables, crane-tower poses, and graded-doodad forms.
4. emit each row via the first kind whose `place` claims it (bridges → doors → rest looks incl.
   lifts → animator starts → region walls → crane towers), else as a plain model or
   [graded doodad forms](scene-controls.md#graded-doodads) (plus doodad-group forms), else as
   facility forms.
5. wrap every emitted model in `InteractiveRow` (`interactive-row.ts`), applying switches, blight
   core, model scale, ride, crane hang, and lock.
6. place resting effects last.

adding a new interactive kind means implementing `InteractiveKind`, adding its detection trait, and
inserting it in this list (order determines emitted model, control, and diagnostic ids).

### templates and models

- `readLevelInteractives` reads LevelData's sequential prefix through the interactive list
  ([interactives](../game-data/interactives.md)); `readInteractiveTable` reads
  `InteractiveTable.json`.
- `readInteractiveBaseModel` reads the template's model component; `readInteractiveVariantModels`
  reads its variant table.
- a placement uses its variant model if present, else the template model. an enabled but empty
  variant override draws nothing (e.g. magic
  [Wuling bridges](../game-data/interactives.md#wuling-bridges) show only their DynamicStreaming
  row, not the template drawbridge). a doodad-group shell places one form per group level
  ([doodad groups](scene-controls.md#doodad-groups)).
- because hundreds of component/action-graph types sit before the
  [variant table](../game-data/interactives.md#the-variant-table), the reader locates it from EOF: a
  candidate offset matches when parsing reaches exact EOF and its keys match all InteractiveTable
  ids naming that template (excluding the template's own id).
- every placed template is also decoded whole via [MemoryPack](../extraction.md#memorypack-data) to
  detect model-upgrade components. templates with one emit one model per visual form under a
  per-facility control ([facility visual forms](scene-controls.md#facility-visual-forms)). known
  facilities get English labels; others use the template id. unusable model-upgrade components log
  to `unsupported-interactives.json` and fall back to the base model.

### view-state poses

view states come from the model's own file or its `ModelTable` row's `dependModelViewDataId`
([interactive view states](../game-data/interactives.md#interactive-view-states)), for doors, rest
looks, and facility forms alike.

an interactive with view states settles every animator layer with all keys false, except `state`
(set to the placement's starting [`state`](../game-data/interactives.md#the-state-key) when the
template has a common-perform component; cached per `(model, state)`). each pose holds one clip end
pose per animator: local transforms, GameObject switches, renderer material values, and particle
pivots.

- `readPrefabRenderers` applies transforms and switches during the walk so skinned meshes follow
  their bones.
- inside a clip that switches GameObjects, nodes saved off and untouched by the clip draw nothing
  (not stand-ins).
- clip material hashes resolve against each material's saved property names (unsaved properties are
  dropped) and produce a [posed copy](../package-format.md#materials).
- an empty switch name targets the animator's own GameObject. if the root animator switches the root
  off, the pose is `hidden` and emits no renderers, lights, or effects.
- facility visual forms pose under their own model id with all keys false (player-set keys aren't
  read). doodad-group shells aren't posed.

**lengths and followers**: poses also carry
[lengths](../game-data/interactives.md#lengths-view-states-set) set along every layer's path (not
just its resting state). vertical ropes settle per placement with `RopeLength` from `target`;
[broken robots](../game-data/interactives.md#broken-robots) settle with `level`, `damage_type`, and
`exit_type`. during the walk, `VFXAdjustLength` scales target local scales (before clip transforms)
and stretches renderer material texture scale/offset. a `VFXAdjustLength` that also modifies
renderer bounds, particle lifetimes, or moved Transforms fails the prefab (becomes a stand-in box).
`PositionFollower`s move with their subtrees after the walk finishes so forward references resolve.

**controlled poses**:

- **doors**: template has a door component and model has exactly one settled open-idle clip
  ([interactive doors](../game-data/interactives.md#interactive-doors)). emitted once per pose (clip
  end pose + `SetActive` switches) under a [door control](scene-controls.md#doors).
- **campfires**: template has a campfire component; emitted with `Enabled` false and true under
  `activation:<id>` (0 off, 1 on default), grouped with progressions.
- **proximity**: template drives a
  [player-set key](../game-data/interactives.md#keys-the-player-sets) (`Distance`, `InZone`);
  settled again with those keys true. if any settled state changes, both poses emit under
  `proximity:<id>` (0 away, 1 near) with the largest radius, driven by camera position
  ([proximity](../package-format.md#proximity)).
- **telescopic bridges**: template has a
  [telescopic bridge](../game-data/interactives.md#telescopic-bridges) controller; posed with the
  prefab root as Animator: retracted (end port moved back, track/piece off), extended (end port
  moved out, track scaled), plus one placement per piece (everything else off, moved to its slot,
  open-idle clip re-keyed from piece Animator to root; [bridges](scene-controls.md#bridges)).

### effects at rest

rest looks (not doors, bridges, or facility forms) also place persistent effects left playing by
their states ([effects states play](../game-data/interactives.md#effects-states-play)).
`settledPath` traces each layer from start; `restingEffects` keeps persistent effects enabled along
the way plus the resting state's other effects, skipping fire-and-forget ones.

each effect prefab places under the look's visibility unless its `EffectSetting`s don't loop
(`isOneShotEffect`) or it is missing from the manifest (logged in `unsupported-interactives.json`).
node matrices come from `prefabNodeMatrices` at the clip end pose (ignoring looping-clip motion);
effects that don't rotate with their GameObject keep world axes with the GameObject's scale.

also placed this way:

- **jump pad arrows** ([the `state` key](../game-data/interactives.md#the-state-key)): at pad
  position, yawed toward target, unit scale, under pad visibility only.
- **vertical jump pad vents** (when starting on): placement position/rotation/scale (without model
  scale).
- **laser gates** ([laser gates](../game-data/interactives.md#laser-gates), when starting on): each
  name in model root's `effectsOnActive` (`ElectricFences`), using placement transform without model
  scale.

## animation and poses

### looping clips

a settled state whose clip loops keeps playing
([playing a clip](../game-data/interactives.md#interactive-view-states)). `readClipMotion` loads its
curves, and `poseFrames` re-poses the recorded hierarchy at each frame (`duration × sampleRate`)
while other clips hold their end poses:

- **skinned renderers**: if bones move across frames, emits `motion` (prefab-space bone matrix ×
  bind pose per frame, bounds unioned over all frames) as an animated geometry keeping bind-space
  vertices, weights, bone indices, and frames
  ([geometry blob](../package-format.md#geometry-blob-mesh-efgm)).
- **mesh renderers (non-billboarded)**: if Transform moves, emits a `rigid` motion with the
  Transform as bone 0 (identity bind pose; conversion assigns every vertex bone 0 at weight 1 via
  `rigidSkin`, ignoring any mesh bone weights).
- **animated material floats**: sampled per frame (`playedFloats`, from `ClipMotion.materials`).
  conversion runs the material describer per frame and keeps changing numbers as `motion` tracks
  (`surfaceMotion` in
  [material-motion.ts](../../packages/extractor/src/pack/convert/material-motion.ts): e.g. soft-body
  frame, tint alpha, dissolve threshold). structural surface changes across frames drop the motion
  and record the gap `material values a looping clip plays`. vector/colour components, ACL clip
  material curves, and looping clips after a renderer's first hold their end values.
- **particle systems**: placed at end pose with per-frame emitter offsets (`emitterMotion` in
  [skin-pose.ts](../../packages/extractor/src/game/prefabs/skin-pose.ts)), capped at 30 fps
  ([particles](../package-format.md#particles)).
- unreadable clips hold their end pose.

examples: `int_balloon_postmodel` (balloon tube) and `int_system_fac_region_upgrade_postmodel`
(upgrade terminal robot) animate skinned; Qingbo Stockade's octagonal waterwheels
([scenery animators](../game-data/animation.md#scenery-animators)) animate rigidly over >1000 frames
each.

### scenery animators

prefabs without a view-state pose play what their own Animators settle into
([scenery animators](../game-data/animation.md#scenery-animators)):

- **`animatorDefaultPose`**: walks active GameObjects for enabled Animators with plain
  AnimatorControllers and takes each showing layer's settled state clip under saved parameters (end
  pose, or looping motion at state speed). skips blended layers, blend trees, sub-machine
  transitions, and override controllers.
- **template animator bools**
  ([template animator parameters](../game-data/interactives.md#template-animator-parameters)):
  `animatorPose` applies template-set bools to every Animator in the prefab (unverified which
  Animators the game targets). a bool read from a saved property emits one placement per value under
  `activation:<row id>` (default set, matching a finished save).
- **decoration animators** ([decoration animators](../game-data/animation.md#decoration-animators),
  [decoration-animators.ts](../../packages/extractor/src/game/dynamic/decoration-animators.ts)):
  `decorationAnimatorStarts` traces each scene script from `ScriptEvent_OnScriptActive` through
  `nextID`, branch lists, and saved-property if/else nodes, keeping constant or
  single-property-split `SetDecorationAnimatorInt`/`Bool` values. groups set past other conditions,
  by multiple scripts, or with multiple values on one path stay as saved
  (`decorationAnimatorGroupsUntraced`). other events and `PlayDecorationAnimation` aren't read.
  split groups emit one placement per value under `activation:<script>:<property>` (default set).
  `collectPlacementSources` applies these after level scripts load; view-state-posed models and
  effect rows keep their look.

### ACL clips

`readClipMotion` decodes [ACL-compressed clips](../game-data/animation.md#acl-compressed-clips) via
[acl.ts](../../packages/formats/src/unity/acl.ts), a TypeScript port of ACL 2.1 transform-track
decompression (MIT; notice in file). supports full/w-dropping rotations, full/variable vectors,
multi-segment clips, and stripped keyframes. it decodes all stored samples with float32 w-rebuild
and range reduction (near `w = 0`, rounding picks `w`), interpolates stripped samples, and agrees
with upstream ACL to ~`1e-5` translation and ~`1e-4` rotation on Wuling City's spinning cube.
sampling between frames matches the dense block (wrapping when the buffer wraps), mapping tracks via
sub-track masks and holding constant bindings fixed.

## special interactives

### moving platforms

[auto-moving platforms](../game-data/interactives.md#auto-moving-platforms)
([curve-move.ts](../../packages/extractor/src/game/interactives/curve-move.ts)) with starting
`state === 1` and a valid `spline_id` ride their spline:

1. decode the level's LevelData whole via [MemoryPack](../extraction.md#memorypack-data) once per
   level (`readLevelSplines` in
   [level-splines.ts](../../packages/formats/src/endfield/level-splines.ts)).
2. `curvePath` builds world-space Bézier curves with a 30-sample arc-length table per curve,
   simulates one loop (one-way or round-trip) in `1/240` s steps with speed ramps and knot waits,
   and samples at 15 fps from the initial phase (loop length within one step per trip of the game).
   a knot waiting for the player stops simulation and parks the platform (1-frame path).
3. each frame stores the world-axis offset from placement as `StructureModel.ride`, written into
   block [rides](../package-format.md#instance-block-inst-efin). the prefab still runs its own
   Animators and view states, and [resting effects](#effects-at-rest) inherit the ride; lights stay
   at the placement.

platforms that rotate along the curve, vary speed by segment/curve, or stop at target (mode 0) log
to `unsupported-interactives.json` and stay fixed.

### crane towers

[crane towers](../game-data/interactives.md#crane-towers)
([crane-tower.ts](../../packages/extractor/src/game/interactives/crane-tower.ts)) are posed before
placements draw:

1. `craneTowerOf` merges tower component parameters with the placement's component type 172;
   `state_*` entity properties pick the active steps.
2. `readCraneLook` walks the prefab for the postmodel MonoBehaviour's five Transforms and builds one
   root clip: rope scale, rope-end position, and base/hook rotations (world yaws converted to local
   rotations under posed parents).
3. the walk outputs the attach point's world position and rotation; the tower's `target` container
   draws there (lowered by its `height`) instead of at its own placement.

towers with an empty step list or missing MonoBehaviour log to `unsupported-interactives.json` and
draw as saved; missing `target` containers still pose the tower and log.

### lifts

[lifts](../game-data/interactives.md#lifts)
([lifters.ts](../../packages/extractor/src/game/interactives/lifters.ts)) are rest looks whose
template has the lift core component:

- `lifterStart` reads the starting floor, its position, and door bools (which settle view states).
- `readLifterLook` adds a root clip moving the cabin to the floor (world position converted to
  parent's saved space) and scaling the pole.
- if no view state switches a GameObject, the pose is `closed` (nodes saved off draw nothing, not
  stand-ins).
- floors missing from `position_list`, or prefabs without the MonoBehaviour, log to
  `unsupported-interactives.json` and draw as saved.
