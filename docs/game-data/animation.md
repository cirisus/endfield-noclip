# animation

how scenery moves: AnimationClip bindings and curves, prefab Animators, and clock-driven ECS
spinning scenery. which clip an interactive's view state rests in is in
[interactives.md](interactives.md#interactive-view-states).

## animation clips

### bindings

a generic muscle clip stores every animated value's start and stop in `m_ValueArrayDelta`, ordered
by `m_ClipBindingConstant.genericBindings`:

| binding kind   | attribute / class         | scalars |
| -------------- | ------------------------- | ------- |
| position       | attribute 1               | 3       |
| rotation       | attribute 2               | 4       |
| scale          | attribute 3               | 3       |
| Euler rotation | attribute 4               | 3       |
| other float    | any other float attribute | 1       |
| PPtr curve     | object reference          | 0       |

`path` is the CRC32 of the `/`-joined GameObject path below the Animator (`Root/Bone001`; 0 for the
Animator's own GameObject). a clip loops when `m_MuscleClip.m_LoopTime` is set.

- **Euler rotations**: degrees, applied in the Unity `RotationOrder` given by `customType`: 0 XYZ (x
  first, then y, then z), 1 XZY, 2 YZX, 3 YXZ, 4 ZXY (`Quaternion.Euler`), 5 ZYX. only 0 and 4 have
  been seen. the locked chest (`int_trchest_lock_postmodel`) uses XYZ for all Euler bindings;
  reading them as ZXY turns a third of its bones wrong and sinks the chest into the floor.
- **activity**: GameObject binding (class 1) with attribute CRC32(`m_IsActive`) toggles the
  GameObject on (1) or off (0). effect clips switch whole groups this way; untouched nodes in the
  subtree keep their saved activity.
- **material properties**: `customType` 22 on a renderer (mesh renderer class 23, skinned 137,
  particle system renderer 199). the attribute's low 28 bits match the low 28 bits of the property
  name's CRC32; the top 4 bits select a vector component x–w (0–3), colour r–a (4–7), or float (8).
  talosite clips set `_TintColorAlpha` and `_BlendTint`; campfire effect clips use kinds 0–3 (read
  as x–w; unconfirmed against a saved material property).
- **other renderer properties**: `customType` 0, identified by the CRC32 of the property path (e.g.
  particle pivot `m_Pivot.x`).

### curves

`m_MuscleClip.m_Clip.data` stores curve scalars in binding order: streamed block, then dense block,
then constant block.

- **streamed**: standard Unity frames (time, key count, per-key curve index and cubic coefficients),
  evaluated from each key's time to the next, bracketed by frames at `−FLT_MAX` and `+∞`.
- **dense**: `m_SampleArray` is empty and `m_ACLType` is 16. `m_ACLArray` stores one u16 per frame
  and curve (frame-major), decoding to `(u16 − 32767.5) / 32767.5 · factor`, where `factor` is
  `m_PositionFactor`, `m_ScaleFactor`, `m_EulerFactor`, `m_FloatFactor`, or 1 for quaternion
  rotations. on the balloon's clips, start and stop samples match `m_ValueArrayDelta` within one
  16-bit step.
- **ACL**: streamed and dense blocks are empty (`m_DenseClip.m_ACLType` 0); curves live in
  `m_AclCompressedBuffer` ([below](#acl-compressed-clips)).

### ACL-compressed clips

`m_AclCompressedBuffer` holds up to three stock
[Animation Compression Library](https://github.com/nfrechette/acl) 2.1 `compressed_tracks` buffers
(tag `0xac11ac11`, version 10, repeated in `Header.Version`, hash verified):

- `TransformBufferData`: Transform curves
- `FloatBufferData`: other float curves (e.g. the spinning cube's Animator parameters)
- `RootMotionBufferData`: root motion

buffers drop rotation `w` (`quatf_drop_w_variable`), quantize translations (`vector3f_variable`),
and strip keyframes interpolated at playback. for example, Wuling City's spinning cube decodes as 15
transform tracks (`qvvf`), 21 and 14 float tracks, and 1600 wrapping samples at 30 Hz (53.3 s, last
sample interpolating into the first).

track-to-binding mapping:

- `TransformSubTrackMasks` holds three bitsets (position, rotation, scale), each
  `⌈OutputTrackCount / 8⌉` bytes, MSB-first for track 0, padded to 4 bytes. the `k`-th binding of a
  kind (in `genericBindings` order) maps to the `k`-th track with that bit set (a rotation-only
  Transform has its position bit clear).
- bindings listed in `m_ConstantIndexs` read `m_ConstantValues` instead (in listing order: 3 or 4
  values per Transform binding, 1 per float). ACL tracks can disagree with these constants (e.g.
  `A_actor_car_e2m5_1_007` and kin store a different position in the ACL track than the clip's start
  and stop).

across the first few thousand ACL clips in bundle order (~10% of the install's AnimationClips),
decoded start and stop values match `m_ValueArrayDelta` within `1e-2` (most much closer), except a
few dozen wrapping run/sprint loops within `0.06` at their stop where wrapping replaces the last
frame with the first. none had Euler bindings. what `RootMotionBufferData`, `RootPosIndex`,
`RootRotIndex`, and `RootTrackCount` add isn't traced.

## scenery animators

prefabs without view states can carry an Animator with an AnimatorController. on load:

- each layer starts in `m_DefaultState` (base layer at weight 1 regardless of `m_DefaultWeight`;
  later layers at `m_DefaultWeight`).
- the layer takes the first transition whose conditions all hold
  (`m_AnyStateTransitionConstantArray` checked before state transitions) until none holds.
- conditions test parameters by id = CRC32(name) using `m_ConditionMode` (1 if, 2 if not, 3 greater,
  4 less, 6 equals, 7 not equal) against `m_EventThreshold`.
- saved parameter defaults live in `m_DefaultValues` (`m_Values`: 1 float, 3 int, 4 bool, 9 trigger)
  at `m_Index`. triggers are unset at rest; unconditional transitions wait for exit time.
- a single-node blend tree plays `m_AnimationClips[m_ClipID]` at `m_Speed`; non-looping clips hold
  their end pose. interactive templates can override parameters on load
  ([template animator parameters](interactives.md#template-animator-parameters)).

examples:

- **Wuling City's spinning cube** (`p_anm_map02_machine+1_002_01`, −1442, 330, −336 in map02_lv002,
  placed by mission `e6m1`): `AC_anm_map02_machine+1_002_01` has one state (`idle_loop`) looping the
  53.3 s [ACL-compressed](#acl-compressed-clips) clip `A_anm_map02_machine+1_002_01` (1600 samples
  at 30 Hz) across 15 Transforms of a skinned mesh, four of which turn a full circle.
- **Qingbo Stockade's octagonal waterwheels** (`p_igroup_map02_sfwaterwheel+2_004_01`, two in
  map02_lv003 at −530.4, 246.9, −1074.6 and −551.8, 247.5, −1103.8, gated by script group
  `23300000004`): `AC_imod_map02_sfwaterwheel+2_004_01` has one state (`on_idle`) looping the 25 s
  60 fps streamed clip `A_imod_map02_sfwaterwheel+2_004_01_openidle_01`. three ZXY Euler bindings
  turn wheel Transforms about z (two 0° → −360°, one 45° → 360°, wrapping seamlessly by 1/8 turn).
  the clip also drives two water-sheet MonoBehaviours, toggles three GameObjects, sets material
  properties, and animates two pour emitters (`bigwater_01`, 26 m out at hub height) under
  `P_fxmap_map02_lv003_sfwaterwheel_01/rotate/rotate2`: `rotate` turns steadily 0° → −360° while
  `rotate2` steps +45° every 3.125 s (riding each scoop from ~30° below hub height to ~15° above,
  matching its 3.125 s [rate over time](particles.md#emission-and-lifetime) loop).

### decoration animators

level scripts drive Animators on [script-group](scene-states.md#script-groups) prefabs via
`SetDecorationAnimatorInt`, `SetDecorationAnimatorBool` (`animatorParamName`, `targetValue`), and
`PlayDecorationAnimation` (`animationName`), targeting `targetDynamicEntity` (`groupName`,
`sceneName`). before a script sets a parameter, the controller rests on its saved defaults.

Origin Lodespring's two luffing cranes (map01_lv006) work this way:

- group `3500030000` places `p_igroup_gtmachine+1_001_01` at the origin with a world-space hierarchy
  (skinned jib on `Bone_Prop_Crane_*` over mast at 646.2, 49.3, 412.0; container on `Bone_box_001`).
- `AC_interactive_gtmachine+1_001_01_004` has int `state` saved as 0 (`empty`, no clip): the saved
  pose leaves the jib raised, hook at 628.2, 45.1, 406.1, and container floating 7 m below and 4.5 m
  aside. `state` 1–4 select `close_idle`, `close_idle_2`, `open_idle`, and `open_idle_2`.
- level script `3500030021` (240 m start shape around 535.5, 38.6, 428.7) sets `state` on
  activation: 3 if saved `state_1` holds else 1, and for crane 2 (group `3500030001`,
  `p_igroup_gtmachine+1_001_02`, near 420, 85, 350) 4 if `state_2` holds else 2.
- `open_idle` swings the jib over the gap with the container under the hook; `close_idle` pulls it
  in at 641.4, 46.3, 390.7. mission e2m7 custom events (`action_e2m7_1`, `action_e2m7_2`) play
  `open`/`open_2` and call the server (inferred that the server saves `state_1`/`state_2`; no client
  data sets them).

## spinning scenery

two sets of ECS scenery spin from the gameplay clock without clips:

**Qingbo Stockade's other waterwheels (map02_lv003)**: ECS renderers carry InitChunkData column 54
([layout](world.md#initchunkdata-layout)), and a model row places a hub collider prefab with
`DynamicSceneSimpleRotate` (`TickableMono`, `angleSpeed` in deg/s). on enable and every tick, that
script sets world `Transform.rotation = Euler(0, 0, TimeManager.gameplayTime · angleSpeed)`,
overriding the row's rotation with an absolute phase. column 54 stores `|angleSpeed|` in rad/s about
±z (axis carries the sign) through the hub:

| wheel                                             | hub                                                                    | collider prefab `angleSpeed`                            | column 54               |
| ------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------- | ----------------------- |
| `sfwaterwheel+1_002`, three (owner `23300000004`) | −278.5, 292.9, −1403.6; −233.4, 303.6, −1426.2; −237.2, 300.3, −1359.3 | −3 (`…sfwaterwheel_collider_effect+1_002_01_postmodel`) | 0.0524 about (0, 0, −1) |
| large wheel above them (`sfwaterwheel+1_001`)     | −233.8, 438.9, −1408.0                                                 | 2 (`p_igroup_map02_sfwaterwheel+1_001_01_col`)          | 0.0349 about (0, 0, 1)  |

no other scene has column 54. the native system isn't read; rotating `speed · gameplayTime` about
the axis through the pivot from the stored pose is inferred from the collider script. the small
wheels load with script group `23300000004` (default on,
[script groups](scene-states.md#script-groups)).

**originium hub frames** (`zmdhubframe+1_001`: four in base01_lv001 around −68, 15, −105 and −64,
40, −164; three in dung01_rdg003): prefab root carries native `HGTransformAnimatedBehaviour`
(`eulerAngleSpeed` `(0, 3.5, 0)` deg/s, no translation, anchor at origin, absolute time). baked ECS
entities store column 52: `0.0611` rad/s (3.5°/s) about local +y, which entity matrices orient
horizontally along the frame. no other entity has column 52. turning `speed · t` about the local
axis through the entity's origin from the stored pose is inferred from the profile, not read from
the native system.

## open

- [ACL-compressed clips](#acl-compressed-clips): what `RootMotionBufferData`, `RootPosIndex`,
  `RootRotIndex`, and `RootTrackCount` add
- [spinning scenery](#spinning-scenery): the native systems behind columns 52 and 54 (their
  absolute-time spin formulas are inferred from the data and collider scripts)
