# Turn contracts

`turns/` defines the binding shapes between engine, agents, and UI: the four agent result schemas (`SimulantResult`, `ArchivistResult`, `ContinuityResult`, `DirectorResult`) — their field-level spec lives in [turn-engine.md](../turn-engine.md) §Post-turn agents and the zod source is the single truth — plus the SSE chunk event:

```ts
type TurnChunkEvent = { segmentIndex: number; speaker: string | null; content: string };
// speaker matches a session_participants.display_name, or null for narrator prose
```

Rules:

- Agent schemas reference world entities **by display name**, never db ids — models are bad at ids; deterministic resolvers ground names to rows (with embedding-fuzzy fallback) and emit diagnostics for misses (`merge.<agent>.unresolved_*` codes).
- Every agent schema field is `.default()`ed; the schemas double as their own degraded fallbacks ([turn-engine.md](../turn-engine.md) §Degraded defaults).
- Perception (phase 3, see [perception.md](../perception.md)): `SimulantResult` item/activity events may carry optional `salience: { visual, audible }`, and the result has a top-level `commsEvents` (`open`/`close`, `call`/`text`, `withName` → `runtime.commsLinks`); each `ContinuityResult.violations[]` entry carries `kind: "general" | "narrated_absent_character" | "reacted_to_unperceived_event"`.

## Intent brief

`turns/intent-brief.ts` — the **pre-narration** intake agent's output (phase-4 pre-narrator, [turn-engine.md](../turn-engine.md) §Intake agent), the one agent contract produced *before* the narration exists. Emitted on the **`tool` model** — which now has a second consumer (was: only the image scene composer). Like the post-turn agents it references entities **by display name** (present NPCs, items, locations), every field is `.default()`ed (so the empty brief is today's behavior), and it persists on the turn row (`turns.intent_brief` jsonb).

```ts
type IntentBrief = {
  actionType: "converse" | "move" | "observe" | "touch" | "manipulate_item"
            | "comms" | "rest" | "social_attempt" | "intimate" | "meta" | "other";  // default "other"
  // regex-SceneIntent mirror — sceneIntentFromBrief(brief) is lossless
  lookTarget?: string; touchTarget?: string; smellTarget?: string; tasteTarget?: string;  // NPC display names
  examineItem?: string;                                             // item name
  enterLocation?: string;                                           // location phrase
  addressedNpcs: string[];                                          // NPC display names
  // PERSISTED SEAMS — written in v1, not yet enforced:
  movement: { kind: "none" | "self" | "narrated_npc" | "co_travel_request" | "implied_subspace";
              destination?: string; coTravelTargets: string[] };   // movement-authority-spec consumes later
  appointment?: { withNpc?: string; location?: string; timePhrase?: string; reason: string };  // scheduled-arrivals-spec
  check?: { relevantAttributeIds: string[]; stakes: "low" | "med" | "high" };  // future attribute/skill-check resolution
  notes: string;                                                   // one-line rationale, diagnostics only
};
```

`sceneIntentFromBrief(brief)` adapts the mirror fields (`lookTarget`…`enterLocation`) back to the deterministic `SceneIntent` the prompt builders consume, and `intentBriefFromSceneIntent(detectIntent(input))` is the degraded fallback (movement/appointment/check seams empty) — both directions are lossless across the mirror fields. The three seam fields (`movement`, `appointment`, `check`) are recognized and stored now; their downstream resolvers (movement authority, scheduled arrivals, skill checks) are separate phase-4 specs.
