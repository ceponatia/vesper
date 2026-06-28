[← Contracts index](README.md)

# Turn contracts

`turns/` defines the binding shapes that pass between the engine, the agents, and the UI.

## Agent result schemas

The four post-turn agents each return a validated result:

| Schema | Agent |
| --- | --- |
| `SimulantResult` | Simulant |
| `ArchivistResult` | Archivist |
| `ContinuityResult` | Continuity |
| `DirectorResult` | Director |

Their field-level spec lives in [turn-engine.md](../turn-engine.md) §Post-turn agents, and the zod source is the single source of truth.

## The streaming chunk event

Narration streams to the UI as SSE chunk events:

```ts
type TurnChunkEvent = { segmentIndex: number; speaker: string | null; content: string };
// speaker matches a session_participants.display_name, or null for narrator prose
```

## Rules

- **Reference entities by display name, never db ids.** Models are bad at ids; deterministic resolvers ground names to rows (with embedding-fuzzy fallback) and emit diagnostics for misses (`merge.<agent>.unresolved_*` codes).
- **Every agent schema field is `.default()`ed.** The schemas double as their own degraded fallbacks ([turn-engine.md](../turn-engine.md) §Degraded defaults).
- **Perception (phase 3, see [perception.md](../perception.md)):**
  - `SimulantResult` item/activity events may carry an optional `salience: { visual, audible }`.
  - `SimulantResult` has a top-level `commsEvents` (`open` / `close`, `call` / `text`, `withName` → `runtime.commsLinks`).
  - Each `ContinuityResult.violations[]` entry carries `kind: "general" | "narrated_absent_character" | "reacted_to_unperceived_event"`.

## Intent brief

`turns/intent-brief.ts` is the **pre-narration** intake agent's output (phase-4 pre-narrator, [turn-engine.md](../turn-engine.md) §Intake agent) — the one agent contract produced *before* the narration exists.

It is emitted on the **agent model** (`agentModelId()`, which defaults to the state model and is overridable per-world from the World tab — the same resolver the post-turn agents use), **not** the tool model (that backs only the image scene composer). Like the post-turn agents, it references entities **by display name** (present NPCs, items, locations), every field is `.default()`ed (so the empty brief is today's behavior) — **except** the optional `focus` planner, whose *absence* is itself the degrade signal (see below) — and it persists on the turn row (`turns.intent_brief` JSONB).

```ts
type IntentBrief = {
  actionType: "converse" | "move" | "observe" | "touch" | "manipulate_item"
            | "comms" | "rest" | "social_attempt" | "intimate" | "meta" | "other";  // default "other"
  // regex-SceneIntent mirror — sceneIntentFromBrief(brief) is lossless
  lookTarget?: string; touchTarget?: string; smellTarget?: string; tasteTarget?: string;  // NPC display names
  examineItem?: string;                                             // item name
  enterLocation?: string;                                           // location phrase
  addressedNpcs: string[];                                          // NPC display names
  socialActs: { concept: string; target: string }[];               // directed interaction concepts; empty on regex fallback
  narratedNpcBehaviors: { npc: string; concept?: string; summary?: string }[];  // puppet-guardrail seam; empty on regex fallback
  // PERSISTED SEAMS — written in v1, not yet enforced:
  movement: { kind: "none" | "self" | "narrated_npc" | "co_travel_request" | "implied_subspace";
              destination?: string; coTravelTargets: string[] };   // movement-authority-spec consumes later
  appointment?: { withNpc?: string; location?: string; timePhrase?: string; reason: string };  // scheduled-arrivals-spec
  check?: { relevantAttributeIds: string[]; stakes: "low" | "med" | "high" };  // future attribute/skill-check resolution
  // PHASE-3 narration-focus planner — OPTIONAL (absent ⇒ buildResponseShape uses its deterministic derivation):
  focus?: { primaryResponse: "converse" | "answer_question" | "resolve_action"
                           | "react_emotionally" | "transition_scene" | "ooc_answer";
            reactionScale: "none" | "small" | "moderate" | "strong";          // authored band overrides this
            allowedNewTopic: "none" | "one_open_thread" | "urgent_scene_event";
            suggestedShape: "concise_exchange" | "scene_establishing" | "multi_party" | "action_resolution" };
  notes: string;                                                   // one-line rationale, diagnostics only
};
```

| Group | Fields | Notes |
| --- | --- | --- |
| Action | `actionType` | Defaults to `"other"`. |
| Mirror | `lookTarget`, `touchTarget`, `smellTarget`, `tasteTarget`, `examineItem`, `enterLocation`, `addressedNpcs` | The regex-`SceneIntent` mirror — `sceneIntentFromBrief(brief)` is lossless. Targets are NPC display names; `examineItem` is an item name; `enterLocation` is a location phrase. |
| Reaction seams | `socialActs`, `narratedNpcBehaviors` | `socialActs` are directed interaction concepts (`{ concept, target }`); `narratedNpcBehaviors` is the puppet-guardrail seam (`{ npc, concept?, summary? }`). Both empty on the regex fallback. |
| Seams (persisted, not yet enforced) | `movement`, `appointment`, `check` | Written in v1; downstream resolvers are separate phase-4 specs. |
| Narration focus (Phase 3) | `focus` | The intake agent's read of HOW to shape the response — `primaryResponse` / `reactionScale` / `allowedNewTopic` / `suggestedShape`. Consumed by `engine/scene.ts` `buildResponseShape` to enrich the "## Response shape" steers (narrator-prompt-focus §Phase 3). **`.optional()`, not `.default()`ed**: its absence (regex fallback / any degrade) tells `buildResponseShape` to fall back to its deterministic Phase-2 derivation. Never overrides deterministic authority — the **authored reaction band wins** over `reactionScale`. |
| Diagnostics | `notes` | One-line rationale, diagnostics only. |

**Conversion in both directions is lossless across the mirror fields:**

- `sceneIntentFromBrief(brief)` adapts the mirror fields (`lookTarget` … `enterLocation`) back to the deterministic `SceneIntent` the prompt builders consume.
- `intentBriefFromSceneIntent(detectIntent(input))` is the degraded fallback (the movement / appointment / check seams come out empty).

The three seam fields (`movement`, `appointment`, `check`) are recognized and stored now; their downstream resolvers (movement authority, scheduled arrivals, skill checks) are separate phase-4 specs.
