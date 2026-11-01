# OEM integration

the ordinary package/level viewer remains available. OEM adds an opt-in static companion release, an
explicit point launch and a cross-window bridge to the Atlos-owned World app. no game account,
collection record or locator credential is transferred.

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

## World host

Atlos owns the World application, OEM navigation, condition panel, minimap and region overlay.
`@endfield-noclip/viewer/host` exports `ViewerApp`, `Viewer`, `httpSource` and `useViewerState`;
`@endfield-noclip/viewer/style.css` supplies the existing renderer panel styles. pass an `overlay`
render function to `ViewerApp` to receive the initialized viewer and its right-hand panel portal.
the host owns navigation in that mode; package/level URL handling and their panels remain available
in the ordinary standalone app. the host must use the same React instance as the renderer.

World uses a fixed source revision and a separately pinned data catalog. package generation/source
validation and the precomputed pose binding remain required. the host shares the existing package
format conditions and story evaluator rather than implementing another condition engine.

## local verification

`NOCLIP_RELEASES` can override the local release root (default `out/releases`); Vite dev and preview
serve it at `/oem/`. set OEM's `VITE_WORLD_URL` and `VITE_WORLD_CATALOG_URL` to the local
viewer and immutable catalog before starting OEM. World owns its own local development server and
directly composes the OEM map UI.

desktop WebGPU and the existing keyboard/mouse controls are the initial acceptance platform. the
ordinary GPU-start error remains visible in unsupported browsers. no touch-flight or WebGL fallback
is added.

## deployment

World is an independently deployed Pages application owned by Atlos (`apps/world`), with the title
`World - Open Endfield Map`. its frontend is built and deployed separately from the OEM main site.
scene archives and companions remain immutable data releases on R2. this repository's ordinary
viewer remains a development tool; it does not own World domains or frontend deployment.

upload and verify a complete data release before updating World's catalog configuration. frontend
source pins and data release ids are independent: new renderer builds must still validate package
versions, generations and source fingerprints. no build or offline export publishes automatically.

## camera-driven level changes

the host can call `showLevel(id, { fly: false })` to change level visibility while keeping the
free camera and controls. `load(source, level, progress, { preserveCamera: true })` similarly
replaces a package without setting its overview pose. the host owns cross-scene coordinate
registration, route validation and overlap rules. `controls.flying` suppresses automatic routing
during point and overview flights. the ordinary standalone calls retain their existing flight behavior.

`oem-navigation <baked-release> -o <releases> --config <config>` adds `navigation.json` to a new
immutable release, hard-linking the existing model archives and retaining every baked point pose.
it reads `MapRegionTable` from the same game build, exports tier volumes and explicit scene/level
routes plus the source `isSeamless` flag, and binds all package generations. unsupported shapes
fail export; `oem-check` verifies the binding. independent scenes without tier volumes use a conservative verified gameplay-point footprint
expanded by 10 m, rather than their much larger decorative content bounds. outside that footprint
there is no automatic-entry evidence; no floor heights are invented. navigation is optional for older
manual-only releases. rebaking also preserves and rebinds an existing navigation companion.

## hosted panel presentation

`Panel`, `PanelProvider` and `PanelProps` are part of the viewer host interface. scene conditions,
display settings and statistics use separate title, action and body slots. a host can provide its
own panel shell around the same controls; without a provider the standalone viewer uses its existing
panel styling with explicit headings. keep the body mounted when collapsing it, so control filters
and disclosure state survive. renderer bindings, values and scene logic stay in the existing controls.

### adaptive free flight

World can supply `viewer.controls.groundHeight` from its existing low-frequency ground sample. with
a finite elevation, ordinary movement eases from 10 m/s within 5 m of the ground to 50 m/s at 100 m
clearance. `controls.speed` remains the persisted Ctrl+wheel trim (40 is neutral); normal adaptive
speed is capped at 50 m/s after that trim. `null` keeps standalone fixed-speed behavior. the
existing velocity smoothing also eases changes in the sampled ground elevation. this does not change
automatic point/overview flight timing or rendering.

hold Tab or Alt for one-fifth speed, or right mouse for fivefold boost. slow takes priority when
both are held; releasing it restores the other held modifier. Tab is captured only during flight
(pointer lock, drag look, or held movement keys), preserving ordinary UI focus navigation. blur,
pointer cancellation and leaving pointer lock clear the modifiers.
