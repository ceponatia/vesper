# Social cards

A **social-reaction card** is importable taboo or social-rule content (`socialReactionCardSchema`,
`apps/web/src/contracts/personality/cards.ts` — pure, no IO).

Fields: `id`, `label`, `description`, `kind` (`social_rule` | `taboo` — an authoring label only),
`triggers` (interaction-concept ids, **not** free keywords), `severity` (0–100), an optional
`defaultReaction`, and `reactionOverrides` (per-tag flips).

A card carries **no raw affinity or mood delta**. One `severity` becomes a tier, then a base
intensity via a fixed ramp, and the response curve (`reactions.ts`: affinity + mood + trait scale,
clamped by the reaction step) does the rest — one curve shared with bespoke preferences.

## Severity → tier → intensity

Helpers in `cards.ts`:

- `severityToTier` — thresholds 26/51/76 → `odd` | `disapproval` | `shunning` | `ostracized`;
- `tierIntensity` — the fixed 2/5/8/10 ramp;
- `tierDefaultKind` — the kind a tier defaults to when the card authors none.

`ReactionKind` (`revulsion` | `disapproval` | `shunning` | `fear` | `accepting` | `enjoy` |
`kindred_spirit` | `indifferent`) maps to a curve valence via `reactionKindToValence`.
**`indifferent` ⇒ null** — a real "doesn't mind" verdict, not a fall-through.

## Triggers and overrides

Triggers are ids from the interaction-concept vocabulary
(`contracts/personality/interactions.ts` — `flirt`, `proposition`, `public_display`,
`boundary_push`, …), the same controlled vocabulary the reaction classifier maps prose onto.

**Tag overrides** (`reactionOverrides`) key on disposition tags — canonical ids
(`contracts/personality/tags.ts`) or free-form. Matching runs both sides through `normalizeTag`, so
case, spacing and underscore variants still hit. `resolveCardForTags` resolves **tag override
(first match) › card default › tier default**; an override whose tag no character carries is a
silent no-op at runtime.

## Resolution

`resolveCardReaction`: the first card whose `triggers` include the concept **governs outright** — a
pure override. A bespoke preference resolves ahead of any card (`resolveSocialReaction`).

## Storage

An inline JSONB snapshot array on `CharacterProfile.socialCards`
(`contracts/world/profile.ts`) — **snapshot copies, never live-linked** — so editing or deleting a
library card never reaches a character using it.

The `social_cards` library row stores the mechanical slice in a `definition` column
(`socialReactionCardExtrasSchema`) plus label and description; `cardFromLibraryParts` recomposes a
fresh-id inline card on import.

## UI

The mechanical controls (`SocialCardFields`, `components/personality/social-card-fields.tsx` — kind
· severity→tier · triggers · tag overrides · a live `CardReactionPreview`) are shared by the inline
array editor (`SocialCardsEditor`, on a character) and the standalone builder
(`/social-cards/[id]`), so both author the same `definition`.

Each override row edits the full `ReactionOverride`: a free-form tag with the canonical registry as
datalist suggestions, a reaction kind, an optional intensity (unset means the tier's ramped base),
and an optional hint.

The `/social-cards` library is an `EntityLibrary` with **All / Public / Owned** scope, a publish
toggle, and clone-on-use (`/api/social-cards/[id]/clone`); cards wire into embedding search like
items and locations.
