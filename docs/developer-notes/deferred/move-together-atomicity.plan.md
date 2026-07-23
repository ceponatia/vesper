# travel_together atomicity — a real move_together command

Status: draft (successor-engine backlog item A4, parked 2026-07-23; **fleshed
out 2026-07-23 — owner rulings 1–3 recorded below**; still parked — promote per
[CLAUDE.md](CLAUDE.md) before building. Per ruling 2 it graduates **paired
with A1 [sim-command-idempotency](sim-command-idempotency.plan.md)** as one
command-integrity plan.)

## What

The walk-with-me choreography commits scene-end, player move, and NPC move as
three independent transactions (`sim-exchange.ts:1290-1354`). A process death
after the player's move strands the pair: player in transit, primary at the
origin, scene ended, no beat — and a retry refuses with `not_copresent`
("isn't here to walk with you", the co-presence gate at `:1246-1254`). The
in-process `traveled_alone` degrade never runs on a crash. (MED · M)

Verified at flesh-out (2026-07-23 — re-verify on promotion):

- **Shared journeys are already first-class in the data model.** `Journey`
  carries `actorIds` as a list (≥ 1 refinement —
  `contracts/simulation/space.ts:229, 242-244`), the `actor_departed`
  projector moves EVERY listed actor into transit
  (`lib/simulation/space.ts:633-645`), and `resolveJourneyArrival` lands ALL
  of them together (`:539-547`). Only the command that creates a multi-actor
  journey is missing.
- **The agency check sits outside the lock today**: `decideAccompany` reads
  activities/commitments before any commit (`sim-exchange.ts:1230-1276`), so
  the primary can gain a conflicting claim between the read and her move —
  a small race the atomic command closes for free.
- Review note kept from parking: the `npc_policy` accompany envelope
  (`principalId:"sim-accompany"`) was audited and is lawful — authorization
  keys on `controlledActorIds`; nothing assumes npc_policy envelopes
  originate only from the arbiter.
- The solo departure choreography (end-scene + one move) shares the window's
  *class* but not its severity: a crash there leaves only an ended scene, and
  the player simply travels again. No change needed there.

## Why it matters

The marquee romance feature has a crash window whose failure state is
unrecoverable through the UI.

## Owner rulings (2026-07-23 — copy into engine.spec §39 at promotion)

1. **One indivisible action.** A dedicated branch-locked `move_together`
   command commits scene-end + one SHARED journey (both actors on it)
   atomically — a crash can no longer catch the pair halfway, and "together"
   becomes true by construction (one journey, one arrival trigger, both land
   in the same event). The resumable-steps alternative was **rejected**
   (halfway states would still exist and recovery depends on a retry
   happening).
2. **Graduates paired with A1** (composed-command idempotency + per-chat
   lock) as one command-integrity plan — both are about composed actions
   staying honest under retries and crashes.
3. **Stays parked** until promoted in backlog order — the window needs a
   mid-flight process death, which nobody has hit yet.

## Sketch

- **New command `move_together`** in the sim-command vocabulary, submitted by
  the PLAYER principal for the player actor + an invited co-traveler. §14.2
  is preserved and strengthened: the player principal still never moves an
  NPC — the resolver enforces NPC agency by re-running the deterministic
  `decideAccompany` policy INSIDE the locked authority view; accept ⇒ events,
  decline ⇒ the §14.4 public face as the command's refusal. (The agency check
  moves inside the atomic boundary, closing the read-vs-commit race.)
- **One event batch, all existing event types**: `engagement_ended` (when a
  scene stands, `participant_choice` — §18.2 grace preserved),
  `journey_planned` with `actorIds: [player, primary]`, one
  `actor_departed`, one `trigger_scheduled` (one arrival uniqueness key for
  the shared journey). Projectors and the arrival resolver need no changes.
- **Choreography simplifies**: decide → submit `move_together` → drain to the
  one journey's arrival (A7's `expectedArrivalAt`) → one `together` beat. The
  walk-with-me "max of two targets" composition and the mid-flight
  `traveled_alone` divergence disappear; a whole-command refusal degrades to
  today's plain solo travel (a `traveled_alone`-shaped outcome), recorded via
  C15.
- Forward headroom (schema preference): `actorIds` already generalizes to
  parties larger than two; splitting up mid-journey would be a future
  `journey_split`-style event, not a v1 concern.

## Slices

Sized for the paired A1+A4 command-integrity plan; A4 alone is one M slice.

1. **The command** — contract + resolver (locked-view agency re-check, event
   batch) + store wiring, with pure resolver tests: accept, decline (§14.4
   face), claim-conflict refusal, already-in-transit refusal, and a
   multi-actor journey landing both actors (arrival already covered by
   existing tests — extend, don't duplicate).
2. **Choreography swap** — walk-with-me (chip + NL twin) submits
   `move_together`; delete the two-move composition; int test that a shared
   journey drains to one arrival and restores co-presence at the
   destination.

## Open questions

- Does the NL accompany intake need a distinct admitted command kind, or does
  the existing accompany admission simply route to the new submit? (Leaning:
  same admission, new submit — decide in the A1+A4 plan.)
- Should `move_together` accept a declined invite as a *command refusal*
  (current lean: yes, the §14.4 face IS the refusal) or should the decline
  stay a pre-command choreography outcome so the command is only ever
  submitted post-acceptance? The locked re-check exists either way; this is
  about which surface renders the decline.
