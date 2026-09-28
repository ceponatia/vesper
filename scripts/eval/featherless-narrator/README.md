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
| `PROBE_ATTEMPTS` | runtime | Rounds of the full arm × case grid (default 3) — the pre-#594 name for "calls per case", kept because the default arm set (`profile` alone) makes a round mean the same thing it always did. One round cannot establish an intermittent empty reply. Must be a positive integer or the probe refuses to start. |
| `PROBE_ARMS` | runtime | Comma-separated list of the six comparison arms (below). Defaults to `profile` alone, so an unset run has the pre-#594 shape. An entry that is not one of the six known arms makes the probe refuse to start — it never silently drops an unknown name. |
| `PROBE_CASES` | runtime | Comma-separated filter over `tiny`, `vesper-sized`, `terse-invite`. Defaults to all three. An unknown entry refuses to start, the same as `PROBE_ARMS`. |
| `PROBE_MAX_CALLS` | runtime | Refuses to start (clear message, exit 0) when the **worst-case request count** exceeds this (default 60), or when the value itself is not a positive integer. A large interleaved run needs an explicit opt-in. Guards worst-case requests, not planned calls — see "Hidden retries and the spend guard" below. |
| `PROBE_OUT` | runtime | A file path. When set, the runtime probe writes a `type:"run"` header line, one JSONL row per call (typed by `kind`), and a final `type:"summary"` object. |
| `PROBE_LONG_HISTORY` | runtime | `1` adds the two context-edge calls, through the `profile` arm only. Off by default — they carry ~32K input tokens each and are the most expensive calls here, and are not part of the interleaved arm × case grid or its summary. |
| `PROBE_WARMUP` | runtime | `1` adds one `profile` call before round 1 (`kind: "warmup"`), so the first grid call does not absorb a cold start. Excluded from the grid summary; counted in the planned-call budget and the token totals. |
| `PROBE_FIELDS` | fields | Comma-separated field filter, for iterating on one field without re-billing the sweep. A name is expanded to the calls its verdict is read from, so naming a grouped member selects its whole group and a dependent field pulls in its prerequisite. The baselines always run, because every verdict is a comparison against one of them. |

No runtime-probe env var ever falls back silently on a bad value: an unparseable
`PROBE_ATTEMPTS`/`PROBE_MAX_CALLS`, or an unrecognised `PROBE_ARMS`/`PROBE_CASES`
entry, refuses to start with a clear message and exits 0.

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
from a production arm's own call for that case — specifically, the FIRST request
that call made. A model with a hidden retry can make a second request carrying
the retry-only `min_tokens` floor (`narratorRetryFloor`,
`apps/web/src/server/ai/model-adapters.ts`), and the captured body is pinned to
the first request's bytes so a direct arm never ends up replaying a retry nobody
asked it to reproduce. If a direct arm is selected without any production arm,
the probe makes one extra un-transformed call to seed that replay body and says
so in its output — and in that mode `PROBE_CASES` must name exactly one case (the
probe refuses to start otherwise), because without a production arm there is only
the one captured body to replay.

## Hidden retries and the spend guard

`narratorHiddenRetryModel(modelId)` (`@/server/ai`,
`apps/web/src/server/ai/model-adapters.ts`) names the narrator rows whose chat
lane makes up to TWO requests per turn when the first comes back with no visible
text (`apps/web/src/server/engine/character-chat.ts`'s `maxAttempts`). Fable
Fusion 711 — this probe's default `PROBE_MODEL` — is one of them; Asmodeus is
not. Every PRODUCTION arm (`profile`/`profile-uncapped`/`lane`/`lane-capped`, and
the bootstrap/warm-up/long-history calls, which are all production calls too) can
therefore bill up to 2 requests for what the console counts as one "call". Direct
arms always make exactly one request.

The startup print shows both numbers — `planned calls` (logical rows) and
`worst-case requests` (what `PROBE_MAX_CALLS` actually guards, at the hidden-retry
model's 2x multiplier on every production call) — and refuses to start when the
worst case, not the planned-call count, exceeds `PROBE_MAX_CALLS`. The JSONL run
header carries both (`plannedCalls` and `worstCaseRequests`, plus
`hiddenRetryMultiplier`).

This budget is about Vesper's OWN hidden retry, not the AI SDK's transport-level
retries on a transient `408`/`429`/`5xx` (a handful more requests per call in the
worst case) — those are a real cost but not one this guard sizes against; treat
them as a caveat when reading a run's actual bill.

Each row records its arm, round, **two** position counters and its wall-clock
start time:

- `position` — monotonic across the whole run (every call this run ever made, in
  the order it was made);
- `positionInRound` — 1-based order within that row's own round, resetting to 1
  at the start of each round. Comparing `positionInRound` across rounds is how the
  rotation itself becomes visible (the arm at `positionInRound: 1` differs from
  round to round); `position` is the one to cite when pointing at a specific call.

A hidden retry inside a production call can make several underlying HTTP
requests; `requestStartOffsetMs` records the LAST one's start as an offset from
the call's own start (0 when there was no retry) — see "Raw vs visible timing"
below for why that offset matters.

## Raw vs visible timing, and two independent stub verdicts

Every Featherless request — production and direct alike — is wrapped in a
pass-through tap that forwards the response bytes unchanged to whichever consumer
needs them (the AI SDK for a production arm, the probe's own reader for a direct
one), while a decoded copy records:

- time to first response body byte;
- time to the first SSE event carrying a non-empty
  `delta.content`/`delta.reasoning_content` (null for `direct-json`, which has no stream);
- the number of content delta events and total content characters — **counts
  only**, never the text;
- the raw `finish_reason` from the last event that carried one;
- raw `usage.prompt_tokens`/`usage.completion_tokens`, when present.

A hidden retry can make several requests for one production call; the row records
the request count and reports the **last** request's raw values, and
`requestStartOffsetMs` (above) records when that last request actually started
relative to the call. The existing `ttftMs` — the first non-empty delta
`streamCharacterChat` itself yields — stays as the "visible" column, anchored to
the call's own start rather than the last request's, so every production row
carries both plus the offset needed to reconcile them.

`direct-json` reads its whole body in one `response.text()` call, so it has no
incremental "first content" moment distinct from "the whole body arrived" — its
`firstContentMs` is always `null`, and `firstByteMs` (measured the instant the
response headers arrive, before `.text()` is even called) is the only raw timing
it reports.

Both a raw-wire stub verdict and, on every production row, an SDK-completion stub
verdict:

- production rows: `isNarratorLengthStub(completion)`
  (`apps/web/src/server/ai/narrator-completion.ts`);
- direct arms, and the raw-wire column on every row: `rawLengthStub` (`probe-stats.ts`),
  a documented pure mirror of the same three-part rule, applied to the raw wire
  evidence instead of the SDK-normalized completion. `probe-stats.test.ts` pins a
  parity table of both functions agreeing on the same cases.

Any disagreement between the two verdicts on a production row is its own counted
line in the summary — that is what shows whether a one-token stub is a fact
already true on the raw wire, or something the SDK's own normalization introduces.

Every production row also carries the columns the pre-#594 probe printed:
`providerError` (code + a truncated detail), `rawTextLength`, `visibleTextLength`,
`textTokens` and `reasoningTokens` — plus `requestMaxTokens`, the `max_tokens`
THIS arm's own request actually carried on the wire (`null` for an arm that sent
none), distinct from `visible.maxOutputTokens`, the narrator gateway's own budget
bookkeeping.

`raw.promptTokens`/`raw.completionTokens` stay the LAST request's own usage — what
the stub and timing verdicts read, and what a hidden retry's second attempt
reported on its own. `billedPromptTokens`/`billedCompletionTokens` are the
SEPARATE, SUMMED field: every request the row's call made, added together, which
is the number that actually prices it. When a request reported no usage at all
and could not be recovered (recoverable only when the call made exactly one
request, from the SDK's own completion counts), the row's billed total is `null`
and `unpricedRequests` names how many requests could not be priced — every token
total (`tokenTotalsByArm`, `tokenTotalsByKind`, `tokenTotalsGrand`, and each
cell's) sums the billed fields and its own `unpricedRequests`.

## Failed rows

A row is FAILED when it threw/timed out, its HTTP status was >= 400, or its
finish (raw or completion) was `"error"` — a failed call answers a different
question (did the request complete at all) than a stub verdict does, so failed
rows are excluded from the stub count/rate/Wilson interval and from the raw/visible/
total latency stats, and reported separately as their own `failed` count per cell.
They still contribute to the `n` count and the `finish_reason` tally — a failure's
own reason is evidence too.

A direct-arm read failure (a timeout, or the connection dropping mid-body) used to
come back as a clean, empty-looking row; it is now recorded as an errored row with
the read's own message.

## Safe metadata

Every response's status, every header **name**, and header **values** for a small
allowlist (request/trace/correlation ids, `cf-ray`, server, worker, region, node,
backend, model, version, served-by — never `set-cookie`/`authorization`/`server-timing`/
anything key- or secret-shaped) are recorded, plus `id`/`model`/`system_fingerprint`/
`created` from the first SSE event or JSON body. An allowlisted value longer than
120 characters is **dropped** (the header name still appears; the value key is
simply absent), never truncated — a printed value is always the host's own
unmodified text. No prompt, prose, reasoning content or Authorization header is
ever printed or written — unchanged from the "Counts and finish state only" rule
above.

## Distributions and the JSONL output

For each arm × case the console prints (and, with `PROBE_OUT=<path>`, the same
counts-only fields are written as JSONL): n, errored, failed and empty counts;
stub count/rate/Wilson-95% (over `n - failed`, see "Failed rows" above); a
`finish_reason` tally (every row, failed included); count/p50/p90/max for raw
first-content ms, visible first ms and total ms, excluding failed rows (the
percentile method — nearest-rank — is stated in the output); a stub cross-tab of
raw-wire verdict vs completion verdict; and BILLED prompt/completion token totals
(summed over every request each row made, not just the last — see "Raw vs visible
timing" above), per arm, per `kind`, and grand, each with its own
`unpricedRequests` count, so a tester can price a run before spending more.

`PROBE_OUT`'s file is three kinds of line:

1. one `type:"run"` header, written before the first call: the model id, arms,
   cases, attempts, the planned call count and its breakdown, the worst-case
   request count and the hidden-retry multiplier it was sized from (see "Hidden
   retries and the spend guard" above), `git rev-parse HEAD` of the checkout that
   ran it (`null` if it could not be read — never a network call), and the start
   time. No env values or secrets.
2. one line per call, `type` equal to its `kind` — `"call"` (the interleaved grid),
   `"bootstrap-call"`, `"long-history"`, or `"warmup"` — carrying every field the
   console row prints.
3. one final `type:"summary"` object — `buildProbeSummary`'s output. Only `"call"`
   rows feed its per-arm/case cells; every kind's tokens count toward the totals,
   because a bootstrap, long-history or warm-up call is still money spent.

## Running from a worktree

`probe.ts` keeps its `import "dotenv/config"` at the top, and `dotenv/config`
honours `DOTENV_CONFIG_PATH` when it is set. An isolated worktree has no `.env` of
its own, so a run from one needs the main checkout's, e.g.:

```
DOTENV_CONFIG_PATH=<main checkout>/.env \
  PROBE_MODEL=DarkArtsForge/Asmodeus-24B-v3 \
  PROBE_ARMS=profile,profile-uncapped,lane,lane-capped,direct-stream,direct-json \
  PROBE_CASES=vesper-sized \
  PROBE_ATTEMPTS=3 \
  PROBE_OUT=<main checkout>/eval-images/featherless-narrator/<YYYY-MM-DD>/asmodeus.jsonl \
  pnpm probe:featherless-narrator
```

That plans 18 calls (3 rounds × 6 arms × 1 case), under the default
`PROBE_MAX_CALLS=60`, and leaves the full evidence — the `type:"run"` header, one
line per call, and the final `type:"summary"` — in that gitignored evidence file.

Without it (or without a token in either place), the probe prints why it skipped
and exits 0 — the evidence-discipline rule above still holds either way.

## Adding a model

Per-model evidence is the rule, not a family inheritance: a new narrator earns its own run
of both probes before it earns a policy entry, and a row with no measurement gets no
sampler. Record the run as a dated file under `eval-images/featherless-narrator/`, which is
gitignored — probe output is evaluation evidence and never enters `docs/`.
