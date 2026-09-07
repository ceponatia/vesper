# API, jobs, and code map

## Routes

| Route                                          | Wrapper                  | Methods              |
| ---------------------------------------------- | ------------------------ | -------------------- |
| `/api/admin/self/image-generator/runs`         | `withOwnerAdmin`         | GET list, POST (201) |
| `/api/admin/self/image-generator/runs/delete`  | `withOwnerAdmin`         | POST bulk delete     |
| `/api/admin/self/image-generator/runs/[runId]` | `withOwnerAdminResource` | GET detail, DELETE   |
| `/api/admin/self/owned-images`                 | `withOwnerAdmin`         | GET                  |

Everything is self-scoped: models, images, and runs resolve against the requesting admin's own id,
and another owner's run answers the same 404 a nonexistent one does.

The bulk delete takes its ids in a body — a list of them does not belong in a URL — capped at the
list route's own maximum. Both of its statements carry the owner predicate, so an id that is not
this admin's is simply absent from the count rather than refused, and never deleted.

The POST runs the shared admission guard with `outputKind: "generator_output"` (provider budget
applies, storage reservation skipped), creates the pending row, then starts the `generator_image`
job from the route — a refused job slot deletes the just-created row rather than stranding a
`pending` record that never runs. The page's `?run=<id>` parameter deep-links one run's detail.

## Code map

| Module                                                     | Owns                                            |
| ---------------------------------------------------------- | ----------------------------------------------- |
| `apps/web/src/contracts/images/image-generator.ts`         | statuses, request/wire schemas, failure codes   |
| `apps/web/src/contracts/images/image-generator-outputs.ts` | the per-prediction output record and its reader |
| `apps/web/src/server/images/image-generator-store.ts`      | row↔wire, create/list/detail/delete/settle      |
| `apps/web/src/server/images/image-generator-run.ts`        | runner algorithm, synthetic profile, refusals   |
| `apps/web/src/server/images/image-generator-render.ts`     | injectable render seam (`renderImageIntent`)    |
| `apps/web/src/server/images/owned-image-reads.ts`          | shared owner-scoped byte readers                |
| `apps/web/src/app/api/admin/self/image-generator/…`        | run routes                                      |
| `apps/web/src/app/api/admin/self/owned-images/route.ts`    | sources endpoint                                |
| `apps/web/src/app/settings/image-generator/page.tsx`       | server page (`?run=` idiom)                     |
| `apps/web/src/components/settings/image-generator-*.tsx`   | client UI (page, form, list, detail, copy)      |
| `apps/web/src/components/settings/image-generator-form/`  | model view data, request assembly, prefill interpretation, reference and control fields |
| `apps/web/src/components/settings/owned-image-picker.tsx`  | general owned-image picker                      |

The runner builds a synthetic in-memory profile per run — a pass-through prompt strategy, a caller
seed policy, and the run's advanced values as provider overrides — so `compileProfileRenderPlan`
stays the only control mapper and no production profile is consulted.
