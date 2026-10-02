# Exchange traces

Every admitted chat exchange, on the legacy lane and the sim-routed lane, writes one
durable **exchange trace**. The trace records:

- the ordered stages the exchange ran, and what each one did
- which context families reached the narrator
- which agent legs it spawned
- how it ended

The chat inspector's **Exchange trace** panel and the `pnpm trace:chat` CLI both read these
rows, through the same read model. A reply can look fine yet run degraded; the trace pins
that down to the exact stage, leg, or missing context that diverged.

## Owns / does not own

- Owns:
  - the trace identity and its persisted shape in `events`
  - the stage and coverage vocabularies
  - the outcome derivation
  - the read model, the inspector route, and the CLI
- Does not own:
  - what each stage does — see [pipeline.md](pipeline.md), [post-turn.md](post-turn.md),
    and [../engine/narration.md](../engine/narration.md)
  - the per-leg failure classifier — see [../resilience.md](../resilience.md) §8.
  - how a reply that never arrived is classified — see [reply-failures.md](reply-failures.md)

## Where it lives

- Contract, vocabularies, pure assembler and the versioned JSON output —
  `contracts/turns/chat-exchange-trace.ts`.
- Recorder (`startExchangeTrace`, `noopExchangeTrace`) — `server/engine/chat-exchange-trace.ts`.
- Read model (`loadChatExchangeTraces`) — `server/memory/chat-exchange-trace-log.ts`.
- Inspector route — `GET /api/admin/chat-inspector/:chatId/traces`, plus its `/self/` twin
  ([api.md](api.md) §The `/self/` mirror). Panel: `components/chat/chat-inspector-exchange-trace.tsx`.
- CLI — `scripts/chat-trace.ts` (`pnpm trace:chat`).

## Laws

### Identity and admission

- A trace is minted only once an exchange is **admitted**:
  - on the legacy lane, after `submitChatMessage` holds the exchange lock;
  - on the sim lane, after `runSimChatExchange` passes its authority and catching-up gates.
- A request refused before that point has no trace. That covers a validation 400,
  `chat_busy`, `world_catching_up`, and a sim-lane refusal.
- A legacy rejection that returns before doing any work (`nothing_to_regenerate`, a refused
  rerun target) never flushes, so it persists nothing.
- The trace id is stamped on `meta.traceId` of the rows the exchange writes, through the
  `chat-message-meta` constructors:
  - the reply, where it names the exchange that last generated the row (a take switch does
    not move it);
  - the player line, for `send`.
- These are not traced:
  - transcript edits and deletes
  - take switches
  - agent runs inside detached jobs (`chat_summary`, `chat_meanwhile`, scene renders)

  An exchange that **enqueues** one of those jobs records the enqueue as a stage.

### Storage and privacy

- A trace is stored in the `events` table under `type = "chat_trace"`. It has no table of its
  own and needs no migration. Rows cascade with their chat and expire under the table's
  30-day retention ([../database/README.md](../database/README.md) §Operational tables).
- The recorder buffers in memory and writes **parts**: one `events` row per flush, holding
  only what was not yet written.
  - The legacy lane flushes at the narrator handoff, at the end of settle, on every early
    return, and on the catch-all path.
  - The sim lane flushes when the exchange finishes or fails.
  - Late stages (the shadow pass, a scene enqueue) flush their own part.
- No flush is awaited, and no recorder method throws.
- A part's payload holds only ids, enum values, stable codes, counts, sizes, durations, and
  hashes.
- Free text rides the `logEvent` `content` split and is **never stored in production**. That
  covers a stage's `detail`, a coverage entry's `summary`, and a diagnostic's `message`.
- A diagnostic's `context` is never stored at all.
- Nothing else is ever recorded: no prompt text, reply text, secret, header, request body, or
  model reasoning.
- What the narrator received is recorded as a **fingerprint**:
  - the rendered prompt-node unit ids, with their sizes and hashes;
  - the instruction and assembled-system hashes that `meta.narratorRun` also carries.

### Stages

Each stage carries:

- a per-trace `seq`, assigned when the stage begins, so stages order by start
- a phase, a start, a duration, and a status
- a stable `reason` whenever the status is not `success`
- on model stages, the model id, provider, and attempt count

| Phase       | Meaning                                                     |
| ----------- | ----------------------------------------------------------- |
| `admission` | Lock or command admission, and the persisted player line    |
| `prepare`   | State, window, recall and context assembly before the call  |
| `narrator`  | Narrator prompt assembly and generation                     |
| `settle`    | Reply persistence and the post-reply fan-out it awaits      |
| `post_turn` | Fire-and-forget work after settle (shadow pass, job queues) |

| Status     | Meaning                                                  |
| ---------- | -------------------------------------------------------- |
| `success`  | Ran and produced its normal result                       |
| `degraded` | Ran, but on a fallback path; `reason` names the fallback |
| `failed`   | Did not produce a result; `reason` names why             |
| `skipped`  | Did not run, for a known and meaningful reason           |
| `retried`  | Succeeded only after more than one attempt               |
| `blocked`  | Refused by a gate                                        |

- A stage still open when a part is flushed is written without a status. It reads back as
  `failed` until a later part closes it. Parts merge by `seq`, and the latest part wins.
- A stage is recorded `skipped` only where its absence is meaningful on that path. A lane
  never records a stage it does not have.
- The legacy lane records these stages:
  - `admission.lock`, `admission.user_line`
  - `state.rollback`, `state.load`, `state.drift`
  - `history.window`, `jobs.summary_enqueue`, `ensemble.load`
  - the five `prepare.*` stages: `recall`, `beats`, `presentation`, `contact`, `guidance`
  - `narrator.prompt`, `narrator.stream`, `reply.persist`
  - the `settle.*` stages: `npc_decision_begin`, `finalize`, `members`, `wardrobe`,
    `npc_decision_finish`, `contact_events`, `permission`, and `settle.error` when settle
    itself throws
  - `post_turn.shadow` (on `successor_shadow` chats only) and `jobs.scene_enqueue`
- `narrator.stream` ends:
  - `failed`, with the reply-failure code, when no reply settled
  - `degraded`, with the provider's error code, when a provider error mid-stream kept
    partial text
  - `degraded` (`watchdog_timeout`) when a watchdog trip kept partial text
  - `retried` when the narrator spent more than one attempt
  - `success` otherwise, with reason `player_stop` when the player stopped it
- The sim lane records `sim.admission`, `sim.turn`, `sim.cut` (retakes), `sim.context`,
  `sim.time`, `sim.travel`, `sim.narrator`, and `sim.persist`.
  - `sim.narrator` is `degraded` or `retried` from the render's own signals.
  - The header carries the branch, cut, branch version, and sequence range.

### Narrator context coverage

Each context family the narrator can receive is recorded **where it is computed**. It is never
inferred from the assembled prompt, because by then a flag-off family, an empty one, and a
failed one are the same absent key.

| Status       | Meaning                                                             |
| ------------ | ------------------------------------------------------------------- |
| `present`    | Computed, and at least one item reached the prompt                  |
| `empty`      | Computed, legitimately nothing (a first exchange has no summary)    |
| `suppressed` | Off by flag (`flag_off:<FLAG>`) or by policy (`policy:<what>`)      |
| `degraded`   | Reached the prompt from a fallback; `reason` is the diagnostic code |
| `missing`    | Its source was unavailable; nothing reached the prompt              |

- Families: `history`, `summary`, `memory.facts`, `memory.episodes`, `memory.callback`,
  `scene`, `actor_state`, `relationship` (ensemble only), `schedule_time`,
  `physical_guidance`, `visual_state`, `garments`, `affordances`, `contact`, `directives`.
- Some sim-lane loaders degrade a failed read to the same value as a genuine absence, so
  `summary`, `memory.episodes`, `actor_state`, `relationship` and `garments` read `empty` in
  both cases. On the sim lane, only `schedule_time` (no branch clock) and the solo cut's
  `scene` (a failed space read) can report `missing`.

### Correlation

- `AgentTelemetry.traceId` rides every `agent_run` and `agent_failure` row that an exchange's
  legs write: the pulse, the three extraction legs, the personal pass, and the NPC
  scene-decision and romantic-permission classifiers.
- On the sim lane, `composition_fallback` rows carry it too.
- The read model joins those rows to their trace by `traceId` in SQL. So newer activity on the
  same chat never crowds out an older trace's failures.
- The coordinator attaches its per-exchange diagnostics (severity, code, path) to the trace at
  settle, and on every failure path.

### Outcome

The outcome is derived from the persisted evidence, checked in this order:

| Persisted evidence                                       | Outcome      |
| -------------------------------------------------------- | ------------ |
| No finish record                                         | `incomplete` |
| Finish `failed`                                          | `failed`     |
| Finish `stopped`                                         | `stopped`    |
| Finish `ok`, with any degradation signal (listed below)  | `degraded`   |
| Finish `ok`, with none of them                           | `ok`         |

- The degradation signals are: a degraded, failed, or retried stage; degraded or missing
  coverage; a `warn` or `error` diagnostic; a correlated agent failure; a correlated
  composition fallback.
- An `incomplete` trace never reads as success.
- `highlights` lists:
  - the first failed stage
  - degraded and retried stages
  - missing, degraded, and suppressed coverage
  - each composition fallback, with the stage that produced it when that can be linked

## Reading a trace

- Both readers emit the contract's versioned output, `{ schemaVersion: 1, chatId, traces }`,
  newest first by when each exchange **started** — a late part (the shadow pass, a scene
  enqueue) never reorders an older exchange ahead of a newer one.
- The inspector route takes:
  - `limit` — default 10, clamped to 1–50; a non-numeric `limit` is a 400
  - `traceId`
  - `messageId` — matches any trace whose prompt, reply, or guard id is that message, so a
    regenerated reply lists every exchange that wrote it
- The CLI takes `--chat <chatId>` and at most one selector: `--latest` (the default),
  `--message <id>` (every trace naming that message, newest first, up to 10 unless `--limit`
  says otherwise), `--trace <id>`, or `--limit <n>` (1–50) alone for the newest traces.
  `--json` prints the versioned output and nothing else on stdout. Exit codes:
  - 0 when traces are found
  - 1 for an unknown chat, no matching trace, or a database error. With `--json`, stdout still
    gets a valid empty document.
  - 2 for a usage error
- The CLI needs no web authentication. It runs inside the trusted app environment, the same
  boundary as `report:npc-scene-decisions`. Against production, run it on the Fly machine:

  ```bash
  fly ssh console -a vesper -C "pnpm trace:chat --chat <chatId> --latest --json"
  ```

  When the SSH tunnel is unavailable, reach the machine through the Machines API instead:

  ```bash
  fly machine exec <machine-id> -a vesper 'pnpm trace:chat --chat <chatId> --latest --json'
  ```

- A production trace carries no text by design. A development trace also shows each stage's
  detail, the coverage summaries, and the diagnostic messages.
