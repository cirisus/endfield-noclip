# loading a package

## sources

packages are read through `PackageSource`
([`package/package-source.ts`](../../packages/viewer/src/package/package-source.ts)), supporting
whole-file reads, single byte-range reads, and multi-range reads of one file:

| source            | used for                                                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `httpSource`      | dev/preview server or any static host; issues single or multi-range HTTP requests, tolerating servers that ignore `Range` |
| `directorySource` | folder picked via File System Access API (`showDirectoryPicker`), or a package copied into OPFS                           |
| `fileListSource`  | `<input webkitdirectory>` fallback when `showDirectoryPicker` is unavailable                                              |

multi-range reads in `httpSource`:

- sends `Range: bytes=a-b,c-d,…` and parses `multipart/byteranges` responses in `parseByteRanges` by
  each part's `Content-Range` (tolerating server reordering or merging).
- some hosts return the whole file or a single range instead (e.g. Amazon S3; nginx and Apache
  return multipart; others unsurveyed). on the first non-multipart response, `httpSource` drops the
  body unread and permanently falls back to one request per range.
- cross-origin hosts must allow the `Range` request header in CORS preflight (single-range requests
  skip preflight).

change detection:

- every range read passes the archive size from the manifest. a size mismatch throws
  `PackageChangedError`; the stream manager stops fetching shards, keeps resident content drawn, and
  the stats panel offers a reload.
- this checks size only (same-sized edits go undetected). repacks normally change
  [archive names](../package-format.md#layout), so an open tab usually hits a missing-file error
  when old archives are deleted.

the package panel ([`ui/package-panel.tsx`](../../packages/viewer/src/ui/package-panel.tsx)) exposes
all three sources. where both `showDirectoryPicker` and OPFS exist, "copy into browser storage"
imports the picked folder into OPFS (skipping `debug/`, which the viewer never reads) and reports
copy or reopen failures in the panel.

## dev package server

[`vite-plugins/package-server.ts`](../../packages/viewer/vite-plugins/package-server.ts) serves
extracted packages under `/packages/` in both `vite dev` and `vite preview`. the root defaults to
`out/`; override with `NOCLIP_PACKAGES=/path`
([`vite.config.ts`](../../packages/viewer/vite.config.ts)).

- static files are served via `sirv` with `Range`, `ETag`, `Last-Modified`, and
  `cache-control: no-cache`. production deployments need range support and revalidation for
  `core.czar` (fixed name; other archives have content-derived names).
- multi-range `GET` requests (`bytes=a-b,c-d,…`), which `sirv` does not handle, are answered by the
  plugin itself as `multipart/byteranges` in requested order.
- `GET /packages/index.json` (dev-only) lists non-hidden subdirectories containing a core archive
  and its size, skipping packer staging/replaced directories. `fetchDevPackages`
  ([`package/dev-packages.ts`](../../packages/viewer/src/package/dev-packages.ts)) reads it and
  lists nothing if absent.

## opening

1. `Viewer.load` calls `openViewerPackage`
   ([`package/viewer-package.ts`](../../packages/viewer/src/package/viewer-package.ts)), which reads
   `core.czar`, checks manifest format and version (throwing `PackageError` on mismatch), and
   decodes all core tables (tree, blob table, LOD chains, geometry, material, texture, water, light,
   particle, environment, irradiance).
2. shard JSON headers are never fetched: the blob table gives each blob's offset within its
   archive's data section (whose start is in the manifest), so each blob takes one range read.
3. `load` sets the irradiance volume, then `openScene`
   ([`viewer/scene-loader.ts`](../../packages/viewer/src/viewer/scene-loader.ts)) builds the tile
   tree, texture store, stream manager, and selectors, and pins the coarse layer
   ([residency](streaming.md#residency-and-budgets)).
4. `load` picks the initial level and poses the camera over it.

`MeshSelector` is created only when at least one geometry converted; otherwise instances draw as
boxes. terrain page sizes are `package-format` constants; any other size throws and fails that blob.

## decode workers and zstd

[`package/decode-pool.ts`](../../packages/viewer/src/package/decode-pool.ts) runs 2–4 module workers
(half the hardware threads, clamped) and assigns each job to the least busy worker.

- **queueing.** each worker holds at most 64 jobs; excess jobs wait in the pool so unloading a
  package drops unstarted work. worker results reach the main thread only between frames, so 64
  in-flight jobs per worker prevents worker starvation (a map02 teleport settled in 0.9 s vs 2.4 s
  with 4 per worker).
- **zero-copy transfers.** each job references a range in a `SharedBytes` buffer (a coalesced range
  read, or a core blob copied off the main thread's core bytes). the pool transfers the buffer once
  to the worker taking its first job and routes all later jobs from that buffer to the same worker.
  workers aren't the bottleneck ([decoding](streaming.md#residency-and-budgets)), so this affinity
  costs little. the buffer tracks unposted jobs (the stream manager releases dropped jobs) and is
  freed once zero remain; until then the whole read stays in memory. only uncompressed texture,
  layer, and irradiance blobs that share a read are copied out on the worker to transfer back (a few
  KiB vs tens of MB on the main thread; ~1/3 of blobs share a read during map02 flights).

[`package/decode-worker.ts`](../../packages/viewer/src/package/decode-worker.ts) decompresses blobs
and builds GPU-ready arrays:

| kind                       | worker output                                                                                                                                                                                           |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| heights                    | raw `u16` samples, padded to whole words for storage buffers                                                                                                                                            |
| instances                  | instance rows, per-row cull data, `(chain, first, count)` runs, decal placements, spinning/water-riding rows (`buildInstanceRows`), and mesh-selection bounds (`buildRowBounds`)                        |
| geometry                   | meshopt-decoded vertex streams (quantized positions, `snorm16x2` octahedral normals, UV0, UV1, tangents, `unorm8x4` colours), 4-byte-padded indices, UV formats/transforms, bind pose and bone matrices |
| surface                    | separate albedo and normal BC3 buffers                                                                                                                                                                  |
| splat                      | control, tint, and index arrays                                                                                                                                                                         |
| texture, layer, irradiance | decompressed bytes as stored                                                                                                                                                                            |

a 16-bit UV set stays `unorm16x2` (dequantized in the vertex shader) unless the mesh's other UV set
is float, in which case both become `float32x2`. a mesh without UV1 aliases UV0.

zstd decompression uses `zstddec`'s WASM build
([`package/zstd.ts`](../../packages/viewer/src/package/zstd.ts)), ~10× faster than JS on textures.
each realm (main thread for core tables, each worker) awaits its own `zstdReady`. because `zstddec`
does not report errors, `decompressZstd` checks the decoded length and throws on short frames.

## URL parameters

| parameter | meaning                                                                                                                                                                                                               |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `package` | dev package name (served from `/packages/<name>/`), or a directory URL/path starting with `/`, `./`, `../`, `http:/`, or `https:/` ([`package/package-param.ts`](../../packages/viewer/src/package/package-param.ts)) |
| `level`   | initial level id to pose over; falls back to the first level with instances if missing or empty                                                                                                                       |

the app syncs both via `history.replaceState` so reloads and shared links reopen the same package
and level (all levels render either way; see [levels](streaming.md#levels)). local folder packages
omit `package`.
