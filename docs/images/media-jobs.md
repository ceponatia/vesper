# Character media jobs

Character pages read portrait, portrait-variant, identity-pack, and reference-view work through
one persistent status contract. The contract projects existing `jobs` rows; it does not create a
second queue or make tab components infer background work from image rows and local booleans.

## Owns and does not own

This page owns the character-facing media-job read, its access boundary, lifecycle projection, and
retry/result vocabulary. The individual generation lanes own job creation and settlement:
[avatars](pipelines/avatars.md), [portrait variants](pipelines/portrait-variants.md),
[identity packs](identity-packs.md), and [reference views](pipelines/reference-views.md).

The status surface never starts or retries provider work. Generation remains an explicit action in
the owning character tool, so a reload, poll, remount, or retry of the status read cannot create a
new charge.

## Safe owner-scoped read

- `GET /api/characters/:id/media-jobs` first authorizes the character and collapses missing and
  foreign characters to the same 404.
- The job query independently requires both `jobs.owner_id` and the character id in the job
  payload. A row from another owner or another character cannot enter the projection.
- The read returns at most eight jobs created in the preceding day, newest first. Current media
  work fits inside that window; older rows remain operational history in the database rather than
  character-page state.
- The response never returns a raw payload, prompt, arbitrary provider error, provider identifier,
  or secret. It allowlists operation, target labels, counts, stable diagnostic codes, timestamps,
  and result identifiers.

## Lifecycle and progress

The player-facing lifecycle is `queued`, `running`, `succeeded`, `partial`, `failed`, or
`interrupted`.

- A queued or running row older than the shared job-staleness bound reads `interrupted`. The status
  view therefore cannot show an endless active job after a deploy replaces its worker.
- Avatar, variant, and identity work count as one target unless their owning result reports a more
  specific set.
- Reference work reports its requested slots and the job's bounded `planned`, `built`, and `failed`
  counts. A settled batch with both built and failed slots reads `partial`.
- Terminal copy names the failed operation and points to the owning character tool. Raw job errors
  remain in server and operator logs.

## Results and retry targets

- Avatar and variant jobs expose their resulting image id when the job payload records one.
- Identity preparation exposes the identity-pack id and optional crop image id only when the pack
  row was created during that job's execution window.
- Reference builds expose attempt ids and optional image ids for attempts created during the job's
  execution window.
- A retry target is navigation state: operation plus reference slots where applicable. Invoking it
  opens the controls that can make a new request; it never replays a saved payload or spends by
  itself.

## Client behavior

- The character-level status component lives above the active tab, so changing tabs cannot hide or
  reset work.
- It polls slowly while idle so work started by a nested tab appears without a coupling callback,
  then tightens the interval while a job reads queued or running.
- A failed refresh retains and labels the last successful snapshot. The owner can retry the read
  without losing portrait or reference content already displayed elsewhere.
- Image result identifiers link through the ordinary owner-scoped image file route. Non-image
  result identifiers remain visible for inspection and support correlation.
