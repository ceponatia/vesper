# Supporting cast & narrator input

Recurring named side characters who are not character entities — and the composer
register that lets the player author story narration in their own right
([developer-notes/chat-supporting-cast.plan.md](../developer-notes/chat-supporting-cast.plan.md)).

## Supporting cast

Recurring named side characters — the player's coworker, the character's sister — who are
NOT character entities and NOT roster members
([developer-notes/chat-supporting-cast.plan.md](../developer-notes/chat-supporting-cast.plan.md),
2026-07-13). Before this, rule 3's incidental-person discipline kept every non-roster person
"unnamed and passing," so a recurring friend like Abby was reacted to but never *written for*.
The scene-memory pattern applied to people:

- **Storage**: `supporting_cast` jsonb on the CHAT row (the shared scenario; one cast for the
  roster) — `SupportingCastMember { name, relation, details[], voice?, whereabouts? }`
  (`contracts/turns/chat-supporting-cast.ts`), hard caps (≤8 members, ≤6 details, length
  caps), `parseOr` degraded-empty at the load boundary. Rides the `pre_exchange_scenario`
  rollback anchor, so "another take" restores it.
- **Reconcile**: the archivist's 10th field `cast` proposes new people / new details —
  merged accrete-only by `mergeSupportingCast` (upsert by normalized name, details dedupe +
  cap, `relation` fills only when empty — author edits are canonical), with roster member +
  player names **excluded** so full characters can never double as cast entries. The build
  prompt lists the known cast (fenced) so details attach instead of re-minting.
- **Prompt law**: a compact volatile-tail **Supporting cast** block (both frames) lists each
  member + the play license — the narrator may voice and move them (prose attribution, never
  a `[Name]` tag; the render contract is unchanged) and give them initiative true to what's
  established, while they stay supporting (never steal a beat, never contradict what the
  player wrote for them, never act FOR the player). Rule 3 carves them out of the
  incidental-person clause; **rule 16** lets them populate the character's side of a scene
  cut, so she and a cast member can carry threads forward while the player is away.
- **UI**: the **Supporting Cast panel** (`components/chat/chat-supporting-cast-panel.tsx`),
  below "In this story" in the desktop aside and the Roster sheet — names listed as they
  accrete, "+ Add person," and a lightbox editor (name/relation/details/voice/whereabouts +
  Remove) for manual seeding and for deleting erroneous entries. Saves are whole-list
  replacements through the state PATCH (`ChatStateEdit.supportingCast`, chat-wide half);
  409 `chat_busy` while a reply streams.
- **Deferred**: per-member images, a promote-to-character flow (the cast entry as forge seed).


## Narrator input (the player as storyteller)

The composer's **You ↔ Narrator** toggle (same plan): a `send` with `inputMode: "narrator"`
is story narration the player authored as the STORYTELLER — supporting-cast dialogue and
actions, offscreen developments, scene flavor — never the player's own POV, so the reply
must not treat it as something the player said or did.

- **Persistence**: the user line stays byte-verbatim; `meta.inputMode: "narrator"` marks it
  (regenerate/rerun recover the register from the stored meta; the transcript renders the
  line with a "Narration" label and neutral styling).
- **Model boundary**: past narrator lines are wrapped in the replayed window with
  `wrapNarratorInput` ("[Story narration from X — written as the storyteller, not as X
  speaking or acting]"); a static notation-legend line teaches the marker (1-on-1 +
  ensemble), and the current turn adds a one-turn tail note (`narratorInputNote`) suspending
  the player-input perception partition for that message.
- **Post-turn**: the reaction pulse is **skipped** (no player act to classify — regard,
  meters, and feeling untouched, exactly like a "go on" beat); selfie request/offer arms
  never fire; the archivist and the summary fold read the player half under a
  STORYTELLER-NARRATION label so authored events are filed as story truth, never as the
  player's own words (archivist rule 6). The clock ticks and the archivist still runs —
  authored canon is worth remembering.
- **UI guards**: narrator mode requires text and never carries photos (attach is
  player-mode-only; the toggle locks while photos are staged).

