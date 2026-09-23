# API, jobs, and code map

## Routes

| Route                                                | Wrapper                  | Methods              |
| ----------------------------------------------------- | ------------------------ | -------------------- |
| `/api/admin/self/image-generator/uploads`            | `withOwnerAdmin`         | GET list, POST (201) |
| `/api/admin/self/image-generator/uploads/[imageId]`  | `withOwnerAdmin`         | DELETE               |
| `/api/admin/self/image-generator/runs`               | `withOwnerAdmin`         | GET list, POST (201) |
| `/api/admin/self/image-generator/runs/delete`        | `withOwnerAdmin`         | POST bulk delete     |
| `/api/admin/self/image-generator/runs/[runId]`       | `withOwnerAdminResource` | GET detail, DELETE   |
| `/api/admin/self/owned-images`                       | `withOwnerAdmin`         | GET                  |

Everything is self-scoped: models, images, and runs resolve against the requesting admin's own id,
and another owner's run answers the same 404 a nonexistent one does.

The upload POST is synchronous and starts no provider work. It accepts one bounded raster data URL,
runs the shared upload quota/abuse guard, then stores the decoded image through the normal
row-before-file image lifecycle. PNG, JPEG, WebP, and AVIF are accepted; the shared decoder rejects
other MIME types and oversized decoded payloads before they reach Sharp. The stored row has no
entity, character, chat, or scene association and records `source: "generator_upload"` plus the
original filename when supplied. A Files import lands through the same storage function
(`storeReusableImageReference`) with `source: "admin_files_import"` instead.

A Generator upload uses the hidden `generator_output` storage class, but it is not a run output:
no run output record names it. Run deletion removes only the output image ids recorded by the runs
being deleted, so an uploaded reference persists for later selection in the owned-image picker —
and, since #635, in the settings page's own "Reference uploads" panel, until the admin deletes it.

The upload GET and the `[imageId]` DELETE are the panel's own surface, scoped **strictly** by
`meta.source in ("generator_upload", "admin_files_import")` on top of the ordinary owner+kind
guard — never by kind alone. A run's rendered output shares the identical hidden
`generator_output` kind and would otherwise be indistinguishable from an uploaded reference; the
`meta.source` filter is the only thing that keeps this surface from ever listing or deleting one.
DELETE removes the row and unlinks the file (the periodic sweep reconciles a straggler); an id that
is foreign, absent, the wrong kind, or a run's own output all answer the same 404.

Once the form receives an uploaded image's id, a run treats it exactly like any other selected
owned image — owner-scoped byte loading, preparation, capacity checks, dedicated-field routing, and
provider transport remain unchanged.

The bulk delete takes its ids in a body — a list of them does not belong in a URL — capped at the
list route's own maximum. Both of its statements carry the owner predicate, so an id that is not
this admin's is simply absent from the count rather than refused, and never deleted.

The run POST runs the shared admission guard with `outputKind: "generator_output"` (provider budget
applies, storage reservation skipped), creates the pending row, then starts the `generator_image`
job from the route — a refused job slot deletes the just-created row rather than stranding a
`pending` record that never runs. The page's `?run=<id>` parameter deep-links one run's detail.

## Code map

| Module                                                        | Owns                                                                                    |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `apps/web/src/contracts/images/image-generator.ts`            | statuses, request/wire schemas, failure codes                                           |
| `apps/web/src/contracts/images/image-generator-upload.ts`     | bounded direct-upload request, and the uploads-panel wire schema (`meta.source` enum)   |
| `apps/web/src/contracts/images/image-generator-outputs.ts`    | the per-prediction output record and its reader                                         |
| `apps/web/src/server/images/image-generator-store.ts`         | run row↔wire, create/list/detail/delete/settle, and the standalone-upload list/delete   |
| `apps/web/src/server/images/image-generator-run.ts`           | atomic claim and prepare-to-settle coordination                                         |
| `apps/web/src/server/images/image-generator-request.ts`       | request validation, version, profile and pre-spend planning                             |
| `apps/web/src/server/images/image-generator-provenance.ts`    | capability snapshot and sanitized effective request                                     |
| `apps/web/src/server/images/image-generator-settle.ts`        | sequential renders, output storage and deletion-race cleanup                            |
| `apps/web/src/server/images/image-generator-render.ts`        | injectable render seam (`renderImageIntent`)                                            |
| `apps/web/src/server/images/upload.ts`                        | shared safe data-URL decode plus Generator upload storage                               |
| `apps/web/src/server/images/owned-image-reads.ts`             | shared owner-scoped byte readers                                                        |
| `apps/web/src/app/api/admin/self/image-generator/…`           | run and upload routes                                                                   |
| `apps/web/src/app/api/admin/self/owned-images/route.ts`       | sources endpoint                                                                        |
| `apps/web/src/app/settings/image-generator/page.tsx`          | server page (`?run=` idiom)                                                             |
| `apps/web/src/components/settings/image-generator-*.tsx`      | client UI (page, form, list, detail, copy)                                              |
| `apps/web/src/components/settings/image-generator-form/`      | model view data, request assembly, prefill interpretation, reference and control fields |
| `apps/web/src/components/settings/owned-image-picker.tsx`     | general owned-image picker                                                              |

The request planner builds a synthetic in-memory profile per run — a pass-through prompt strategy, a caller
seed policy, and the run's advanced values as provider overrides — so `compileProfileRenderPlan`
stays the only control mapper and no production profile is consulted.
