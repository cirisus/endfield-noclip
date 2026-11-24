# architecture

endfield-noclip has four workspace packages under `packages/`. the extractor reads a local Endfield
install using `formats` and writes a package in the layout `package-format` defines. the viewer
streams that package in the browser and renders it with WebGPU.

| page                                                           | covers                                                                      |
| -------------------------------------------------------------- | --------------------------------------------------------------------------- |
| [extraction.md](extraction.md)                                 | extractor CLI, keys, container layers, decoders, `pack` pipeline            |
| [package-format.md](package-format.md)                         | package layout, tables, binary encodings                                    |
| [viewer/index.md](viewer/index.md)                             | viewer loading, streaming, frame loop, rendering                            |
| [driving-the-viewer.md](driving-the-viewer.md)                 | opening, posing, inspecting, and profiling the viewer from an agent         |
| [status.md](status.md)                                         | index of known gaps                                                         |
| [game-data/containers.md](game-data/containers.md)             | VFS, HG bundles, USPC string pools, SparkBuffer tables, MemoryPack          |
| [game-data/world.md](game-data/world.md)                       | scenes, maps, levels, chunk files, stream areas, LOD, HLOD                  |
| [game-data/terrain.md](game-data/terrain.md)                   | terrain tiles, heights and holes, close-up layers, puddles                  |
| [game-data/assets.md](game-data/assets.md)                     | Unity objects, asset resolution, asset classes, prefabs, dynamic structures |
| [game-data/interactives.md](game-data/interactives.md)         | interactive placements, spawning, templates and models, view states         |
| [game-data/animation.md](game-data/animation.md)               | clips and curves, ACL, scenery Animators, spinning scenery                  |
| [game-data/scene-states.md](game-data/scene-states.md)         | scene states, load gates, progressions, facility forms, script groups       |
| [game-data/environment.md](game-data/environment.md)           | environment phases and volumes, blending, weather                           |
| [game-data/lighting.md](game-data/lighting.md)                 | sun, shadows, ambient, reflections, local lights                            |
| [game-data/irradiance.md](game-data/irradiance.md)             | baked irradiance volume                                                     |
| [game-data/materials.md](game-data/materials.md)               | HGRP surface shaders                                                        |
| [game-data/effects.md](game-data/effects.md)                   | `HGRP/Effect/*` scenery effects, one-shot effects, effect LOD tables        |
| [game-data/particles.md](game-data/particles.md)               | particle systems and spline movers                                          |
| [game-data/sky-and-fog.md](game-data/sky-and-fog.md)           | atmosphere, clouds, celestial layers, fogs                                  |
| [game-data/post-processing.md](game-data/post-processing.md)   | pass order, exposure, light shafts, lens flare, bloom, GTAO, colour grading |
| [game-data/water.md](game-data/water.md)                       | open-world water, water volumes, foam boxes                                 |
| [game-data/quality-settings.md](game-data/quality-settings.md) | quality presets, tiers, per-level render settings                           |

`game-data/` documents only the game itself (formats, shader behavior, in-game display), with
unchecked facts marked. our implementation lives in [viewer](viewer/index.md),
[extraction.md](extraction.md) (and its subpages), and [package-format.md](package-format.md); gaps
live in [status.md](status.md). links point toward `game-data/`, never back.

## data flow

```
install (Endfield_Data)                      local, read-only
  │  VFS catalogs + chunks → HG bundles → Unity SerializedFiles, world data, tables
  ▼
extractor (node, offline)                    pnpm extract pack <scene>
  │  decode with formats, convert meshes/textures, build tables and the tile tree
  ▼
package on disk (out/<scene>/)               core.czar + shards/ + assets/ + irradiance/
  │  served by the dev server, or opened from a local directory
  ▼
viewer (browser, WebGPU)                     range-reads blobs, streams around the camera
```

the viewer never touches the game install. the extractor precomputes GPU-ready data (meshopt
geometry, raw BC texel blocks, binary instance blocks), so the runtime does no game-format parsing.

## packages

| package          | owns                                                                                                                                     |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `formats`        | on-disk decoders for binary primitives, Hypergryph containers/tables, IL2CPP metadata, Unity serialization/asset classes, and world data |
| `extractor`      | CLI, local config/keys, VFS/bundle I/O, cross-bundle asset resolution, game-data interpretation, packer, and glTF/PNG debug exports      |
| `package-format` | package contract: manifest and table types, enums, path constants, binary codecs for hot data, and scene-control condition evaluation    |
| `viewer`         | package sources (HTTP, File System Access, OPFS), decode workers, streaming and tile selection, WebGPU rendering, and React UI           |

dependencies are one-way: `extractor → formats`, `extractor → package-format`,
`viewer → package-format`. the viewer never imports `formats`, and `package-format` imports neither.

### boundaries

- **`formats` is environment-agnostic.** it accepts bytes or a `ByteSource` and returns plain
  values, with no `node:` APIs outside tests. file I/O, handle caching, and install layout live in
  `extractor`.
- **`formats` decodes; `extractor` interprets.** a `formats` module parses one layout (catalog,
  bundle, TypeTree, chunk file). record selection, level/scene-state rules, and package mapping live
  in `extractor`.
- **`package-format` is the only shared contract.** incompatible changes bump the package or
  encoding version so stale packages fail at load instead of misrendering. it stays free of node and
  browser APIs.
- **failures are explicit.** decoders throw `FormatError` on unrecognized layouts instead of
  guessing. the packer records unsupported or failed inputs in debug outputs rather than
  substituting stand-in assets; a wrong mesh or texture is harder to spot than a missing one.

## decisions

- **offline local extraction.** a TypeScript extractor on node reads the install directly, with no
  .NET or Python step. packing a region takes minutes and gigabytes of output, so the viewer stays a
  static app over prebuilt files. in-browser install parsing is deferred, which is why `formats`
  stays environment-agnostic.
- **one package per streaming scene, all levels shown together.** a package holds one scene (one
  world and coordinate frame, e.g. `map02`) and all of its own map's levels, matching seamless
  streaming on map01 and map02. each instance carries its owning level as metadata: the current
  level (from the `level` URL param, then whichever level the camera enters) picks the base
  environment, prioritizes streaming right after near-camera tiles, and orders scene controls.
  levels don't overlap; overlapping content (Snowy Forest's snow peaks over Test Area on map02)
  lives in stream areas switched by camera. excluding other maps' levels prevents collisions when a
  level streams another scene (`dung02_gdg001` on map02, `dung02_rdg012` on `dung02_rdg008`).
- **czar archives with content-addressed assets.** a package is a small always-resident `core.czar`
  plus shard and asset archives ([package-format.md](package-format.md)). czar provides CRCs,
  deterministic output, and CLI tooling. the core's blob index lets the viewer range-read any blob
  without parsing archive headers. content-addressed blobs deduplicate shared meshes and textures
  across levels and tiles.
- **custom WebGPU renderer.** three.js's WebGL renderer lacks compute shaders (forcing CPU culling
  and LOD; a prototype spent ~15 ms CPU at a few thousand draws). three.js's WebGPU renderer keeps
  per-object render lists, bind groups, and per-material node shaders, fighting GPU-driven
  rendering. Babylon.js would push HGRP shaders through ShaderMaterial in a heavy runtime while
  still leaving GPU culling and LOD to us. multi-draw-indirect isn't available in Chrome on macOS,
  so the draw loop stays replaceable by one MDI call without depending on it. WebGL2 is out of
  scope.
- **no keys or game content in the repo.** Endfield's ToS bans reverse engineering, and Hypergryph
  has DMCA'd a VFS decryptor on GitHub. `init` derives keys from the user's install into gitignored
  `endfield.local.json`; packages stay in gitignored `out/` or outside the repo; decompiled game
  code stays out of the repo. deployers are responsible for hosted packages.
- **permissive prior art only.** MIT-licensed ports are credited in their implementing modules:
  - [AnimeStudio](https://github.com/Escartem/AnimeStudio) and AssetStudio: bundle descrambling,
    SerializedFile, mesh layout
  - [An1X3R/Endfield-map-extractor](https://github.com/An1X3R/Endfield-map-extractor): chunk
    framing, water
  - [Variante/endfield_research_kit](https://github.com/Variante/endfield_research_kit): bundle
    manifest, StringPathHash, string pools, LevelConfig
  - [SaigyoujiYusora/Sora-Core](https://github.com/SaigyoujiYusora/Sora-Core): 16-bit dense
    animation curves
  - GPL, AGPL, and non-commercial tools are reference only.
