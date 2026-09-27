# Text-model onboarding

Read `docs/text-models/README.md`, `packages/text-models/README.md`, and the
current source at each seam before changing a narrator. Do not generalize one
model's sampler, chat template, context behavior, or retry policy to its family.

## Catalog and transport

`apps/web/src/lib/narrative-models.ts` is the curated narrator catalog. Its exact
id is persisted and its optional provider selects the upstream. Confirm the id
against the provider's live model record; a marketing page or published weights
do not prove that an API serves the model.

`apps/web/src/server/ai/provider.ts` owns provider clients, credentials, routing,
and the `textModel()` gateway. Provider-specific request mechanics stay there.
If exact-model behavior is still encoded in a transport table, move it only when
the adapter join replaces that ownership completely; do not leave two policies
that can drift or merge in an accidental order.

## Adapter contract

`packages/text-models/src/features/` owns semantic sampling features and value
bands. `packages/text-models/src/hosts/` owns per-host SDK-setting, raw-body, or
unsupported bindings. `packages/text-models/src/composer.ts` owns composition,
binding, withholding, and merge order. `packages/text-models/src/registry.ts`
maps exact model ids to measured adapters without family or prefix fallback.

Compose the complete known profile. Reuse semantic features; add a feature only
for a real profile value the vocabulary cannot express, and keep wire spelling
in the host dialect. `bindTextModelProfile` must expose values the selected host
can carry in `settings` or `body`, and return every declared unavailable value in
`withheld` without sending it. Execution hints and quirks require exact-model
measurements; absence means the lane default governs.

Locate the application join that resolves `adapterForTextModel`, binds for the
host in force, applies lane defaults then adapter values then explicit per-call
overrides, and reports withheld values. If the join does not exist yet, adding a
registry entry alone does not complete onboarding. Prove that both streaming
character chat and non-streaming successor narration reach the same effective
policy when both lanes use the model.

## Provider and prompt evidence

For Featherless, `scripts/eval/featherless-narrator/` contains separate opt-in,
billed runtime and field probes. Use those only when the exact task authorizes
provider spend. Other hosts need evidence from their own supported interfaces;
do not rename a Featherless result into a universal text-model fact.

When the host offers a rendered-prompt or chat-format debug surface, inspect the
prompt assembled for the exact model and host revision. Verify role order,
history, speaker tags, template markers, thinking sections, and token count that
matter to the lane. A correct request JSON is not proof of the prompt the host's
tokenizer rendered.

Pooled servers can return different baselines for identical calls. Use repeated
controls and confirmation samples, compare stable signals such as finish reason,
token counts, output presence, or a controlled prompt marker, and leave the
result unknown when pool variation overlaps the claimed effect. One completion
does not establish a model quirk.

Potential coverage lives near `apps/web/src/lib/narrative-models.test.ts`, the
text-model composer/binding/registry tests, provider wire tests, and the two lane
tests. Invoke `vesper-testing` to choose the one owning layer rather than copying
the same capability matrix into each.
