# Character drives — desires & secrets as gated inner life

Status: **next** (planned 2026-07-11, from the character-chat & schema engagement
review — seven-plan batch at the top of [roadmap.md](roadmap.md) §Next; effort
**L**)

The character's interiority is one free-text `mindNote` (pulse-written, 1–3
sentences) plus `openLoops` (conversational leftovers). There is no want she
*pursues* across exchanges and no secret she *withholds* — the `private` fact
channel fences only the **player's** interiority. Drives are what turn a
reactive chatbot into a character with an arc: she steers scenes, teases,
deflects, confesses.

## Design

- **Authored** — `CharacterProfile.drives`, ≤3 entries:
  `{ want (short phrase), why (one line), secrecy: "open" | "guarded" |
  "secret", revealBand?: { axis: "familiarity" | "regard", band } }`. The forge
  drafts them (a new profile-section instruction, sibling of the personality
  sketch); the editor gets a "Desires & secrets" card on the Disposition tab;
  Forge-the-rest and per-tab Re-draft cover the field.
- **Runtime** — `character_chat_state.drives` (new jsonb column, migration;
  seeded from the profile at first exchange, scenario-modal-editable like the
  card set): adds `{ progress?: string, revealedAtExchange?: number }` per
  drive. Included in `storedChatStateSchema` (rollback-safe), `ChatStateEdit`,
  and the state-tools modal.
- **Archivist 8th field** — `driveUpdates`: progress notes, resolution, and
  (rare) a new drive minted by the fiction, capped; a degraded archivist keeps
  the prior drives untouched (the open-loops rule).
- **Prompt law** — a "What you want" block in the volatile tail (drives change
  too often for the byte-stable prefix): `open` drives render plainly;
  `guarded` render with a withhold-until-asked note; `secret` drives **below**
  their band render as withholding law — the character knows it, steers around
  it, may deflect and (under direct pressure) lie about it: the first
  mechanical footing for character-side lying. At or above the band the block
  flips to "you may let this out when the moment is right."
- **Reveal = milestone** — new `MilestoneKind` `"secret_shared"` (a data edit
  on the enum; `deriveExchangeMilestones` reads the archivist's reveal signal),
  surfaced on the relationship panel. The reveal also files a `perceived` fact
  so RAG remembers it was said out loud.
- **Guardrail** — drives never override the §6 curve or the relationship law;
  they add motive, not permission (the escalation floor still governs).

## Slices

1. Contracts (profile + state shapes, band gate) + seeding + state tools +
   migration.
2. Forge section + editor card + redraft coverage.
3. Prompt block + withholding law + archivist field + reveal milestone + fact.
4. Eval fixtures: `chat-secret-hold` (secret survives direct probing below the
   band, in character) and `chat-secret-reveal` (reveal lands at band, files
   the milestone + fact).

## Open questions

- Lying license: outright false statements below the band (models may
  over-lie) or deflection-first with lies only under direct pressure? Lean
  **deflection-first**, lie license reserved for `secrecy: "secret"`.
- Does a reveal that contradicts an earlier in-fiction lie need special fact
  supersedence, or does ordinary extraction supersedence already cover it?
  (Likely free — verify in slice 3 tests.)
- Multi-character substrate: drives are already keyed per (chat, participant) —
  confirm the ensemble prompt frame
  ([multi-character-chat.plan.md](multi-character-chat.plan.md)) budgets a
  per-character want line.

## Cross-links

- [chat-initiative.plan.md](chat-initiative.plan.md) — life-event beats draw on
  drives for offscreen texture.
- [memory-callbacks.plan.md](memory-callbacks.plan.md) — a reveal is a prime
  callback candidate.
