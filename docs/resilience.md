# Resilience

The prime directive: **an error may degrade a turn, it must never disrupt the game.** A session must stay playable through malformed LLM output, a dead provider, a bad JSONB row, or a bug in one agent. This document defines the patterns every module uses to get there. They are not optional.

## 1. Boundary parsing: `parseOr`

Every value crossing a trust boundary — JSONB columns, LLM output, API request bodies, file payloads — goes through `src/lib/parse.ts`:

```ts
parseOr<T>(schema: ZodType<T>, raw: unknown, fallback: T, diag?: DiagnosticSink): T
parseOrNull<T>(schema: ZodType<T>, raw: unknown, diag?: DiagnosticSink): T | null
```

- Never `JSON.parse` + `schema.parse` inline. `parseOr` handles string-or-object input, catches, records a diagnostic, returns the fallback.
- Fallbacks are **schema defaults**, defined next to the schema (`emptyCharacterState()`, `emptyBrief()`), not ad-hoc literals at call sites.
- A failed parse is a diagnostic, not an exception. Exceptions are for programmer errors only.

## 2. Diagnostics

`src/contracts/diagnostics.ts`:

```ts
type Diagnostic = {
  severity: "info" | "warn" | "error";
  code: string;          // stable machine code, e.g. "agent.simulant.parse_failed"
  message: string;       // human-readable
  path?: string;         // where (schema path, table.column, module)
  context?: Record<string, unknown>;
};
```

- Everything that degrades records a diagnostic. Turn-scoped diagnostics persist on `turns.diagnostics`; they render in the dev Turn Inspector.
- A `DiagnosticSink` is just `{ push(d: Diagnostic): void }`; pipelines thread one through rather than logging from leaf functions.

## 3. LLM structured output: validate → repair → degrade

Wrapper in `server/ai`: `generateChecked({ schema, system, prompt, code, fallback?, … })`.

1. Plain-text generation with the JSON Schema rendered into the system message, then local extract → `JSON.parse` → zod parse. Deliberately NOT provider-side constrained decoding (`Output.object` / response_format): constrained decoding degenerated on some models into hollow-but-valid objects that all-defaulted schemas accepted without ever tripping repair (followups.phase2.md #20) — this ladder is the enforcement.
2. On validation failure: **one** repair round-trip (model sees its own output + the zod issues).
3. On second failure: return the schema's degraded default + an `error` diagnostic. Never throw into the pipeline.

Schema design rules that make this work:
- Keep each agent's schema **small** (one concern). Small schemas parse reliably; the old app's one giant `TurnParseResult` is the anti-pattern.
- `.default()` everything defaultable. `.catch()` on leaf enums/numbers so a single bad field doesn't reject the whole object.
- Quantities are clamped in the merge reducer regardless of what the schema allowed (`minutesAdvanced` 1–480, meter deltas −1–1, etc.). Trust nothing.

## 4. Independent agent failure

The four post-turn agents run in parallel and fail independently. The merge reducer consumes whatever subset succeeded:

- No simulant → no state changes this turn (clock advances by heuristic estimate).
- No archivist → no new facts/episode (a synthetic episode row is written from the narration's first ~300 chars so the window stays contiguous).
- No director → previous brief carries forward with `sceneSummary` refreshed heuristically.
- No continuity → no corrections, fine.

A turn reaches `status: "ready"` even if *every* agent failed — the player keeps playing; diagnostics tell the dev what degraded.

## 5. Turn-state machine and recovery

`turns.status: pending → narrating → processing → ready | failed`. Sessions have three states (`ready`/`narrating`/`processing`); a failed turn returns its session to `ready` — failure never wedges play. Recovery rules:

- Liveness is heartbeat-based: streaming and processing refresh `heartbeat_at` (~5s). On boot and on any turn start, turns/jobs whose heartbeat is >60s stale are failed and the session reset — a slow-but-alive stream is never clobbered.
- Session concurrency is guarded by an atomic compare-and-swap (`UPDATE sessions SET status='narrating' WHERE id=$1 AND status='ready'`) — a second concurrent submit gets a clean 409, not a race.
- Client disconnects don't abort turns: SSE writes are best-effort; narration persistence and the post-turn job proceed regardless.
- The post-turn merge is **one transaction**: partial agent application is impossible.

## 6. Demo mode

With no `OPENROUTER_API_KEY`, the app runs end-to-end: deterministic template narrative, heuristic post-turn results, hash-based pseudo-embeddings (1536-dim, recorded as `embedder: "pseudo"` and never compared against real vectors — see [memory.md](memory.md) §Embedder isolation). Demo mode is what CI exercises.

## 7. API and UI

- Route handlers: zod-validate input; error envelope `{ error: { code, message } }` with proper status; never leak stack traces.
- UI: every data surface tolerates `null`/missing (broken image → monogram fallback; absent state block → hidden panel, not a crash). Streaming client treats a dropped stream as "incomplete turn" with a retry affordance, not an unhandled rejection.

## 8. What is *not* tolerated

Degradation hides bugs if nobody looks. Hence: diagnostics are persisted, the Turn Inspector shows them, and tests assert on diagnostic codes — a test that triggers degradation asserts both the fallback behavior **and** the emitted diagnostic.
