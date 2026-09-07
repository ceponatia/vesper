# Runs

`image-generator-run.ts` coordinates the claim, request preparation and settlement.
`image-generator-request.ts` completes the pre-spend gates and records the effective
request through `image-generator-provenance.ts`; `image-generator-settle.ts` owns
sequential rendering, output storage and cleanup when a run disappears during rendering.

## Runs are immutable records

One run is one row in `image_generator_runs`
([../database/images.md](../database/images.md)): `pending → running → succeeded | failed`.

The row snapshots the model slug at create; the runner re-resolves it against the registry at run
time and writes the exact pinned provider version and the post-preparation `final_prompt` **before**
any provider spend. A settled row is never mutated or re-run — a rerun is a new row citing the
original through `sourceRunId`.

The `pending → running` claim is a conditional update, and every settle is guarded on `running`, so
two deliveries of one job cannot both reach the provider and a settled row cannot be rewritten. Rows
CASCADE with their owner; the result and lineage pointers are SET NULL, so deleting an output or a
source run never erases the record of what happened.

A run executes under the bench's two-phase prediction budget (8 minutes to start, 3 to render), and
a prediction the provider abandons in the queue — confirmed cancelled without ever executing — is
recreated once. Each is billed only if it actually executes, and every prediction the run created
appears in the row's `providerAttempts` record (outcome, queue and render durations, prediction id),
oldest first. The run detail panel renders this history.

The admin's prompt is the whole positive prompt. The only transformations between the text box and
the wire are the shared model-boundary preparation every registered-model render applies and, when
a curated LoRA is selected, that LoRA's own prompt additions — and the recorded `final_prompt` is
the post-transform text actually sent.

Deleting a run hard-deletes every hidden output image it rendered, in the same call. Deletion is a
**list** action as much as a detail one: every row in the run history carries its own Delete, and
the tick boxes beside them clear a whole batch in one call. Both doors end in the same
confirmation, which names how many records and how many rendered images are about to go — the
record is provenance and nothing brings it back.

## Several images from one request

A run asks for **1 to 4 images**, and every extra one is another prediction. No model Vesper
registers returns more than one image per prediction, so the count is the bench's own loop: one
compiled plan, one pre-spend record, one strict request gate, then that same plan sent again for
each image.

The predictions run one after another — the two-phase budget is built to wait out a cold queue, and
four simultaneous startup timeouts would read as an upstream in trouble when they are one bench
asking for four pictures. A four-image run therefore takes roughly four times as long, and the daily
`provider_image_day` budget is charged four units at admission rather than one.

Nothing about the row changes shape. `result_image_id` keeps naming the **first** image the run
stored — the history thumbnail, the lineage pointer, the FK-SET-NULL target — and so do the
`prediction_id` and `executed_version_id` columns, which describe that same first output. The
siblings are ordinary hidden `generator_output` images, and the run's own record names them one per
prediction: which image each produced, or the code that stopped it. That record is also what the
delete reads, since nothing else points at a sibling. The run detail shows a grid of the lot; a
one-image run keeps the single result tile it has always had, and the history list keeps one cover
thumbnail plus a "×N".

**An explicit seed and a count above one refuse each other.** A fixed seed reaches every prediction,
so the provider would answer with the same picture however many were asked for. The run refuses
pre-spend with `control_refused` rather than dropping the seed or trimming the count — both would
charge for renders nobody asked for. An unseeded run is the ordinary case: no seed key is sent at
all, and the provider varies each prediction itself.

**A run that stored at least one image succeeded.** A prediction that failed mid-fan-out costs its
own tile and nothing else: the images that did render are paid for and on screen, and calling the
run failed would hide them. Only a run that stored nothing settles `failed` —
`output_store_failed` when the provider did render, otherwise `render_failed`. Provider health
hears a lane failure only when *every* prediction failed; one prediction that came back with pixels
is proof the upstream is alive.

This count is **not** a provider input, and the difference is the point. A native image set is one
prediction answering with several pictures; a fan-out is several independent predictions asked for
together. The image-set controls stay refused ([form.md](form.md)) so a request for the first is
never quietly answered with the second.

## Outputs are hidden assets

A successful run stores every image it rendered as kind `generator_output`, a member of
`HIDDEN_IMAGE_KINDS` ([../images/asset-registry.md](../images/asset-registry.md), which owns what
that subtracts).

The `provider_image_day` budget and render backpressure still apply, the budget charged one unit per
image asked for — hidden outputs are free of storage accounting, not of provider cost control.

## What a run records about itself

Beside the request the admin authored, every run writes down — **before the provider is paid** — a
sanitized **effective request**: the provider-shaped control fields and their values, the shape mode
with the aspect field and value actually sent, each selected image with the provider slot it
occupies, each structural image with the provider field it was bound to, and whether any
post-render crop was going to happen.

Once the provider answers, the run settles the returned pixel dimensions, whether Vesper cropped,
and the prediction and executed-version echoes — from the first stored output, on a run that
produced several — plus one record per prediction naming the image it stored or the code that
stopped it.

The recorded request is the **whole** payload, assembled by the same builder the transport uses, not
just the controls the run set. The model row's own pinned fields, the output format, and the
reviewed quality corrections Vesper applies to a few known models all reach the provider too, and a
record that omitted them would be describing a request nobody sent.

The reason for all of it is drift. Vesper keeps one capability record per registered model and
replaces it wholesale on re-probe, so a row saying `guidance = 4` cannot by itself say whether the
provider received `guidance: 4` or `cfg: 4`, and a row saying "3:4" cannot say whether that reached
`aspect_ratio`, reached `size` as `1536*2048`, or was applied by cropping afterwards. Recording the
bound names makes a run's account of itself independent of a capability record that will move. Each
run also freezes the mechanical capability facts it executed under, which is what makes exact replay
possible.

Nothing sensitive is kept: no bytes, no data URLs, no signed download URLs, no credentials. A LoRA
reaches the payload as a download address, so that field is recorded as redacted and the curated
library id stands as the real reference.

The run detail's **Effective request** panel shows all of it, with the raw sanitized record
underneath.

## Duplicate and variant

A settled run's detail offers **Duplicate**: the create form remounts seeded with the original's
model (when still registered), prompt, ordered primary references and purposes, dedicated inputs,
controls including any explicit seed, and advanced provider values, plus `sourceRunId` lineage.
Nothing runs until submitted, and the original row and output stay untouched.

When the original's pinned version no longer matches the model's current pin, the form says so and
asks which version to run:

- **Use the current registered version** — the ordinary duplicate, recorded as a different arm.
- **Replay the captured version** — the exact historical version, planned against the capability
  record that run stored. The server verifies the version belongs to the same registered model and
  that the stored record genuinely describes it; when it cannot, the run refuses with
  `version_replay_unsafe` rather than pointing today's field bindings at yesterday's weights. The
  current version is never substituted for a replay the admin asked for.

One limit worth knowing: Vesper's reviewed quality corrections for a handful of known models live in
code rather than in the capability record, so a replay picks up whatever those corrections say
today. That is deliberate — they exist to correct harmful provider defaults, and dropping them for a
replay would make it less like a real Vesper render, not more.

The run detail likewise surfaces a requested-versus-executed version disagreement on any single run.
