# Recognition and visual-cue memory

Two disjoint per-observer records: what the player viewpoint has *noticed* about a
character's body, and what the narrator has recently *said* about the ordinary details
recognition deliberately refuses. Both hang off the affordance read in
[affordance-cues.md](affordance-cues.md) and the committed state in
[body-state.md](body-state.md).

## Recognizable features

**`chat_visual_memory`** (behind `CHAT_RECOGNITION_CUES`, default off): what the
player viewpoint has noticed about a character's body, and what the narrator has recently
said about it. The pipeline projects canonical body truth into per-feature candidates,
scores each against the same perception view the affordance read uses, and appends **at most
one** extra line to that same cue block ("a crooked nose", "the scar across her right
forearm") — standing truth after the physical cues, never competing with them. Contracts in
`contracts/appearance-features/` (what a feature IS) and `contracts/affordances/recognition/`
(what THIS observer can make of it); the lane bridges them in
`engine/chat-recognition-adapter.ts` (pure) over `engine/visual-memory-store.ts`.

- **Scoped to the memory group, not the chat** — PK `(memory_group_id, viewpoint_id,
  subject_id)`, viewpoint = the chat owner. "Continue our history" retains recognition; a
  fresh conversation meets a stranger. `deleteChat` clears the group's rows with its last chat.
- **Two generations per row** (`features` / `features_before` / `applied_message_id`, the same
  rollback guard the state and scenario anchors take): a retake re-runs from the identical
  pre-exchange memory instead of counting the same look twice. There is no event ledger here,
  so one generation of history is what makes the retake law true.
- **Notices persist even when no cue fires.** Looking strengthens recognition; only a cue that
  reached the transcript moves `lastMentionedAt` and starts a cooldown. The commit is a
  serializable value returned by the contract and written only once the exchange settles.
- With `CHAT_AFFORDANCE_CUES` off but this flag on, the affordance read is still built as a
  **perception source only** — its `nextCues` and `coverage` are deliberately dropped, so one
  experiment's flag can never write the other's state.
- **Production-silent**: the perception view asserts exposure only for garment-covered
  locations and hair, so bare skin (nose, face, forearms) reads `unknown` and recognition fails
  closed — the same shape of missing-owner gap as garment fit.

## The narrator's own cue record

**`chat_visual_cues`** (behind each conversation's own visual-continuity switch, default off) is the sibling
record for everything `chat_visual_memory` deliberately refuses. Recognition memory holds
what a person could *recognize* — a crooked nose, a scar — and a rolled sleeve, a posture, or
an occupied hand has no business filling it up. That exclusion would otherwise leave those
details with no cooldown after being mentioned and no record of having been seen, so a
recently stamped sleeve would stay eligible turn after turn and nothing could tell the
narrator that an ordinary detail became *visible* now rather than merely being true now.

Contract in `contracts/visual-state/cue-state.ts`, storage in
`engine/visual-cue-store.ts`. The two records are disjoint: one predicate
(`isMemoryEligible`) decides which answers for a feature, so novelty, the cooldown, and the
mention ledger all follow it and a single cue can never spend both.

- **Keyed by repeat family, not by feature** — both questions it answers are questions about
  the family ("this sleeve's arrangement"), and its stored fingerprint covers every visible
  member of that family, so a change to any of them registers.
- **It counts cuts, not minutes.** "Newly visible" means *not in view at the immediately
  previous cut*. Chat turns move the story clock by wildly varying amounts, so a time
  threshold would call a continuously visible sleeve newly revealed after a long gap and miss
  a coat that came off and back on inside an hour.
- **Seeing and saying are separate events**, exactly as they are for recognition. Every cut
  records what was in view, said or not; only a cue that reached the transcript starts a
  cooldown. A detail in continuous, unchanged view stays quiet; one that reappears or changes
  can earn a beat.
- **Same key and same two-generation retake law** as `chat_visual_memory`, in its own table.
  The counter is why that matters more here: a retake that advanced it twice would make every
  tracked detail read as newly revealed on the following cut.
- **Read either way, written only when the chat's switch is on.** The visual-state shadow reads
  the stored state and ranks against it, so its repetition and newly-revealed counts are real;
  only a conversation with visual continuity turned on commits.
- **A just-said detail leaves the fence for one cut.** The fence otherwise never goes quiet — a
  fact stays contradictable — but a detail the narrator has only just used would otherwise be
  re-presented immediately, and the narrator reads a fence entry as something it may say. The
  ledger of what was spoken, and when, is what closes that loop in the projection rather than in
  prompt wording.

## What the narrator can see

Visibility claims nothing unless it knows the light, the distance, the angle, and whether
anyone is moving; one unknown component suppresses every detail in the snapshot. Distance and
angle come from the scene owner's proximity and facing for the observer/subject pair. Nothing
in the app owns scene lighting or whole-subject motion, so the lane **states** a base
value for each (an ordinary lit room, a still scene) and marks it as stated — the marker
rides the evidence on every visible read, one info diagnostic, and the inspector's own panel,
so a stated placeholder can never be mistaken for an observation.
