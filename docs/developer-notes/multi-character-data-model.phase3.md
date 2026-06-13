# Multi-character systems — data-model addendum

Status: **implementation reference**. The single consolidated list of
every schema/contract change the seven specs require, grounded against
the current code (verified 2026-06-11; phase-2 additions marked inline,
2026-06-12). Each item names its owning spec.
Migration workflow per CLAUDE.md: edit `src/server/db/schema.ts` →
`pnpm db:generate` → review SQL → `pnpm db:migrate`.

## New tables

```
participant_relationships            [cast-tiers-and-affinity]
  id, session_id
  from_participant_id                -- the edge OWNER (always an NPC)
  to_participant_id
  kind: "feeling" | "perceived"      -- perceived = owner's belief about
                                     --   the other's feeling toward them;
                                     --   only created for player edges
  value: int (−100..100)
  stage: text (derived, denormalized for queries)
  updated_at
  UNIQUE (session_id, from_participant_id, to_participant_id, kind)

fact_knowers                         [character-memory]
  fact_id → facts                    -- points at the VERSION known
  participant_id
  source: "witnessed" | "told" | "common"
  since_turn
  PRIMARY KEY (fact_id, participant_id)
  -- NOTE: rows do NOT migrate on supersedence (decision 20)

character_episodes                   [character-memory]
  id, session_id, owner_participant_id
  text, embedding vector(1536), embedder
  source_turn_id NULL, source_tick NULL
  salience: real NULL                -- affinity-swing magnitude if any
  perspective: boolean default false -- colored rewrite vs shared text
  created_at
```

## Column additions (existing tables)

```
world_links / session_links          [time-and-travel, npc-movement]
  travel_minutes: int default 1
  audibility: text NULL              -- reserved (decision 11); unused v1
  access: jsonb default '{"kind":"public"}'
      -- { kind: "public" } | { kind: "private", ownerParticipantIds }
      -- | { kind: "locked", keyItemId? } | { kind: "timeWindow", start, end }
  door_item_id NULL → items/instances  -- world: item id; session: instance id

locations / world overrides / session_locations   [proximity, offscreen]
  scale: text default 'room'         -- intimate|room|hall|open|expanse
  area: text NULL
  affordances: jsonb default '[]'    -- [{ id, label, attention?, durationId? }]

world_cast / session_participants    [cast-tiers]
  tier: text default 'minor'         -- major|minor|extra
  (world_cast.start_world_location_id exists & is honored — verified)

world_cast                           [cast-tiers; phase-2-plan T1]
  relationships: jsonb default '[]'  -- [{ toward: castName | "player",
                                     --    stage }]; spawn seeds
                                     --    participant_relationships at
                                     --    stageMidpoint, reverse edge
                                     --    implied unless authored

worlds                               [cast-tiers, decision 47]
  player_start_world_location_id NULL

facts                                [character-memory]
  canon: boolean default true        -- false ⇒ belief only (decision 19)
  witnessed_by: jsonb default '[]'   -- participant ids; WRITE NOW
                                     --   (decision 3), read when ledger ships

characters (library)                 [cast-tiers]
  faction tags → inside profile (no column; see profile below)

lore_chunks                          [character-memory, decision 22]
  knower_scope: jsonb default '{"kind":"all"}'
      -- { kind: "all" | "tags" | "characterIds" | "none", ... }
```

## Contract / registry changes (no migrations)

```
contracts/actions/registry.ts (NEW)              [time-and-travel, proximity]
  { id, label, minutes, aliases: string[],
    meterEffects?: [{ meterId, delta? , set? }],
    requiredTier?: ProximityTier }
  + actionById(), matchAction(text) helpers; registry tests

contracts/relationships/stages.ts (NEW)          [cast-tiers]
  { id, label, min, max }   -- hostile…devoted; boundaries are DATA
  + stageForValue(); per-world override hook later

contracts/perception/ (NEW)                      [presence-and-perception]
  detection channels: { id: "sight" | "hearing", ... }   -- extensible
  salience: { visual: "obvious"|"subtle", audible: "loud"|"quiet"|"silent" }
  attention: "engaged_with" | "absorbed" | "idle_alert" | "asleep_or_impaired"
  attentionHint: "absorbing" | "faces_away" | "outward"  -- on items/affordances
  proximity tiers: "distant"|"apart"|"near"|"close"|"contact"|"entwined"
  witness lookup table (attention × salience → perceived?)

contracts/world/profile.ts (CharacterProfile)    [several]
  schedule entries: + days?: number[]            -- day-of-week mask
  + goals?: string[]                             -- movement drive 3
  + factionTags?: string[]                       -- decision 44 (tag now)
  + normStances?: [{ normRule, stance }]         -- decision 45
  + senseProfile?: [{ channelId, acuity }]       -- future non-human senses

contracts/state/participant-state.ts             [proximity, presence]
  (nothing — proximity/attention live in runtime/derived state, not here)

contracts/items/item.ts                          [perception, offscreen]
  + attentionHint?: "absorbing"|"faces_away"|"outward"
  + affordances?: string[]                       -- item-contributed

meters registry                                  [npc-movement]
  + seeks?: string                               -- affordance id sought

contracts/state (NextTurnBrief)                  [npc-movement; phase-2-plan T9]
  + arrivals/departures lines ("Mara arrived from the market") —
    written by the merge from schedule ticks now, by traversal later;
    co-located ⇒ perceived interim rule until presence gates them
```

## Session runtime additions (`session.runtime`, parseOr-safe defaults)

```
proximity: Record<pairKey, { tier, engagements?: [...] }>   -- sparse
commsLinks: [{ kind: "call"|"text", withParticipantId, since }]
pendingComms: [{ fromParticipantId, kind, urgency, gist, at }]
lastInteractedTurn: Record<participantId, number>           -- NEW (was never built)
lastWorldTickAt: number (clock minutes)
lodTiers: Record<participantId, "active"|"background"|"dormant">
encounteredParticipantIds: (exists) — semantics change: FULL encounters only
```

## Agent schema additions (`contracts/turns/agent-results.ts`)

All additive, `.default([])`, `.catch()` on enums per house pattern:

```
simulant +
  proximityEvents: [{ a, b, toTier, engagement? }]
  affinityAdjustments: [{ a, b, delta (clamped ±5), reason? }]
  commsEvents: [{ op: "open"|"close", kind, withName }]
  salience on itemEvents/activityUpdates: { visual?, audible? }  -- optional,
      defaults obvious/quiet by action kind

archivist +
  disclosures: [{ factIndex | factText, toldToNames: string[] }]

continuity + (violation kinds)
  "narrated_absent_character" | "reacted_to_unperceived_event"
  (existing violations schema is freeform subject/claim — these become
   conventions in the prompt + a kind field if needed)

director +
  castSignals (already specced in emergent-cast)
  spawnSignals: [{ templateName, count, encounterHintId }]   -- decision 42
  urgentComms: [{ fromName, reason }]                        -- decision 8

world-tick (NEW agent, offscreen-simulation)
  offscreenEvents: [{ participantName, kind: "action"|"social"|"move"|
    "commsIntent", summary, toLocationName?, withName?, driveCited,
    itemEffects?: RESERVED }]
```

## Constants (`engine/constants.ts`)

```
DEFAULT_LINK_TRAVEL_MINUTES = 1
MAX_CHAINED_ACTIONS = 2
WORLD_TICK_MINUTES = 30
ACTIVE_LOD_CAP = 8            -- decisions 1–2
MAJOR_TIER_SOFT_CAP = 6       -- decision 46
AFFINITY_DELTA_CLAMP = 5
PERSPECTIVE_MEMORY_SALIENCE_MIN  -- affinity-swing trigger (tune)
FOLLOW/APPROACH thresholds    -- existing FOLLOW_THRESHOLD + new approach
REST_CLAMP_MINUTES            -- declared-rest (decision 38), > 480
SCHEDULE_JITTER_MINUTES = 15  -- seeded (decision 33)
```

## Diagnostics (new codes, per resilience.md)

```
merge.movement.unmotivated / .engaged / .unreachable
merge.movement.access_denied         -- player-side, phase-2-plan T8
merge.proximity.invalid_tier / .inconsistent (open/expanse clamp)
merge.salience.defaulted
merge.affinity.unresolved_pair
tick.event.ungrounded / .names_background (info) / .item_power_denied
memory.disclosure.unresolved_listener
spawn.start_location.unset (info)
```

## Verified-against-code notes

- Held/worn item placement is holder-relative (`schema.ts:273–307`):
  items move with movers automatically. No change.
- `spawn.ts:284–322`: `startWorldLocationId` honored; player anchors to
  companion/first cast. Only authoring surfaces are missing.
- `pipeline.ts:452`: `turnsSinceInteraction` was never populated —
  `lastInteractedTurn` runtime tracking is net-new work.
- Canonical character blocks render in the **static rulebook** for all
  NPCs (cache-stable). Presence filtering happens in **turn context
  only** — do not touch the rulebook per-move.
- Segmenter accepts tags for all session NPCs (liberal); only the
  narrator's present-list needs comms participants appended.
- `ambient.light` already exists on locations — the darkness model
  composes daylight band × ambient light with zero new authoring.
```
