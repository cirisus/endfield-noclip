# loading a package

## sources

packages are read through three source kinds, each supporting whole-file, single byte-range, and
multi-range reads:

- **HTTP**: dev/preview server or any static host; issues single or multi-range HTTP requests,
  tolerating servers that ignore `Range`.
- **File System Access**: folder picked via `showDirectoryPicker`, or a package copied into OPFS.
- **file list**: `<input webkitdirectory>` fallback when `showDirectoryPicker` is unavailable.

multi-range reads over HTTP:

- sends `Range: bytes=a-b,c-d,…` and parses `multipart/byteranges` responses by each part's
  `Content-Range` (tolerating server reordering or merging).
- some hosts return the whole file or a single range instead (e.g. Amazon S3; nginx and Apache
  return multipart; others unsurveyed). on the first non-multipart response, the reader drops the
  body unread and permanently falls back to one request per range.
- cross-origin hosts must allow the `Range` request header in CORS preflight (single-range requests
  skip preflight).

change detection:

- every range read checks the archive size against the manifest. a size mismatch stops shard
  fetching, keeps resident content drawn, and offers a reload in the stats panel.
- this checks size only (same-sized edits go undetected). repacks normally change
  [archive names](../package-format.md#layout), so an open tab usually hits a missing-file error
  when old archives are deleted.

where both `showDirectoryPicker` and OPFS exist, "copy into browser storage" imports a picked folder
into OPFS (skipping `debug/`, which the viewer never reads).

## dev package server

a Vite plugin serves extracted packages under `/packages/` in both `vite dev` and `vite preview`.
the root defaults to `out/`; override with `NOCLIP_PACKAGES=/path`.

- static files support `Range`, `ETag`, `Last-Modified`, and `cache-control: no-cache`. production
  deployments need range support and revalidation for `core.czar` (fixed name; other archives have
  content-derived names).
- multi-range `GET` requests (`bytes=a-b,c-d,…`) are answered as `multipart/byteranges` in requested
  order.
- `GET /packages/index.json` (dev-only) lists non-hidden subdirectories containing a core archive
  and its size, skipping packer staging/replaced directories.

## opening

1. read `core.czar`, verify manifest format and version, and decode all core tables.
2. shard JSON headers are never fetched: the blob table gives each blob's offset within its
   archive's data section (whose start is in the manifest), so each blob takes one range read.
3. build the tile tree, texture store, stream manager, and selectors, and pin the coarse layer
   ([residency](streaming.md#residency-and-budgets)).
4. pick the initial level and pose the camera over it.

if a package has no converted geometry (`--no-assets`), instances draw as boxes. terrain page sizes
must match `package-format` constants; any other size fails that blob.

## decode workers and zstd

2–4 module workers (half the hardware threads, clamped) decompress blobs and build GPU-ready arrays,
assigning each job to the least busy worker:

- **queueing.** each worker holds at most 64 jobs; excess jobs wait in the pool so unloading a
  package drops unstarted work. worker results reach the main thread only between frames, so 64
  in-flight jobs per worker prevents worker starvation (a map02 teleport settled in 0.9 s vs 2.4 s
  with 4 per worker).
- **zero-copy transfers.** each coalesced range read (or core blob copy) transfers once to the
  worker taking its first job, and all later jobs from that buffer route to the same worker. the
  buffer stays in memory until all jobs referencing it finish or are dropped. only uncompressed
  texture, layer, and irradiance blobs that share a read are copied out on the worker to transfer
  back (a few KiB vs tens of MB on the main thread; ~1/3 of blobs share a read during map02
  flights).

worker outputs by blob kind:

| kind                       | worker output                                                                                                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| heights                    | raw `u16` samples, padded to whole words for storage buffers                                                                                                  |
| instances                  | instance rows, per-row cull data, `(chain, first, count)` runs, decal placements, spinning/water-riding rows, and mesh-selection bounds                       |
| geometry                   | meshopt-decoded vertex streams (quantized positions, octahedral normals, UV0, UV1, tangents, colours), 4-byte-padded indices, UV transforms, and skin buffers |
| surface                    | separate albedo and normal BC3 buffers                                                                                                                        |
| splat                      | control, tint, and index arrays                                                                                                                               |
| texture, layer, irradiance | decompressed bytes as stored                                                                                                                                  |

a 16-bit UV set stays `unorm16x2` (dequantized in the vertex shader) unless the mesh's other UV set
is float, in which case both become `float32x2`. a mesh without UV1 aliases UV0.

zstd decompression uses WASM (~10× faster than JS on textures) and verifies decoded length to catch
short frames.

## URL parameters

| parameter | meaning                                                                                                                    |
| --------- | -------------------------------------------------------------------------------------------------------------------------- |
| `package` | dev package name (served from `/packages/<name>/`), or a directory URL/path starting with `/`, `./`, `../`, or `http(s):/` |
| `level`   | initial level id to pose over; falls back to the first level with instances if missing or empty                            |

the app syncs both via `history.replaceState` so reloads and shared links reopen the same package
and level (all levels render either way; see [levels](streaming.md#levels)). local folder packages
omit `package`.
