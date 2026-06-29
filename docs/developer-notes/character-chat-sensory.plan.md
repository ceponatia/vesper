# Character chat — opportunistic sensory cues

Status: **next** — queued, settled. A prompt-only pass to surface proximity-gated sensory
detail (scent first) in the sessionless Chat tab, *when the beat earns it*. No session
exposure/proximity simulation in this pass (that's the deferred escalation, §Follow-up).

Related: [prompts.md](../prompts.md) §Exposure gating (the **session-lane** sense machinery
this deliberately does *not* port yet), [contracts/attributes.md](../contracts/attributes.md)
(the registry + `kind`), [character-chat.plan.md](finished/character-chat.plan.md) /
[character-chat-state.spec.md](finished/character-chat-state.spec.md) (the chat prompt this edits),
[narrator-prompt-focus.plan.md](finished/narrator-prompt-focus.plan.md) §Behavioral eval harness (the
`pnpm eval:narration` harness this adds a fixture to), [intimacy-notes.plan.md](intimacy-notes.plan.md)
(the adjacent intimate-tier work; both ride the same "surface only when earned" discipline).

---

## Goal

Improve character-chat narration so sensory attributes — especially
`presentation.scent_baseline` — surface **naturally when relevant**, as a small embodied
detail when the scene earns it: closeness, approach, a first encounter, physical intimacy,
explicit smell/touch/leaning/nearby input, or a scenario/premise where scent is salient.

The target behavior is **not** to mention scent constantly. Scent is *one possible sensory
hook*, not a required checklist item. Most ordinary, distant chat turns should mention nothing
of the kind.

### Target example

> Sabrina notices you enter the room and blushes. She takes a step toward you, the floral
> scent of her perfume fading into your notice as she nears.
> [Sabrina] "How are you today, Danial?" she asks with a smile.

The approach earns the detail; one hook is enough; it's woven into the action, not announced.

---

## Current architecture findings

Grounded in the files this plan touches.

### The chat prompt builder renders every applicable attribute as a flat `label: value` line
`buildCharacterChatSystemPrompt` (`src/server/engine/prompts/character-chat.ts:176`) resolves
`profile.attributes` (`resolveAttributes`), then for each value: skips `apparent_age`, looks up
the registry `def`, skips `excludeFromPrompts`, checks `realizedBody.isAttributeApplicable`,
and renders `attributePhrase(def.label, def.unit, value)` (`character-chat.ts:120`) into an
**Attributes** block, collecting each def's `promptHints` into a deduped **Phrasing guidance**
block (`character-chat.ts:214-226, 269-272`). There is **no sense-aware treatment**: a sensory
attribute is rendered identically to a physical one.

### `presentation.scent_baseline` already leaks today — flatly, and with a chat-meaningless hint
`scent_baseline` (`src/contracts/attributes/categories/presentation.ts:30`) is
`kind: "sensory"`, `category: "presentation"`, `valueType: "text"`. With no body-plan gate it's
always applicable, so today it renders as a bare `- baseline scent: lavender soap and cedar`
Attributes line, and its `promptHint` — *"Surface scent only within the exposure mask's scent
range; closeness earns detail."* — lands in **Phrasing guidance**. But **the chat lane has no
exposure mask** (`character-chat.ts` builds none), so that hint is a dangling reference, and the
flat line invites the model to state scent unconditionally. This is exactly the failure mode the
plan fixes.

### The sensory `kind` spans three very different cases
`def.kind === "sensory"` (`attributes/types.ts:4`) covers:
- **`presentation.scent_baseline`** — proximity-gated, safe for ordinary chat *when close*.
- **`voice.pitch` / `voice.timbre` / `voice.cadence`** (`categories/voice.ts`) — sensory but
  **audible at any conversational distance**; not proximity-gated at all.
- **`vulva.scent` / `vulva.taste` / `penis.scent`** (`categories/intimate/*`) — **intimate**,
  earned only at close/intimate exposure (which chat lacks).

So "all non-intimate sensory" is the wrong filter: it would sweep in **voice**, and gating voice
behind closeness is both semantically wrong and breaks existing tests — the default test
`profile()` authors `voice.pitch`/`voice.cadence` and asserts they render in Attributes
(`character-chat.test.ts:19-20,42`).

### Intimate categories have a ready-made gate
`INTIMATE_ATTRIBUTE_CATEGORIES = ["breasts","vulva","penis","testicles"]` with
`isIntimateAttributeCategory(category)` (`src/contracts/body/locations/intimate.ts:32-37`) — the
canonical predicate. `realizeBody` already drops intimate attributes a character's body-config
doesn't switch on (`species/realize.ts:148`), but a character who *has* the anatomy keeps them
applicable, so an authored `vulva.scent` would otherwise reach the chat Attributes list — with no
exposure signal to gate it. We use `isIntimateAttributeCategory` to keep intimate sensory out.

### The session lane already does this right — and chat deliberately doesn't
The session narrator gates every sense through the per-turn `ExposureMask`
(`contracts/state/brief.ts`; `prompts.md` §Exposure gating): scent `none→ambient→close→intimate`,
intent detection raises a sense for one turn (smell→scent, touch→touch), and
`buildGlanceImpressions` surfaces per-region scent/taste only when the axis is earned. The chat
lane intentionally drops all of that (`character-chat.ts` docstring). **This plan does not port
that machinery** — it adds a prompt-only, opportunistic steer, and leaves a real chat sense
signal as the deferred escalation (§Follow-up).

---

## Design decisions

1. **Scope = proximity-gated sensory, scent first.** The new section is for senses that require
   *closeness* (scent now; touch/warmth/texture if/when such attributes are added). The selecting
   predicate is:

   ```ts
   def.kind === "sensory" && !isIntimateAttributeCategory(def.category) && def.category !== "voice"
   ```

   Today that resolves to exactly `presentation.scent_baseline`, and a future non-voice,
   non-intimate sensory attribute (e.g. a skin-texture/warmth sense) would qualify automatically —
   no registry change needed (honors "avoid broad architecture changes").

2. **Voice stays in Attributes (deliberate exclusion).** `voice.*` is sensory but perceptible at
   distance, so it is *not* a closeness-gated cue. The `category !== "voice"` clause keeps it in
   the existing Attributes/voice channel; existing voice tests stay green. (Whether voice deserves
   its own always-on "how you sound" micro-treatment is an §Open question, out of scope.)

3. **Intimate sensory is gated out of chat entirely (this pass).** `isIntimateAttributeCategory`
   keeps intimate scent/taste out of the new section, **and** — a small correctness fix — out of
   the flat chat **Attributes** list too: with no exposure/intimacy signal, a bare
   `- vulva scent: …` line has no business in ordinary chat. (Broader intimate-*visual* attributes
   in chat are a separate, larger question — see §Open questions — and stay out of scope.)

4. **Promoted sensory leaves Attributes, and its exposure-mask hint is dropped.** When the helper
   claims an attribute (scent), its `- label: value` line is removed from `attributeLines` and its
   `promptHints` are **not** added to Phrasing guidance (its hint references the exposure mask chat
   lacks). The new section carries chat-appropriate closeness wording instead — so nothing is
   stated twice and the misleading hint is gone.

5. **Opportunistic, never a checklist.** Both the new section and the new CHAT rule must say:
   sensory detail is *opportunistic, not mandatory*; scent needs *closeness/relevance*; *never*
   list `label: value` verbatim; *prefer one* grounded detail woven into action. No "always
   mention scent" anywhere.

---

## Implementation tasks

All changes are in the pure chat prompt builder + its tests + the eval harness. No DB, no schema,
no session machinery.

### 1. Helper: `sensoryCues(...)` near `attributePhrase`
A pure helper in `character-chat.ts` (beside `attributePhrase`, `character-chat.ts:120`) that,
given the resolved attributes + the realized body, returns the proximity-gated, non-intimate
sensory cues as `{ id, label, text }[]`:
- filter by the §Design-decision-1 predicate (`kind === "sensory"`, not intimate, not `voice`);
- respect `excludeFromPrompts` and `realizedBody.isAttributeApplicable` (same guards as the
  attribute loop);
- reuse `attributePhrase`/`humanize` to render the value `text` (so `"lavender soap and cedar"`
  stays verbatim authored text).

Return ids so the main attribute loop can skip them (decision 4). Keep it a small standalone
function for unit-testability.

### 2. Wire it into `buildCharacterChatSystemPrompt`
- Compute `const cues = sensoryCues(resolved, realizedBody)` once.
- In the attribute loop (`character-chat.ts:216-226`), **skip** any `value.id` claimed by `cues`
  (so it neither renders a flat Attributes line nor contributes its hint).
- Also skip `isIntimateAttributeCategory(def.category) && def.kind === "sensory"` (decision 3 —
  keep intimate sensory out of the flat list).
- Build the new section string (task 3) and insert it (task 4 placement).

### 3. The new "Sensory cues" section
Rendered **only when `cues` is non-empty**, so the byte-identical-when-absent guarantee holds for
every existing profile without a scent. Wording can vary but must hit the decision-5 points, e.g.:

```
Sensory cues (use only when the beat earns them — never list them):
- Sabrina's baseline scent: soft floral perfume
- Work a sensory detail into action only when proximity, touch, intimacy, a first impression, or
  the player's input makes it noticeable. One grounded hook is enough — never recite label: value.
```

(The leading per-cue lines are authored `label: value` *for the model's reference*; the framing
line forbids reciting them. Name the character in the section so it reads as embodiment, not data.)

### 4. Placement + the new CHAT rule
- **Placement:** insert the section into the `sections` array (`character-chat.ts:257`) **after**
  Attributes + Phrasing guidance and **before** `priorSummary` / `stateSection` / `CHAT_RULES`.
- **CHAT_RULES** (`character-chat.ts:153`): add a new rule near the beat/voice rules (renumber the
  tail — tests assert rule *text*, not numbers, so this is safe), wording per the brief:

  > When a character moves close, the player notices them closely, or the moment turns intimate,
  > use one relevant sensory cue if available — scent, warmth, texture, voice, etc. Do not force
  > sensory detail into ordinary distant conversation.

### 5. Tests — `character-chat.test.ts`
Add cases:
- a profile with `presentation.scent_baseline` renders a **Sensory cues** section;
- the section contains the authored scent text (e.g. `"soft floral perfume"`);
- the section carries the restraint wording (only-when-relevant / closeness-earns-detail /
  never-list);
- ordinary **physical** attributes still render in Attributes as before (e.g. `hair.color` →
  `auburn`); **voice** sensory attributes still render in Attributes (regression guard for
  decision 2);
- **no** hard requirement like "always mention scent" appears (regex guard);
- an **intimate** sensory attribute (e.g. `vulva.scent` on a body-config that has it), absent any
  exposure signal, does **not** appear in the Sensory cues section **nor** the flat Attributes list;
- **omission guard:** a profile with no scent renders no Sensory cues section (byte-identical to
  today for existing snapshots).

### 6. Eval fixture — `scripts/eval/narration/fixtures.ts`
Add a chat-lane scenario:
- `id: "chat-sensory-closeness"`, `lane: "chat"`;
- character profile authored with `presentation.scent_baseline = "soft floral perfume"` (built
  through the real `buildCharacterChatSystemPrompt`, like the existing `chat-compliment` fixture);
- `playerInput: "I step into the room and Sabrina comes closer."`;
- `expectation`: stays focused, third-person narration, *may* include **one** natural
  scent/sensory detail because closeness makes it relevant; must not dump attributes or
  over-describe.

### 7. (Optional) deterministic sensory metric — `run.ts`
- Add an optional `sensoryRelevant?: boolean` (or `sensoryCueWords?: string[]`) field to
  `EvalScenario` and set it on `chat-sensory-closeness`.
- In `streamNarration`'s metrics (`run.ts:107`), for **flagged scenarios only**, compute a boolean
  "used a sensory cue" = output contains one of `scent|smell|perfume|soap|cedar|lavender|fragrance|
  warmth|…`. Surface it in the table/JSON.
- **Not** a universal metric — most scenarios *should* score 0 here, so it is reported only for
  flagged ones (a non-flagged scenario mentioning scent isn't a failure).

### 8. Run
```bash
pnpm test -- src/server/engine/prompts/character-chat.test.ts
pnpm eval:narration --dry-run --scenarios chat-sensory   # inspect the assembled prompt, no spend
```
Then `pnpm verify` before claiming done. A live scored run (`pnpm eval:narration --scenarios
chat-sensory`, spend) is optional and the author's call.

---

## Testing & eval plan

- **Unit (gating + wording):** the task-5 cases lock the surfacing, the restraint wording, the
  voice/physical regression, the intimate gate, and the omission guarantee — pure, in `pnpm verify`.
- **Behavioral (does the model use it well):** the `chat-sensory-closeness` fixture + the optional
  deterministic metric, run via `pnpm eval:narration` (never in CI/`verify`). The bar: the
  closeness scenario *may* surface one scent detail; a **distant** chat control (the existing
  `chat-compliment`, no closeness) should **not**. If the model ignores the steer or over-uses it,
  iterate wording before reaching for §Follow-up.

---

## Open questions

- **Voice as an always-on cue.** Should `voice.*` get its own small "how you sound" treatment
  (always available, not closeness-gated) rather than sitting as flat Attributes lines? Out of
  scope here; revisit if voice reads flatly in eval.
- **Intimate *visual* attributes in chat.** This pass gates intimate *sensory* out of chat; the
  broader question of intimate *visual* attributes (which the session lane gates via the exposure
  mask, and chat currently does not) is larger and stays out of scope — track with
  [intimacy-notes.plan.md](intimacy-notes.plan.md).
- **Does prompt-only suffice?** If the model can't tell "stepped closer" from "chatting across the
  room" from the wording alone, escalate to §Follow-up.

## Acceptance criteria

- `presentation.scent_baseline` surfaces via a dedicated **Sensory cues** section (closeness-gated
  wording), **not** as a flat `label: value` Attributes line, and not at all when absent.
- The section + a CHAT rule state: opportunistic-not-mandatory, closeness/relevance-gated, never
  list verbatim, one grounded hook woven into action. No "always mention scent" exists.
- Voice + physical attributes render in Attributes exactly as before (regression-guarded).
- Intimate sensory attributes never reach ordinary chat (neither the section nor the flat list).
- `character-chat.test.ts` covers the above; `pnpm verify` passes; `docs/prompts.md` (chat lane)
  updated in the same change; the `chat-sensory-closeness` eval fixture lands.

## Rollout

1. Helper + builder wiring + the section + the CHAT rule + tests + `docs/prompts.md` update — one
   change, `pnpm verify`.
2. Eval fixture (+ optional metric) — same or follow-up change; `--dry-run` to confirm assembly.
3. Optional live eval pass to confirm the model uses the cue with restraint (spend, author's call).

## Risks & mitigations

- **Over-use (scent every turn).** The whole framing is opportunistic; the distant-chat control
  (`chat-compliment`) is the regression guard; the metric flags over/under-use.
- **Under-use (model ignores it).** Iterate wording; if structural, §Follow-up adds a real signal.
- **Prompt-cache churn.** The section is additive and only appears for scented profiles; for an
  unscented character the system prompt is byte-identical to today (existing snapshots hold).
- **Intimate leak.** Closed by `isIntimateAttributeCategory` in both the section and the flat list,
  with an explicit test.

## Follow-up (deferred — only if prompt-only fails)

A lightweight chat **"beat cue" wrapper** around the *latest user message*: a small classifier (or
even a regex first cut, mirroring `engine/intent.ts`) reads the current input for
proximity/approach/touch/intimacy/first-encounter signals and raises a **one-turn** sensory hint
fed into the prompt (the chat analogue of the session lane's `raiseExposureForIntent`). It must
**not** persist into chat history — it wraps only the live turn. This is the escalation path if the
prompt-only steer can't distinguish "stepped closer" from "talking across the room"; it is **not**
full session exposure/proximity simulation, which stays out of scope.
