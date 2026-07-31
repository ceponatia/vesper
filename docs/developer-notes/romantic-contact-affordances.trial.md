# Affectionate-contact technical MVP — internal trial report

Status: **complete — 2026-07-31, awaiting the owner's verdict.** The verdict
decides what un-gates (plan §"Continuation order" 2). Flags were returned to
**off** after the runs; migration 0093 and the backfill-free schema stay
deployed either way.

## How it was run

Per the owner's rulings (2026-07-31): both flags (`CHAT_CONTACT_ACTIONS` +
`CHAT_PHYSICAL_CONSTRAINTS`) set globally on the Fly deploy for the trial
window; I drove the scripted set with the dedicated QA account
(`uxtest-main@vesper.local`) against fresh, fresh-start chats with the same
character (Sabrina Vale, dressed, café setting, default model); the owner
reviews this report and rules.

Six scripts, identical lines in both configs. **Config A** = flags off
(baseline, run first). **Config B** = both flags on. Scored per exchange on
four axes (1–5): COHERENCE (no contradicted physical state), CONTINUITY (held
touch acknowledged, ended touch never resurrects), NATURALNESS (no mechanical
wording), NON-INTRUSION (no forced irrelevant body detail).

| Script | A (flags off) | B (flags on) |
| --- | --- | --- |
| S1 approach→touch→chat→release | C4 / Ct3 / N5 / NI5 — touch she ended in prose silently RESURRECTED two beats later | C5 / Ct5 / N5 / NI5 — touch **held** ("She doesn't pull away"), acknowledged across an unrelated beat ("still under your hand"), clean release ("watches your hand leave") |
| S2 approach→touch→step back | 5/5/5/5 (she pre-ended the touch herself) | 5/5/5/5 — step-back registered; departure producer wrote proximity `near` with `chat.contact.departure` provenance (verified in the scene row) |
| S3 touch with NO approach | C2 — **teleport**: player at the door, touch lands instantly | prose STILL teleports (C2 unchanged) — but the **state stayed honest**: zero ledger rows, zero proximity, the designed diagnostics filed (`scene.relation_unavailable`, `contact.pose_unavailable`) |
| S4 "I kiss her" | character deflects; fine | **identical class of narration** (deflection), and the ledger is EMPTY — the romantic veto held in production; no machinery touched a romantic line |
| S5 touch → 3-hour skip | clean post-skip (no stale touch) | clean post-skip; see "settle race" below — this run's touch honestly no-op'd |
| S6 touch → "I walk over to her desk" | C2/Ct3 — **double teleport**, held touch VANISHED silently | prose still invents the desk scene, but the state ended the touch **durably**: `contact_started` @2, `contact_ended` @3 (`scene_changed`) — no stale touch survived into the new scene |

## What the flags visibly changed (the wins)

1. **Held touches persist and are narrated as persisting.** The committed
   contact's mandatory outcome made the difference between baseline's
   she-always-shrugs-it-off and B-S1's held-through-conversation arc — and
   between baseline's silent resurrection (A-S1.4) and B's state-aligned
   release beat.
2. **Material reaches the prose.** B-S6's touch reads "warmth of her shoulder
   solid **through the thin cotton of her shirt**" — the material-between
   transmission surfacing naturally, not mechanically.
3. **The state never lies.** Every ledger check matched the fiction's
   authorized events exactly: committed touches produce rows; releases,
   scene changes end them; romantic lines and unreachable touches produce
   NOTHING. The full loop (detect → resolve → commit → transactional persist
   → acknowledged outcome) ran in production, verified in Neon.
4. **Nothing got stilted.** No mechanical wording, no forced body details, in
   any B run — NATURALNESS/NON-INTRUSION stayed 5/5 across the board.

## What the flags did NOT fix (the bounded result)

- **Prose teleports survive.** An unreachable touch (S3) or an
  invented-scene move (S6) still RENDERS in prose, because an `unresolved`
  attempt produces silence by design (unavailable is never narrated as
  refusal) and nothing fences the narrator's own improvisation. The
  improvement is honest state + diagnostics, not prose prevention. Preventing
  it needs a geometry-fed **constraint** ("she is across the room") in the
  physical-guidance channel — a natural, small follow-up: the scene owner's
  reach read already knows; only the constraint wording is missing.
- **The settle race.** The coverage capture (which the material-honesty rule
  requires for a dressed body) is written at the PREVIOUS turn's settle. A
  touch sent within ~20–30s of the prior send (before post-turn legs finish)
  honestly no-ops with `contact.material_unavailable` (B-S2, B-S5). Humans
  pacing normally rarely hit this; scripted/fast users will. Follow-up worth
  ruling on: capture coverage pre-prompt in the contact leg rather than
  relying on the previous settle.
- **NPC prose vs projection.** When SHE eases the touch off in prose (her
  right under actor control), the projection still holds the contact until a
  player release/departure/skip/scene change ends it. No visible incoherence
  surfaced in the runs (a later guidance line could theoretically claim a
  touch she ended). The eventual fix is an NPC-side ending producer — part of
  continuation item 3 (actor control through the live lane).

## Recommendation

The trial's question was whether narration is **more coherent and natural**
with the machinery on. On these runs: yes on coherence wherever the machinery
had authority (held contacts, releases, endings, material), neutral on
naturalness (no regressions, no mechanical texture), and neutral-with-honest-
state on the classes it deliberately does not police yet (unreachable-touch
prose, invented scenes). No run was worse than baseline; three were clearly
better; the failure classes that remain are the ones already queued (reach
constraints, NPC endings) or needing one small ruling (pre-prompt coverage
capture).

**Recommend: verdict PASS for the affectionate tier**, with enablement
following the two follow-ups above rather than preceding them — or a
provisional enablement accepting the bounded gaps. Owner's call.

## Artifacts

- Trial chats (uxtest account): Trial A — S1…S6, Trial B — S1…S6 (Sabrina
  Vale; B-chat ids j7w7q…, whbzj…, i5tsn…, s8464…, rtrev…, syyai…).
- Ledger verification: `chat_contact_events` on Neon (queries in-session);
  scene projections read from `character_chats.scene`.
- Machine diagnostics: `engine.chat` log lines showing
  `contact.material_unavailable` (B-S2/S5) and
  `scene.relation_unavailable` + `contact.pose_unavailable` (B-S3).
