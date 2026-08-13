# Resilience

The prime directive: **an error may degrade a turn, it must never disrupt the game.** A conversation must stay playable through malformed LLM output, a dead provider, a bad JSONB row, or a bug in one agent. This document defines the patterns every module uses to get there. They are not optional.

## 1. Boundary parsing: `parseOr`

Every value crossing a trust boundary — JSONB columns, LLM output, API request bodies, file payloads — goes through `apps/web/src/lib/parse.ts`, the application's barrel over the shared implementation in `@vesper/contracts`:

```ts
parseOr<T>(schema: ZodType<T>, raw: unknown, fallback: T, sink?: DiagnosticSink, path?: string): T
parseOrNull<T>(schema: ZodType<T>, raw: unknown, sink?: DiagnosticSink, path?: string): T | null
```

- Never `JSON.parse` + `schema.parse` inline. `parseOr` handles string-or-object input, catches, records a diagnostic, returns the fallback.
- Fallbacks are **schema defaults**, defined next to the schema (each shape's `empty*()` constructor), not ad-hoc literals at call sites.
- A failed parse is a diagnostic, not an exception. Exceptions are for programmer errors only.

## 2. Diagnostics

`apps/web/src/contracts/diagnostics.ts`, likewise a barrel over `@vesper/contracts` — the diagnostic contract is defined once for the whole workspace, so a package reports degradation through the same shape the app persists:

```ts
type Diagnostic = {
  severity: "info" | "warn" | "error";
  code: string;          // stable machine code, e.g. "agent.simulant.parse_failed"
  message: string;       // human-readable
  path?: string;         // where (schema path, table.column, module)
  context?: Record<string, unknown>;
};
```

- Everything that degrades records a diagnostic. Exchange-scoped diagnostics ride the memory trace; they render in the admin chat inspector.
- A `DiagnosticSink` is just `{ push(d: Diagnostic): void }`; pipelines thread one through rather than logging from leaf functions.
- **A pipeline that owns its collector still takes an optional `sink` so callers can watch.** Otherwise the run's degradation record is write-only — logged and dropped — and the only way to assert on it is scraping the log line, which pins a test to a message string rather than to behavior. The shape is `teeSink` (`contracts/diagnostics.ts`): keep the internal `DiagnosticCollector` that drives the log or the persisted `turns.diagnostics`, and fan each push to the caller's sink as well, so threading one in adds a reader without changing what the run records. Live today on `renderResolvedScene` and on `submitChatMessage`, whose diagnostics accrue through the settle step — a reader must drain the reply stream before the sink is complete.

## 3. LLM structured output: validate → repair → degrade

Wrapper in `server/ai`: `generateChecked({ schema, system, prompt, code, fallback?, … })`.

1. Plain-text generation with the JSON Schema rendered into the system message, then local extract → `JSON.parse` → zod parse. Deliberately NOT provider-side constrained decoding (`Output.object` / response_format): constrained decoding degenerated on some models into hollow-but-valid objects that all-defaulted schemas accepted without ever tripping repair (followups.phase2.md #20) — this ladder is the enforcement.
2. On validation failure: **one** repair round-trip (model sees its own output + the zod issues).
3. On second failure: return the schema's degraded default + an `error` diagnostic. Never throw into the pipeline.

Schema design rules that make this work:
- Keep each agent's schema **small** (one concern). Small schemas parse reliably; the old app's one giant `TurnParseResult` is the anti-pattern.
- `.default()` everything defaultable. `.catch()` on leaf enums/numbers so a single bad field doesn't reject the whole object.
- Quantities are clamped by the consuming reducer regardless of what the schema allowed (`minutesAdvanced` 1–480, meter deltas −1–1, etc.). Trust nothing.

### Worked example: time-box a new leg, and make its fallback the prior deterministic path

The cleanest shape this rule takes: a leg that could make a turn worse can never do so if its **degraded default is the deterministic code path that ran before it existed**. Two live cases in the chat lane:

- The one-turn intent reads (`chat-intent.ts`) are **regex-first, no LLM** — the safe baseline. The optional markup lane (`lib/message-spans`) only *upgrades* them to determinism when the player opts in; absent markup, behavior is exactly the regex baseline.
- Every LLM leg on the reply path runs `generateChecked` (the full ladder above) wrapped in a hard timeout (`withGenerateTimeout`). On timeout, generation failure, or demo mode it degrades to a safe default — a no-op or the prior state — and records a diagnostic; the reply never blocks on it.

The pattern to copy when adding a pre-reply check: make its fallback the deterministic step that runs without it, time-box it, and the new call is pure upside.

## 4. Independent leg failure

The chat lane's post-turn fan-out — the reaction **pulse** ‖ the **three extraction legs** — runs in parallel and fails independently. The finalize step consumes whatever subset succeeded:

- No pulse → no reaction/affinity change this exchange.
- No memory scribe → no new facts/episode (a synthetic episode row is written from the reply's first ~300 chars so the window stays contiguous).
- No character/continuity tracker → the state row keeps its old values.

An exchange settles even if *every* leg failed — the player keeps playing; diagnostics tell the dev what degraded (see §8's agent-failure telemetry, the counter-measure to this independence).

## 5. Reply lifecycle and recovery

A chat exchange streams the reply, then finalizes state. Recovery rules:

- The **reply-stream watchdog** (`withStreamTimeouts`) trips on a stalled provider — a first-token or overall timeout aborts the stream; whatever already streamed persists as the reply, and a zero-token stream surfaces an explicit "didn't reply" toast rather than a silently-vanishing bubble.
- Exchange concurrency is guarded by a **keyed per-chat lock** (`acquireKeyedLockWithin`) — a second concurrent submit waits a bounded window then fails cleanly, not a race. The atomic **rerun** stops any in-flight reply, waits, re-acquires the lock, and transacts.
- Client disconnects don't abort an exchange: SSE writes are best-effort; the reply persists and the post-turn jobs proceed regardless.
- The finalize memory writes are each internally transactional; a failed embedding degrades ([memory.md](memory.md)) instead of failing the exchange.

## 6. Demo mode

With no `OPENROUTER_API_KEY`, the app runs end-to-end: deterministic template narrative, heuristic post-turn results, hash-based pseudo-embeddings (1536-dim, recorded as `embedder: "pseudo"` and never compared against real vectors — see [memory.md](memory.md) §Embedder isolation). Demo mode is what CI exercises.

## 7. API and UI

- Route handlers: zod-validate input; error envelope `{ error: { code, message } }` with proper status; never leak stack traces.
- UI: every data surface tolerates `null`/missing (broken image → monogram fallback; absent state block → hidden panel, not a crash). Streaming client treats a dropped stream as "incomplete turn" with a retry affordance, not an unhandled rejection.

## 8. What is *not* tolerated

Degradation hides bugs if nobody looks. Hence: diagnostics are persisted, the chat inspector shows them, and tests assert on diagnostic codes — a test that triggers degradation asserts both the fallback behavior **and** the emitted diagnostic.

### Agent-failure telemetry (the counter-measure to §4)

§4's independence is correct and it is also a **blindfold**: a leg that fails on *every* exchange looks exactly like a leg that had nothing to say — the state row simply keeps its old values. A log line is not enough, because a failure that only reaches `fly logs` is found by accident or not at all.

So a failed agent leg leaves a **durable, tallied record with a suspected cause**:

- **Contract + classifier** — `contracts/turns/agent-failure.ts` (pure): the `kind` (`timeout` / `api_error` / `parse_failed`), a closed `cause` vocabulary, and `classifyAgentFailure`. A provider error is not a guess (the provider's own class passes through, via `classifyProviderError`); a parse failure is diagnosed by whether the JSON *stopped mid-object* (⇒ `output_cap_too_low`, a real and fixable bug) or was wrong from the start; a timeout blames the prompt only when the prompt is actually large.
- **Recording** — `server/ai/agent-failures.ts`, called from `generateChecked` (api/parse failures) and `withGenerateTimeout` (watchdog trips — the important one, since an aborted `generateChecked` returns silently by design and nothing downstream would ever hear about the miss). Fire-and-forget into the existing `events` table (`type = "agent_failure"`); **no migration** — this is append-only observability, which is what that table is for.
- **Reading** — `memory/agent-failure-log.ts` → `GET /api/admin/chat-inspector/[chatId]/agent-failures` → the **Agent health** panel at the top of the chat inspector: this conversation's failures, plus the all-conversations tally (a timing-out leg is usually an infrastructure story, not a per-chat one).
- **Successful runs too** (chat-plans-promises follow-up): a clean completion is ALSO recorded (`type = "agent_run"`, `recordAgentRun` in the same `withGenerateTimeout` success path) with its measured **latency**, the routed provider, and a one-line summary of what the leg produced ("3 facts · 1 episode · 2 queries"). The read side (`agentRunReport`) tallies runs by leg with **median/max latency**, and the panel renders a *"Completed runs — latency by leg"* view plus a *"Recent activity"* log. Because a failure record answers "is a leg dying?" but only a run record answers "when it lives, **how slow is it?**" — the diagnostic that separates a slow-but-alive endpoint from a dead one (the question a wall of `model_slow` timeouts can't).

**A failure is labelled by what actually failed.** `generateChecked` reserves `${code}.parse_failed` for output the model could not produce validly; a 429 / 402 / network drop emits `${code}.api_error` with the provider's class instead. The diagnostic, the log line, and the recorded failure all tell the same story.

Telemetry is **optional at the call site**: a leg that passes no `telemetry` is still counted (the leg id falls back to the diagnostic `code`), just with less to say about why. Wired today: the chat lane's pulse, the three extraction legs, and the per-member personal pass. Unwired (counted, not diagnosable): the detached chat jobs — pass `telemetry` when one of them next needs diagnosing.
