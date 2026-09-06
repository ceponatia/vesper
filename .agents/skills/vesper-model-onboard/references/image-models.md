# Image-model onboarding

Start with `docs/image-models/README.md` and `docs/image-models/models/README.md`,
then read the relevant existing per-model page: it owns the captured provider API
and drift evidence. Follow `docs/images/providers/README.md` when transport or
probing changes. Inspect current source at the affected seams below; catalog-only
work does not require reading every adapter and transport implementation.

## Registry and provider truth

The selectable image-model catalog is data in `image_models`, managed through
the owner-admin image-model surface. `apps/web/src/server/images/models.ts` owns
row parsing and reads; `apps/web/src/app/api/admin/self/image-models/route.ts`
creates a row by probing the provider first. Operator-added availability does
not belong in a second code list. If a built-in row must exist on a fresh
database, follow the repository's schema and migration workflow rather than
teaching seed code a second catalog.

`packages/image-replicate/src/probe.ts` and the application version flow in
`apps/web/src/server/images/model-versions.ts` own provider schema discovery,
candidate comparison, smoke testing, and activation. Record the exact provider
version. `latest` and the Vesper row's active pin are different facts, and a
historical render must be judged against the stored or executed version rather
than today's provider playground.

The probe owns mechanical facts such as provider field bindings, reference
arity, optional controls, and `probedVersionId`. Do not type those from memory.
Reference capacity, supported aspects, edit kind, identity preservation, and
operator warnings include owner or visual judgment the schema cannot establish;
do not overwrite them on re-probe or infer them from a URI-shaped input.

Probe-latest is read-only but still calls the provider. A smoke test spends a
real prediction, and activation mutates the live row. Perform only the stages
authorized by the task, and report the others as unverified.

## Family behavior and package boundaries

`packages/image-models/` owns provider-neutral model-family features,
validations, execution hints, and base-slug adapter registration. Add an adapter
only when Vesper has family-specific behavior to encode; `null` is the normal
generic path. A version-pinned `owner/name:version` row must still resolve the
base-slug adapter, while similarly prefixed sibling endpoints must not inherit it.

Provider field names and active-version capability remain in the probed row.
Prompt wording belongs to the prompt-program dialects in
`packages/image-core/`. Credentialed HTTP and prediction mechanics remain in
server-only `packages/image-replicate/`. These peer packages do not import one
another. `apps/web/src/server/images/model-adapters.ts` is the application join;
verify planning and sending resolve the same idempotent prompt preparation and
the same adapter behavior.

An endpoint advertising a field does not prove the behavior it names. For
example, a negative-prompt input is a mechanical provider capability until a
controlled image comparison shows it steers output. Keep unreviewed behavior
unknown and avoid advertising it as a semantic feature.

Potential coverage lives near the provider probe and version-flow tests,
`packages/image-models` composer/registry tests, `packages/image-core` prompt or
render planning tests, and the application join or lane that consumes the
behavior. Invoke `vesper-testing` to select the smallest owner. For deployed
proof, use `verify` to confirm the active row/version, the offered surface or
profile, the provider's executed version when available, and the requested
observable result.
