# Sensory grounding — post-ship fixes

Parent plan: [sensory-grounding.plan.md](sensory-grounding.plan.md) (shipped 2026-07-12).

## 2026-07-13 — authored scent still drifting to "clean" / "salty" (owner report)

A character authored `feet.smell: cheesy` kept reading as *clean* or *salty* in
narrator prose. Three prompt-level causes in `buildSensoryFocusSection`
(`engine/prompts/character-chat.ts`), all fixed the same day:

1. **The block itself said "clean".** On every smell/taste beat it appended
   `- Right now: clean skin, nothing strong` unless a hygiene threshold was
   crossed (initial hygiene 0.9 crosses nothing, and a stateless chat has no
   meter at all) — directly beneath `foot scent: cheesy`. The perfume line's
   label ("overall scent when clean") and the directive's "freshly washed mutes
   a scent" reinforced it, and the model obediently reconciled toward clean.
   **Fix:** an authored region scent/taste value is the *current truth*
   (`feet.smell` is mutable state, not a "when dirty" hypothetical). When one
   rendered: the perfume line is worded as an overlay above it, a crossed
   hygiene band *deepens* it ("stronger and staler, never a different
   character"), and no unremarkable-hygiene line renders at all. The
   `clean skin, nothing strong` default remains only when nothing regional is
   authored (a grounded default beats an invention vacuum).
2. **The taste clause hardcoded "salt".** `focusExperienceClause("taste")`
   instructed "skin under the tongue, its warmth **and salt**" — steering every
   taste beat toward salty prose regardless of the authored value. The word is
   gone.
3. **The verbatim ban had no semantic anchor.** "Never repeat them verbatim"
   forced a paraphrase of a bare enum token whose game meaning the model didn't
   know, so it reached for generic sweat vocabulary. The directive now holds
   each value's **character** fixed — unfold it into specific felt prose, never
   trade it for a milder/cleaner/more generic sensation; state deepens, never
   washes away — and the values themselves now carry authored meaning via
   `narratorGuidance` glosses
   ([attribute-narrator-guidance.plan.md](attribute-narrator-guidance.plan.md)
   core, shipped the same day: `foot scent: cheesy (dense fermented funk, like
   aged cheese — thick and unmistakable up close)`).

Generalization: nothing here is feet-specific — the region join, the layering
rules, and the gloss mechanism apply to every body region's sensory attributes
(intimate scent/taste palettes got glosses in the same change), which is the
long-run shape the owner asked for (all attribute fields grow sensory values).
