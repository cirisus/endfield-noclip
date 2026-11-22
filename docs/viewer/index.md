# viewer

`packages/viewer` is a React shell around a WebGPU renderer. see
[package-format.md](../package-format.md) for the package contract and
[driving-the-viewer.md](../driving-the-viewer.md) for agent automation and profiling.

entry points:

- [`src/app.tsx`](../../packages/viewer/src/app.tsx) — UI shell and URL state.
- [`src/viewer/viewer.ts`](../../packages/viewer/src/viewer/viewer.ts) — `Viewer` controller (loaded
  package, camera, scene states, options, frame loop). the UI drives it via public methods (`load`,
  `setOptions`, `flyToLevel`, `flyToPoint`, `setSceneValue`, etc.) and reads `stats` via
  `subscribe`.

`src/viewer/` also holds `Renderer` (`renderer.ts`, GPU systems and frame submission), `Traversal`
(`traversal.ts`, per-frame selection and streaming), `openScene` (`scene-loader.ts`, wires an opened
package to renderers), `EnvironmentState` (`environment-state.ts`, environment blending at the
camera), `options.ts`, `stats.ts`, and `sky-textures.ts`.

## layout

| directory                                                   | holds                                                                                                                                                                                           |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/viewer/`                                               | `Viewer` shell, renderer, traversal, scene loading, environment state, options, stats                                                                                                           |
| `src/render/`                                               | GPU code by feature (`frame`, `shadows`, `terrain`, `instances`, `meshes`, `textures`, `lighting`, `sky`, `water`, `post`, `shaders/common`); `render/frame/frame-graph.ts` orders frame passes |
| `src/gfx/`                                                  | device setup and feature-agnostic GPU helpers: pipelines, uniform ring, buffers, samplers, placeholders, profiler                                                                               |
| `src/streaming/`                                            | residency and selection: stream manager, per-kind residency handlers, tile and mesh selection, texture requests                                                                                 |
| `src/scene/`                                                | camera, controls, tile tree, ground height, level poses                                                                                                                                         |
| `src/scene-states/`                                         | scene controls (`SceneState`), panel listing, water levels                                                                                                                                      |
| `src/environment/`                                          | environment profiles: camera blending and derived renderer state                                                                                                                                |
| `src/looks/`, `src/particles/`, `src/content/`, `src/math/` | materials as looks, particle evaluation, instance rows, math                                                                                                                                    |
| `src/package/`                                              | package sources, opening, decode workers                                                                                                                                                        |
| `src/ui/`                                                   | React panels                                                                                                                                                                                    |

module boundaries:

- CPU-only domain directories (`looks`, `particles`, `content`, `math`, `environment`,
  `scene-states`, `scene`) do not import `render/` or `viewer/`, so they run under `node --test`.
- `render/` imports the domain directories, `gfx/`, `scene/`, decoded blob types from `package/`,
  and shared layouts/types from `streaming/` (GPU culler words, first shadow layer of a bounds,
  whole-texture requests).
- `streaming/` imports shadow-layer constants, the texture store, mesh draw ranges/sort bands, and
  geometry pool/skin types from `render/`.
- only `ui/` and `app.tsx` import `viewer/`.

implementation pages (each links to its corresponding [game-data](../architecture.md) findings):

| page                                  | covers                                                                     |
| ------------------------------------- | -------------------------------------------------------------------------- |
| [loading](loading.md)                 | package sources, dev package server, opening, decode workers, URL params   |
| [streaming](streaming.md)             | tile tree, instance and terrain selection, LOD, priority, residency        |
| [frame](frame.md)                     | frame passes and render targets                                            |
| [GPU resources](gpu-resources.md)     | bind groups, pipelines, buffers, textures                                  |
| [performance](performance.md)         | frame optimizations, measured baseline, optimization candidates            |
| [scene states](scene-states.md)       | scene control evaluation and the scene conditions panel                    |
| [environment](environment.md)         | environment volume blending and wetness                                    |
| [lighting](lighting.md)               | units, sun, shadows, ambient, reflections, local lights, irradiance volume |
| [materials](materials.md)             | material-to-look conversion and unsupported materials                      |
| [effects](effects.md)                 | scenery effects in the transparent pass                                    |
| [terrain](terrain.md)                 | terrain layers, puddles, foliage grids                                     |
| [water](water.md)                     | water pass                                                                 |
| [sky and fog](sky-and-fog.md)         | sky, celestial layers, fogs                                                |
| [post-processing](post-processing.md) | post chain, AO, light shafts, lens flare, exposure, bloom, grading         |
| [particles](particles.md)             | billboards and particle evaluation                                         |

known gaps are indexed in [status](../status.md).
