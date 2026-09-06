# Model evidence states

Use these terms precisely. Several may apply to one field: `accepted, forwarded,
effect unknown` is a valid result.

| State | What proves it | What it does not prove |
| --- | --- | --- |
| `documented` | Provider-owned docs, model card, or schema names the field or behavior for the scoped model/revision | The live endpoint accepts, forwards, or honors it |
| `accepted` | The exact endpoint completes a request carrying the field instead of rejecting it | The field reached the model or affected output |
| `sent` | Captured outbound request shows Vesper sent the value to the provider | The provider accepted it or forwarded it to the model |
| `forwarded` | A host-rendered prompt, provider-side debug trace, or equivalent evidence shows the value at the model boundary | The model honored the value |
| `honored` | A controlled comparison shows the field changes the intended count, stop state, prompt shape, or output behavior | The same result on a sibling model, host, or revision |
| `unsupported` | An explicitly exhaustive contract excludes it, the endpoint rejects it, or the host explicitly refuses it | That a differently named equivalent is also unsupported; omission from a non-exhaustive schema remains unknown |
| `unknown` | Evidence is absent, conflicting, pooled, or the probe cannot observe the effect | Support or rejection |

For text profiles, `withheld` is a Vesper action rather than a provider verdict.
It means a declared adapter value has no supported binding on the selected host,
so the binder keeps it in the profile, reports a reason, and sends it nowhere. An
accepted-but-ignored field is not unsupported: record `accepted`, `forwarded`
when proven, and `not honored` with the control evidence.

## Evidence record

Copy [the evidence record template](../templates/evidence-record.md) into the
owning issue or a gitignored evaluation record. Do not commit run output as a
durable repository document.

Prefer evidence in this order, while preserving what each source can prove:

1. exact provider model/revision record and official schema or documentation;
2. outbound request capture for what Vesper sent, or provider-side evidence for what reached the model;
3. controlled field or behavior probes with explicit baselines;
4. Vesper CI at the tested commit; and
5. deployed-path verification on the exact Fly release.

A paid probe or provider mutation is never an automatic consequence of finding
that stronger evidence would help. Use current task authorization and record
when a result remains unknown.
