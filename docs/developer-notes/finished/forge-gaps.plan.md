# Forge gaps — close the hand-authoring holes found in the 2026-07-12 character build

Status: shipped — 2026-07-12

Building two chat-demo characters end-to-end through the forge (Wren Halloran, Vaelith Noor —
owner session 2026-07-12) surfaced six authoring gaps that forced hand-work the forge should
have done, plus one narrator-output artifact. This plan closes them.

## The gaps (all found in one build session)

1. **Starting relationship never drafted.** Both prompts explicitly described the
   player relationship ("engaged to the player nine years ago", "the player is her
   favorite client"); the Chat tab still seeded Strangers/Neutral. → The profile leg
   drafts `playerRelationship` (authored band picks + kind/history/mask/premise note),
   grounded against the band vocabulary; emitted only when the concept actually
   describes the player.
2. **Personal social cards never drafted**, even when the concept names hard lines in
   "hates X" form ("hates being haggled over her art"). → The profile leg drafts 0–2
   cards `{label, description, kind, severity, triggers}` grounded against the
   interaction-concept vocabulary, with a **preference-shadow guard**: a trigger the
   drafted preferences already opine on drops (a bespoke preference resolves ahead of
   any card, so the card would be dead weight).
3. **Only the 7 `coreVisual` attributes are tier-filled.** Everything else that scene
   renders re-invent per image (face structure, silhouette, hair length) stayed sparse.
   → New registry flag `renderVisual`; ~19 silhouette/face-structure enum attributes
   carry it; the forge's range emission + seeded fill now covers `[CORE]` **and**
   `[RENDER]` attributes. Sparse-is-correct still holds for everything unflagged.
4. **Secret reveal gates default to the top band.** Both forged secrets came out gated
   "Deeply known" (nearly unreachable; the ruled default is familiarity ≥ familiar).
   → Prompt bias toward mid-arc gates + grounding demotes extreme bands
   (familiarity `deeply_known`, regard above `close`) to the ruled default with a
   diagnostic.
5. **Drive want/why inputs clip silently** at 120/200 chars (`maxLength`, mid-word, no
   feedback) — and schema-side, an over-cap `why` was `.catch("")`-wiped rather than
   truncated. → Contracts truncate over-length text instead of dropping/wiping; the
   Desires & secrets editor shows a live counter as a field nears its cap.
6. **Mood words leak into physical attributes** (a fog-worn *town* gave a 36-year-old
   "weathered" skin). → One guardrail line in the attributes system prompt.
7. **(Chat, not forge)** Aion 2.0 appends trailing meta-commentary ("Note for the
   parser: …") that `stripNarratorArtifactStream` doesn't catch. → The artifact
   stripper also cuts a line-start parser/system/engine-note block through end of
   stream, stream-safe across chunk boundaries.

## Non-goals

- Cards keep their "never re-drafted" rule (create/fill only; the redraft scopes are
  untouched except that disposition already owned drives).
- Intimate anatomy stays human-authored — the forge vocabulary still excludes it, so
  the render tier covers non-intimate morphology only.
- No band-vocabulary or schema migrations; everything is registry data + prompt +
  grounding + one UI touch.

## Fill-merge policy additions (lib/character-fill.ts)

- `playerRelationship`: adopted from the generated draft only while the base's is
  still the untouched default (mirrors the species cluster) — any authored band,
  text, or mask freezes it.
- `socialCards`: additive, deduped by normalized label; authored cards never change.

## Shipped state

All seven gaps closed 2026-07-12, same day they were found:

- `groundPlayerRelationship` + `groundSocialCards` in `server/authoring/character-forge.ts`
  (new prompt sections, new diagnostics `unknown_relationship_band` /
  `unknown_card_trigger` / `card_trigger_shadowed` / `card_without_triggers` /
  `cards_capped`); card ids derive from a label hash so demo forges stay deterministic.
- `renderVisual` flag on 19 attributes (`contracts/attributes/categories/*`);
  `fillCoreVisualDefaults` → `fillVisualDefaults` (diag `core_defaults` →
  `visual_defaults`); `[RENDER]` joins `[CORE]` in the range-emission prompt.
- Reveal-gate ceiling in `groundDrives` (`extreme_reveal_band`), + prompt bias and the
  secret-substance instruction ("put the actual truth in the why").
- Drive want/why/progress caps truncate via `cappedText` (`contracts/personality/drives.ts`);
  `DrivesEditor` shows a live counter from 80% of cap.
- Mood-word guardrail line in `ATTRIBUTES_SYSTEM`.
- Meta-note cut in `server/ai/narrator-artifacts.ts` (line-start markers, stream-safe,
  whitespace-folding; documented in docs/prompts.md §Narrator output cleanup).
- Fill-merge policies + `isPlayerRelationshipUnset` in `lib/character-fill.ts`;
  `renderSheetLines` now renders the authored relationship + card labels.

Leftovers: none. The existing characters built before this (Wren, Vaelith) already had
these fields hand-authored; no backfill needed.
