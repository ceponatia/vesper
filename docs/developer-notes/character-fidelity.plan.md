# Character fidelity — disposition & age realism, long-term anti-drift

Status: next (slices 1–2 shipped — 2026-07-13; slices 3–10 queued below)

The owner's report (2026-07-13): some personality/disposition fields barely affect
narration; long chats drift until characters read generic; and numeric age doesn't
influence prose — children and teens speak like adults or far too wise for their
years. A two-agent code sweep grounded ten improvements; this plan is their index.
Chat lane leads per the test-bed direction (`CLAUDE.md`); slices with obvious
session twins name them.

## Diagnosis (from the 2026-07-13 sweep)

- The character sheet is re-injected fresh every turn (stable prefix), so drift is
  not the sheet falling out of context — it's the 40-exchange history dominating
  attention with nothing anchoring *voice* near generation, an events-only summary
  fold (`prompts/chat-summary.ts` — deliberately "NOT dialogue"), and no chat-lane
  consistency check (the session continuity agent has no chat twin).
- A mechanical homogenizer: `REGARD_TRAIT_SHIFTS`
  (`contracts/personality/modulation.ts`) pushes every character toward
  warm/open/uninhibited as regard climbs (smitten = warmth +35, guardedness −40,
  inhibition −25) — long successful chats converge on the same personality.
- Disposition **tags** are inert (cards never shipped); **preferences** never reach
  the chat narrator (only the post-turn pulse), so a "dislikes compliments"
  character accepts the compliment and only the number stings;
  `confidence`/`extraversion`/`dominance` are hint-only.
- Age renders as one line ("You are 15 years old.") plus the generic rule 7; the
  chat `CONTENT_FRAMING` asserts "every character is a fictional adult", which
  actively fights age-true minors. The owner's own note
  (`user-guidance/ideas.md` §Model Improvements 2) confirms non-adult characters
  exist and are never for intimate scenarios.

## Slices

1. **Life-stage registry from numeric age** _(shipped — 2026-07-13)_ — `contracts/world/life-stage.ts`:
   bands (child / teen / young adult / adult / middle-aged / elder) with
   `promptHint` + `registerRules` + `minor` flag; `lifeStageForAge` parses bare
   numerals like `formatAge` (blank / non-numeric / >120 ⇒ none — fantasy ages are
   species-scaled, never forced into a human register). Chat identity line and
   session canonical-facts line carry the hint. Registry pattern — pure data, no
   migration.
2. **Minor/elder register enactment + content-framing fix** _(shipped — 2026-07-13)_ — bands with
   `registerRules` render a binding "Life stage" block (chat prefix; ensemble
   member sheets get a compact form). Minor fence: intimate disposition bands,
   the disinhibition block, the intimate-craft rules block, the selfie license,
   and the relationship escalation line never render for a minor; session
   `buildIntimateDispositionLine` skips minors. `CONTENT_FRAMING` is scoped:
   the adult assertion attaches to intimate-content *participants*; a minor
   primary flips to a hard romance-out-of-scope framing; an ensemble with a
   minor member adds a cast fence line.
3. **Cap regard soft-coloring** _(shipped — 2026-07-14)_ — `regardDispositionOverlays`
   now clamps each overlay to **one band step** from the authored value
   (`REGARD_OVERLAY_MAX_BAND_STEPS` = 1, via `clampValueToBandSteps` in
   `traits/registry.ts`); a composed `dispositionIdiomLine` (`relationships/law.ts`)
   fires at warm+ regard for a cold-side authored warmth so growing closeness keeps
   the character's own manner. Rulings below.
4. **Preferences reach the chat narrator** _(shipped — 2026-07-14)_ — a cache-stable
   "What lands well and badly with you" prefix block (`buildPreferencesSection`,
   `describePreference`) renders `profile.preferences` so a like/dislike shapes the
   reply IN the exchange, not just the post-turn pulse; intimate-concept preferences
   fence out for a minor. The one-turn reaction-verdict line is deferred as a
   **follow-up** (see Follow-ups) — a robust version needs the pulse's LLM classifier
   pre-turn, which isn't the "clean and small" the stretch bar asked for.
5. **Wire inert sliders into existing mechanics** _(shipped — 2026-07-14)_ —
   `social.extraversion` → initiative-opener cadence (`buildInitiativeCue`) + ensemble
   quiet tolerance (`ensembleQuietThreshold`); `social.dominance` → the `CHAT_RULES`
   forward-move rule; `temperament.confidence` → the drives block's reveal posture.
   All keyed off the shared `traitPole` (±34), so a mid/absent value is byte-identical.
   The Disposition-tag editor now flags that tags are inert (no cards read them yet).
6. **Per-character micro-exemplars** _(shipped — 2026-07-14)_ — `profile.microExemplars`
   (`{situation, line}[]`, cap 3; `contracts/world/profile.ts`) drafted by the forge
   (`groundMicroExemplars`), re-derived by the **profile** prose Re-draft scope, and
   hand-editable on the Profile tab (`MicroExemplarsEditor`); rendered as the "How you
   actually answer a charged moment" few-shots in the chat prefix so voice +
   disposition + age anchor near generation. Fill-merge is all-or-nothing (like outfit).
7. **Voice anchors near generation** _(next)_ — structured `voiceAnchors` (pet
   phrases, rhythm, never-says) + a one-line tail re-anchor beside the mood pin.
8. **Voice-exemplar ring past the summary horizon** _(next)_ — archivist picks ≤1
   distinctly in-voice line per exchange into a ≤5 ring on `character_chat_state`
   (callback/selfie ring pattern), rendered as "How you sound" few-shots.
9. **Chat-lane consistency check** _(next)_ — a `characterSlip` field on
   pulse/archivist → one-turn corrective tail note (session corrections pattern);
   promote the owner-gated enactment eval (deferred.plan.md §Owner-gated live
   eval runs) as its measurement.
10. **Explicit bounded personality evolution** _(next)_ — persisted `traitOverlays`
    (parallel to `attributeOverlays`), milestone-gated archivist proposals, small
    clamps, `narrative` source; flip plausible traits to `developable`. Change
    becomes visible, editable, rollback-safe — instead of implicit prose drift.

## Open questions

- Slice 8: archivist-picked exemplars vs. a deterministic "most characterful line"
  heuristic (avoid an extra agent judgment on a hot path?).
- Slice 10: which traits flip to `developable` first, and the per-arc overlay clamp.
- Session-lane register block: canonical facts carries the hint only (slice 2);
  does the session rulebook need the full register block once a session cast
  regularly includes minors?

### Resolved

- Slice 3 (ruled 2026-07-14): the per-band step cap is **one** step
  (`REGARD_OVERLAY_MAX_BAND_STEPS`) — conservative, and with the current 3-band
  traits it's a guardrail that never actually mangles a real shift (their 67-wide
  middle band means a ±40 overlay can't cross two bands on its own; it earns its
  keep against future tuning / narrower bands). The idiom line is **composed**, not
  registry data — one function keyed off the authored warmth value, mirroring
  `dispositionContrastLine` (simpler; no per-warmth-band registry to maintain).

## Follow-ups

- **Slice 4 — one-turn reaction-verdict line (deferred).** The plan's "later"
  regex-first verdict line so reply and pulse agree on the *same* exchange's act
  wasn't shipped: robustly classifying a social act (compliment/insult/…) is the
  pulse's LLM classifier's job, not a regex one (unlike the sensory/movement reads
  `chat-intent.ts` already does), and reusing that classifier pre-turn is an extra
  hot-path LLM leg — past the "clean and small" stretch bar. The prefix preferences
  block already tells the reply what lands well/badly, which addresses the core
  diagnosis; a future verdict line would sharpen turn-level agreement.
- **Slices 4 & 6 — ensemble parity (deferred).** The preferences block and the
  micro-exemplar few-shots render in the 1-on-1 lane only; ensemble member sheets
  (token-tight by design) don't yet carry them. Add if ensemble fidelity needs it.
