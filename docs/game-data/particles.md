# particles and spline movers

how prefabs emit and move objects: Unity `ParticleSystem`s (as configured by the game) and Beyond's
spline movers. see [effects.md](effects.md) for particle shaders and custom data, and
[assets.md](assets.md#prefabs) for prefabs and billboards.

## particle systems

`ParticleSystemRenderer.m_RenderMode`:

| value | mode                                                                                                                                            |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 0     | billboard quad                                                                                                                                  |
| 1     | stretched quad                                                                                                                                  |
| 2     | horizontal quad                                                                                                                                 |
| 3     | vertical quad                                                                                                                                   |
| 4     | mesh                                                                                                                                            |
| 5     | none (trails/sub-emitters/lights only, e.g. storehouse sparks `light` in `p_fxmap_uninteractive_storehous_01`, `_var1`, `p_fxmap_map_spark_02`) |

### emission and lifetime

- **rate over time**: `EmissionModule.rateOverTime` (particles/s). curves evaluate at
  `systemTime / lengthInSec`, repeating each loop (per Unity docs; engine step and two-curve
  sampling untraced). example: Qingbo waterwheel pours (`bigwater_01` in
  `p_igroup_map02_sfwaterwheel+2_004_01`) emit 32/s from 12% to 77% of a 3.125 s loop and 0 in the
  last 15%.
- **cap (`maxNumParticles`)**: without a ring buffer, limits emission to `cap − live` (never drops
  live particles; skipped emissions are lost). example: Very Large Rift ripple rings (`wenli_02`
  etc. in `p_fxmap_dung02_dg005_boss_semicircle_ripple_01`) burst every 0.1 s with cap 1 → one ring
  per 6 s life. cap 0 emits nothing unless a looping ring buffer is active (e.g. tilted torch flames
  `P_fxmap_common_tiltedflame_2501`).
- **ring buffer (`ringBufferMode`)**: removes the emission cap and replaces the oldest slot
  (`maxNumParticles` emissions ago):
  - `1` (PauseUntilReplaced): holds particle age at end of lifetime while modules and velocity keep
    running (curves read at end). on replacement, drops the old particle and fires death
    sub-emitters. example: Jingyu Valley fish school (one burst lives 5–10 s, then swims in its
    force field indefinitely).
  - `2` (LoopUntilReplaced): loops age over `ringBufferLoopRange` while position keeps integrating.
    on replacement, moves the particle past the cap where it finishes its current cycle and dies
    normally (allowing fade-out). example: Wuling City bamboo smoke
    (`p_fxmap_map02_lv002_bamboo_watersmoke_2501`, cap 2, emits 4/loop).
- **simulation space (`moveWithTransform`)**: `0` Local (moves with Transform), `1` World (stays
  where emitted), `2` Custom (`moveWithCustomTransform`). example: Qingbo octagonal waterwheel pours
  (`bigwater_01 (6)`, `(7)` in `p_igroup_map02_sfwaterwheel+2_004_01`) use World space while the
  [Animator clip](animation.md#scenery-animators) rotates the scoops; splash `huihuagenbu (2)` holds
  still.
- **donut shape (`ShapeModule.type = 17`)**: torus of major radius `radius` around shape `z`, tube
  radius `donutRadius`, outer fraction `radiusThickness`, emitting outward from the tube centreline
  (per Unity docs; unchecked against engine). example: accelerate mushroom coin motes (`lizi1` in
  `int_acceleratemushroom_postmodel`).
- **mesh shape (`ShapeModule.type = 6`)**: emits from `m_Mesh` (all submeshes, or clamped
  `m_MeshMaterialIndex` with `m_UseMeshMaterialIndex`). supports triangles, lines, strips (read as
  lists), and unindexed submeshes (as line strips); quads or points invalidate the mesh (no
  emission). corner count (2 or 3) comes from the last submesh read, so mixed line/triangle meshes
  sample inconsistently.
  - `placementMode`: `0` (vertex) picks a primitive uniformly then a corner (shared vertices bias
    higher); `1` (edge) picks a triangle by area (line by length) then a uniform edge parameter
    (each side weighted 1/3); `2` (triangle) picks uniformly by area.
  - `m_MeshSpawn.mode`: for vertex placement, steps through the vertex buffer directly (ignoring
    material index) via a running counter — Loop wraps, PingPong/BurstSpread bounce, ignoring
    `speed`/`spread`. for edge placement, walks the outline at `m_MeshSpawn.speed`; `spread` snaps
    positions (including in random mode).
  - particles emit along normalized interpolated normal (`(0, 0, 1)` if absent), pre-offset by
    `m_MeshNormalOffset` along the unnormalized normal in mesh space (scaled by shape scale).
    `m_UseMeshColors` multiplies start colour by interpolated `Color32`, then shape texture.
  - example: red mission portal sparks (`dot_Line` in
    `p_fxint_s_missionportal_entrance_red_narrowloop_2103`) emit on ring edges.

### motion

per-step order:

1. add gravity to particle velocity
2. apply external forces to particle velocity
3. add Velocity over Lifetime beside particle velocity (not baked into it)
4. apply Limit Velocity (limit, then drag) to the combined speed, subtracting changes from particle
   velocity alone
5. advance position by `combinedVelocity · speedModifier · dt`

details:

- **Limit Velocity**:
  - `dampen = 0`: skips speed limit; applies drag only. reduces combined speed by `k · dt` (or
    `k · s² · dt` with `multiplyDragByParticleVelocity`), where `k = drag` (× `π · (size / 2)²` with
    `multiplyDragByParticleSize`, `size` = max axis of 3D size), clamped at 0. example: Jingyu falls
    splashes (`shuihua` in `P_fxmap_common_splashes_middle_2501`) hang against 2–6× gravity.
  - `dampen > 0`: when combined speed `s > L` (`magnitude` at particle age; two constants pick per
    particle), sets `s = s + (L − s) · (1 − (1 − dampen)^(30·dt))` (30 fps normalized), then applies
    drag. because excess comes out of particle velocity alone, a particle driven only by Velocity
    over Lifetime builds an opposing own velocity and settles at `L`. examples: challenge start
    point rock cards (`stone` in `int_challenge_start_point_once_postmodel`: pushed 0.2–1 m/s,
    limited 0.1–1 m/s, dampen 0.1); Marker Stone Interiors rift monster smoke (`smoke_loop`,
    `smoke_end` in `p_fxmap_map02_lv004_liexi_only_*`). `separateAxis` limits and drag curves are
    untraced.
- **speed modifier**: `VelocityModule.speedModifier` (at normalized age; two constants pick per
  particle) scales final displacement (`combinedVelocity · speedModifier · dt`), affecting start
  speed, gravity, and Velocity over Lifetime alike, after Limit Velocity. example: Valley's
  Aberrants floating stones (`floatstone01` in `p_fxmap_map01_lv001_floatstone_*`) rise at 0.5–1.5
  m/s with modifier ramping 0.39 → 1 over 5–10 s.
- **external forces (`ExternalForcesModule`)**: applies active, enabled `ParticleSystemForceField`s
  selected by `influenceFilter` (`0` = `influenceMask` layers + wind zones, `1` = `influenceList`,
  `2` = both) when multiplier scalar > 0. runs after gravity and before Velocity over Lifetime,
  noise, and Limit Velocity.
  - **sphere fields**: distance measured in field's scaled local frame (e.g. squashed y reaches less
    vertically); inactive outside `m_StartRange`–`m_EndRange`; curves read at normalized distance
    (two constants pick one value per particle across all fields; multiplier `m` read at particle
    age). applied in order:
    1. direction: `+= direction · m · dt` along field axes
    2. gravity: `+= −n · gravity · m · dt · 30` (`n` = centre→particle, reversed within
       `m_GravityFocus`)
    3. swirl (when speed and attraction scalars ≠ 0): lerps `v` toward `t · speed` by
       `attraction · m · dt · 30` (`t` = unit tangent around field `+y`, tilted per particle up to
       `±180° · m_RotationRandomness` about x then z)
    4. drag: reduces speed by `drag · m · dt` (× `π · (size / 2)²` and `s²` per flags), min 0
  - `× 30` normalizes pulls to 30 fps. example: Jingyu fish school field (3–15 m, y scale 0.2, swirl
    ±4 m/s @ 2–5% per 1/30 s, gravity 3–7.5 m/s², `s²` drag); large fish field has 0 swirl
    attraction. hemisphere, cylinder, box, vector fields, and wind zones are untraced.
- **rotation over lifetime (`RotationModule`)**: `curve` (about `z`, plus `x`/`y` with
  `separateAxes`) gives angular velocity at normalized age. example: accelerate mushroom wind sheets
  (`wind01`/`wind02`) start up to ±60°/s between two curves and slow to 0.

### size and pose

- **scaling (`scalingMode`)**:
  - `Hierarchy`: emitter uses full Transform world matrix (axes shear under non-uniform parent
    scale); particles size by lossy scale (world-rotation axes projected onto matrix, not sheared
    lengths). example: Jingyu big waterwheel (`int_big_wheel_postmodel`, near −630, 246, −1251)
    scoops carry `P_fxint_s_bambootube_waterfall_2501_variant` under `0.1 × 1 × 1` scale + 90° y
    rotation → Hierarchy splashes (`water001 (3)`, `(6)`) become 0.13 × 1.2 thin streaks along axle.
  - `Local`: emitter uses world pos/rotation × system local scale; particles size by local scale.
  - `Shape`: emitter uses unscaled world pos/rotation; shape scales by lossy scale; particles keep
    start size (e.g. Jingyu bird flock `p_fxmap_map_bird_03` under 363 × 150 × 148 m parent).
- **pivot (`m_Pivot`)**: offsets particle in its rotated frame by `pivot · size`. in mesh mode, also
  scales by mesh bounds size `2 · (|centre| + extent)` per axis (e.g. Dijiang robot lamps
  `P_fxmap_common_robot_lamp_802` offset 0.1 m eye planes by ±0.95 → 7 cm under 30× parent).
- **meshes**: up to four (`m_Mesh`..`m_Mesh3`), uniform or weighted by `m_MeshWeighting*` when
  `m_MeshDistribution = 1`.
- **render alignment (`m_RenderAlignment`)**: `0` View, `1` World, `2` Local, `3` Facing, `4`
  Velocity (`+z` along motion).
  - for meshes in Velocity mode: velocity transforms to world through the full emitter matrix; look
    rotation has `F = normalize(vel)`, `R = normalize(F.z, 0, −F.x)` (`+x` if vertical), `U = R × F`
    (still particles face `+z`). transform order: pivot offset → particle size → particle rotation →
    emitter scale (lossy/local/none) along rotation axes → look rotation.
  - examples: accelerate mushroom arrows (`dajiantou02`/`03`, flat `+z` meshes lifted vertically and
    spun); Jingyu fish (`p_fxmap_map02_lv001_fish_2101`, modelled along `y`, rotated −90° about `x`
    to swim level).
- **stretched quads** (`m_FreeformStretching` off vs on):
  - legacy (`m_FreeformStretching` off):
    - length along `−vel`: `size.y · m_LengthScale · emitterScale.x + speed · m_VelocityScale`,
      using `vel − cameraWorldVel · m_CameraVelocityScale`.
    - width `size.x` along `vel × (particle − camera)` flattened onto the view plane (particle
      rotation and `m_RotateWithStretchDirection` unused; zero velocity or velocity along view ray
      draws nothing).
    - pivot shifts head forward by `pivot.y · size.y` (no length scale) and sideways by
      `pivot.x · width / 2` (`pivot.z` unused).
  - freeform (`m_FreeformStretching` on, e.g. Jingyu waterfall mist `shuiwu` in
    `P_fxmap_common_splashes_middle_2501`):
    - builds a centred camera-facing billboard `(bx, by, bz)` at the particle
      (`bz = normalize(P − eye)`, `bx = normalize(camUp × bz)`, `by = bz × bx`), rotated in-plane by
      particle Z rotation (plus `acos(dot(by, vp)) · sign(dot(bx, vp)) + π/2` when
      `m_RotateWithStretchDirection` is set, where `vp` is velocity projected onto the billboard
      plane).
    - stretches each centred corner and pivot offset linearly along unit velocity `v̂` by
      `S(p) = p + (factor − 1) · dot(p, v̂) · v̂`, where
      `factor = |m_VelocityScale · |v| / size.y + m_LengthScale|`. still particles stay drawn as
      unstretched centred billboards.
  - corner normals lean from face normal (toward camera) out along edges by
    `cos(m_NormalDirection · 90°)` (`1` = flat face normal). example: Suiming drifting fog (`smoke`
    in `p_fxmap_map02_lv007_windice01`, 10–13 m streaks at 5–15 m/s, steep Fresnel).
- **on-screen size**: all quad modes clamp the larger side between `m_MinParticleSize` and
  `m_MaxParticleSize` × viewport width at particle depth (`2 · tan(fov/2) · aspect · depth`, or
  `2 · orthoSize · aspect`), scaling x and y together. behind the camera, negative min hides the
  particle only if `m_MinParticleSize > 0`; negative max is ignored. stretched quads compute length
  before clamping (so clamping only narrows them). dead particles (`age ≥ lifetime`) get size 0.

### texture sheets and custom data

- **texture sheet (`UVModule`)**: grid mode plays full sheet or one row (fixed, random, or by mesh),
  timed by `frameOverTime` + `cycles` or `fps`, offset by `startFrame`, on `uvChannelMask`.
- **custom data (`CustomDataModule`)**: vector mode (`mode0 = 1`) evaluates `vectorComponentCount0`
  (≤4, rest 0) `MinMaxCurve`s per step at `min(age / lifetime, < 1)`. random-between-two values are
  fixed per particle from its seed (salted per component). with `m_UseCustomVertexStreams`,
  `m_VertexStreams` beyond position/normal/tangent/colour pack sequentially into 4-wide UV sets
  (uniform across quad corners): streams `[0, 1, 3, 4, 5, 34]` pack `UV + UV2` in set 0 and
  `Custom1XYZW` in set 1 ([particle custom data](effects.md#particle-custom-data)).

### trails

`TrailModule` renders behind/between particles with `m_Materials[1]` (per Unity docs; engine trail
code unread):

- **Particles mode (`mode = 0`)**: strip behind each particle (`ratio` = probability). each point
  lasts `lifetime · particleLifetime` (× size with `sizeAffectsLifetime`); `dieWithParticles`
  removes trails on death. width = `widthOverTrail` (head 0 → tail 1, × size with
  `sizeAffectsWidth`); tinted by `colorOverTrail`, `colorOverLifetime`, and `inheritParticleColor`.
  texture mode 0 (Stretch) maps once over trail length.
  - example: Valley's Aberrants purification devices (`trail` in
    `int_purification_device_postmodel`, dung01_wrdg001 ~2, 355, 208): trail-only particles leaving
    a 0.25 m sphere at 0.05–0.1 m/s, orbital velocity about `z`, trail lifetime 0.35–0.5 of 2–3 s,
    width 0.037–0.05 m head → 0.017–0.023 m tail.
- **Ribbon mode (`mode = 1`)**: connects particles to each other (e.g. map02 water pours in
  `int_big_wheel_postmodel`, `int_fake_waterfall_postmodel`, `int_waterpipe_postmodel`).

### examples

- Wuling City pillar-array threads (`p_fxmap_lv002_fangyuzhenlie_*`): single ring-buffered
  particles, no texture sheet.
- Origin Lodespring crater floating rocks (`Rock02` in `P_fxmap_common_brokentree_01/02`): four rock
  meshes per system.
- campfire flames (`fire01`/`fire02` in `P_fxmap_common_damagefire_small_2501`): single
  ring-buffered particle playing an 8×8 flipbook per loop.
- waterfall spray and stretched mist cards: `shuihua` and `shuiwu`.

## spline movers

Beyond's `HGSplineMovingObjects` MonoBehaviour (identified by `desc`, `knotData`, `fixedPostion`)
emits whole prefabs along a spline in native code. example: Dijiang central shaft cargo crates (ten
movers in `p_fxmap_base01_lv001_zmdlogistics_02_01` and `_01_01`, base01_lv001). `desc` holds
managed Unity `MinMaxCurve`s (`m_Mode`, `m_ConstantMin/Max`, `m_CurveMultiplier`, `m_CurveMin/Max`):

- **emission**: `emissionRateOverTime` objects/s in mover time (`dt · simulateSpeed`, using logic
  clock if `useLogicDeltaTime`). mid-frame spawns pre-age by the remainder. each picks a random
  entry from `lodGroups` and draws its renderers together.
- **placement**: distance `d` along end-to-end cubic Bézier segments (`knotData` `p0`–`p3`, each
  spanning its stored `length`). segment parameter `t = segmentDist / length` (control-point spacing
  sets easing, e.g. shaft straight segments with handles at ends ease in/out).
  `d += velocityOverLifeTime(age/life) · dt`; removed past the last segment. `emissionType = 0` adds
  a random offset within `aabb` to every spline point.
- **lifetime**: `clamp(startLifeTime, 0, 1) · span` (fraction of trip: shaft descending crates at 5
  ride all 60 m; rising ones at 0.6–0.75 stop partway). `unverified:` `span = length / speed`.
- **scale & rotation**: uniform `startSize · sizeOverLifeTime`; Euler degrees `startRotationX/Y/Z`
  in Unity order (`z` only without `has3dStartRotation`), plus noise offset (`hasNoise`). with
  `hasRotation`, adds `rotationOverLifeTime` (z) and, with `has3dRotation`,
  `rotationX/YOverLifeTime` (deg/s in mover time) evaluated with the same per-object random value as
  size and speed. matrix is `objectToWorld` from transform. example: Sword Vault Dale floating
  stones (`p_fxmap_map02_lv006_*stone_01`) tumble ≤10°/s per axis; shaft crates neither spin nor
  wander.
- **fade (`hasAlphaControl`)**: evaluates `alphaOverLifeTime` at normalized age (same random value);
  while `< transparentAlpha`, flags the object for renderer fade at that value (renderer behaviour
  untraced). `unverified:` curves appear to encode fade-out amount (0 = fully visible): Qingbo
  bucket chain (`p_fxmap_lv003_bucke_2101`/`2102`, `transparentAlpha = 1`) runs 1 → 0 over first 7%
  and 0 → 1 over last 5%; Sword Vault Dale stones (`transparentAlpha = 1`) run 1 → 0 over first
  2–5%; shaft movers set `transparentAlpha = 0` (never fade).

## open

- [particle systems](#particle-systems): exact per-frame rate-curve integration, donut shape,
  `separateAxis` speed limits, drag curves, non-sphere force fields, and Unity trail generation
  (`minVertexDistance`)
- [spline movers](#spline-movers): lifetime span formula (`length / speed`, unverified) and how the
  renderer applies `alphaOverLifeTime` fade (untraced)
