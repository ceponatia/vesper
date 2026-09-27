---
name: vesper-model-onboard
description: Onboard or revise Vesper text and image models by coordinating provider evidence, catalogs, adapters, coverage, and deployed verification. Use when adding a model, changing its host or version, or changing model-specific capabilities and behavior.
---

# Onboard a Vesper model

Coordinate one evidence-backed model change from provider identity through live
Vesper behavior. A selectable row, a provider schema, and a behavior adapter are
separate claims; prove and place each one at its owning seam.

## Establish the evidence boundary

Before editing, record the model kind, exact provider model id, host, exact
provider revision or version when the host exposes one, intended Vesper surfaces,
and whether paid probes or live mutations are authorized. Read
[evidence states](references/evidence.md), then the applicable route:

- [Text models](references/text-models.md)
- [Image models](references/image-models.md)

Use provider documentation to identify candidate fields and constraints. Label
what the evidence actually proves: documented, sent, accepted, forwarded, honored,
unsupported, or unknown. Provider acceptance does not prove forwarding or
behavioral effect. Scope every measured result to the exact model, host, and
revision observed.

For text, a full adapter declares the model's complete known profile and
supported behavior. Keep a known author-profile or future-host value declared
when the current host cannot carry it, but bind that host as unsupported so the
value is reported as withheld and never sent. Leave an uncertain field unknown;
do not turn missing evidence into either support or rejection.

## Place each change once

- Catalog or database records own selection, display, routing identity, and the
  active provider version.
- Model packages own provider-neutral, measured model or family behavior.
- Provider transports own credentials, network calls, and wire mechanics.
- Application join modules connect the catalog, adapter, and transport. Verify
  that the join is wired; a registered adapter that no call resolves is inert.
- Lane prompt modules own what the narrator or image model is told. Do not move
  prompt policy into a transport or duplicate provider field truth in an adapter.

Use `vesper-agent-build` for delegated implementation, `vesper-docs` for issue
content or durable documentation, and `vesper-board` for lifecycle operations.
Those skills retain ownership of their workflows and authorization rules.

## Prove the delivered behavior

Invoke `vesper-testing` before adding or changing tests. Protect the smallest
meaningful invariant at its owning layer: catalog resolution, binding and
withholding, serialized wire shape, family behavior, or lane integration. Never
run Vesper application gates locally. Map each changed test to the CI command and
job that actually selected it; a green aggregate does not prove an unscheduled
suite ran.

After the exact change reaches Fly, use `verify` to prove the requested live
behavior against that deployed commit. Provider calls, billed probes, smoke
renders, version activation, deployment, and production mutations require scope
or authorization from the current task; this skill grants none of them.

Report the exact identity and revision, evidence status per field or behavior,
catalog and adapter placement, every withheld or unknown capability, focused
coverage, CI selection actually observed, deployed release, and concrete live
evidence. Mark any omitted stage unverified rather than treating implementation
or green CI as proof.
