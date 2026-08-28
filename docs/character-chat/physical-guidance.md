# Narrator physical guidance — constraints and premise checks

Committed physical state reaches the narrator mostly as what it **must not claim**. Behind
`CHAT_PHYSICAL_CONSTRAINTS` (default off) the pipeline compiles two things from the cut it
already has, and renders them as one binding-tier block. The wording and placement of that block are owned
by [perception-gates.md](perception-gates.md) §Physical consistency.

- **Consistency constraints**, from the hair domain's `hair.bulk_restraint` resolution: a
  braid, a bun, a hood, or a soaking holds the hair's bulk still, and the narrator may not
  write it streaming loose. This is the one phenomenon that emits a `constraint` rather than
  an observation, and it needs no wind: the wind/motion read computes the same
  restraint but only ever uses it as a reason for its own silence, so on a still evening the
  domain knows the hair is braided and nobody would be told.
- **Premise corrections**, from the current player message: a high-confidence physical claim
  that committed state contradicts (rain when the state records a bath, loose when the style
  is a braid) or cannot support (a claim about an owner this lane could not read). A claim
  counts only in the clause that names the hair — a hair reference in one clause licenses
  nothing in the next, so "your braided hair looks lovely while the curtains go streaming"
  corrects nothing — and a cause word ("a storm", "a pool") is scenery until the same clause
  also says somebody got wet. A clause that names **two** people's hair ("your braid looks
  lovely beside Mira's hair streaming in the wind") corrects nothing either: there is no
  way to tell which head the verb belongs to, and ambiguity is silence.

## A standing fence is stated only when the turn is about it

A braid is true all day, and
repeating its prohibition on every exchange spends prompt bytes on inventory and risks
priming the very description it forbids. So constraints are compiled only when at least one
relevance signal holds: the message names **this character's** hair (a subject-bound
reference in any span — the claim wording may be absent, "you tuck your hair behind one ear"
is enough), a premise was corrected this turn, something is actually acting on the hair
right now (wind above still air, or falling precipitation), or the turn's sensory beat is
aimed at the hair. No signal means no candidates, no block, and a byte-identical prompt —
with one `guidance.constraint.irrelevant` info diagnostic per withheld fence so the
inspector can explain the silence. Corrections are never gated this way: a correction is
about the current turn by construction.

A bare claim word bound to nobody is **not** a signal. The claim vocabulary is ordinary
English — "river", "pool", "loose", "soaking" — so "it is absolutely soaking wet out there"
is about the weather, and arming a braid fence on it would spend prompt bytes to prime the
very description the fence forbids.

## The two flags share the read and nothing else

`CHAT_PHYSICAL_CONSTRAINTS` makes the
pipeline build the affordance read when `CHAT_AFFORDANCE_CUES` is off, but cue rendering
**and** the `character_chats.affordance_cues` write stay gated on the cue flag alone — so
running the constraint leg can never spend or advance the cue leg's repeat
gate, and the two remain independently measurable. The adapter hands back the committed
facts it derived (`ChatCommittedHairState`: wetness band, single wetting cause, arrangement,
covered fraction, whether a force is currently acting on the hair, and per-owner
availability) rather than letting the guidance layer re-read state, so a fence can never
disagree with the read it accompanies.

## Provenance truth and cue freshness are two different windows

The 60-minute event
freshness window governs whether the domain may *volunteer* a cause ("still damp from the
rain") — beyond it the hair is simply wet and says nothing about why. The committed cause the
premise fence compares against comes straight off the body-surface entry and lives as long as
the wetness does: three story hours after a bath the hair is still wet *because of* the bath,
and a player blaming the storm is still wrong. It goes `null` when the hair is dry, when the
recorded cause is `other` or absent, or when two causes are live at once (a bath, then rain
on the walk home) — silence, never a guess.

## Nothing is persisted, and that is what makes retakes correct

Every input is either the
committed cut or the current message text, and both already roll back through
`pre_exchange_state` / `pre_exchange_scenario` and the transcript — so the same take
recomputes identical candidates, identical selection fingerprints, and identical prose for
free. There is no `physical_guidance` row to restore, and adding one would only create a way
for the stored answer and the recomputed one to disagree.

## The developer preview

`/chat/:id/inspector` (admin-only) shows the staircase read-only —
input authority (which spans of the newest player line were even eligible) → committed state
and per-owner availability → the relevance decision (which signals admitted a fence, or "not
relevant" per constraint) → candidates with their disclosure → what survived the gate and the
budget → the rendered lines. It reports `CHAT_PHYSICAL_CONSTRAINTS` rather than obeying it,
because silence here has six different causes that look identical from the prompt.
