# Pre-narrator intake — reliability follow-ups (improvement pass)

Status: **findings / proposed** (2026-06-18). Post-ship fixes for the intake
agent shipped per [pre-narrator-agents.spec.md](pre-narrator-agents.spec.md)
§7 (Stack A). Triggered by a flood of intake diagnostics in the dev Inspector
during session `ra2enpex3luvmsrlaafsyn8x` ("Whisperwing Estate"). This is the
measurement the UX-audit deferred — [ux-audit.plan.md](ux-audit.plan.md) §6
(M5) said "measure the fallback hit-rate first"; this doc is that measurement,
plus the two root causes it surfaced.

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

### 2a. Reasoning tokens (the shared root cause) — *verify*

The spec estimated intake at **400–1200 ms** with a small schema and ≤512 output
tokens (spec §4.1). The observed reality is the opposite: >1.5 s on 91% of
turns, plus truncated/empty JSON. Both symptoms have one parsimonious
explanation: the model is doing **reasoning** before it writes the object.

- Reasoning is slow → blows the 1.5 s budget → `timeout`.
- Reasoning tokens count against `maxOutputTokens` → 512 is spent thinking, so
  the JSON is truncated (`Expected ',' or '}'…`) or never reached at all
  (`response contained no JSON object`).

`generateChecked` sends no provider reasoning config (`generate-checked.ts:43`),
so the model runs at its **default** reasoning behaviour — and a "flash"
reasoning model defaults to thinking. This is a single knob with outsized
leverage: turn reasoning **off** for intake (it is a fast classifier, not a
reasoner) and both the latency and the truncation should disappear, putting
intake back near the spec's 400–1200 ms estimate where the 1.5 s budget works
as designed.

> **To verify before committing:** confirm gemini-3.5-flash is emitting
> reasoning tokens on these calls (OpenRouter response usage:
> `completion_tokens_details.reasoning_tokens`, or the `/inspect` token counts
> once the dev HUD lands — ux-audit §6). If reasoning is *not* the cause, the
> fallback explanation is plain verbosity/slowness of the flash tier under load,
> which points at "raise the budget and/or pick a faster tool model" instead.

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

---

## 3. Recommended fixes (ordered by leverage)

### Fix 1 — Disable reasoning on the intake call *(highest leverage; do first)*

Pass a provider option that turns reasoning off (or to minimum effort) for the
intake `generateChecked`. With the AI SDK + OpenRouter provider this is a
`providerOptions: { openrouter: { reasoning: { enabled: false } } }` (or
`max_tokens: 0` for the reasoning slice) on the `generateText` call — **verify
the exact key against the installed `@openrouter/ai-sdk-provider` version**;
the only existing precedent in the repo is `extraBody` for image modalities
(`provider.ts:77`).

This is the one change that addresses **both** headline symptoms at once: a
non-reasoning flash classifier should return in a few hundred ms (under budget →
timeout rate collapses) and have the full 512 tokens for JSON (truncation →
gone). Plumb it as a `generateChecked` option so callers opt in per-agent rather
than globally (the post-turn simulant/director may legitimately *want*
reasoning).

A cheaper-but-blunter alternative if the provider flag is awkward: point intake
at a known non-reasoning tool model via `TOOL_MODEL` / a dedicated fast slug.
The `toolModelId()` slot already exists for exactly this role (`provider.ts:44`)
but intake currently resolves through `agentModelId` (`intake.ts:39`), so it
rides the shared agent default. Re-pointing intake at `toolModelId()` would let
the intake model be tuned independently of the post-turn agents.

### Fix 2 — Stop the orphaned call from polluting the turn

Two options; **do at least the first**, prefer both:

- **Minimal (contained to `intake.ts`):** give `generateChecked` a *buffering*
  sink, and only flush it to the real sink if intake **wins** the race. If the
  timeout wins, drop the buffer. Stops the noise; does not stop the wasted
  repair call.
- **Better (cancellation):** thread an `AbortSignal` from `withTimeout` into
  `generateChecked` → `generateText`. On timeout, abort: this kills the in-flight
  request *and* the wasted repair round trip. Teach `generateChecked` to treat
  an abort as "caller walked away" — return silently, push **no** `parse_failed`
  / `degraded`. This is the honest fix and saves the billed repair call.

Either way, the invariant to restore: **a timed-out intake produces exactly one
diagnostic — `agent.intake.timeout` — and nothing after it.**

### Fix 3 — Skip the repair round trip for intake

Intake is best-effort, latency-critical, and fully degradable. A repair round
trip is a *second sequential* LLM call (`generate-checked.ts:66`); with the
current latency profile it almost always runs orphaned and discarded. Add a
`repair?: boolean` (default true) to `GenerateCheckedOptions` and set it
`false` for intake: one attempt, then straight to the regex fallback. Removes a
guaranteed-wasted call and halves intake's worst-case tail. (The post-turn
agents keep repair — their result is worth a second try because nothing else
catches their miss.)

### Fix 4 — Right-size the diagnostics

- Let `generateChecked` callers choose the degrade severity (e.g.
  `degradeSeverity?: "warn" | "error"`, default `error`); set intake to `warn`.
  A best-effort fallback is a `warn`, not an `error`.
- Once Fix 2 lands, the `timeout` + `degraded` double-log for the same event
  goes away on its own (only one path fires).

### Fix 5 — Re-tune the budget on honest numbers *(the original M5 ask)*

After Fixes 1–2, re-measure with the dev turn HUD (ux-audit §6 / feature #7:
per-turn latency + intake-timeout rate, already in `/inspect`). Expectations:

- If reasoning was the cause, the 1.5 s budget (`INTAKE_TIMEOUT_MS`,
  `constants.ts:95`) should now pass on the large majority of turns — leave it.
- If a residual tail remains, the spec's **Open-question A** (first-token
  latency tolerance) is the governing product call. Given the narrator stream is
  ~30 s, spending an extra ~1–2 s of TTFT to *use* the intake the system is
  already paying for is plausibly worth it — but decide on the HUD's data, not
  vibes. Raising the budget is a one-line change once it's a deliberate call.

---

## 4. Suggested sequencing

Fix 1 (reasoning off) → re-measure → Fix 2 (abort + silent on walk-away) →
Fix 3 (skip repair) + Fix 4 (severity) as a small cleanup → Fix 5 (budget
re-tune) gated on the HUD. Fixes 1–4 are self-contained engine/`ai`-layer
changes with no schema or product implications; Fix 5 is the only one that needs
a product decision (Open-question A).

This also de-risks the **personality** work, which leans harder on intake:
`socialActs` / `narratedNpcBehaviors` tagging
([personality-and-state.plan.md](personality-and-state.plan.md) §1.3, already
shipped into the brief) only fires when intake **lands** — at a 91% fallback
rate those reactions almost never trigger today. Fixing intake reliability is a
prerequisite for the authored likes/dislikes loop actually working in play.

## 5. Cross-references

- Spec: [pre-narrator-agents.spec.md](pre-narrator-agents.spec.md) (§4.1
  latency, §4.2 resilience ladder, Open-question A).
- M5 tracking: [ux-audit.plan.md](ux-audit.plan.md) §6 — this doc supplies the
  "measure first" data it was gated on.
- Consumer at risk: [personality-and-state.plan.md](personality-and-state.plan.md) §1.3.
- Code: `src/server/engine/intake.ts` (`withTimeout`),
  `src/server/ai/generate-checked.ts` (repair ladder, severity),
  `src/server/engine/constants.ts` (`INTAKE_TIMEOUT_MS`,
  `INTAKE_MAX_OUTPUT_TOKENS`), `src/server/engine/pipeline.ts`
  (`assemblePreTurn` fan-out, `persistNarration` sink capture).
</content>
</invoke>
