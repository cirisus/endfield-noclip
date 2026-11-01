# OEM integration

the ordinary package/level viewer remains available. OEM adds an opt-in static companion release, an
explicit point launch, a cross-window bridge and an iframe containing the OEM-owned minimap. no game
account, collection record or locator credential is transferred.

the main OEM detail contains only a link, reusing its existing divider and action styles. the point
prerequisite panel and preset selector live in the preview's right dock, using the viewer's existing
panel, heading and scene-choice styles. both inherit their host application's typography.

## generate a release

use packages and metadata from the same local install. pack all seven complete scenes first:
`map01`, `map02`, `indie_dg005`, `indie_dg007`, `indie_dg016`, `base01_lv001` and `dung01_wrdg001`.
the last two cover Dijiang and Valley's Aberrants; `base01` and `dung01` are logical map ids, not
streaming scenes. then run:

```sh
pnpm extract oem --config endfield.local.json --atlos /path/to/Atlos/talos --packages out --output out/releases
pnpm extract oem-check out/releases/<release-id>
```

the command rejects incompatible package versions, source fingerprints, partial packages, ambiguous
placements and unresolved point ids. NPC proxies resolve their level through NpcProxyTable, not a
coordinate search or identifier prefix. output lives under a content-derived release id; the catalog
is written last. publish only directories holding a complete `index.json`. after an incompatible
package-format change, repack all seven scenes and export a new release before switching the main
site's catalog URL. an older release keeps its original package version; changing its catalog's
version fields cannot upgrade its archives. partitions and their region membership come from OEM's
`src/data/map/region.json`, including DJ_1 and ES_1. point placement still comes from the game's
exact entity id and LevelConfig scene path.

the release contains a catalog, one companion JSON per OEM subregion and the referenced package
archives. it excludes debug output. generated releases and game-derived metadata stay outside git.
rerunning the same release into an occupied destination fails rather than overwriting it.

## companion contract v1

`package-format/oem.ts` defines the JSON contract. the catalog binds a release, game source
fingerprint, scene package generation/version/path, partition files and a point-to-partition index.
each partition contains points, supplemental quest/mission controls, mission ordering and localized
labels with English fallback. points retain authored Unity coordinates, scene and level, OEM
region/subregion/tier, prerequisite alternatives, interaction locks, script-driver evidence,
unknowns and validated presets.

conditions use the existing disjunction-of-conjunctions mask encoding and evaluator. presets use the
existing story-point ordering: they never set an unplaceable quest independently or treat a script
driver as a sufficient collection prerequisite. defaults are preferred when already satisfying;
other valid presets are ordered by number of changed controls, stably in source order. unresolved
runtime locks and spawn scripts remain unknown even after a known quest prerequisite is satisfied.
this is an authored preview, not the state of a logged-in player.

the viewer merges supplemental controls into the package's original controls without changing its
visibility formulas. OEM previews initially set quests and missions to completed and facilities,
Control Nexus and cabin slots to their maximum available levels, keeping derived gates automatic.
manual story presets remain selectable; the panel reports when the selected state does not satisfy
the point's recorded prerequisite. selecting another point restores completed progression and
replaces companion controls; rendering options remain. target markers locate points whose gameplay
model is not represented. authored world positions can differ from manually positioned OEM facility
icons; the preview keeps the authored coordinates rather than moving the scene target to match the
icon.

all default-profile point views can be baked with `oem-views` after exporting a base release
([offline framing](oem-precompute.md)). the new immutable release embeds a generation- and
visibility-bound pose per point; a matching pose avoids framing-only geometry reads on the frontend.
first entry and cross-scene loads immediately use south 10 m / up 6 m while the final pose resolves.
same-scene point changes retain the flight animation and retarget it when the pose becomes
available.

framing tries sixteen headings and several elevations at a minimum horizontal distance of 10 m. it
checks nearby opaque triangles and terrain; small geometry containing the target is not treated as
an occluder, and underground points remain beneath their cave's terrain roof. no-candidate cases
keep the 10 m / 6 m fallback and carry an explicit unconfirmed-view flag. this is best effort:
transparent or alpha-tested surfaces, missing meshes and authored points inside solid geometry do
not provide a visibility guarantee. the target marker remains available.

manual scene values or missing/stale baked bindings use the same local framing kernel. checked local
poses persist up to 512 entries, keyed by framing version, package generation, level, target and
visibility groups. decoded nearby geometry is reused up to 64 MiB per opened package. cancellation
never applies a stale pose. results obtained before required terrain pages arrive are not persisted.

OEM launches hide the package and level panels; standalone noclip retains them. region navigation
uses OEM's shared UIOverlay and region components in a transparent full-viewport frame. its hit
region is clipped to the actual buttons, submenu and tooltip rectangles, so other pixels allow
pointer input through to WebGPU. submenus remain below the minimap and scroll when needed. switching
region/subregion opens an overview, clears point markers and the point panel, and records the region
in the share URL; selecting a main-site point restores the point view. no main-site region is
mutated.

## launch and messages

an OEM link supplies `oem` (catalog URL), `release`, `point`, `origin` (OEM origin) and `session`.
production data must come from `cdn.opendfieldmap.org`; local HTTP development is also allowed.
standalone links work without an opener and default to the `.org` minimap. query input never
supplies arbitrary executable code, minimap hosts or scene transforms.

all messages include `version: 1`, `session`, and `type`. receivers check the exact origin and
source:

| direction            | type                                             | payload                                                                                                                        |
| -------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| viewer → opener      | `ready`                                          | none; sender may now flush its pending command                                                                                 |
| opener → viewer      | `open-point`                                     | `point`                                                                                                                        |
| viewer → opener      | `state`                                          | `point`, `preset`, `unknown`                                                                                                   |
| viewer → opener      | `error`                                          | `point`, `message`                                                                                                             |
| minimap → viewer     | `minimap-ready`                                  | none                                                                                                                           |
| viewer → minimap     | `minimap-target`                                 | selected `point`; begin map loading while its 3D package loads                                                                 |
| viewer → minimap     | `camera`                                         | selected `point`, Unity `position`, `forward`, optional `view: { groundY, fovY, aspect }`, `target: false` for region overview |
| OEM overlay → viewer | `regions-ready`, `open-region`, `overlay-layout` | session-bound region/subregion choice and finite viewport rectangles                                                           |
| viewer → OEM overlay | `region-state`, `region-error`                   | accepted selection or failed navigation                                                                                        |

the minimap fits an approximate perspective footprint using height above local terrain, pitch, lens
FOV and the OEM coordinate transform's local scale, with 1.5× magnification and continuous zoom
clamped to 0–5. absent or above-camera terrain falls back to the target's height (interiors and
terrain holes); near-ground and near-horizon views stay bounded. it remains north-up and centered on
the camera, so it does not reproduce the perspective view's exact footprint. older camera messages
without `view` keep zoom 3; malformed optional view data is rejected. lens changes and viewport
resizes also refresh the map. camera samples are coalesced to one draw per iframe animation frame.
the condition panel is outside the camera render loop; the 3D target updates its position directly.
the minimap cursor has no heading transition delay and stops its initial pulse after movement or
turning. target preparation starts map tiles and artwork before the 3D package is ready, without
displaying a fictitious camera.

scene loads are serialized and only the newest pending target is committed. the viewer checks the
actual loaded package's source, version, generation and level before applying companion state. a
mismatch stops point preview rather than guessing. the iframe is passive: selected-point floor,
north up, camera centered, selected target and the existing locator artwork. camera movement never
commands the main map or invokes the game locator backend. offscreen targets keep their original OEM
icon pinned at the minimap's rectangle edge, with padding for the artwork and sub-icon. the icon
returns to its real map position when it enters the viewport.

## local verification

`NOCLIP_RELEASES` can override the local release root (default `out/releases`); Vite dev and preview
serve it at `/oem/`. set OEM's `VITE_NOCLIP_VIEWER_URL` and `VITE_NOCLIP_CATALOG_URL` to the local
viewer and immutable catalog before starting OEM. its dev server proxies `/minimap/` to the minimap
app on port 5176. production deployments include the minimap in the complete OEM artifact on both
hosts.

desktop WebGPU and the existing keyboard/mouse controls are the initial acceptance platform. the
ordinary GPU-start error remains visible in unsupported browsers. no touch-flight or WebGL fallback
is added.

## deployment

`pnpm build` creates the frontend; `wrangler.toml` describes the independent `oem-noclip` Pages
project. use its default `pages.dev` hostname initially. package archives belong on R2, not Pages.
copy a complete release to the existing bucket's `noclip/releases/<release>/` prefix with rclone's
`--immutable` option. inspect a `--dry-run` first; do not use deletion or `sync` for publication.

`deployment/r2-cors.json` is the required read/range policy, to merge with the bucket's existing
rules rather than replace unrelated consumers. expose Content-Range and validators; verify real
browser range reads, including a request with Origin. `_headers` preserves opener communication. the
minimap route must allow framing by the preview origin; avoid imposing cross-origin isolation that
severs the opener. no SharedArrayBuffer is required.

after uploading, verify archive sizes, source/generation, a range response and each scene; only then
pin OEM's catalog environment variable and deploy its complete `.cn`/`.org` artifacts. keep the
previous release for rollback. building, exporting and local testing never publish or push code.
