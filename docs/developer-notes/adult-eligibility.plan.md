# Adult eligibility — the explicit participant declaration

Status: next (planned 2026-07-30 from the owner's romantic-contact rulings and
same-day scope correction; build order ruled: after the romantic-contact
slice-2 hardening pass, before the first genuinely romantic foot trial)

## In one sentence

Give every participant in a scene — characters and the player persona alike —
an explicit `adult | minor | unresolved` declaration that is independent of
their written age, so romantic and intimate contact can require a positive
"everyone here is an adult" answer instead of inferring one from text that was
never designed to prove it.

## Why this exists

The repo's only age gate today is a negative fence: it rejects characters whose
numeric age reads as a minor, and treats everything it cannot parse — a blank
age, "ancient", "seventeen" written out, a fantasy-scaled 312 — as an adult.
The player persona carries no age at all, so the system's own prompt assertion
that "everyone taking part is an adult" is unverified for one of the two people
in every scene.

The owner ruled (2026-07-30, recorded in the
[romantic-contact audit](romantic-contact-affordances.audit.md#owner-decisions-needed))
that romantic and intimate contact require **positive** adult eligibility for
every participant, with fantasy-scaled and missing ages staying `unresolved`
and failing closed. The contact contracts already enforce that rule — which
means the ruled-`romantic` foot trial stays fail-closed for everyone until a
declaration exists that can resolve a participant to `adult`. That makes this
a **cross-cutting prerequisite**: it gates the romantic-contact plan's first
romantic trial (slice 3), not just the later intimate slices.

## What the owner ruled

- An explicit `adult | minor | unresolved` declaration, independent of
  numeric/display age.
- Every participant must be positively `adult` for romantic or intimate
  contact.
- Existing records default to `unresolved`.
- Player and NPC declarations are authoritative inputs; the legacy adapter maps
  them into the existing contact eligibility read.
- The repo-wide `isMinorAge` fail-open fallback is **not** changed as part of
  this feature.
- The declaration ships before the first genuinely romantic foot trial. Slice 3
  of the romantic-contact plan may begin earlier with a separately authored,
  genuinely affectionate/non-romantic integration case.

## The experience we want

An author opening a character (or the player opening their persona) can state
plainly: this participant is an adult. Until someone does, nothing breaks —
ordinary chat, affectionate contact, and every existing feature behave exactly
as today — but romantically or intimately framed contact reports that it
cannot proceed because eligibility is unresolved, rather than assuming an
answer.

A character whose numeric age already reads as a minor can never be declared
eligible: the declaration adds a positive proof, it does not override the
existing fence. The two must agree; a contradiction is a validation error, not
a tug-of-war.

## Boundaries

- This is a **fiction-side declaration about characters and personas**, not
  age verification of the human user, and not a content-rating or account
  gating system.
- It does not loosen anything: no surface that is gated today becomes less
  gated, and `isMinorAge` keeps rejecting known numeric minors everywhere it
  already does.
- It does not decide consent, attraction, or permission — those remain the
  permission owner's job (romantic-contact slice 3).
- Successor-lane wiring is contract-level only until that lane's adapter work
  is scheduled; the declaration itself must be lane-neutral data.

## Delivery outline

### Slice 0 — contract and storage

The declaration vocabulary, where it lives on character records and the player
persona, the `unresolved` default for every existing record, and the
agreement rule with the numeric-age fence (a declared `adult` on a
numeric-minor record is invalid). Technical shape goes in a spec file at
implementation time.

### Slice 1 — authoring surfaces

The character editor and persona editor gain the declaration with plain
wording, defaulting to `unresolved`. Copy should be honest: this is a
statement about the fiction's participant, and romantic/intimate framing stays
unavailable until it is made.

### Slice 2 — the legacy adapter read

Map declarations into the contact core's existing participant-eligibility
read: declared adult ⇒ `eligible`, declared minor or numeric-minor ⇒
`ineligible`, everything else ⇒ `unresolved`. Degradation diagnostics for
malformed values. This is the slice that actually unblocks the romantic foot
trial.

## Success criteria

- Every existing character and persona reads `unresolved` with no data
  backfill beyond the default.
- A declared-adult player persona plus a declared-adult character lets a
  `romantic` contact attempt pass the eligibility gate (permission still
  applies).
- A numeric-minor record cannot be declared eligible, and a declared `minor`
  fails eligibility even where the numeric fence would have passed it.
- No behavior change anywhere for `unresolved` participants relative to today.

## Open questions

- Where exactly the declaration lives per record kind (character profile field
  vs attribute registry vs persona profile field) — a spec-time decision.
- Whether world/scenario templates can pre-declare cast members, and whether
  imports carry the declaration.
- What the editor copy says, and whether the persona prompts for it once or
  stays quiet until a romantic feature first needs it.
