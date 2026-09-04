# Featherless narrator probes

Two opt-in live probes behind one credential. Both make real, billed calls, neither is part
of any suite, and neither runs in CI. Without `FEATHERLESS_API_TOKEN` each prints one line
saying it skipped and exits 0, so a clean checkout can run either harmlessly.

| Probe | Command | Asks |
| --- | --- | --- |
| Runtime | `pnpm probe:featherless-narrator` | How does a narrator behave **through Vesper's own seam** — first-token and total latency, finish reasons, token counts, empty replies, speaker-tag and asterisk shape, the context edge. |
| Field acceptance | `pnpm probe:featherless-fields` | What does **the host** do with each candidate request field on one exact model — accept and honor it, accept and ignore it, or reject it. |

The split is deliberate. The runtime probe runs `streamCharacterChat`, so every policy the
chat lane applies is in force and the completion record it prints is the same one the
pipeline classifies a failed reply from; a probe with its own request builder would measure
the probe. The field probe is the opposite question — what a host does with a field Vesper
does not send today — so it owns its request body and calls
`/v1/chat/completions` directly, one candidate field per call.

## Counts and finish state only

Neither probe ever prints a prompt, a completion, or reasoning content. Output is token
counts, character lengths, finish reasons, latencies, SHA-256 prefixes, derived ratios, and
the host's own error text. Reply text is accumulated in memory only where a count needs it
and never leaves the function that measures it. This is what makes a run safe to paste into
an issue: a diagnostic that carried content would be a transcript.

## Environment

| Variable | Applies to | Effect |
| --- | --- | --- |
| `FEATHERLESS_API_TOKEN` | both | Required. Absent ⇒ skip with exit 0. |
| `PROBE_MODEL` | both | The model to measure. The runtime probe requires a curated `NARRATIVE_MODELS` row and defaults to Fable Fusion 711; the field probe accepts any id the host serves. |
| `PROBE_ATTEMPTS` | runtime | Calls per case (default 3). One call cannot establish an intermittent empty reply. |
| `PROBE_LONG_HISTORY` | runtime | `1` adds the two context-edge calls. Off by default — they carry ~32K input tokens each and are the most expensive calls here. |
| `PROBE_FIELDS` | fields | Comma-separated field filter, for iterating on one field without re-billing the sweep. A name is expanded to the calls its verdict is read from, so naming a grouped member selects its whole group and a dependent field pulls in its prerequisite. The baselines always run, because every verdict is a comparison against one of them. |

## Adding a model

Per-model evidence is the rule, not a family inheritance: a new narrator earns its own run
of both probes before it earns a policy entry, and a row with no measurement gets no
sampler. Record the run as a dated file under `eval-images/featherless-narrator/`, which is
gitignored — probe output is evaluation evidence and never enters `docs/`.
