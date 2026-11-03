# interaction authoring

interactive templates carry a `TriggerObserverComponentData` property list. the trigger's
`shape`, `radius`, `center` and `size` are separate from directional-check parameters
`interactive_direction_check`, `check_area_offset`, `check_area_radius`,
`check_area_height`, `check_angle`, `check_angle_offset` and `player_direction_check`.
these inputs must retain the entity's transform and their source template identity.

## checked template inputs

the following base-template values match both AKEData's authored JSON and a current-install
template decode. paths are `Json/Interactive/InteractiveData/data_<template>.json` in AKEData,
and `Data/Json/Interactive/InteractiveData/data_<template>.json` in the install. radii and offsets
are in metres, angles are authored degree values. displayed decimals below are rounded from
single-precision values. all checked templates have shape code 2 and player-direction check disabled.

| template | trigger radius | trigger center y | interactive direction check | check radius / height | check angle |
| --- | ---: | ---: | --- | --- | ---: |
| `int_collection_common` | 1.5 | 0 | disabled | 10 / 5 | 360 |
| `int_collection_piece` | 1.43 | 0 | disabled | 10 / 5 | 360 |
| `int_collection_coin` | 1.59 | 0.75 | disabled | 10 / 5 | 360 |
| `int_collection_trstar` | 2 | 0 | enabled | 2 / 2 | 360 |
| `int_system_world_energy_point` | 1 | 0 | disabled | 10 / 5 | 360 |
| `int_trchest_common` | 3 | 0 | enabled | 3 / 3 | 180 |
| `int_trchest_wrdg` | 1.5 | 0 | disabled | 1.5 / 1.5 | 180 |
| `int_trchest_bubble` | 1.59 | 0.75 | disabled | 10 / 5 | 360 |
| `int_rope_port` | 2.2 | 0.7 | disabled | 10 / 5 | 360 |
| `int_campfire_v2` | 2.5 | 0 | disabled | 10 / 5 | 360 |
| `int_jumpmachine` | 1 | 0 | disabled | 10 / 5 | 360 |
| `int_jumpmachine_vertical` | 0.9 | 0 | disabled | 10 / 5 | 360 |
| `int_accelerate_buff` | 1.6 | 0.75 | disabled | 10 / 5 | 360 |

all listed trigger-center x/z, check-area offsets and check-angle offsets are zero.
when interactive-direction checking is disabled, its authored check radius/height/angle
remain recorded independently and must not be substituted for the trigger volume.

the checked equip, supplybox and lock chest bases share the common chest's radius and
direction gate. the wrdg and bubble bases carry their own values shown above. box
triggers also occur, including mission_beacon with size (3, 3, 3) and lifter_v2 with
size approximately (1.43, 2, 1.88). a stored radius field on those boxes is kept separate
from the effective box dimensions.

## placed authoring

placed values can differ from the table above. in the checked install, a common-collection
placement supplies a trigger-component radius of 0.5 instead of the base template's 1.5;
a chest placement supplies radius 2 instead of base radius 3. the route regression's
world-energy-point placement supplies radius 2 instead of its base radius 1.

placed rules retain the base properties and every selected override scope. direct component
values resolve in base, selected variant, placement order. a selected variant replaces matching
base keys, while placement component properties overwrite or add keys. parameters whose
types cannot be decoded and referenced/global expressions remain unresolved. later scripts,
saved state and gameplay availability require their own state snapshot.

## normal-channel goal model

the supported navigation model uses separate normal-channel runtime probe constants. it represents
the interaction probe at 0.4 m above
the player root with a 0.5 m probe radius. that probe is independent of the player's physical
navigation capsule. a sphere trigger retains its local center and expands by the probe radius
after the trigger radius is multiplied by the largest positive entity scale. a foot-coordinate
goal therefore uses the transformed sphere center shifted down by 0.4 m.

when directional checking is enabled, its unscaled center and dimensions remain an independent
constraint. the model intersects the primary sphere with the direction-check radius plus 0.5 m
and its absolute vertical-difference limit. an authored 180-degree full angle supplies a
90-degree horizontal half-angle, rotated by entity yaw and the authored angle offset. a
360-degree check retains its distance/height constraints without a facing sector.

the current goal representation supports coincident primary/direction centers, upright rotations,
positive scales and horizontal full angles up to 180 degrees or exactly 360 degrees. other shapes,
separate centers, player-facing requirements and incompatible expressions remain unresolved.
NPC interaction inputs and the various plant/resource families still require their own templates
and instance properties. hint/outline distances from `InteractiveHintConfig` remain presentation
inputs. line-of-sight checks, active interaction state and unlock conditions are evaluated separately
before claiming that an endpoint can perform the interaction.
