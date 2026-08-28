# Narrator craft rules

How the chat narrator is told to write: reply discipline and the per-turn scene context, the
narration shape profiles, the fixed viewpoint, the dialogue-attribution contract, and the
stream cleanup that runs after generation. The prompt these rules live in is assembled in
[prompts.md](prompts.md); the ceilings that bound what a reply may claim are
[perception-gates.md](perception-gates.md).

## Character-chat reply discipline & scene memory

A narrator left unshaped over-produces: long replies that re-describe the unchanged scene,
drift from the mood, end every reply with a question ("interview mode"), and — during
intimate beats — solicit a check-in every turn. The counter is rules plus per-turn
deterministic context (no token limits, no extra LLM legs). All prompt wording lives in
`prompts/character-chat.ts`; the per-turn reads live in `engine/chat-intent.ts`; the state
lives in the scenario's `scene_memory` (see [scene-memory.md](scene-memory.md)).

- **Turn grammar (`CHAT_RULES`, stable prefix).** A `Shaping each reply` block: **Resolve,
  then one move** (answer what the character heard/saw, then AT MOST one forward move —
  action/offer/disclosure/scene-shift, or a question *only* when the character genuinely
  wants the answer; never stack moves; vary the endings), carried by a **worked example
  pair**; a **per-shape length story** (`chatLengthStory` — see §Narration shape &
  proportionate reaction); and a **freshness** rule (every narrative paragraph carries
  something new). The **"When a scene turns intimate:"** block adds the intimate-frame
  exception: physical narration can widen but **dialogue goes sparse**, and the **check-in
  refrain is banned** (at most once per scene, only when consent/hesitation is genuinely in
  play).
- **Off-screen-life lines (volatile tail).** The one-shot **meanwhile note** (the pass's
  `pending_meanwhile_note`, rendered beside the skip note and cleared with it); the one-turn
  **return license** ("You just got back — you were {whereabouts}; ONE trace of it"); and
  the standing **daily-rhythm line** per present member (`formatScheduleRhythm`). See
  [plans.md](plans.md) §Off-screen life.
- **Story-time line (volatile tail, binding).** ONE authoritative time: `promptStateSlice`
  derives `storyMoment` from the scenario's `clock_minutes` + `calendar_start`
  (`formatStoryMoment` — "Friday, January 5 — 2:10pm (afternoon)") and both frames render it
  as a binding line. Time never comes from extraction — the archivist's scene proposal
  carries no time-of-day field.
- **Scene block (volatile tail).** A compact `Scene` block rendered from the accumulating
  `scene_memory`: the current place + its established details and connections, followed by a
  directive that flips on whether the scene just changed — unchanged ⇒ "do not re-establish;
  at most one fresh accent"; just changed ⇒ "establish the new scene in 1–2 paragraphs —
  sight plus one other sense — then leave it alone". `buildSceneSection`; "" when the memory
  is empty and nothing changed.
- **Plans block (volatile tail).** A compact `Plans` block rendered from the conversation's
  tracked commitments (`character_chats.plans`), showing only what is NEAR this turn — each
  with a **directive per state**: anticipation before, the event when due, the fallout when
  just missed (`buildPlansSection` over `derivePlanSalience` vs the story clock). In the
  **ensemble** frame a due plan also drives `buildPlanPresenceLicense` — arrival/exit
  licenses ([multi-character.md](multi-character.md)). See [plans.md](plans.md) §Plans &
  promises.
- **Response-shape + mood-pin line (volatile tail).** A deterministic per-turn steer:
  respond to the player's input, no unrequested topics, keep the scale proportionate, pin
  the reply's tone to the derived mood descriptor (`deriveMoodDescriptor`).
  `buildResponseShapeLine`; **suppressed on an opening beat**.
- **Reply-discipline gates (volatile tail).** Pure reads over the window's last 1–2
  assistant replies (`buildChatReplyGates`, `chat-intent.ts`): a **hook-cadence** note when
  the last two replies both ended their final dialogue line with "?"
  (`replyEndsInQuestion`), and an **intimate check-in** suppression note when the beat is
  intimate and the previous reply matched the check-in pattern (`isCheckInReply`).
- **Action-beat cue (synthetic player turn).** A tapped action chip runs as an `action_beat`
  exchange with no player line, so — like the opening/"go on" beats — the model gets a
  synthetic, non-persisted player turn: `buildActionBeatCue` wraps the chip's gesture as a
  parenthesized stage direction, licenses **one small beat**, and bakes the resolved
  **register** (apart ⇒ answer as a text; co-present ⇒ play it in the scene). The paired
  deterministic state effect is applied to the drifted state *before* the prompt builds
  ([pipeline.md](pipeline.md)).
- **Sensory focus block (volatile tail, scope guard).** `detectSensoryFocus` requires a
  locally bound action pair: a current **player-narrated** smell/taste/touch/study candidate
  plus a character-owned target in the same sentence/action phrase. Speech, thoughts, OOC,
  storyteller mode, questions, denials, irrealis, perfect-tense history, third-party actors,
  player-owned targets, cross-clause pairs, and ambiguous ensemble pronouns fail closed. The
  first valid pair wins in textual order and carries the resolved roster member id plus
  registry `region`; the ensemble frame therefore reads the named member's attributes
  instead of guessing from whichever member was addressed elsewhere. The builder joins the
  region to that member's authored attributes via `expandBodyTarget` — sense-ranked,
  intimate categories gated by the hint's `intimate` flag, capped at 6 lines. Generic
  grounding follows but **layered, never competing**: a crossed hygiene band *deepens* an
  authored scent ("stronger and staler, never a different character"). The directive treats
  the detector result as a candidate that the written beat must still prove, then **opens
  the reply with the sensation itself**; it never adds contact or motion beyond the player's
  text. `buildSensoryFocusSection`; when nothing authored grounds it, the builder **degrades
  the allowance line to `close_range_hook`**.

## Supporting cast & narrator input

Two prompt systems close the gap where "the narrator reacts to a mentioned side character
but never writes *for* them". Both are owned by [supporting-cast.md](supporting-cast.md);
the prompt-side shape is:

- **Supporting cast block** (`buildSupportingCastSection`, volatile tail — it accretes like
  Scene): one line per recurring named side character from the scenario's `supportingCast`
  (name — relation · details · voice · whereabouts) plus the play license. Rule 3's
  incidental-person clause names this block as its exception, and rule 15 (the apart camera)
  lets cast members populate the character's side of a scene cut.
- **Narrator input** (the composer's You ↔ Narrator toggle): a `send` with `inputMode:
  "narrator"` is story narration the player authored **as storyteller**, never their own
  POV. The stored line stays byte-verbatim (`meta.inputMode` marks it); at the model
  boundary the pipeline wraps it with `wrapNarratorInput`, a static notation-legend line
  teaches the marker, and the current turn adds the one-turn `narratorInputNote` tail line
  suspending the player-input perception partition.

## Narration shape & proportionate reaction

The narrator's job is to stay on the player's beat and react in proportion. All pure prompt
wording (no extra LLM call): the **shape profiles** and **proportionate-reaction rules**
(cached static rulebook), plus the per-turn **Response-shape** line (volatile, derived).

- **Shape profiles** (`NARRATION_SHAPE_PROFILES` in `prompts/constants.ts`) are the
  length/focus guidance that opens the chat `How to respond:` rules:
  - **`concise_immersive`**: one focused beat per turn; match length to the input; keep the
    prose vivid.
  - **`aggressive_concise`**: brief and tightly scoped; answer in as few sentences as it
    honestly needs.
  - The active profile is a **dev/code knob** with a per-lane resting default (chat
    `aggressive_concise`), threaded as `narrationShape`. The chat route passes
    `narrationShapeId("chat")`, resolving **live dev override → `NARRATION_SHAPE` env →
    per-lane default**. A **dev-only toggle** (`POST /api/dev/narration-shape`, 404 in
    production) force-overrides without a restart.
  - **Per-model reasoning knob** (`NARRATOR_REASONING`, applied by
    `narrativeProviderOptions`): Aion `effort:low`, unlisted narrators send no reasoning
    option (Aion rejects `enabled:false`).
- **Per-shape chat length story** (`chatLengthStory`): the length sentence is keyed to the
  active shape — `concise_immersive` keeps the three-paragraph baseline;
  `aggressive_concise` gets "length follows the beat — one line of dialogue plus an action
  beat can be the whole reply".
- **Proportionate reaction.** Ordinary remarks, agreement, greetings, and mild compliments
  are not emotional gifts. `CHAT_RULES` says affection / gratitude / fluster scale with the
  Relationships block, mood, and authored disposition; an unclassified remark is ordinary.
  Self-motivated NPC initiative (rule 6) is **licensed, not mandated** — a present character
  with a concrete reason may contribute one self-motivated beat; a quiet turn owes none.
  Rule 7 carries no "traits per turn" quota — a trait is possessed, never performed on a
  schedule.

**Authored override.** Concise + proportionate is the default, but it **yields to authored
Style directives**: a directive like "lush, descriptive narration" is the lever for richer
prose. Proportionality scales with disposition + relationship, so a canonically devoted
character at high affinity dotes correctly without any new knob.

## Narrator viewpoint

The chat lane pins a **single fixed viewpoint** so the narrator never drifts between
persons. Narrate the character in the **third person** (`Mara …`, she/he/they); address the
player in the **second person** (`you`); allow first-person `I`/`me`/`my` **only inside the
character's quoted dialogue** (`[Mara] "…"`). `How to respond:` rule 2 says the same —
first-person-as-the-character wording fights the roleplay models' third-person training and
lets a model wander between persons.

## Dialogue tagging

In the sessionless character chat the renderer owns presentation, so the `[Name]` tag is
**conditionally optional** (dialogue-attribution). Chat rule 3 states the **mechanical**
contract — a line that is *nothing but* the quote auto-attributes **only in a reply that
carries no tag at all**; a line mixing speech with narration/action beats must open with the
tag or split into separate quote/prose lines ("when unsure, tag"); and once any line in a
reply is tagged, every one of the character's spoken lines in it must be. It also licenses
**other people** (a waiter, a voice on the phone, a named friend) to speak — always *inside
the narration prose* with plain attribution (`Amanda blurts, "That's not funny."`), never as
a bare quoted paragraph and never with a bracketed tag, which belongs to the character
alone. Recurring named people in the **Supporting cast** block are the licensed exception
(§Supporting cast & narrator input).

**Brackets are scoped to that one position** (owner report 2026-08-02): a `[Name]` span only
means anything at the **start of a line**, so a name bracketed mid-sentence — above all
inside quoted speech, `"Nice to see you, [Brian]."` — is not notation at all and the player
reads the literal square brackets. Rule 3 (both the 1-on-1 charter rule and the ensemble
rule) says so with the worked negative example, and `stripMisplacedSpeakerTagStream`
(`server/ai/narrator-speaker-tags.ts`) is the runtime backstop — see §Narrator output
cleanup.

The renderer (`components/characters/chat-segments.ts` → `chat-message.tsx`) parses each
reply with `parseSegments(reply, rosterNames, { attributeStandaloneQuotes: true })` — the
**whole roster's** names, not just the primary, so a group reply's non-primary `[Name]` tags
attribute instead of leaking as literal text — degrading to the sole-speaker 1-on-1 behavior
when the roster has one member: in a **tag-free** reply an untagged **whole-line** quote
attributes to the sole character exactly as a tag would (a quote embedded in a narration
sentence stays narrator prose); in a reply that uses a known tag **anywhere**, untagged
quotes stay narrator prose (`hasKnownTag`). Stored transcripts stay byte-verbatim — this is
rendering only. The streaming segmenter is the pure `lib/segmenter.ts`, shared with the
client renderer (components never import `server/*`).

## Narrator output cleanup

`aion-labs/aion-2.0` (a selectable chat narrator) wraps its answer in an internal
`<uncensored_response>…</uncensored_response>` template and **leaks the marker** into the
visible stream — most often the closing tag in misspelled / negated forms — and sometimes
appends a **trailing meta-commentary block** ("Note for the parser: …"). The chat narrator
stream runs through `stripNarratorArtifactStream` (`server/ai/narrator-artifacts.ts`) before
the segmenter / accumulator sees it. Stripping the **stream** cleans both surfaces at once:
the live deltas the client renders, and the accumulated text that gets persisted and fed
back as history (a persisted artifact teaches the model in-context to emit it *more*). The
stripper removes tags split across token boundaries, swallows whitespace glued to a tag, and
cuts a line-start meta-note marker from its line through the end of the stream — line-start
only, so prose merely containing the phrase streams through untouched.

**Misplaced name brackets** (`server/ai/narrator-speaker-tags.ts`). A `[Name]` span is
notation **only** at the start of a line (§Dialogue tagging); anywhere else the segmenter
leaves it alone and the brackets render literally. `stripMisplacedSpeakerTagStream` composes
between the artifact stripper and the repeat collapse and **de-brackets known names outside
a tag position**, keeping the name: the vocabulary is split into `speakers` (the roster — a
line-opening tag for one of them is left exactly as written) and `plain` (the player + the
scenario's supporting cast — never a tag in *any* position, since the renderer's tag
vocabulary is the roster alone, so even a line-opening `[Brian]` would leak). Unknown spans
(`[CLOSED]`) are never touched — guessing is how a filter starts eating story. Cleaning the
**stream** cleans the live deltas and the persisted reply together, so a bracketed name
never comes back as history; replies already persisted keep whatever they stored, since no
cleanup pass rewrites the transcript.
