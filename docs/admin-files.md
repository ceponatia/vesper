# Admin Files

`/settings/files` is a deliberately small **owner-admin-only** file manager for temporary sharing between devices. It is a developer convenience, not a user-facing asset system and not part of chats, characters, or other game state. The Image Generator and Image Lab may explicitly **import** a supported raster from Files; that operation copies the bytes into the ordinary owner-scoped image registry and thereafter uses only the new image id. Files itself does not become image/game state.

## Storage

Files live under `DATA_ROOT/admin-files`. On the Fly deployment `DATA_ROOT` is pinned to `/app/data`, which is the mounted `vesper_data` Fly Volume, so files survive ordinary application restarts and deploys until the owner deletes them.

Uploads stage in `DATA_ROOT/.admin-files-upload-tmp` and become visible only after the request completes. The completed temporary file is then published into the managed tree atomically (or replaces an existing file only after the caller explicitly requests overwrite). Failed/interrupted uploads are removed from the staging area when the process remains alive. If a Machine exit or deploy prevents that cleanup from running, later Files access scavenges `.part` files older than 24 hours; active uploads in the current process are excluded from reclamation.

This relies on the current **single always-on Fly Machine + one attached volume** deployment. Fly Volumes are machine-local; if Vesper is later scaled to multiple application Machines, this utility must either stay pinned to the Machine owning the volume or move behind shared object storage. Short destination-changing mutations are serialized inside the current process so create/rename/delete/upload-publication requests cannot race one another into an unintended overwrite; upload byte streaming itself does not hold that lock.

## API

Every route is beneath `/api/admin/self` and uses `withOwnerAdmin`, so a signed-in non-admin receives the same hidden 404 as the other owner-admin tools.

| Route | Method | Purpose |
| --- | --- | --- |
| `/api/admin/self/files?path=...` | `GET` | List one folder. |
| `/api/admin/self/files` | `POST` | Create a folder, rename an entry, delete one entry or a batch, move a batch into another folder, or count what a delete would remove. |
| `/api/admin/self/files/upload?path=...&name=...` | `PUT` | Stream raw file bytes into the current folder. `overwrite=1` explicitly permits file replacement. |
| `/api/admin/self/files/download?path=...` | `GET` | Download one file as inert `application/octet-stream` content. |
| `/api/admin/self/files/preview?path=...` | `GET` | Serve one previewable file inline with its real content type, supporting range requests. |
| `/api/admin/self/files/import-image` | `POST` | Copy one PNG/JPEG/WebP/AVIF Files raster into the owner image registry and return its `imageId`. |

The image-import route accepts `{ path }`, opens the file through the same symlink-safe descriptor path as download/preview, refuses unsupported extensions and sources over the reference-upload byte ceiling, applies the same image-storage and accepted-upload-byte budgets as a direct Generator upload, validates/decodes the raster with the shared Sharp limits, materializes EXIF orientation without cropping/resizing, and stores the result as a reusable owner-only image asset. Metadata records `source: "admin_files_import"`, the original name, and the Files path as provenance. That path is not a durable dependency: renaming or deleting the original Files entry does not affect the imported image.

The batch actions — `delete_many`, `move` and `delete_preview` — take up to 500 paths and are partial-success operations. A refusal for one entry becomes a row in `failures` carrying that entry's path and error code, and the request still answers `200` even when every entry failed, so `deleted` and `moved` report what actually happened rather than what was asked for. One fact about the request as a whole still fails it outright: a `move` whose destination is missing or is not a folder is answered once, not repeated per path. A duplicated path is removed by its first occurrence and reported `not_found` by the rest.

`delete_preview` sums the files, folders and bytes a recursive delete would remove, so a confirmation can name them before anything is unlinked. It counts a duplicated or overlapping selection once and spends a single 10,000-entry budget across the whole selection, reporting `truncated` when it stops there. It is a count and not a safety check: a path it cannot walk is skipped rather than failing the call, and the refusals below are enforced by the delete itself, so a tree that previews a total can still be refused whole.

The upload route intentionally does **not** call the buffered JSON `readBody()` helper and does not define a Vesper-level file-size cap. Browser, Fly proxy, filesystem, available-volume-space, and other infrastructure limits still apply. A full volume returns a storage error rather than changing the global API body limit.

Compressed request bodies are refused because this utility promises to preserve the bytes supplied by the browser exactly.

## Filesystem safety

The managed tree is rooted at `DATA_ROOT/admin-files`. Relative paths are validated segment-by-segment; absolute paths, `..`, slash/backslash-bearing names, NUL/control characters, and symbolic-link traversal are rejected server-side. The API never executes uploaded content.

The download route always uses `Content-Type: application/octet-stream`, `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`, and private/no-store caching, and it is the only door for every file the preview route refuses. The server opens the requested file before deriving `Content-Length` and streams from that same descriptor, so a concurrent replacement cannot make headers describe one file while response bytes come from another. Uploading HTML, JavaScript, an executable, or any other arbitrary file therefore does not turn it into an application route or executable server artifact.

The preview route is the single exception, and `nosniff` is what keeps the guarantee intact rather than merely narrowing it. It serves a real content type only for a strict extension allowlist — `png`, `jpg`, `jpeg`, `webp`, `gif` and `avif` as images; `mp4`, `webm` and `ogv` as video; `mp3`, `m4a`, `aac`, `ogg`, `oga`, `wav` and `flac` as audio — decided from the final extension of the name the server resolved, never sniffed from the bytes and never taken from a client-supplied type. Anything else is `415`. Because every response carries `nosniff`, a file named `x.png` whose bytes are HTML is served as `image/png` and the browser refuses to reinterpret it as a document: it renders as a broken image, and no markup or script in it reaches Vesper's origin. `svg` is deliberately absent from the allowlist and stays absent, because an SVG is a document that can carry script, and navigating to one served as `image/svg+xml` would execute it in that origin. The route opens the file through the same descriptor discipline as the download route, answers a single `bytes=` range with `206` and an unsatisfiable one with `416`, and advertises `Accept-Ranges: bytes` so a video can be sought. Playback is whatever the viewer's browser decodes natively; Vesper transcodes nothing, so a file whose codec the browser cannot decode reports that rather than showing an empty frame.

Deleting a non-empty folder is refused with `folder_not_empty` unless the request explicitly asks for recursion (owner ruling 2026-09-14); recursion is never implicit in a request that did not ask for it. A recursive delete validates the entire subtree before it unlinks anything, and refuses one containing a symbolic link or an unsupported filesystem entry, so such a folder is left in place rather than emptied up to the entry the server will not manage. Rename and move never silently overwrite an existing entry, a folder cannot move into itself or into one of its own subfolders, and an entry already in the requested destination is refused with `already_in_destination`. A path routed through a component that is a file is refused with `not_directory`.

## UI behavior

The account menu exposes **Files** only to admins. The page supports:

- folder breadcrumbs and parent navigation
- creating folders
- selecting one or more files with the browser/OS file picker on desktop or phone
- dragging files from the desktop onto the listing, and whole folders, whose tree is recreated under the
  current folder and whose contents are uploaded
- per-file upload progress across the batch
- a replace confirmation offering replace, skip, or replace every later collision in the same upload
- multi-select with an indeterminate select-all, and a toolbar that deletes or moves the selection at once
- moving a selection through a keyboard-operable destination picker, to the parent folder, or by dragging it
  onto a folder row, a breadcrumb, or the parent target
- opening a previewable file in the shared image lightbox, with video and audio playing in place
- download, on every row and regardless of whether the file can be previewed
- rename
- confirmed delete, counted before it runs

The Image Generator and Image Lab's generic owner-image pickers additionally offer **Choose from Files**. That browser shows folders plus PNG/JPEG/WebP/AVIF files, previews them through the authorized Files preview route, and imports the chosen image before selecting it. A failed import leaves the previously selected reference unchanged. Face Repair deliberately does not expose Files because its source-kind contract is narrower than the generic bench reference contract.

Deleting asks the server first what the selection contains, so the confirmation names how many folders and files will go before the owner confirms it, and a selection larger than the preview's ten-thousand-entry budget is described as a floor rather than a count. A single row's delete travels the same batch path as a multi-row one, so the two cannot drift apart. Every confirmation and every name prompt is a Vesper dialog; the page uses no native browser dialog.

Directory reads use the shared generation-guarded client loader, so a slower response for a folder the owner has already left cannot replace the listing for the current breadcrumbs. A multi-file batch also reloads the directory after stopping on a later-file failure, preserving visibility of files that were successfully published earlier in the batch.

Preview is inline viewing for the owner-admin and nothing more: there are intentionally no public links, thumbnails in the Files listing, transcoding, poster frames, content scanning, quotas, per-file permissions, database records, retention jobs, or normal-user surfaces. The explicit Generator/Lab import does not change that boundary: it creates a separate ordinary image asset rather than extending Files into a product-level asset system.
