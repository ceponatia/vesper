# Romantic contact affordances — NPC actor control through the live lane

Status: technical companion to
[romantic-contact-affordances.plan.md](romantic-contact-affordances.plan.md)
(§"Continuation order" item 3 — **spec drafted 2026-08-02, before
implementation**. The item's first bounded deliverable, the NPC-authored
contact-ending producer, shipped 2026-07-31 inside item 1.2 and is treated
here as frozen precedent, not open surface.)

## Scope, in one paragraph

The lane can already commit the player's own movement and affectionate touch
(the deterministic player leg) and can END a contact the NPC's prose plainly
walked away from (the reply-side ending producer). What it cannot do is give
an NPC any other physical authority: an NPC who crosses the room, sits beside
the player, takes the player's hand, or shifts a resting touch into a squeeze
changes nothing in the scene, so the projection and the prose drift until a
player action re-anchors them. This spec defines the remaining item-3 surface:
**authoritative NPC-side movement (approach and departure) and affectionate
contact starts and updates**, fed by a structured NPC-decision source, with
persistence and retake behavior extending the shipped reply-side model, and
every ambiguity failing closed to silence.

Out of scope, permanently or until named prerequisites exist: any movement of
the **player's** body (`player_movement_requires_player_authority` stands —
scene spec §"Actor-control law"); romantic or intimate contact (waits for the
`romantic_touch` permission owner, item 4); restraint or pinning (`trapped`
has no producer — scene spec §"Open design questions"); posture and support
changes (deferred to a later increment — the scene owns only one `ground`
surface, so "she sits on the couch" has no surface to land on); wardrobe or
exposure changes; and any generalized reading of reply prose (§"The fence"
below).

## The structured NPC-decision source

### Ruling this spec makes

NPC decisions arrive through **two tiers, and only two**:

1. **The deterministic floor (shipped, frozen).** The ending producer in
   `chat-contact-reply.ts` keeps exactly its current vocabulary: whole-sentence
   allow-list detection of `withdrawn` / `separated` endings, narration spans
   only, shared vetoes, sole-pronoun rule. It stays because it is proven, it
   is retake-reproducible from the persisted reply bytes, and it still works
   when tier 2 degrades. **It does not grow.**

2. **The reply-scene decision read (new).** A settle-time structured agent
   call — the `generateChecked` pattern the pulse and the scene sketch already
   use — that reads the settled reply plus a compact scene digest and returns
   a **closed decision schema** (below). The model classifies; it never
   narrates, never proposes numbers, and never touches state. Every decision
   carries a **verbatim evidence quote**, and a deterministic evidence gate —
   the wardrobe restatement guard's architecture, proven through the round-2/3
   corrections — must pass before the decision reaches any resolver:

   - **grounded** — the quote appears verbatim in the reply's *narration*
     spans (`parseMessageSpans`, curly quotes normalized; dialogue, thoughts,
     OOC, comms, and styled spans can never be evidence);
   - **asserted** — the containing sentence is a completed action: the full
     veto set applies (negation, hedge/modal/conditional/future/intent,
     question, command, quoted speech, refusal, incomplete action, **romantic
     framing, restraint** — for starts and updates the restraint veto is
     mandatory, unlike the ending floor);
   - **actor-attributed** — the asserting sentence's grammatical subject
     resolves to the deciding NPC by the shipped rule: name or alias always;
     a bare pronoun only when exactly one NPC is present.

   The LLM proposes; deterministic code disposes. A decision that fails any
   clause is dropped with a diagnostic, never repaired.

The precedent split is deliberate and worth naming: the **pulse** shows a
settle-time structured read can carry NPC decisions (presence changes and
`sentPhoto` already ride it), and the **wardrobe evidence gate** shows a
structured read must not be trusted without deterministic verbatim-evidence
validation (the extractor self-quoting its own paraphrase is exactly the hole
`classifyOutfitChangeQuote` closed). Tier 2 composes both lessons.

### The fence — what "broader scene-language read" may never become

The phrase in the plan's item 3 is bounded by this rule: **no new regex
families are added for NPC movement, starts, or updates, and no code path may
interpret free reply prose into scene facts.** The only prose the deterministic
side ever reads is (a) the frozen ending floor and (b) the evidence gate's
verification of a quote the structured read proposed — verification of a claim,
not extraction of one. If a decision kind is not expressible in the schema, the
lane stays silent; the answer to "the model keeps phrasing it differently" is
never "loosen the parser", it is "the schema does not carry that decision".

A pure test pins the fence the way the scene spec pins its no-prose-provenance
law: the decision schema's enums are asserted closed, and the reply-side leg
exports no detector beyond the frozen ending set.

### Cost control (not authority)

The decision read runs only when a cheap deterministic **trigger** fires: the
reply's narration contains at least one movement/contact verb stem from a
small lexicon within a sentence that also names a present roster member or a
sole-NPC pronoun. The trigger is pure cost control — a miss costs one missed
decision, a false fire costs one small agent call — so it may be broad and
sloppy in the way authority-bearing readers may not. Model: `agentModelId`
with a timeout and degraded default, exactly as the pulse.

## The decision schema

`src/contracts/turns/npc-scene-decision.ts` — pure, zod, fully
`.catch()`/`.default()`ed so a malformed answer degrades to the empty decision
set (docs/resilience.md §3). All enums are existing vocabularies; the only
free text is the evidence quote.

```ts
movement: {
  kind: "approach" | "depart",
  otherName: string,          // resolved against the present roster, fail-closed
  adjacency?: "beside" | "arms_length",   // approach only; maps to touching | close
  evidence: string,           // verbatim quote from the reply's narration
} | null                      // .catch(null) — at most ONE movement per reply

contact: {
  kind: "start" | "update" | "end",
  targetName: string,                       // start: whose body; update/end: whose contact
  gesture?: "rest" | "pat" | "squeeze",     // start/update — chatContactGestures verbatim
  targetPart?: string,                      // start only; must key CONTACT_TARGET_LOCATION
  endReason?: "withdrawn" | "separated",    // end only
  evidence: string,
} | null                      // .catch(null) — at most ONE contact decision per reply
```

At most one movement and one contact decision per reply mirrors the player
leg's "first eligible sentence wins": two movements in one reply is a beat
this proof does not model, and a list invites the model to enumerate the whole
scene. A reply that genuinely does more loses the tail, which costs a turn of
drift — the same price the player side already pays.

## Validation and resolution

Order per decision: **schema → roster → evidence gate → resolver/intent
machinery**. Nothing skips the fourth step — a validated decision is still only
an *attempt*, and every gate that refuses a player act refuses an NPC act the
same way.

**Movement** becomes `npc`-origin `SceneMovementIntent`s through
`commitSceneIntent`, which already enforces the actor-control law
(`SCENE_CONTROL_ORIGINS`: `npc` may move only `npc_controlled` bodies), the
ordering law (stale intents no-op, restatements never write), and structural
validation. Specifically:

- **approach** → `set_proximity` (band from `adjacency`: `beside` ⇒
  `touching`, `arms_length` or absent ⇒ `close` — the player mapping's
  semantics) plus `set_facing` toward the other body, both stamped
  `npc_decision` provenance under the reply's scene event ref. The pair may be
  NPC↔player or NPC↔NPC; the *moved* body is always the deciding NPC's own.
- **depart** → the player departure's laws mirrored: end every active contact
  involving the NPC (`separated`), and write a **wider** band only for a pair
  the scene already placed or an active contact proves was `touching`; never a
  band nearer than the standing one; a pair nobody ever placed keeps its
  unknown distance. This closes the shipped ending producer's documented gap
  ("the distance simply stays whatever the scene last said") — with an
  authoritative movement design, a stated departure may now open distance.

**Start** mirrors `resolveChatContactAttempt` with the sides swapped: source =
the NPC's `hands`; actor control **read** from the scene's control fact
(`allowed` iff `npc_controlled` — the mirror of `chatActorControl`, same
no-hardcoding rule); `targetAgencies` empty for the same reason the player leg's
is — only the actor's own hand moves; eligibility and policy `not_required`
(affectionate is permission-neutral, owner ruling 2026-07-30, and the evidence
gate's romantic veto is what keeps the label honest); geometry and support
through the scene reads; material through `chatContactMaterialSource` for the
target body — the player as target resolves under the player's garment actor,
and a body whose coverage nobody modelled reads `unavailable` ⇒ `unresolved` ⇒
silence, never bare skin. Gesture maps through `GESTURE_CONTACT` unchanged.
`explicit_transition_required` produces **nothing** — the lane never invents
the adjustment an NPC "would have" made; `rejected` and `unresolved` keep
their shapes (silence + diagnostics).

**Update** applies only to an **active** contact whose source body is the
deciding NPC (an NPC may not modulate the player's hand on her shoulder);
the new pressure/motion comes from the same closed gesture map and lands as
the core's `contact_updated` commit. No active matching contact ⇒ dropped
with a diagnostic — an update is never promoted into a start.

**End** folds through the same `endCoveredContacts` body as the floor. When
both tiers state an ending, the second fold finds the contact already ended
and the core's stale-end law no-ops it — composition needs no dedup logic.

## Permitted scene changes — the closed set

| NPC decision | May change | May never change |
| --- | --- | --- |
| approach | own proximity band (nearer), own facing (`toward`) | the other body's facing or posture; anything about a third body |
| depart | own proximity band (wider only, placed pairs only); ends own contacts (`separated`) | a band for an unplaced pair; the other body's anything |
| start | one new affectionate contact, NPC hands → allow-listed target location | clothing, exposure, target's pose, romantic/intimate surfaces (absent from the lexicon) |
| update | pressure/motion of an active own-sourced contact | the contact's surfaces, its material, its target |
| end | ends own contacts (`withdrawn`/`separated`) | proximity (that is `depart`'s claim), any other fact |

Everything else — posture, support, player-body movement, wardrobe, restraint,
third-party puppeting — is structurally unrepresentable in the schema, which is
the enforcement.

## Persistence, ordering, retakes

One **reply scene leg** replaces the shipped ending producer's pipeline slot
and subsumes it — same position, same invariant: it runs LAST, after
`finalizeChatState` and the garment reconcile, so nothing later re-writes
`character_chats.scene` from a pre-decision projection.

- **One ordered commit list per reply**: floor endings first, then validated
  decisions in schema order (movement, then contact), exactly as the player
  leg builds one list per exchange so the ledger's `sequence` indexes the
  whole reply and a replay re-derives identical keys.
- **Event identity**: the existing reply-side ref
  (`contact-reply:<assistantMessageId>`), guarded by the assistant row.
  Contact commits and the folded projection land in ONE verified transaction
  (`appendChatContactEventsWithScene`); a conflicting record under the reply's
  keys fails closed with the projection unchanged, as shipped.
- **Movement-only replies** produce scene changes but no ledger rows (the
  player-side precedent: movement rides the scenario, only contacts ride the
  ledger). The leg extends the reply-side write to persist the projection
  under the same assistant-row guard with compare-and-swap semantics even when
  `commits` is empty. Recorded alternative, rejected for scope: minting
  movement event rows in `chat_contact_events` would buy uniform provenance at
  the cost of widening a contact ledger into a scene journal — reopen only if
  movement provenance proves insufficient in practice.
- **Retakes**: unchanged from the shipped model — the retake prune deletes
  reply-ref rows beside the exchange prune, the scenario rollback restores the
  snapshot projection, deletes cascade off the assistant row, and the
  nondeterminism of tier 2 is harmless because a discarded take's decisions
  are durably discarded with it; the new take runs its own read.
- **Story time**: `trunc(scenario.clockMinutes)` at settle, as shipped.
- **Trace**: the leg persists a `lastSceneDecisionTrace` beside the scene
  (pulse-trace pattern): trigger fired?, raw decision presence, per-decision
  gate outcome (which clause dropped it), resolver outcome, degraded flag +
  diagnostic code. The dev inspector renders it — "why did nothing happen"
  must stay answerable, and tier 2 adds three new silent causes (trigger miss,
  gate drop, schema degrade) to the flag-off/hedge/ambiguity causes the
  previews already explain.

## Fail-closed ambiguity rules

Every rule resolves to **silence plus a diagnostic**, never a guess:

1. Trigger fires but the call times out, errors, or returns unparseable JSON ⇒
   degraded empty decision set (`npc_decision.degraded`).
2. A name that resolves to zero or ≥2 present roster members ⇒ that decision
   dropped (`npc_decision.subject_ambiguous`). "The player" resolves only via
   the player's stated name/handle; pronouns never name the player.
3. Evidence quote not found verbatim in narration spans ⇒ dropped
   (`npc_decision.evidence_ungrounded`).
4. Evidence sentence vetoed (negation/hedge/question/dialogue/romantic/
   restraint/…) ⇒ dropped (`npc_decision.evidence_unasserted`).
5. Evidence sentence's subject is not the deciding NPC ⇒ dropped
   (`npc_decision.evidence_misattributed`).
6. `targetPart` outside `CONTACT_TARGET_LOCATION`, gesture outside
   `chatContactGestures`, band request outside the schema ⇒ unrepresentable
   (schema `.catch`) ⇒ that decision null.
7. Movement targeting the player's body, an absent body, or an unplaced pair
   (for `depart`'s band) ⇒ refused by the existing intent machinery
   (`commitSceneIntent` rejection / ordering), no new code path.
8. Update with no matching active own-sourced contact ⇒ dropped
   (`npc_decision.update_without_contact`).
9. Two decisions in one slot (schema arrays are not arrays — the slots are
   nullable singletons) ⇒ unrepresentable by construction.
10. Ledger conflict under the reply's keys ⇒ transaction rolls back, projection
    unchanged (`CHAT_CONTACT_LEDGER_MISMATCH`, shipped).

## Flag and rollout

New flag **`CHAT_NPC_SCENE_DECISIONS`**, literal `"on"`, default off, effective
only when `CHAT_CONTACT_ACTIONS` is also on (it feeds the same projection; the
guidance trip still rides `CHAT_PHYSICAL_CONSTRAINTS`). Flag off ⇒ the reply
leg is byte-identical to the shipped ending producer — pinned by the same
flag-off identity obligation the MVP carries.

Increments, each with its own integration obligations before the next starts
(the durable-ending suite's ten obligations are the template — durable rows,
retake prune, idempotent replay, fail-closed conflict, flag-off identity):

1. **Movement** — approach/depart, including depart's band-widening and the
   ending fold. Smallest new authority; exercises the whole tier-2 chain.
2. **Starts** — the NPC hand on an allow-listed surface, full resolver path,
   material honesty on the player's body included.
3. **Updates** — gesture modulation on active contacts.

## Diagnostics

`npc_decision.degraded` (warn) · `npc_decision.subject_ambiguous` (warn) ·
`npc_decision.evidence_ungrounded` (warn) · `npc_decision.evidence_unasserted`
(warn) · `npc_decision.evidence_misattributed` (warn) ·
`npc_decision.update_without_contact` (warn) · plus every existing scene,
contact, and ledger code unchanged. A rejection by the actor-control law stays
undiagnosed on the scene side by that module's own rule (an answer, not a
failure); the trace records it instead.

## Open questions (restated in the plan)

- **Cost envelope for tier 2** — one trigger-gated agent call per qualifying
  settle, off the reply path. RECOMMENDED: accept (the pulse already runs per
  member per settle; the trigger keeps quiet turns free). Owner call because it
  is a standing per-turn cost, the same class of ruling as the intake-agent
  reversal.
- **Posture/support increment timing** — "she sits beside you" is common
  enough that increment 1 will visibly miss it, but doing it honestly needs
  support surfaces beyond `ground` (a seat vocabulary at minimum). Deferred
  here; the owner may pull it forward as increment 4 with a named surface
  design.
