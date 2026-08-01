# Affectionate-contact technical MVP — internal trial report

Status: **verdict PASS (owner, 2026-08-01) — rev 3.**

## The verdict (owner, 2026-08-01)

**PASS for the affectionate-contact tier.** The product-value gate and the
three bounded contact-lane repairs (item 1.2) are accepted. Continuation
items 3–6 un-gate in their existing sequence; the broader parked list
remains parked. The live NPC-withdrawal case may remain "not exercised" —
its deterministic persistence suite is sufficient for this gate, and its
first organic production occurrence should be monitored.

**One condition on enablement:** both flags stay off until the
outfit-restatement work is FINISHED and passes targeted verification. The
strict guard (`370d583`) fixed complete restatements only; the rerun proved
partial paraphrases still demote a modelled wardrobe (evidence §Residuals).
The finished guard must protect both the character-side and player-side
modelled wardrobes from narration-only complete or partial restatements,
preserve every real change (garment deltas, exposure claims, preset changes,
genuine whole-look replacements), carry multi-garment and false-positive
regression tests, and pass one targeted live check: a partial outfit
description settles and an immediate valid touch still commits with the
correct cloth layer. No full S2/S5/S3 rerun.

**The condition is met — see §"Post-verdict verification (2026-08-01)"
at the end of this report.** Flags were returned to **off** after each trial
window; migration 0093 and the backfill-free schema stayed deployed
throughout.

**The full auditable record — every chat id, message id, timestamp, verbatim
transcript, ledger row, scene projection, diagnostic code, and every labeled
attempt — is the
[evidence appendix](romantic-contact-affordances.trial.evidence.md).** This
report is the summary and the judgment; the appendix is the proof.

## How it was run

Per the owner's rulings (2026-07-31): both flags (`CHAT_CONTACT_ACTIONS` +
`CHAT_PHYSICAL_CONSTRAINTS`) set globally on the Fly deploy for each trial
window; the scripted set driven with the dedicated QA account
(`uxtest-main@vesper.local`) against fresh disposable chats with the same
character (Sabrina Vale, café setting, default model `z-ai/glm-5.2`); the
owner reviews this report and rules.

Two windows:

1. **Original run (19:20–19:57Z)** — six scripts, identical lines in both
   configs. Config A = flags off (first), Config B = both on. Scored per
   exchange on four axes (1–5): COHERENCE, CONTINUITY, NATURALNESS,
   NON-INTRUSION.
2. **Rerun of the affected cases (23:12–23:38Z)** — after the item-1.2
   repairs (settle-race fix, S3 reach premise, minimal NPC-ending producer)
   plus the wardrobe restatement guard the rerun itself exposed
   (`370d583`). Fresh A/B pairs for S2, S5, S3 with the EXACT original
   scripts, flag-on lines sent the moment the prior stream closed (intervals
   in the appendix — no artificial settlement delay), plus a live
   NPC-withdrawal case. First configured runs are the results; every extra
   attempt is preserved and labeled in the appendix — including the S2-on
   attempt that FAILED and the fix it exposed.

## Results

### Original run (as amended — see "What the original evidence actually supports")

| Script | A (flags off) | B (flags on) |
| --- | --- | --- |
| S1 approach→touch→chat→release | C4 / Ct3 / N5 / NI5 — touch she ended in prose silently RESURRECTED two beats later | C5 / Ct5 / N5 / NI5 — touch **held**, acknowledged across an unrelated beat, clean state-aligned release. Ledger: start + `withdrawn` end. **The clearest player-visible continuity win of the trial.** |
| S2 approach→touch→step back | 5/5/5/5 (she pre-ended the touch herself) | Prose fine — but **the touch never committed** (`contact.material_unavailable`): NOT a valid contact-lifecycle proof. Superseded by the rerun. |
| S3 touch with NO approach | C2 — **teleport** | Prose still teleported (C2); state stayed honest (zero rows, zero proximity, the designed diagnostics). **A safety/presentation finding, not a visible-coherence pass.** Superseded by the rerun. |
| S4 "I kiss her" | deflection; fine | Identical class of narration, and the ledger is EMPTY — **the romantic veto held in production.** |
| S5 touch → 3-hour skip | clean post-skip | Clean post-skip — but **the touch never committed**, so the skip swept nothing: NOT a valid lifecycle proof. Superseded by the rerun. |
| S6 touch → "I walk over to her desk" | C2/Ct3 — double teleport, held touch VANISHED silently | **Partial / state-level win**: the state ended the touch durably (`contact_started` @2, `contact_ended` @3 `scene_changed`) — but visible prose still invented the desk scene and moved both bodies there. |

### Rerun (after the item-1.2 repairs)

| Case | Flag-off baseline | Flag-on result |
| --- | --- | --- |
| S2 (rapid pacing, ≤0.3s between exchanges) | she pre-ends the touch herself | **PASS, attempt 2** (attempt 1 failed and is preserved — see below): touch **committed with the cloth layer** from the current cut (no persisted capture, no settle wait); "the cotton of her work shirt warm between you" reached the prose; touch **held**; step-back → `contact_ended / separated`; proximity `near` with `chat.contact.departure` provenance; projection empty; no resurrection. C5/Ct5/N5/NI5 |
| S5 (touch → `hours` skip, rapid) | she pre-ends the touch | **PASS**: touch committed (with layer) BEFORE the skip; the skip request stamps the pending skip, and the first subsequent exchange writes `contact_ended / separated` at the advanced story minute (+180) before its prompt; projection empty; post-skip prose references the touch as past, never carries it; zero `material_unavailable`. C5/Ct5/N5/NI5 |
| S3 (touch, no approach) | **teleport reproduced** — touch lands instantly | **PASS**: zero rows, zero proximity, the designed diagnostics — and now the PROSE holds too: "the contact sliding past empty air instead of her shoulder" (attempt 1), "the counter keeps the distance fixed; **nothing lands**" (attempt 2). The captured built guidance carries exactly the typed reach premise: *"Unestablished reach: the current scene does not establish that the player's hand can reach Sabrina Vale's shoulder. Do not depict that touch as landing, and do not invent movement by either participant to make it land."* C5/Ct5/N5/NI5 |
| NPC withdrawal (live) | — | **Not exercised** (reported honestly, three labeled attempts): the flag-on narrator consistently chose to HOLD the committed touch — "your hand still rests", "not quite stepping out from under your hand" — including under a narrator-mode customer arrival, whose "shifts under your hand just enough to step toward the counter" is genuinely ambiguous and correctly below the conservative allow-list. The producer's durable behavior (end row identity, retake prune, idempotent replay, fail-closed conflict, no-resurrection) is proven by the mandatory 10-case integration suite instead. |

**The S2-on attempt 1 failure, preserved.** The first rapid flag-on S2 run
still no-opped `material_unavailable` — not the settle race (fixed), but a
second de-modelling path the trial surfaced: the archivist's legacy outfit
bridge folded the narrator's PARAPHRASE of her standing outfit as a free-text
replacement at the first settle, wiping the structured worn list before the
touch read it. Fixed the same day (`370d583` — a pure restatement no longer
wipes a modelled wardrobe), attempt 2 run and passed. Both attempts are in
the appendix.

## What the flags visibly changed (the wins)

1. **Held touches persist and are narrated as persisting** — original S1, and
   now the rerun S2/S5/NPC runs, where the narrator kept the hand in place
   across beats instead of the baseline's she-always-shrugs-it-off.
2. **Material reaches the prose from the machinery.** Rerun S2/S5 committed
   contacts carry the derived cloth layer, and the narration says so. (The
   original B-S6 "thin cotton of her shirt" line predates the fix and was the
   model's own invention over a bare state read — the appendix corrects that
   attribution.)
3. **Unreachable touches no longer land — in state OR prose.** S3's honest
   state (silence + diagnostics) now pairs with a typed reach-premise
   constraint, and both rerun S3 attempts kept the touch from landing without
   inventing movement or a refusal.
4. **Endings are durable.** Player release (`withdrawn`), departure
   (`separated` + the proximity it licenses), story-clock skip (`separated`,
   written by the first post-skip exchange at the advanced minute — the skip
   endpoint itself only stamps the pending skip), scene change
   (`scene_changed`) — all ledger-verified in production.
5. **Nothing got stilted.** No mechanical wording, no forced body detail, in
   any flag-on run across both windows.

## What remains bounded (deviations for the owner)

- **The NPC-ending producer is live but conservatively silent.** Its
  allow-list refuses ambiguous prose by design; in three live attempts the
  narrator never wrote an explicit ending for it to read. Its correctness is
  integration-proven; live exercise awaits a conversation that actually
  states one.
- **Partial paraphrases still demote a modelled wardrobe** (the restatement
  guard is strict on purpose), and the player-side outfit fold has the same
  unguarded fallback (follow-up filed). This is wardrobe-track work, not
  contact-lane work. **Resolved 2026-08-01** (the verdict's enablement
  condition): the finished guard protects both folds from complete AND
  partial narration-only restatements — the boundary is now evidence of a
  DIFFERENT look (an undress claim or a garment noun foreign to the worn
  names, per the `contracts/items/garment-nouns.ts` registry) rather than
  every-name-restated; multi-garment and false-positive regressions pinned
  in `chat-state.test.ts` + `chat-wardrobe.int.test.ts`.
- **S6's prose teleport class** (invented scenes on object/furniture lines)
  remains: the state ends contacts durably through scene changes, but nothing
  fences the narrator's own scene invention. Out of this pass's scope.

## Honesty note on the earlier claim

The original report said "the state never lies." That was too strong then and
is retired: NPC-prose endings were not yet projected (a guidance line could in
principle have claimed a touch the character had ended in prose), and the
original S1 commit carried a bare-skin material read while the fiction wore a
shirt — honest against a wardrobe the state didn't have, wrong against the
fiction. What the evidence supports now: **committed state matches the
authorized events exactly; the reply-side producer aligns explicit NPC-prose
endings; ambiguous prose remains a known, bounded gap.**

## Recommendation

The rerun closes the three bounded gaps the original run found: the settle
race is deterministically gone (rapid-pacing commits with material, in
production, plus the pinned regression suites), S3 receives honest reach
guidance that visibly works, and the NPC-ending producer is durable and
retake-safe (integration-proven; conservatively silent live). No run in
either window was worse than baseline; the failure classes that remain are
named above and owned elsewhere (wardrobe extraction, scene invention).

**Recommend: verdict PASS for the affectionate tier.** The enablement gate
the owner set — bounded repairs plus their evidence — is met.

## Post-verdict verification (2026-08-01)

The verdict's enablement condition, discharged:

**The finished guard.** `fe971f8` gave the player fold the character fold's
restatement guard; the follow-up commit on this branch re-cut the shared
predicate from *every-worn-name-restated* to *evidence-of-a-different-look*
(an undress claim or a garment noun foreign to the worn names, per the new
precision-biased `contracts/items/garment-nouns.ts` registry — a noun the
registry misses fails toward KEEPING the structured wardrobe). Complete and
partial restatements — including styling paraphrases naming no garment, the
trial's exact residual — now keep the modelled wardrobe on both folds;
explicit deltas, exposure claims, preset matches, and genuine whole-look
replacements still apply. Multi-garment and false-positive regressions are
pinned in `chat-state.test.ts`, `garment-nouns.test.ts`, and both fold
suites in `chat-wardrobe.int.test.ts`.

**The targeted live check — PASS** (fresh disposable chat on the QA
account, both flags on, image = this branch):

- Chat `xt7zc2ujgou87g339f278xpw`. Exchange 1
  (`pna1lzgcijpvefvd04v3qnpk` @16:44:01.032Z): "I walk over to her. Her
  sleeves are shoved past her elbows, one cuff dusted with flour." — the
  approach plus a strictly PARTIAL outfit paraphrase (no garment named).
  Settle-1 @16:44:14.139Z filed `chat_garments.legacy_outfit_bridge` +
  `chat_wardrobe.outfit_restatement` — the archivist extracted the
  paraphrase, the legacy bridge folded it, and the guard held: the state row
  kept `worn_item_ids: [sabrinacottonshirt0trial]`, preset `work`, overlay
  `""` (trace lane `legacy`).
- Exchange 2, the immediately following line (`pngg0a36go2vlccl6qve35vq`
  @16:44:42.596Z): "I rest my hand on her shoulder." — **committed**:
  `contact_started` @story-minute 2 under
  `contact:pngg0a36go2vlccl6qve35vq`, `materialBetween` = one cloth layer
  (`s2oq4myennj3u0wiegup43w3:root`, evidence `coverage:shoulders/opaque`),
  `directSkinContact: false`, and the reply narrates it: "…through the soft
  cotton of her work shirt." No `contact.material_unavailable` anywhere.
- Supporting runs from the same window: `rdgir5apwv9jake3iaviuxu1` (an
  ORGANIC partial opening — "sleeves already pushed up" — guard held at
  settle-1, same diagnostic pair) and `jawc4smbqg3xt73thx09s5d4` (a
  complete-restatement settle followed by a committed touch with the same
  1-layer material shape).
- **Configuration note, disclosed:** the first enablement attempt set the
  flag secrets to `1`, which the parser (`=== "on"`) reads as OFF — caught
  when `rdgir5apwv9jake3iaviuxu1`'s touch resolved
  `unresolved / geometry_unavailable` with the inspector reporting both
  flags false. Reset to `on`; every result above is from the corrected
  configuration.

**Flags are now ON and stay on** (`CHAT_CONTACT_ACTIONS=on`,
`CHAT_PHYSICAL_CONSTRAINTS=on`, set 2026-08-01 ~16:39Z) — the enablement
the verdict authorized. Per the verdict: the NPC-ending producer's first
organic production occurrence should be monitored; no further broad
contact-foundation review before the next ruled item.

## Artifacts

- [Evidence appendix](romantic-contact-affordances.trial.evidence.md) — full
  ids, verbatim transcripts, ledger rows, projections, diagnostics, scores,
  and every labeled attempt, for both windows.
- Trial + rerun chats live on the uxtest account (titles `Trial A/B — S1…S6`,
  `Rerun A/B — …`); ledger rows in `chat_contact_events`, projections in
  `character_chats.scene` (Neon, production).
- Implementation: `7eb1ea1` (item 1.2 — race fix, reach premise, NPC-ending
  producer), `370d583` (wardrobe restatement guard).
