# scene states

how the viewer evaluates and presents the conditional content described in
[game-data/scene-states.md](../game-data/scene-states.md). package controls and conditional sets are
in [package-format.md](../package-format.md#conditions).

## evaluation

whenever a pick changes:

1. resolve every control's value.
2. recompute condition visibility for every conditional set (replacing results only when a result
   differs, so environment blending re-plans only on change).
3. map those results to shown visibility groups and notify every consumer: instance selector, local
   lights, water renderer, and irradiance regions.
4. update gameplay water levels from the resolved values.

### camera controls

the camera stands in for the player: unless the user picks a value, the viewer evaluates camera
controls from the eye ([package format](../package-format.md#controls)):

- **`area`**: 1 while the game's trigger test ([stream areas](../game-data/world.md#stream-areas))
  shows the area at the eye. above or below all triggers (where the game falls back to root areas),
  the viewer keeps zones whose footprint the camera is over so overviews still show the level.
- **`near`**: 1 while the eye is within any of its reaches (an interactive's radius).
- **`triggers`**: retains the value set by the last trigger volume the eye entered or left. camera
  path memory resets on package unload; the first evaluation enters every volume containing the eye.

camera controls recompute on camera movement and trigger visibility re-evaluation only when a value
changes. interactives swap between settled looks immediately without transition clips.

## the scene conditions panel

the "Scene conditions" panel lists controls in package category order. rows are checkboxes for
user-only booleans and selects otherwise, with "Follow game" or "Follow camera" for derived and
camera controls:

| category                                    | UI control                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| scene states                                | select per state: "Follow game (on/off)" if derived, else on/off                                                                                                                                                                                                                                                                                |
| quests and missions                         | "Main story progress" select in id order (episode, mission, decimal) setting prior steps complete, current in progress, later not started; per-mission "Progress" and per-quest selects grouped by quest log tab (chapter, episode, location); listed under every gated level ([labels](../game-data/scene-states.md#quest-and-mission-labels)) |
| variables                                   | range select, default marked "(initial)"                                                                                                                                                                                                                                                                                                        |
| progression                                 | select per progression ("Level n", "Visual form n", or "Group level n"; defaults to highest) and per campfire or saved Animator bool (The Hub's comm terminal; activated by default). facility forms use "Visual form" ([facility visual forms](../game-data/scene-states.md#facility-visual-forms))                                            |
| Dijiang                                     | Control Nexus level select, checkbox per cabin slot (built/empty), growth chamber level select                                                                                                                                                                                                                                                  |
| created during play                         | checkbox per level for post-load interactives (`createState` ≠ 0), off by default                                                                                                                                                                                                                                                               |
| limited-time events                         | checkbox per scene for event photo spots ([event placements](../game-data/scene-states.md#event-placements)), off by default                                                                                                                                                                                                                    |
| doors and bridges                           | checkbox per door (open/closed, or "Follow game" for cabin doors) and telescopic bridge (extended/retracted)                                                                                                                                                                                                                                    |
| stream areas                                | select per area: "Follow camera (shown/hidden)", shown, or hidden                                                                                                                                                                                                                                                                               |
| player nearby                               | select per interactive: "Follow camera", away, or near (labelled with settled states)                                                                                                                                                                                                                                                           |
| harvest                                     | standing or felled                                                                                                                                                                                                                                                                                                                              |
| script / event scenery, logic-gate previews | checkboxes, or "Follow game (on/off)" when derived from quest checks; lists drivers ("Shown when the player uses …", "Hidden by quest progress: …") with "Go" fly-to                                                                                                                                                                            |
| water levels                                | select per gameplay water volume's `waterLevel` control over scripted fill levels, listing drivers ([water volumes](water.md#water-volumes))                                                                                                                                                                                                    |
| lighting / environment volumes              | current-level and overlapping volumes first, then remaining under owning level; checkbox per `environmentVolume` control ("(not loaded)" when scene states fail). scripted-blend volumes (blend mode 3) default off ([activation](../game-data/environment.md#activation))                                                                      |

each row displays its [place](../package-format.md#controls) label (with "Go" fly-to), its rule, its
default assumption, and "Drives …" listing downstream derived controls. all sections start
collapsed.

"Show" filters listed controls and volumes:

- **near the camera** (default): controls within 200 m of the camera (distance to box, else
  position), nearest first, updated in 25 m steps; scene-wide controls without a place are omitted.
- **this level**: controls whose `levels` include the [current level](streaming.md#levels), followed
  by collapsed "Other levels" groups (multi-level controls appear in each group).
- **everything** and **picked**: all controls, or only controls with a user pick.

"Reset" clears all picks. the settings panel's "stream areas at camera" toggle switches all
camera-following areas between following and always shown. conditional detail ignores HLOD
refinement and stops streaming below the screen-error threshold ([streaming](streaming.md)).
