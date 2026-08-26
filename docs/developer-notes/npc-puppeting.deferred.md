# NPC puppeting — the full handling system (deferred)

Status: parked — not committed work; tracked as a GitHub issue. The working v1 (the deflection directive) shipped with **personality Slice 2**
(2026-06-18); this file records what a complete puppet-handling system would add, so the
seams Slice 2 created are not mistaken for the whole feature.

## What "puppeting" is

The player's prose authors a **present NPC's** dialogue, affection, or action — "Sabrina
pulls me into a warm hug and says she's missed me" — rather than the player acting and
letting the engine + narrator drive the NPC. Disposition is only real if the player can't
narrate it away, so out-of-character puppeting must be refused.

## What Slice 2 already does (the working v1)

- **Detect** — intake writes `narratedNpcBehaviors: { npc, concept?, summary? }[]` onto the
  `IntentBrief` (`contracts/turns/intent-brief.ts`), generalizing the `movement.kind:
  "narrated_npc"` seam to non-movement behaviour. Empty on the regex fallback.
- **Judge** — `checkPuppetContradiction` (`contracts/personality/puppet.ts`), a pure rule:
  preference (concept/family) → tag affect (`warmth` lean + `wontInitiate` families) →
  honour. Contradiction ⇒ refuse; consistent / unclassifiable ⇒ honour.
- **Deflect** — `buildPuppetDeflection` (`engine/scene.ts`) emits a volatile **Disposition
  guardrail** directive telling the narrator not to honour the act and to answer with a
  brief in-voice meta aside. Consistent puppeting passes silently.

## What is deferred (the rest of the system)

1. **Merge-level state stripping.** v1 relies on the narrator's refusal: because the
   puppeted act never appears in the narration, the post-turn simulant never scores it, so
   there is no state to drop. A hardened system would *also* strip any affinity/meter/mood
   delta attributable to a contradicted puppet act in the merge — belt-and-suspenders for
   the case where the narrator partially honours the prose, and a clean home for the spec's
   "the merge drops any state effect the puppet implied" once a concrete path exists.

2. **Stronger refusal — no NPC authorship from the player prompt at all.** v1 is lenient:
   it honours *consistent* puppeting. The intended end state (spec §6, Note 2, forward
   note) is that the player cannot author NPC behaviour from the **player** prompt at all —
   in-character NPC authorship is routed through the **companion / narrator out-of-player-POV
   affordances**, which need their own improvement first. Until then, consistent puppeting
   is allowed and the guardrail fires on contradiction only.

3. **Richer contradiction judging.** v1 reads `tags` + `preferences`. Personality Slice 3
   adds atomic traits, and Slice 4 adds mood; `checkPuppetContradiction`'s signature should
   grow to read full traits + current affinity + mood (the same enrichment the social-
   reaction curve gets), so the judgment reads "she's guarded *and* already tense" rather
   than a coarse warmth lean.

4. **Tag-meaning depth.** The `warmth` + `wontInitiate` fields on `tags.ts` are the first
   slice of machine-readable "what this tag means to the NPC". A fuller tag-enrichment pass
   (the dedicated tag work) would give tags scored affect, initiation/reception asymmetry,
   and concept-level (not just family-level) stances.

## Relationship to other work

- A node in the pre-narrator before/during/after guardrail mesh
  (`pre-narrator-agents.spec.md`).
- The contradiction-judging enrichment folds into **personality Slices 3–4**
  (`personality-and-state.plan.md`).
