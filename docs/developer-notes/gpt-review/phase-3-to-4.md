# GPT review: Phase 3 to phase 4 doc-split migration plan

Source: [../phase-3-to-4.md](../phase-3-to-4.md)

## Overall opinion

This is useful as a historical routing document, but it is no longer a clean current anchor. It opens as a one-off plan to execute and then delete or mark completed, while the repo now has a completed phase 3 plan, direct phase 4 specs, and a partially implemented intake slice.

The best next action is to either mark this migration note completed with a short "what actually happened" section, or replace it with the missing `phase-4-plan.md`. Leaving it as an active plan makes it hard to tell which instructions are still live and which were overtaken by later docs.

## Gaps and mismatches

- The status is stale. The file still says `Status: plan` and "Execute the steps below, then delete this file or mark it completed" at `docs/developer-notes/phase-3-to-4.md:3`. Meanwhile `docs/developer-notes/phase-3-plan.md:3` is already marked completed.

- The phase 3 scope summary conflicts with later reality. This doc's bottom line says phase 3 includes romance-core proximity and first impressions, but the completed phase 3 plan says phase 3 shipped presence/perception v1 and deferred per-pair proximity, engagement, movement lock, contested transitions, and banded ambient light to phase 4+ at `docs/developer-notes/phase-3-plan.md:3`.

- Extraction step 3 says to author `phase-4-plan.md` at `docs/developer-notes/phase-3-to-4.md:187`, but no such file exists. The direct specs also repeat that their open questions should fold into that future plan.

- Extraction steps 4 and 5 call for re-suffixing several clean phase-4/5/6 specs, but the files are still `.phase3.md`: `npc-movement-spec.phase3.md`, `time-and-travel-spec.phase3.md`, `dynamic-character-introduction-spec.phase3.md`, `offscreen-simulation-spec.phase3.md`, and `character-memory-spec.phase3.md`.

- The file predates the approved intake implementation. It correctly identifies movement as phase 4, but it does not account for the now-existing `IntentBrief` seam that phase 4 movement and appointment systems should consume.

## Improvements I would make

- Create `phase-4-plan.md` now. It should be the current scan point for open questions, per the repo's developer-notes convention. Seed it from:
  - movement authority open questions;
  - scheduled arrivals open questions;
  - pre-narrator remaining questions after Stack A;
  - movement-coupled leftovers from proximity, time/travel, and location design.

- Mark this file completed once the phase 4 plan exists. Keep a concise migration summary rather than a long list of now-partial instructions.

- Separate "phase 4 committed scope" from "phase 4+ parking lot." The document is right to defer broad general-RPG machinery, but the active phase plan should not read like it owns every old `.phase3.md` remainder.

- Resolve the naming convention drift. Either re-suffix the clean docs now or record that this repo intentionally keeps several program-spine docs at `.phase3.md` until a later consolidation. The current half-state makes source links and code comments confusing.

- Add a short status table for the direct phase 4 specs:
  - movement authority: draft, not implemented, intake seam available;
  - scheduled arrivals: draft, not implemented, intake appointment seam available;
  - pre-narrator intake: Stack A implemented as classifier/plumbing, downstream enforcement pending.

## Things I do not think are a good idea

- Do not keep this document as the active phase anchor. It is a migration plan, not a working-phase plan, and the repo's own convention says `phase-N-plan.md` should be the anchor.

- Do not mechanically re-suffix everything before deciding what phase 4 actually owns. Some old specs are broad program references; renaming without scope decisions will create churn without clarifying implementation order.

- Do not carry all "full RPG" leftovers into phase 4 as committed work. The document's instinct to defer lower-romance-value machinery is correct; the phase 4 plan should be narrower and executable.

- Do not leave open questions scattered only in sibling specs. The direct phase 4 specs all point to a future `phase-4-plan.md`; until it exists, there is no single scan point for undecided items.

## Suggested current phase 4 spine

1. Intake handoff cleanup: normalize and inspect `IntentBrief`, then thread it to merge.
2. Movement authority: intake-derived player movement, unauthorized NPC movement suppression, implied-subspace no-op, partial player traversal.
3. Scheduled arrivals: intake-derived appointment records, appointment lifecycle, staged-intent trigger timing.
4. NPC movement expansion: only after authority and appointment ownership are settled.
5. Movement-coupled proximity/location/time followups: add only the parts needed by the above, not the entire old backlog.
