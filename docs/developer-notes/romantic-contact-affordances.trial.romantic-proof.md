# First romantic contact proof — internal trial results

Status: closed — passed 2026-08-18, and **superseded as the rollout input.** The
permission flags were enabled for the proof window only and reverted immediately
afterwards; production runs without them.

Both findings below were closed in code on 2026-08-18, so the behaviour this
trial measured is no longer the behaviour that would ship. A rerun against the
fixed lane is the input to the rollout decision — plan item 10. What follows
stands as the record of what was observed on the day, and is not updated.

Plan: [romantic-contact-affordances.plan.md](romantic-contact-affordances.plan.md)

Technical record:
[evidence appendix](romantic-contact-affordances.trial.romantic-proof.evidence.md)

The earlier [affectionate-contact trial](romantic-contact-affordances.trial.md)
is a separate, closed record and is not superseded by this one.

## Decision

**Passed.** This was the first time a player wrote a genuinely romantic touch in
Vesper and the character's own recorded permission decided what happened to it.

Every case behaved correctly. With no permission on record, the touch committed
nothing. With permission granted but the two characters too far apart, it still
committed nothing — permission does not make a touch physically possible. With
both in place, it committed, and the narrator was told the touch was real. When
the character withdrew permission mid-scene, the existing touch ended and the
next reply did not continue it. Regenerating the committing turn left one touch,
not two.

Several mechanisms ran in production here for the first time: the permission gate
inside the contact resolver, the sweep that ends contacts a withdrawal
invalidates, and the stop guidance handed to the narrator afterwards.

**The one finding that should shape the rollout decision** is in the next
section. It is not a defect, and it is not visible from the fact that the trial
passed.

## The finding that matters: a refusal is silent

When the character has given no permission, the state correctly refuses — nothing
is committed, nothing is written to the record. But a refusal of this kind
produces no line for the narrator, so **the story still described the caress as
landing.** Only an explicit in-story refusal by the character produces text that
blocks it.

This follows a deliberate rule the contact system holds everywhere: something
unknown is not the same as something denied, and Vesper does not narrate a
refusal it was never told about. So the behavior is correct. But it means turning
this feature on governs **what becomes true in the world**, not **what the prose
says**. A player who writes a romantic touch with no permission on record will
still read a reply where it happens; what changes is that Vesper does not record
it, build on it, or carry it forward.

That was the trade to weigh before rollout. **It has since been closed.** The
narrator is now told about this gap, in wording that stops the touch being
written as landing without inventing the refusal nobody gave — which is the hard
half, because saying "she has not allowed that" would replace a false landing
with a false decision. It has not been observed live.

## What the trial needed to prove

- a romantic touch nobody authorized does not become part of the world;
- a grant in the wrong direction, or for something else, does not authorize it;
- permission does not substitute for the characters being able to reach;
- an authorized, physically possible touch commits and the narration honors it;
- withdrawing permission ends a touch already in progress;
- regenerating a turn does not leave a duplicate or a stale touch behind.

## What happened

### With no permission, nothing was recorded

The player caressed the character's arm before anything had been granted. Vesper
produced a real romantic action, asked the permission owner, got no answer, and
committed nothing — no touch, no entry in the permission record. The prose still
described it (see above).

### Permission did not make an impossible touch possible

With permission granted but the characters not near each other, the touch was
refused on physical grounds, and the reason was distance rather than consent. The
narration obeyed it: the character drew her arm back instead of letting the touch
land. This is the law that permission and physical possibility stay independent,
observed live rather than argued from tests.

### With permission and reach, it committed

Approaching and touching in the same message committed the contact, and the
narrator was told plainly that the touch was real, that it must not be written as
missed or refused, and that how the character responds to it was still hers to
decide. The reply wrote it as landing.

### Withdrawing permission ended it

When the character's permission was withdrawn while the touch was live, the touch
ended, the scene was left with no active contact, and the following reply did not
continue it.

### Regenerating did not duplicate

Re-granting, re-establishing the touch and then regenerating the committing turn
left one active touch and no duplicate start. The committed touch still carried
the permission it was authorized by and the fact that it was a sliding caress.

## Two sharp edges worth knowing about

Neither is a fault in the contact feature, and neither blocked the trial.

**Walking over does not stay walked over.** Approaching the character in one
message left nothing usable the following turn, so a touch written a turn later
was refused for distance. Only approaching and touching in the same message
worked. A player who writes those as two natural turns will be refused for a
reason the story has already dealt with.

**A character's first name alone is not recognized.** Writing "Sabrina" does not
match a character named "Sabrina Vale"; a pronoun is needed. **Closed
2026-08-18, and it was worse than recorded here:** the full name did not work
either. Every way of writing a name matched a single word only, so a two-word
character name was unreachable by any phrasing — including the approach and
release lines. A unique first name and a multi-word name now both resolve, and
an ambiguous first name is silence. Not observed live.

One smaller mismatch: the reply described the touch landing through the fabric of
a shirt, while the recorded fact was skin contact. That is narration drifting
from the recorded state, not the state being wrong.

## What this trial does not prove

- one character, one chat, one gesture family, one direction (player to
  character);
- a character initiating romantic contact was not tested and is not claimed;
- how often ordinary romantic writing is refused for being phrased less simply
  than the test lines was not measured, and the producer is deliberately strict
  about sentence shape.

## What happens next

The silent-refusal gap and the naming gap are both closed in code and neither has
been seen live. The rollout decision is still the owner's and still open, but it
now waits on a rerun against the fixed lane rather than on this trial: the
instrument for it is `scripts/trial/romantic-contact/`, and it captures the
inputs, replies, narrator guidance and before/after state this record could only
summarise.
