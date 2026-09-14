# Admin Files

`/settings/files` is a deliberately small **owner-admin-only** file manager for temporary sharing between devices. It is a developer convenience, not a user-facing asset system and not part of chats, characters, image generation, or other game state.

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

The batch actions — `delete_many`, `move` and `delete_preview` — take up to 500 paths and are partial-success operations. A refusal for one entry becomes a row in `failures` carrying that entry's path and error code, and the request still answers `200` even when every entry failed, so `deleted` and `moved` report what actually happened rather than what was asked for. One fact about the request as a whole still fails it outright: a `move` whose destination is missing or is not a folder is answered once, not repeated per path. A duplicated path is removed by its first occurrence and reported `not_found` by the rest.

`delete_preview` sums the files, folders and bytes a recursive delete would remove, so a confirmation can name them before anything is unlinked. It counts a duplicated or overlapping selection once and spends a single 10,000-entry budget across the whole selection, reporting `truncated` when it stops there. It is a count and not a safety check: a path it cannot walk is skipped rather than failing the call, and the refusals below are enforced by the delete itself, so a tree that previews a total can still be refused whole.

The upload route intentionally does **not** call the buffered JSON `readBody()` helper and does not define a Vesper-level file-size cap. Browser, Fly proxy, filesystem, available-volume-space, and other infrastructure limits still apply. A full volume returns a storage error rather than changing the global API body limit.

Compressed request bodies are refused because this utility promises to preserve the bytes supplied by the browser exactly.

## Filesystem safety

The managed tree is rooted at `DATA_ROOT/admin-files`. Relative paths are validated segment-by-segment; absolute paths, `..`, slash/backslash-bearing names, NUL/control characters, and symbolic-link traversal are rejected server-side. The API never executes uploaded content.

Downloads always use `Content-Type: application/octet-stream`, `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`, and private/no-store caching. The server opens the requested file before deriving `Content-Length` and streams from that same descriptor, so a concurrent replacement cannot make headers describe one file while response bytes come from another. Uploading HTML, JavaScript, an executable, or any other arbitrary file therefore does not turn it into an application route or executable server artifact.

Deleting a non-empty folder is refused with `folder_not_empty` unless the request explicitly asks for recursion (owner ruling 2026-09-14); recursion is never implicit in a request that did not ask for it. A recursive delete validates the entire subtree before it unlinks anything, and refuses one containing a symbolic link or an unsupported filesystem entry, so such a folder is left in place rather than emptied up to the entry the server will not manage. Rename and move never silently overwrite an existing entry, a folder cannot move into itself or into one of its own subfolders, and an entry already in the requested destination is refused with `already_in_destination`. A path routed through a component that is a file is refused with `not_directory`.

## UI behavior

The account menu exposes **Files** only to admins. The page supports:

- folder breadcrumbs and parent navigation
- creating folders
- selecting one or more files with the browser/OS file picker on desktop or phone
- per-file upload progress
- explicit replace confirmation when a same-name file exists
- download
- rename
- confirmed delete

Directory reads use the shared generation-guarded client loader, so a slower response for a folder the owner has already left cannot replace the listing for the current breadcrumbs. A multi-file batch also reloads the directory after stopping on a later-file failure, preserving visibility of files that were successfully published earlier in the batch.

There are intentionally no public links, previews, content scanning, quotas, per-file permissions, database records, retention jobs, or normal-user surfaces. If Vesper later needs a product-level asset system, it should be designed separately rather than extending this temporary utility by accident.
