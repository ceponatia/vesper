# Agent reasoning profiles

The chat menu exposes an **admin-only, per-conversation Agent reasoning** control for comparing structured helper-agent behavior without changing the narrator model. The control is present on the shared conversation surface, so it applies to both ordinary character chats and successor-world chats that use that surface.

The setting is operational experiment configuration, not fiction state. It is stored on `character_chats.agent_reasoning_profile`, defaults to `off`, and is intentionally excluded from pre-exchange state and scenario snapshots. Deleting, editing, regenerating, or choosing **Another take** therefore does not roll the profile backward. A selection begins affecting the next eligible helper-agent call.

## Profiles

| Profile                             | Reasoning-enabled helper legs                                                      |
| ----------------------------------- | ---------------------------------------------------------------------------------- |
| `off` — Current — Off               | None. Existing reasoning-disabled behavior and budgets are preserved.              |
| `continuity` — Continuity           | Continuity extraction, character notes, and each ensemble member's personal notes. |
| `synthesis` — Synthesis             | Continuity profile plus the detached meanwhile pass and location-sketch agent.     |
| `broad_post_turn` — Broad post-turn | Synthesis profile plus long-term memory extraction and the reaction pulse.         |

The matrix is an allow-list in `apps/web/src/lib/agent-reasoning.ts`. New or unknown helper legs fail closed to reasoning disabled. Intake, romantic-permission decisions, NPC scene decisions, and contact/authority-sensitive classifiers are deliberately outside the matrix and remain reasoning-off under every profile.

## Provider and budget behavior

Eligible reasoning calls send OpenRouter high-effort reasoning with the reasoning trace excluded from the returned response. Their normal output allowance is multiplied by five, capped at **32,768 tokens**, so hidden reasoning does not consume the entire JSON completion budget. Their watchdog is multiplied by four, with a **20-second floor** and **120-second ceiling**. The `off` profile preserves each call's existing token cap and timeout exactly.

The longer watchdog is part of the experiment: a reasoning-capable agent should not be recorded as "no response" merely because it exceeded the old extraction-only wait. The ceiling prevents a malformed or oversized leg from waiting indefinitely.

## API and authorization

The UI reads and writes through the self-scoped admin route:

- `GET /api/admin/self/agent-reasoning/:chatId`
- `PATCH /api/admin/self/agent-reasoning/:chatId` with `{ "profile": "off" | "continuity" | "synthesis" | "broad_post_turn" }`

The canonical implementation is `apps/web/src/app/api/admin/agent-reasoning/[chatId]/route.ts`; the `/self/` route re-exports it. Both the wrapper and the update statement enforce owner-admin access. Unknown stored values heal to `off`; invalid PATCH values are rejected.

## Telemetry and comparison

Every covered helper call records both the selected profile and whether reasoning was actually enabled. The fields flow through successful-run and failure telemetry, including timeout, provider, and parse failures. The admin **Agent Health** inspector displays and searches the profile alongside model, provider, latency, prompt size, and output cap.

This distinction matters because a profile can be selected while a particular leg remains reasoning-off. Comparisons should use the recorded `reasoningEnabled` value, not infer activation from the chat's current selection after the fact.

## Main implementation points

| Concern                                                            | File                                                                                                      |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| Profile IDs, allow-list, provider options, token and timeout rules | `apps/web/src/lib/agent-reasoning.ts`                                                                     |
| Persisted column                                                   | `apps/web/src/server/db/schema.ts` / `drizzle/0097_agent_reasoning_profiles.sql`                          |
| Server-side profile lookup                                         | `apps/web/src/server/ai/agent-reasoning.ts`                                                               |
| Owner-admin API                                                    | `apps/web/src/app/api/admin/agent-reasoning/[chatId]/route.ts`                                            |
| Conversation-menu selector                                         | `apps/web/src/components/chat/agent-reasoning-select.tsx`                                                 |
| Covered post-turn and detached agents                              | `apps/web/src/server/engine/chat-memory.ts`, `chat-state.ts`, `chat-meanwhile.ts`, `chat-scene-sketch.ts` |
| Success/failure attribution                                        | `apps/web/src/server/ai/agent-failures.ts`, `generate-checked.ts`, `generate-timeout.ts`                  |
| Inspector display                                                  | `apps/web/src/components/chat/chat-inspector-agent-health.tsx`                                            |
