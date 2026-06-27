[← Contracts index](README.md)

# Pinned state shapes

These are the **binding** schemas behind every JSONB column in the database ([database.md](../database.md)). They live in `contracts/state/` and `contracts/world/`, and each exports an `empty*()` default used as the `parseOr` fallback.

## Where each shape is stored

| Shape | Lives on | What it is |
| --- | --- | --- |
| `ParticipantState` | `session_participants.state` | A participant's live state this session. |
| `CharacterProfile` | `characters.profile` / `session_participants.snapshot` | The authored character (and its spawn snapshot). |
| `SessionRuntime` | `sessions.runtime` | Session-wide bookkeeping. |
| `StoryThread` | inside `SessionRuntime` | One open narrative thread. |
| `StagedIntent` | inside `SessionRuntime` | A director-staged off-screen NPC move. |
| `NextTurnBrief` | `sessions.brief` | What the next turn needs to know. |
| `ExposureMask` | inside `NextTurnBrief` | The per-sense narration proximity gate. |
| `SceneGenState` | `sessions.scene` | Scene-image generation cadence. |
| `WorldStyle` | `worlds.style` | A world's tone, calendar, and norms. |
| `LinkAccess` | `world_links` / `session_links`.`access` | Who/when a location link admits. |

## ParticipantState

A participant's live state for this session — overlays, meters, conditions, and what they're currently doing.

```ts
type ParticipantState = {
  attributeOverlays: AttributeValue[];        // shadow profile base values by id
  meters: Record<string, number>;             // meterId → current value
  conditions: ActiveCondition[];
  activity: string;                           // "idle", "cooking dinner", …
  posture?: string;
  notes: string[];                            // short-lived mechanical notes for the narrator
};
```

## StoryThread

One open narrative thread the session is tracking.

```ts
type StoryThread = {
  id: string; title: string; summary: string;
  kind: "investigation" | "ongoing";          // investigation tracks a goal; ongoing is a standing topic only updated
  status: "open" | "cooling" | "resolved" | "archived";
  source: "anchor" | "emergent" | "player";
  question: string;                           // investigation: the core question/goal in one line
  closeConditions: string[];                  // investigation: the events that would close it
  developments: StoryThreadDevelopment[];     // accumulated major beats, oldest→newest (capped in the merge)
  openedAtTurn: number; lastTouchedTurn: number; touchCount: number;
};

type StoryThreadDevelopment = {               // one accumulated beat; kind is a display-only soft tag
  turn: number;
  text: string;
  kind: "evidence" | "statement" | "event" | "lead" | "update";
};
```

## SessionRuntime

Session-wide bookkeeping — threads, where the player has been, who they've met, active links, staged NPC moves, and flags.

```ts
type SessionRuntime = {
  storyThreads: StoryThread[];
  visitedLocationIds: string[];
  encounteredParticipantIds: string[];           // full (sight) encounters only — see ../perception.md first-impression fidelity
  unlockedLoreIds: string[];
  lastInteractedTurn: Record<string, number>;  // participantId → turn number of last targeted interaction
  lastAffinityDecayAt?: number;                // session clock-minutes through which affinity decay has been applied (whole weeks)
  commsLinks: Array<{ kind: "call" | "text"; withParticipantId: string; since: number }>;  // active call/text links (../perception.md §Comms)
  pendingComms: Array<{ fromParticipantId: string; kind: "call" | "text"; gist: string; urgency: "low"|"normal"|"high" }>;  // NPC-initiated messages, surface-once; written by the movement system on a staged beat's arrival (../turn-engine.md §Director-staged movement)
  stagedIntents: StagedIntent[];                 // director-staged off-screen NPC moves + on-arrival beats (phase-4 npc-movement minimal slice; ../turn-engine.md)
  flags: Record<string, boolean>;
};
```

## StagedIntent

A director story decision — walk an NPC off-screen and fire a beat on arrival — executed by `engine/movement.ts`.

```ts
type StagedIntent = {                            // a director story decision, executed by engine/movement.ts
  id: string;
  participantId: string;                         // the NPC being walked off-screen
  destinationLocationId: string;
  reason: string;                                // the verifiable reason (propose-and-audit)
  threadId?: string;                             // optional link to the narrative thread it serves
  onArrival: { comms?: { kind: "call" | "text"; gist: string; urgency: "low"|"normal"|"high" }; directive?: string };
  status: "active" | "resolved" | "cancelled";
  openedAtTurn: number;
  expiresInTurns: number;                        // give-up budget (STAGED_INTENT_DEFAULT_BUDGET)
};
```

## ExposureMask

The per-sense narration proximity gate, set by the director. Each sense is dialed up only as the player gets closer.

```ts
type ExposureMask = {                          // per-sense narration proximity gate, set by the director
  appearance: "ambient" | "close" | "intimate";
  scent: "none" | "ambient" | "close" | "intimate";
  touch: "none" | "close" | "intimate";
  taste: "none" | "close" | "intimate";        // most-intimate sense; raised by a taste/kiss/lick intent (also raises touch)
};
```

## NextTurnBrief

Everything the next turn needs — the scene so far, character notes, directives, and the exposure gate.

```ts
type NextTurnBrief = {
  sceneSummary: string;
  storySoFar: string;
  characterNotes: string[];
  directives: string[];                       // includes ≤2 continuity "Correction: …" lines
  memoryQueries: string[];                    // consumed by the NEXT turn's pre-turn retrieval
  exposure: ExposureMask;
  atmosphere: AtmosphereLabel;                // scene tone (scene-atmosphere.spec.md): director-emitted, sticky; feeds the mood drift; default "calm"
  droppedEvents: string[];                    // merge-dropped agent events, surfaced as gentle corrections
  arrivals: string[];                         // schedule-tick staging ("Mara arrived from the market.") —
  departures: string[];                       //   per-turn, never carried forward; default [] (old briefs parse unchanged)
};
```

## SceneGenState

Controls how often scene images are generated. There's no subject field — the composer picks the focal NPC from whoever is co-located with the player.

```ts
type SceneGenState = {                        // no subject field: the composer picks the focal NPC
  interval: number;                           // every N turns; 0 = off
  lastGeneratedTurn?: number;                 // turn number when an image was last generated
  status: "idle" | "generating" | "failed";   // (docs/images.md §Scene images)
  referenceMode: "single" | "multi";          // single = one identity anchor; multi = up to three references via Venice /image/multi-edit
};
```

## CharacterProfile

The authored character: bio, personality, body-config, attributes, default outfit, and schedule.

```ts
type CharacterProfile = {
  bio: string; personality: string; voice?: string;
  speciesId: string;                          // registry id ("human" / "succubus" / "faerie" / …)
  heritageId?: string;                        // optional heritage within the species (overlay); absent ⇒ bare species
  bodyPlanId: string;                         // registry id ("humanoid" seeded)
  intimateRegions: string[];                  // body-config: present intimate region groups (default []); see body.md §realized body
  bodyFeatures?: string[];                    // additive feature groups; absent ⇒ species defaults, [] ⇒ explicit none
  attributes: AttributeValue[];               // base/creation-sourced
  tags: string[];                             // reusable disposition tags social-reaction cards key overrides on
  preferences: Preference[];                  // bespoke likes/dislikes resolved against a classified social act
  socialCards: SocialReactionCard[];          // the character's own default lines/taboos (tried before the world's)
  traits: TraitValue[];                       // atomic personality traits — numeric scalars with registry-defined bands
  playerRelationship: { stage: string; note: string };  // authored default stance (stage id + one-line note); seeds the character chat
  aliases: string[];
  defaultOutfit: string[];                    // item definition ids (owner's library)
  schedule?: Array<{ startMinute: number; endMinute: number; locationName: string; activity: string;
                     days?: number[] }>;      // weekday mask, 0 = Sunday; absent ⇒ every day
};
```

See [body.md](body.md) §The realized body for `intimateRegions` / `bodyFeatures`.

## WorldStyle

A world's tone, calendar start, meter overrides, and social fabric.

```ts
type WorldStyle = {
  directives: string[];                       // tone/era/pacing/content notes
  narratorGuidance?: string;
  calendarStart: { year: number; month: number; day: number; hour: number; minute: number };
  meterOverrides?: Record<string, Partial<MeterDefinition> | null>;  // null disables a meter
  socialCards: SocialReactionCard[];          // the world's social fabric — inline snapshot
                                              // copies of taboo/social-rule cards (the card
                                              // library is `social_cards`). See
                                              // social-reaction-cards.plan.md. Replaced the
                                              // former freeform `norms`.
};
```

`SocialReactionCard` (`contracts/personality/cards.ts`) carries `{ id, label, description, kind: "social_rule"|"taboo", triggers: conceptId[], severity: 0–100, defaultReaction?, reactionOverrides: [{ tag, toReaction }] }`. `severity` → a tier (`severityToTier`) → a ramped base intensity; a matched card resolves to a `SocialReaction` that rides the §6 curve (no raw deltas). A character carries its own cards on `CharacterProfile.socialCards`, tried before the world's.

## Link access

`world/access.ts` decides who and when a location link admits. It's stored as JSONB on `world_links` / `session_links` and parsed once at the bundle boundary (malformed or absent ⇒ `public`, today's behavior):

```ts
type LinkAccess =
  | { kind: "public" }
  | { kind: "private"; ownerParticipantIds: string[] }   // discourages future NPC pathing; no player effect v1
  | { kind: "locked"; keyItemId?: string }               // keyItemId reserved — v1 blocks even a key-holder
  | { kind: "timeWindow"; start: number; end: number };  // minutes-of-day, [start, end), wraps past midnight
```

`checkLinkAccess({ access, minuteOfDay, moverParticipantId?, door? })` is the one traversal rule — passable, or blocked-with-reason. The merge's player-movement validation uses it now, and phase-4 NPC traversal reuses it.

A bound door item instance (`session_links.door_item_id`) whose state is closed+locked seals the link **regardless of `kind`** (`ItemInstanceState.locked`, an optional boolean). Blocked player moves drop with `merge.movement.access_denied` (see [turn-engine.md](../turn-engine.md)).

## Game time

`src/lib/clock.ts` (pure) derives `GameTime` from `clock_minutes` + `style.calendarStart`. It provides:

- `weekdayIndex` / `dayIndex` — for schedule day masks and per-day deterministic seeds, and
- a `daylightBand` helper — **dawn** 05–07 · **day** 07–18 · **dusk** 18–20 · **night** otherwise —

so consumers never re-derive hours themselves.
