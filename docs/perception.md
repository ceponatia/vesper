# Presence & perception

`src/contracts/perception/` (pure rules) + the turn-engine seams that consume
them. This system answers two questions every turn — **who is present to the
scene**, and **who perceived what happened** — and enforces the answers in the
prompt and the post-turn audit. It fixes the two failure modes of a naive
narrator: absent characters drifting into the scene, and everyone in a room being
silently omniscient.

Shipped in phase 3 (presence & perception v1 — see
[developer-notes/phase-3-plan.md](developer-notes/phase-3-plan.md) and the
[presence](developer-notes/presence-and-perception-spec.phase3.md) /
[proximity](developer-notes/proximity-spec.phase3.md) specs). The rules are pure
and unit-tested (`contracts/perception/perception.test.ts`); the engine wiring is
deterministic and snapshot/merge-tested.

## Presence channels

Each turn, every participant is classified into one **channel** relative to the
player's scene (`contracts/perception/channels.ts`):

| Channel | Condition | Narrator rights |
| --- | --- | --- |
| `sight` | co-located at perceivable proximity | full presence — act, speak, be described |
| `sound` | audibility-linked location | reserved (the cross-location sound channel is phase 4); kept in the enum so nothing changes when it lands |
| `comms` | an active call/text link | may speak, but is **not** physically here — no action, no appearance, cannot be touched |
| `absent` | none of the above | may be **referenced** or remembered, never **enacted** |

`classifyPresenceChannels(bundle, activeLocationId, staged?)` computes the map
(co-located ⇒ `sight`; an active `runtime.commsLinks` entry or a this-turn comms
staging ⇒ `comms`; otherwise `absent`). The "Who is where" roster
(`buildPresenceRoster`) renders sight-present characters as `Present`, comms-present
on an `On call/text` line, and the rest as `Nearby`/`Elsewhere`. The static
rulebook's **Presence fidelity** rules turn this into law: an `Elsewhere`
character who acts or speaks is a continuity violation; reported speech ("she told
me yesterday…") is always fine, a fresh line of dialogue from an absent character
never is.

### Comms v1 (player-side)

A player can call or text an otherwise-absent character. The flow:

1. **Intent + staging** (pre-turn): `detectCommsIntent(input, npcNames)` spots "I
   call/phone/ring/text/message X". The target is staged as `comms`-present for
   this turn (so the narrator may voice them over the phone) and added to the
   speaker-tag name list so their dialogue segments into bubbles.
2. **Persistence** (post-turn): the simulant emits `commsEvents` (`open`/`close`,
   `call`/`text`, `withName`); the merge resolves the name and writes
   `runtime.commsLinks` so the link survives across turns. Unresolved names drop
   with `merge.comms.unresolved`; opens/closes log `comms_link_opened` /
   `comms_link_closed` events.
3. **Surface**: a "Messages & calls" turn-context line lists active links and any
   `runtime.pendingComms` gists. The "On call/text" roster line now carries where
   the voiced character physically **is** (`Maya (by text, at the clinic)`) so the
   narrator cannot have them claim a contradicted location over the line.

### NPC-initiated comms (phase-4 staged beats)

A character can now reach the player unprompted — but only as a *grounded* beat,
set up by the director and walked into place by the movement system, never
fabricated by the narrator:

- The narrator may have a character text/call the player **on its own** only as a
  **quick chat** (a passing thought, a check-in) that asserts no physical location
  and asks for no meeting (Presence fidelity rule 6). A "come over / meet me / I'm
  locked out, come let me in" beat is not the narrator's to invent.
- Those location-dependent beats are **director-staged**: the director stages an
  NPC's off-screen move (see [turn-engine.md](turn-engine.md) §Director-staged
  movement) and, on arrival, the movement system writes a `runtime.pendingComms`
  entry. It surfaces **once** on the next "Messages & calls" line, then clears.
- The continuity checker backstops it: a call/text whose words place the speaker
  somewhere the roster contradicts, or summon the player to meet them, is a
  `general` violation (it is fed each absent NPC's location via the roster).

Escalation, group calls, voicemail content, and rereadable text history remain
**deferred** — see [developer-notes/npc-movement-spec.phase3.md](developer-notes/npc-movement-spec.phase3.md).

## Symmetric perception (NPC-side)

The kitchen-sink fix. An NPC perceives an action only if their **attention**
admits its **salience**. One pure rule decides it, called in two places so the
prompt's prediction and the memory's record never disagree.

### Attention

`deriveAttention({ activity, posture, hint? })` → `{ state, facesAway }`, from the
character's free-text activity/posture plus an optional perception hint on the
item/affordance they're using (`absorbing` | `faces_away` | `outward` —
`ItemDefinition.attentionHint`). States:

- `engaged_with` — actively attending to someone/something
- `absorbed` — focused on a task (narrow; `faces_away` means back to the room)
- `idle_alert` — unoccupied and aware (the **neutral default**, also the degraded
  default when activity data is missing)
- `asleep_or_impaired` — minimal perception

### Salience

Every notable action carries `{ visual: obvious | subtle, audible: loud | quiet |
silent }` (`contracts/perception/salience.ts`). Default is **obvious + quiet** — a
normal, plainly visible interaction. Stealth must be declared, and a stealth
marker only lowers salience when a **concealment target** exists: "quietly" to a
lover at close range is *tone* (stays obvious); the same words with her unaware
mother present is a *sneak* (becomes `subtle`). `deriveActionSalience` (pre-turn,
from intent) and the merge's `turnSalienceSet` (post-turn, from simulant events)
apply the identical rule.

### The witness matrix

`perceives(observer, salience, mods?)` (`contracts/perception/witness.ts`) is the
single arbiter. An observer perceives an action if they perceive **either** its
visual **or** its audible channel:

| Attention | visual obvious | visual subtle | audible loud | audible quiet |
| --- | --- | --- | --- | --- |
| `engaged_with(actor)` | ✓ | ✓ | ✓ | ✓ |
| `idle_alert` | ✓ | — | ✓ | ✓ |
| `engaged_with(other)` | ✓ | — | ✓ | — |
| `absorbed` | ✓ | — | ✓ | — |
| `absorbed` + `faces_away` | — | — | ✓ | — |
| `asleep_or_impaired` | — | — | ✓ | — |

`silent` is never heard. `engagedWithActor` distinguishes the top row (the observer
is attending to *this action's actor*) from `engaged_with(other)` (a conversation
masks subtle/quiet things elsewhere). `mods` stack environmental and per-observer
effects: `dark` downgrades `obvious`→`subtle`; `sight`/`hearing` of `reduced`
narrow a channel and `blocked` removes it; `proximityOverride` (a contact/entwined
partner perceiving everything done to them) forces ✓ — set by phase-4 proximity
tracking, absent in v1.

### Where it runs

1. **Pre-turn (prediction)** — `buildAwarenessBlocks` renders one line per
   sight-present NPC ("Mara — absorbed at the sink, back turned: will NOT notice
   subtle or quiet actions; WILL react to anything loud"), plus up to
   `MAX_NPC_PAIR_AWARENESS_LINES` pairwise NPC↔NPC blindspot lines for non-obvious
   cases. The narrator is told what each character can perceive.
2. **Post-turn (application)** — the merge computes the **witness set**: for each
   co-located NPC, did they perceive any of the turn's salient actions? The set
   (`[player, ...perceivers]`) becomes the `witnessed_by` stamp on this turn's
   facts and episode, replacing the old interim co-location stamp
   ([memory.md](memory.md)).
3. **Enforcement** — the continuity agent flags two violation `kind`s (both major):
   `narrated_absent_character` (an Elsewhere character enacted) and
   `reacted_to_unperceived_event` (a character reacted to something the awareness
   lines say they could not perceive). It receives the same roster and awareness
   text the narrator saw.

Pre-turn and post-turn use the **same** clock (turn-start), matrix, and
concealment rule, so the awareness blocks predict exactly what the witness set
records.

## Environment: darkness & senses

`darknessVerdict(band, ambient.light)` (v1 keyword heuristic, decision 24): a
location is **dark** when the daylight band is `night` AND its authored
`ambient.light` is empty or dark-leaning; any lit-leaning light ("lamplit",
"firelight") keeps it lit. Ambiguous night light defaults dark and logs
`merge.perception.darkness_miss` (info) to tune the keyword lists. Darkness
downgrades visual `obvious`→`subtle` in the witness matrix and adds a scene line.
(Authored banded ambients — replacing the heuristic with per-time-of-day truth —
are a phase-4 location-design item.)

Per-observer sense impairment comes from conditions
(`senseModsFromConditions`): a condition supplies explicit `senseEffects`
(`{ sight?, hearing?: "reduced" | "blocked" }`) or its label matches the known map
(`blindfolded` ⇒ sight blocked, `drunk` ⇒ both reduced). The strongest effect per
sense wins.

## First-impression channel fidelity

A first encounter renders an impression matched to the channel
(`buildGlanceImpressions`): `sight` ⇒ the full appearance impression (as before);
`comms` ⇒ a **voice-only** impression (pitch/timbre/accent/cadence + manner, no
physical description) labeled "first contact by voice". `runtime.encountered­Participant­Ids`
marks full encounters only, so meeting someone first by phone doesn't burn the
in-person first impression.

## Proximity primitive

Phase 3 pulls in only what the `sight` channel needs
(`contracts/perception/proximity.ts`): the tier ladder
(`distant → apart → near → close → contact → entwined`), `defaultEntryTier(scale)`,
and `distantExists(scale)` (only `open`/`expanse`). v1 has no per-pair tracking —
co-located ⇒ `sight`. Engagement detail, `proximityEvents` application, the
movement lock, and contested transitions are **phase 4** (the movement scorer is
their consumer).

## Constants, diagnostics, deferred

- **Constants**: perception tables live next to their rules in
  `contracts/perception/`; `MAX_NPC_PAIR_AWARENESS_LINES` (engine/constants.ts)
  caps the ensemble awareness budget.
- **Diagnostics**: `merge.comms.unresolved` (warn), `merge.perception.darkness_miss`
  (info), `pipeline.perception.darkness_miss` (info). **Events**:
  `comms_link_opened`, `comms_link_closed`.
- **Deferred to phase 4+** (see [developer-notes/phase-3-to-4.md](developer-notes/phase-3-to-4.md)):
  the cross-location sound channel, NPC-initiated comms + escalation, per-pair
  proximity tracking / engagement / movement lock / contested transitions, banded
  ambient light, and player-unperceived hidden acts (v2).

## Where the code lives

- `contracts/perception/` — `channels`, `attention`, `salience`, `witness`,
  `darkness`, `proximity` (pure, the single source of the rules).
- `engine/scene.ts` — `classifyPresenceChannels`, `buildAwarenessBlocks`,
  `buildPresenceRoster`, `buildGlanceImpressions`, `deriveActionSalience`, the
  darkness + comms lines.
- `engine/intent.ts` — `detectCommsIntent`.
- `engine/merge.ts` — `turnSalienceSet`, the witness-set computation,
  `planCommsEvents`.
- `engine/prompts/narrative.ts` — presence/perception rulebook + turn-context blocks.
- `engine/prompts/agents.ts` — simulant salience/comms guidance + continuity
  violation kinds.
