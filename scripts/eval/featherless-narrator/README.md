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
| `PROBE_ATTEMPTS` | runtime | Rounds of the full arm × case grid (default 3) — the pre-#594 name for "calls per case", kept because the default arm set (`profile` alone) makes a round mean the same thing it always did. One round cannot establish an intermittent empty reply. |
| `PROBE_ARMS` | runtime | Comma-separated list of the six comparison arms (below). Defaults to `profile` alone, so an unset run has the pre-#594 shape. |
| `PROBE_CASES` | runtime | Comma-separated filter over `tiny`, `vesper-sized`, `terse-invite`. Defaults to all three. |
| `PROBE_MAX_CALLS` | runtime | Refuses to start (clear message, exit 0) when the planned call count exceeds this (default 60). A large interleaved run needs an explicit opt-in. |
| `PROBE_OUT` | runtime | A file path. When set, the runtime probe writes one JSONL row per call plus a final summary object to it, in addition to the console table. |
| `PROBE_LONG_HISTORY` | runtime | `1` adds the two context-edge calls, through the `profile` arm only. Off by default — they carry ~32K input tokens each and are the most expensive calls here, and are not part of the interleaved arm × case grid or its summary. |
| `PROBE_FIELDS` | fields | Comma-separated field filter, for iterating on one field without re-billing the sweep. A name is expanded to the calls its verdict is read from, so naming a grouped member selects its whole group and a dependent field pulls in its prerequisite. The baselines always run, because every verdict is a comparison against one of them. |

## The runtime probe's six arms (#594)

The runtime probe (`probe.ts`) can run up to six comparison arms, interleaved in
rounds so that a changing provider load over time cannot masquerade as a
configuration effect — **an arm comparison is only valid because the arms ran
interleaved**; comparing arms from two separately-run probes, or from a probe that
ran one arm fully before starting the next, is not the same evidence.

| Arm | What it asks | Reaches the host through |
| --- | --- | --- |
| `profile` | The production request exactly as Vesper builds it. | `streamCharacterChat` (the real narrator seam) |
| `profile-uncapped` | The same request with only `max_tokens` removed. | `streamCharacterChat` |
| `lane` | What a row with **no** exact-model adapter gets: only `messages`/`model`/`stream`/`stream_options` plus the lane's own `NARRATIVE_TEMPERATURE`, no `max_tokens`. | `streamCharacterChat` |
| `lane-capped` | `lane` plus `max_tokens` set to the value the **same call's own** `profile` body carries (read off the wire, never hard-coded) — isolates the sampler/profile fields from the output cap. | `streamCharacterChat` |
| `direct-stream` | The unmodified `profile` body, replayed with the original `fetch` straight against `POST /v1/chat/completions`, parsing raw SSE — no SDK. | direct HTTP |
| `direct-json` | The same replayed body with `stream: false` and no `stream_options`. | direct HTTP (non-streaming) |

`profile`/`profile-uncapped`/`lane`/`lane-capped` are PRODUCTION arms: each one
still calls `streamCharacterChat`, so the exact-model adapter, the lane defaults,
the output normalizers and the hidden retry are all in force — only the arm's
transform (`probe-stats.ts`'s `transformArmBody`) rewrites that call's own outgoing
JSON body inside the probe's `fetch` wrapper, just before it leaves the process.
No override seam was added to application code. `direct-stream`/`direct-json` are
DIRECT arms: they never call `streamCharacterChat` — they replay a body captured
from a production arm's own call for that case. If a direct arm is selected
without any production arm, the probe makes one extra un-transformed call to seed
that replay body and says so in its output.

Each row records its arm, round, position (its 1-based order within that round —
the arm order rotates round to round so no arm always goes first) and wall-clock
start time.

## Raw vs visible timing, and two independent stub verdicts

Every Featherless request — production and direct alike — is wrapped in a
pass-through tap that forwards the response bytes unchanged to whichever consumer
needs them (the AI SDK for a production arm, the probe's own reader for a direct
one), while a decoded copy records:

- time to first response body byte;
- time to the first SSE event (or, for `direct-json`, the parsed body) carrying a
  non-empty `delta.content`/`delta.reasoning_content`;
- the number of content delta events and total content characters — **counts
  only**, never the text;
- the raw `finish_reason` from the last event that carried one;
- raw `usage.prompt_tokens`/`usage.completion_tokens`, when present.

A hidden retry can make several requests for one production call; the row records
the request count and reports the **last** request's raw values. The existing
`ttftMs` — the first non-empty delta `streamCharacterChat` itself yields — stays as
the "visible" column, so every production row carries both.

Both a raw-wire stub verdict and, on every production row, an SDK-completion stub
verdict:

- production rows: `isNarratorLengthStub(completion)`
  (`apps/web/src/server/ai/narrator-completion.ts`);
- direct arms, and the raw-wire column on every row: `rawLengthStub` (`probe-stats.ts`),
  a documented pure mirror of the same three-part rule, applied to the raw wire
  evidence instead of the SDK-normalized completion.

Any disagreement between the two verdicts on a production row is its own counted
line in the summary — that is what shows whether a one-token stub is a fact
already true on the raw wire, or something the SDK's own normalization introduces.

## Safe metadata

Every response's status, every header **name**, and header **values** for a small
allowlist (request/trace/correlation ids, `cf-ray`, server, worker, region, node,
backend, model, version, served-by — never `set-cookie`/`authorization`/anything
key- or secret-shaped, and never longer than 120 characters) are recorded, plus
`id`/`model`/`system_fingerprint`/`created` from the first SSE event or JSON body.
No prompt, prose, reasoning content or Authorization header is ever printed or
written — unchanged from the "Counts and finish state only" rule above.

## Distributions and the JSONL output

For each arm × case the console prints (and, with `PROBE_OUT=<path>`, the same
counts-only fields are written as one JSONL line per call plus a final summary
line): n, errored, empty and stub counts with rate and a Wilson 95% interval; a
`finish_reason` tally; count/p50/p90/max for raw first-content ms, visible first
ms and total ms (the percentile method — nearest-rank — is stated in the output);
a stub cross-tab of raw-wire verdict vs completion verdict; and prompt/completion
token totals per arm, so a tester can price a run before spending more.

## Running from a worktree

`probe.ts` keeps its `import "dotenv/config"` at the top, and `dotenv/config`
honours `DOTENV_CONFIG_PATH` when it is set. An isolated worktree has no `.env` of
its own, so a run from one needs the main checkout's, e.g.:

```
DOTENV_CONFIG_PATH=/home/brian/projects/vesper/.env \
  PROBE_MODEL=DarkArtsForge/Asmodeus-24B-v3 \
  PROBE_ARMS=profile,profile-uncapped,lane,lane-capped,direct-stream,direct-json \
  PROBE_CASES=vesper-sized \
  pnpm probe:featherless-narrator
```

Without it (or without a token in either place), the probe prints why it skipped
and exits 0 — the evidence-discipline rule above still holds either way.

## Adding a model

Per-model evidence is the rule, not a family inheritance: a new narrator earns its own run
of both probes before it earns a policy entry, and a row with no measurement gets no
sampler. Record the run as a dated file under `eval-images/featherless-narrator/`, which is
gitignored — probe output is evaluation evidence and never enters `docs/`.
