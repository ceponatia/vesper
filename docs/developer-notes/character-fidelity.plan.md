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
3. **Cap regard soft-coloring** _(next)_ — bound `regardDispositionOverlays` to one
   band step from authored; add an "in her own idiom" line at warm+ bands so
   warmth growth keeps the authored manner (today `dispositionContrastLine` only
   fires on sign disagreement).
4. **Preferences reach the chat narrator** _(next)_ — cache-stable prefix block
   ("What lands well and badly with you") from `profile.preferences`; later a
   regex-first one-turn reaction verdict line (`chat-intent.ts` pattern) so reply
   and pulse agree in the same exchange.
5. **Wire inert sliders into existing mechanics** _(next)_ — extraversion →
   initiative cadence + ensemble quiet tolerance; dominance → forward-move
   ownership; confidence → drive-reveal posture. Note tag inertness in the editor.
6. **Per-character micro-exemplars** _(next)_ — forge/redraft generates 2–3 worked
   dialogue examples (deflection style etc.) stored on the profile, rendered in
   the prefix; encodes disposition + voice + age jointly.
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

- Slice 3: exact per-band step cap, and whether the idiom line is registry data
  (per warmth band) or composed.
- Slice 8: archivist-picked exemplars vs. a deterministic "most characterful line"
  heuristic (avoid an extra agent judgment on a hot path?).
- Slice 10: which traits flip to `developable` first, and the per-arc overlay clamp.
- Session-lane register block: canonical facts carries the hint only (slice 2);
  does the session rulebook need the full register block once a session cast
  regularly includes minors?
