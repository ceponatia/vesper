# Pre-narrator intake — reliability follow-ups (improvement pass)

Status: **implemented — 2026-06-18** (Fixes 1–4 + budget bump landed; remaining
items in §6). Post-ship fixes for the intake agent shipped per
[pre-narrator-agents.spec.md](pre-narrator-agents.spec.md) §7 (Stack A).
Triggered by a flood of intake diagnostics in the dev Inspector during session
`ra2enpex3luvmsrlaafsyn8x` ("Whisperwing Estate"). This is the measurement the
UX-audit deferred — [ux-audit.plan.md](../finished/ux-audit.plan.md) §6 (M5) said "measure
the fallback hit-rate first"; this doc is that measurement, the root causes it
surfaced, and the fixes that landed.

> **Verified by live probe (2026-06-18).** The reasoning hypothesis (§2a) is
> confirmed and the fixes are in. Headline: the former default
> `google/gemini-3.5-flash` **mandates reasoning that cannot be disabled** and a
> live intake call reproduced the production bug exactly — `finish: "length"`,
> unparseable truncated JSON, 489 reasoning tokens against the 512 cap. It has
> been **dropped from the agent-model list**; the new default is
> `deepseek/deepseek-v4-flash` with reasoning explicitly disabled, which returns
> correct, fully-parsed briefs.

## Bottom line up front

Intake is **paid for but almost never used**, and a second, *racy* bug makes a
healthy turn look broken in the Inspector.

1. **91% of player turns fall back to regex.** 31 of 34 player turns across the
   DB logged `agent.intake.timeout`; intake landed inside its 1.5 s budget on
   only ~3. The agent is running (and billing) on essentially every turn and
   contributing on almost none — exactly the "paid-for but unused" outcome M5
   warned about.
2. **The scary `error`-level lines are noise from an abandoned call.** The
   `agent.intake.parse_failed` (error) + `agent.intake.degraded` (info) pair the
   user reported come from the **orphaned** LLM call — the one the timeout
   already walked away from. It keeps running, does a *second* (repair) round
   trip, fails to parse, and pushes those diagnostics into the **same sink**
   that gets persisted on the turn. The turn itself succeeded on the regex
   fallback; the error is decoration.
3. **The underlying parse failures are output truncation**, and truncation +
   the 91% timeout rate point at one shared root cause: the intake model is
   spending its time/token budget on **reasoning tokens** before emitting JSON.

Fix #3 first (it collapses both the timeout rate and the parse failures), then
#2 (stop the orphaned call from lying in the Inspector), then re-tune the
budget (#1) on the now-honest numbers.

---

## 1. What the data says

Session `ra2enpex3luvmsrlaafsyn8x`, per-turn intake diagnostics:

| Turn | Diagnostics |
| --- | --- |
| 12, 11, 9, 5, 2, 1 | `timeout` (warn) only |
| 10, 6 | `timeout` (warn) → `parse_failed` (error) → `degraded` (info) |
| 8 | non-intake only |
| 7, 4, 3 | none (regex was confident / nothing to classify) |

Across **all** sessions in the DB (`author = 'player'`):

- `agent.intake.timeout` — **31** occurrences, on **31 of 34** player turns.
- `agent.intake.parse_failed` — **3**.
- `agent.intake.degraded` — **3**.

The two parse-failure messages are both **truncation signatures**, not
schema-shape problems:

- `structured output failed after repair: response contained no JSON object` —
  `extractJsonObject` (`generate-checked.ts:105`) found no `{`/`}` at all: the
  model emitted *zero* JSON.
- `… Expected ',' or '}' after property value in JSON at position 282 (line 15
  column 4)` — the object started and was cut off mid-property.

A fully-populated `IntentBrief`, pretty-printed, is ~150–250 tokens; the cap is
`INTAKE_MAX_OUTPUT_TOKENS = 512` (`constants.ts:97`). The JSON alone cannot
exhaust 512 tokens — so something *other than the JSON* is eating the budget.

Model in play: world `agentModel = google/gemini-3.5-flash` (the curated default,
`agent-models.ts:28` → `provider.ts:55`).

---

## 2. Root causes

### 2a. Reasoning tokens (the shared root cause) — *confirmed*

The spec estimated intake at **400–1200 ms** with a small schema and ≤512 output
tokens (spec §4.1). The observed reality was the opposite: >1.5 s on 91% of
turns, plus truncated/empty JSON. One parsimonious explanation: the model does
**reasoning** before it writes the object — reasoning is slow (→ `timeout`) and
its tokens count against `maxOutputTokens` (→ the 512 cap is spent thinking, so
the JSON truncates or never appears).

A live probe across every curated agent + narrator model (intake prompt, temp 0,
512 output cap) confirmed it. `enabled:false` = does the OpenRouter
`reasoning:{enabled:false}` option turn it off, or is reasoning mandatory:

| Model | Default reasoning | `reasoning:{enabled:false}` | Mandatory? |
| --- | --- | --- | --- |
| `google/gemini-3.5-flash` *(former default)* | ~489 tok, **`finish:length`, unparseable** | **errors** | **Yes** |
| `aion-labs/aion-2.0` *(narrator default)* | ~570 tok, ~69 s | **errors** | **Yes** |
| `deepseek/deepseek-v4-flash` | varies (0–247 tok; routing-dependent) | → **0 tok**, parses ✓ | No |
| `z-ai/glm-5.2` | ~381 tok | → **0 tok**, parses ✓ | No |
| `openrouter/owl-alpha` | — could not test (see §6) | — | unknown |

Three findings drove the fix:

1. **gemini-3.5-flash reproduced the production bug live**: a default intake call
   returned `finish: "length"` with truncated, unparseable JSON — exactly the
   `Expected ',' or '}'…` signature — because 489 reasoning tokens crowded the
   512 cap. And its reasoning **cannot be disabled** ("Reasoning is mandatory for
   this endpoint"). It is the wrong model for a latency-critical classifier.
2. **`reasoning:{enabled:false}` reliably zeroes reasoning** on the two real
   agent models (deepseek, glm-5.2) and they then return correct, fully-parsed
   briefs. The alternative `{exclude,effort:"minimal"}` was **unreliable** across
   providers (it *raised* deepseek to 693 reasoning tokens and pushed glm to
   26 s), so the simple `enabled:false` is what shipped.
3. **deepseek's default reasoning is non-deterministic** — 0 tokens on one call,
   247 on the next — because OpenRouter routes the slug to different endpoints.
   So "off by default" cannot be assumed; intake disables it **explicitly**.

> **Follow-up (2026-06-21) — Aion ignores *all* reasoning controls, not just
> `enabled:false`.** A later attempt floored the narrator's effort to
> `reasoning:{effort:"minimal"}` (it can't be disabled, per the table above) on
> the theory that minimal would at least *shrink* the think. A live probe
> (temp 0, n=5/config, identical RP prompt) disproved it: every effort level and
> every `reasoning.max_tokens` budget landed in the same ~210–280 reasoning-token
> band. `minimal` = 223 tok ≈ `baseline` 216 ≈ `high` 225; `reasoning.max_tokens:128`
> = 231 tok (budget ignored). Cause: Aion 2.0 is served only by the first-party
> **AionLabs** endpoint, which accepts but does not honor OpenRouter's reasoning
> knobs. Reasoning is a fixed ~57% of Aion's billed output and **cannot be tuned
> down** — the only levers are a different narrator model or a smaller prompt. The
> no-op `reasoningFloor` was removed from `server/ai/provider.ts`; the floor was
> never committed to a release.

### 2b. The orphaned call leaks diagnostics (and wastes a repair round trip)

`withTimeout` (`intake.ts:56`) races the `generateChecked` promise against the
1.5 s timer. On timeout it resolves the turn with the regex fallback — but it
does **not** cancel the underlying call. That orphaned `generateChecked`:

1. Keeps the **same `DiagnosticSink`** reference (it was passed straight through
   from `runNarrationTask`, `pipeline.ts:193`).
2. On its first parse failure, fires a **second** (repair) `generateText` call
   (`generate-checked.ts:66`) whose result is *guaranteed discarded* — the
   timeout already won.
3. When the repair also fails, pushes `parse_failed` (error) + `degraded`
   (info) into that live sink.

The narrator then streams for ~30 s, and `persistNarration` (`pipeline.ts:274`,
serialising `sink.items` at `:386`) runs *after* the orphan has finished — so
the orphan's diagnostics get written onto a turn that already succeeded. Whether
they appear at all is a **race** between the orphan and the narration stream,
which is exactly why only 3 of 31 timed-out turns show the pair: on the other 28
the orphan finished *after* persistence (or its first attempt happened to
parse). Racy, misleading, and billing a wasted repair call every time.

### 2c. Severity is overstated for a best-effort agent

`generateChecked` logs `parse_failed` at **error** severity for every caller
(`generate-checked.ts:81`). That is correct for the simulant/archivist, whose
output materially shapes state. Intake, by contract, **degrades to the regex and
the turn is fine** — an intake parse failure has no player-visible consequence.
Surfacing it at `error` makes the Inspector read like a turn broke when nothing
did.

### 2d. The dominant cause of the timeout: OpenRouter TTFT variance

After the reasoning fix landed, intake **still** timed out — even on
deepseek-v4-flash, even at a 3 s budget. Streaming probes (real intake prompt,
reasoning off, spaced 4 s apart to avoid self-induced queueing) isolated it to
**time-to-first-token variance**, not output length, not the account (paid, no
rate limit), not concurrency (one intake call per turn):

| | TTFT median | total median | total max |
| --- | --- | --- | --- |
| deepseek, default routing | ~0.7 s | ~1.4 s | **13.1 s** |
| glm-5.2, default routing | ~3.4 s | ~3.5 s | 3.5 s |

deepseek's *median* is fine — but ~⅓ of calls spiked past 3 s (one to 13 s)
because OpenRouter intermittently routes the slug to a cold/slow provider
endpoint. A fixed pre-narration budget cannot fit a distribution with that fat a
tail.

**The lever: OpenRouter provider routing.** Re-running with
`provider:{sort:"latency"}` (prefer the lowest-latency endpoint for the model —
same weights, `allow_fallbacks` still on) flattened the tail:

| deepseek routing | TTFT median | TTFT max |
| --- | --- | --- |
| default | 0.78 s | 1.76 s (13 s seen earlier) |
| `sort:"throughput"` | 0.66 s | 1.15 s |
| **`sort:"latency"`** | **0.68 s** | **0.74 s** |

With latency routing every call landed <0.8 s TTFT / ~1 s total. End-to-end
through `runIntake` (3 s budget, abort, repair off): **deepseek lands 5/6 within
budget with correct classifications and clean diagnostics**; glm-5.2 is inherently
slower (~3 s, lands ~1/6) and stays a graceful-fallback option, not the default.

---

## 3. Fixes (implemented 2026-06-18)

### Fix 0 — Drop the mandatory-reasoning model from the agent list

`google/gemini-3.5-flash` (the former `DEFAULT_AGENT_MODEL_ID`) mandates
reasoning it cannot disable and is ~30× costlier per intake call than DeepSeek.
Removed from `AGENT_MODELS` (`lib/agent-models.ts`); the new default is
`deepseek/deepseek-v4-flash`. `z-ai/glm-5.2` stays; `openrouter/owl-alpha` was
added to both the agent and narrator lists (and GLM 5.1 → 5.2 on the narrator).
Existing worlds that pinned gemini keep it via the World-tab dropdown's
"unknown current value" fallback, but new worlds and the env default are now the
cheap non-reasoning model. *(gemini-3.5-flash remains a valid **narrator** choice
— reasoning helps narration and the narrator output isn't schema-parsed the same
way.)*

### Fix 1 — Disable reasoning on the intake call

`GenerateCheckedOptions` gained `disableReasoning?: boolean`; intake sets it.
`generateChecked` then sends `providerOptions: { openrouter: { reasoning: {
enabled: false } } }` to `generateText`. (Loose `providerOptions` typing accepts
this without a cast; the strict `OpenRouterProviderOptions` union is the
provider's internal parse type.) `{enabled:false}` reliably zeroes reasoning on
the curated agent models; the `{exclude,effort:"minimal"}` alternative was
rejected as unreliable (§2a). Opt-in per agent — the post-turn simulant/director
keep reasoning (they reason over the finished narration).

### Fix 2 — Abort the call on timeout so the orphan stays silent

`withTimeout` now owns an `AbortController`; on timeout it `controller.abort()`s
before logging `agent.intake.timeout`. The signal threads
`runIntake → generateChecked → generateText`. `generateChecked` checks
`opts.signal?.aborted` in its catch blocks and, when the caller walked away,
returns `{value: null, degraded: true}` **silently** — no `parse_failed`, no
`degraded`. Restored invariant (verified by live probe): **a timed-out intake
emits exactly one diagnostic, `agent.intake.timeout`, and nothing after it.**

### Fix 3 — Skip the repair round trip for intake

`GenerateCheckedOptions.repair?: boolean` (default true); intake sets `false`.
One attempt, then straight to the regex fallback — the repair was a second
sequential call the timeout would discard anyway. Post-turn agents keep repair
(their result is worth a second try; nothing else catches their miss).

### Fix 4 — Right-size the diagnostic severity

`GenerateCheckedOptions.degradeSeverity?: "warn" | "error"` (default `error`);
intake uses `warn`. A best-effort fallback to a live code path is not a turn
failure. With Fix 2, the `timeout` + `degraded` double-log for one event is gone
(only one path fires).

### Fix 5 — Budget bump

`INTAKE_TIMEOUT_MS` raised **1500 → 3000** (`constants.ts`). The 1500 was tuned
to the spec's 400–1200 ms estimate; with reasoning off + latency routing a
deepseek call lands in ~1 s, so 3000 gives ~3× headroom and the silent fallback
(Fix 2) covers the rare residual spike. Still the spec's **Open-question A**
(first-token latency tolerance) — finalize on real per-turn HUD telemetry
(ux-audit §6).

### Fix 6 — Low-latency provider routing *(the actual tail fix)*

`GenerateCheckedOptions.lowLatencyRouting?: boolean` → `provider:{sort:"latency"}`
on the OpenRouter call; intake sets it. This is what made the budget achievable:
it flattened deepseek's TTFT from a 13 s tail to <0.8 s (§2d). `allow_fallbacks`
stays on, so it only reorders provider preference — no reliability loss, and same
model weights so no quality change.

**Extended to the narrator and post-turn agents** (2026-06-18, per request):
- Post-turn agents (`agents.ts` `run` helper) set `lowLatencyRouting:true` — the
  four fan out in parallel; trimming each TTFT tail returns the session to
  "ready" sooner. Pure win (small structured outputs, no quality concern).
- The narrator (`pipeline.ts` `liveNarrativeStream`) passes
  `provider:{sort:"latency"}` on its `streamText` so narration's first token
  arrives sooner. **Note:** for a long stream this optimises *time-to-first-token*;
  if sustained tokens/sec ever matters more, switch that one to
  `sort:"throughput"`. Same weights, so prose quality is unchanged.

---

## 4. Why this matters beyond the noise

The user-visible complaint was Inspector noise; Fixes 2 + 4 kill that directly
(at most one `warn` now). But Fix 0 + 1 are the substantive win: the former
default literally could not return a parseable brief (mandatory reasoning →
truncation), so intake was contributing on ~0% of turns. With a non-reasoning
model it returns correct briefs.

This de-risks the **personality** work, which leans harder on intake:
`socialActs` / `narratedNpcBehaviors` tagging
([personality-and-state.plan.md](../finished/personality-and-state.plan.md) §1.3, already
shipped into the brief) only fires when intake **lands**. At the old 91%
fallback rate those reactions almost never triggered. Reliable intake is a
prerequisite for the authored likes/dislikes loop working in play.

## 5. Remaining items

- **owl-alpha is unreachable on this account.** Every probe call to
  `openrouter/owl-alpha` returned *"No endpoints available matching your
  guardrail restrictions and data policy"* — a cloaked/alpha model gated behind
  OpenRouter's privacy/data-policy settings. To use it (it's now in both model
  lists), enable the required data policy at
  <https://openrouter.ai/settings/privacy>. Until then it errors → degrades to
  the fallback. Not a code fix.
- **Post-turn agents still reason.** `disableReasoning` is opt-in and only
  intake sets it. The four post-turn agents reason on the agent model — fine on
  the new non-reasoning deepseek default, but a budget cost if a world pins
  glm-5.2. If post-turn reasoning proves not worth the spend, set
  `disableReasoning` on them too (a one-line change per agent in `agents.ts`).
- **Finalize the budget on real telemetry.** §3 Fix 5 raised `INTAKE_TIMEOUT_MS`
  to 3000 provisionally. Confirm the real per-turn timeout rate via the dev HUD
  (ux-audit §6) and tune — this is spec Open-question A.

## 6. Cross-references

- Spec: [pre-narrator-agents.spec.md](pre-narrator-agents.spec.md) (§4.1
  latency, §4.2 resilience ladder, Open-question A).
- M5 tracking: [ux-audit.plan.md](../finished/ux-audit.plan.md) §6 — this doc supplies the
  "measure first" data it was gated on.
- Consumer at risk: [personality-and-state.plan.md](../finished/personality-and-state.plan.md) §1.3.
- Code: `src/lib/agent-models.ts` + `src/lib/narrative-models.ts` (model lists +
  default), `src/server/engine/intake.ts` (`runIntake`/`withTimeout` abort),
  `src/server/ai/generate-checked.ts` (`disableReasoning` / `repair` /
  `degradeSeverity` / `signal`), `src/server/engine/constants.ts`
  (`INTAKE_TIMEOUT_MS`).

