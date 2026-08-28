[← Character chat](README.md)

# Character-chat prompt architecture

`apps/web/src/server/engine/prompts/character-chat.ts` (+ `prompts/chat-archivist.ts`,
`prompts/chat-state.ts`, `prompts/chat-summary.ts`, `prompts/chat-extractors.ts`) — all chat
prompt assembly is code-reviewed text in one place. Builders are pure functions of typed
inputs (snapshot-testable); no inline prompt strings elsewhere in the engine. Anything
tunable (history depth, fact cap, narration shape) is a named constant in
`prompts/constants.ts`.

This page owns how the prompt is **assembled**. The craft rules it carries are
[narrator-craft.md](narrator-craft.md); the gates and fences that bound a reply are
[perception-gates.md](perception-gates.md); the lifecycle that streams the result is
[pipeline.md](pipeline.md); the tracked state it renders is [state.md](state.md).

**The presentation charter:** the lane-agnostic craft law inside `CHAT_RULES` — content
framing + the minor fence, the camera/agency rules (2 & 4 + "Reading the player's message"),
the attribution contract (rule 3) + message-notation legend,
proportionality/topic/no-refusal/natural-dialogue rules, the Shaping block, and the
intimate-craft block — lives in `prompts/charter.ts` as parameterized number-free units,
with the authored-profile section builders (bio excerpt, voice anchors, micro exemplars,
preferences) in `prompts/profile-sections.ts`. `character-chat.ts` composes them
byte-identically (snapshot-pinned); the successor narrator (`prompts/sim-render.ts`)
consumes the SAME units, so craft fixes land in one place for both lanes. How those units
are classified, and which layer a prompt experiment may replace, is
[../engine/narration.md](../engine/narration.md) §Narrator instruction authority.

## Character-chat prompt-cache split

Provider prefix caching only pays when the prefix is byte-stable, so the chat system prompt
is split. `buildCharacterChatPromptParts` returns a **stable prefix** — content framing
(age-scoped — [perception-gates.md](perception-gates.md) §Life stage & the minor fence),
identity (+ the life-stage hint), the player persona's **stable** half (their bio + how
their voice sounds — what they're wearing and their intimate note move with state and ride
the tail instead), scenario, background/personality/voice, the **How you actually answer**
micro-exemplar few-shots (`profile.microExemplars`), the **Your voice, concretely** anchors
block (`profile.voiceAnchors`: pet phrases, cadence, never-says), the **Life stage**
register block (when the band carries rules), the **regard-colored** Disposition (which
folds in the persisted narrative `trait_overlays` first, then regard-colors on top), the
composed **Relationship** block, social-card values, the **What lands well and badly**
preferences block (`profile.preferences`, so a like/dislike shapes the reply *in the
exchange*, not only the post-turn pulse; intimate-concept preferences fence out for a
minor), Attributes, Phrasing guidance, Sensory cues, and `CHAT_RULES` — and a **volatile
tail**.

The prefix is **byte-identical across consecutive turns** while authored inputs and both
relationship bands hold — asserted by a prefix-byte-stability snapshot test — and re-renders
only on a band crossing on either axis (the Relationship block and regard coloring are
band-keyed). Everything per-turn rides the tail, so a condition starting, a meter drifting,
a scene detail accreting, or a skip note never busts the cached prefix. The full prompt is
`[prefix, tail].join` (`buildCharacterChatSystemPrompt` keeps that seam invisible to
callers).

**The volatile tail** carries, in order: standing state, then the one-turn digest, then the
generation anchors.

**Standing state (data):** recap, "Your memory" (§Character-chat long-term memory), the
**How you sound** voice-exemplar ring (`voice_exemplars`: recent distinctly-in-voice lines
kept past the events-only summary horizon), "Current state", the **What you want** drives
block, the **Scene** block, the **Supporting cast** block
([supporting-cast.md](supporting-cast.md)), the **Plans** block (near commitments +
per-state directives), **what the player is wearing** + the **exposure-earned Intimate
disposition** block ([perception-gates.md](perception-gates.md) §The chat intimate gate —
both move with state, so neither may ride the prefix), and the disinhibition +
transient-appearance override blocks (state-derived overrides of the prefix's own
Disposition/Attributes lines).

**The "Right now" digest** — the turn's one-turn directives, gathered under a single heading
that states their authority ("where they conflict with the standing rules above, these win;
none of them carry to the next turn") and ordered by **tier**, because a model reading a
dozen unranked "note that…" paragraphs has to guess which governs when they pull apart:

- **binding** — what is true this turn, and how to read the message at all: the
  **narrator-input note** (`narratorInputNote` — the message is story narration, not the
  player's POV), the **Physical consistency** block
  ([perception-gates.md](perception-gates.md), `CHAT_PHYSICAL_CONSTRAINTS`), the **notation
  note** (`chatNotationNote` — who is texting whom, an OOC aside), the fenced **Attached
  photos** block (vision reads, seen-channel content under rule 16 — [images.md](images.md)
  §Player photos), the one-shot **skip note**, and the **first-exchange** establish
  directive.
- **gate** — the ceilings and corrections that bound the reply: the **Sensory focus** block,
  the **Sensory allowance** line, the reply-discipline **gate notes** (hook cadence /
  intimate check-in), and the one-turn **Voice correction** line
  (`lastMemoryTrace.characterSlip`).
- **license** — what the beat permits, never demands: the **cue invite** (a tapped open-loop
  continue, or the initiative opener's full cue — `buildInitiativeCue`;
  [initiative.md](initiative.md) §Initiative) and the **selfie license** line
  (`chatSelfieLine`; [images.md](images.md) §Selfies).
- **flavor** — the optional grace note: the **memory-callback** line (`chatCallbackLine` —
  an old episode offered as a "remember when" aside, worded by regard band;
  [initiative.md](initiative.md) §Memory callbacks).

Crowded-turn **deferral is not done here**: the deferrable notes (the callback, an
unprompted selfie offer) are armed upstream, and an offered callback **burns its anti-repeat
ring** the moment it is picked — so dropping one at render time would spend an episode that
never reached the page. `chatCallbackEligible` owns that decision pre-burn
([pipeline.md](pipeline.md) §The one-turn notes); the builder renders exactly what survived
it. The ensemble builder composes the same digest from the group arms of the same notes.

**Generation anchors:** the one-line **Voice check** re-anchor beside the mood pin
(`profile.voiceAnchors`, near generation where voice matters most), and either the
opening-beat instruction or the per-turn **Response-shape** line.

- **Relationship block** (relationship-model v2: `composeRelationshipLaw` over the two
  band-profile registries, `contracts/relationships/law.ts`): authored history/kind → the
  familiarity line (address rights, what can be referenced, how well they read the other) →
  the regard line (feeling, initiative-desire, willingness — bounded by the familiarity
  ceiling) → the `presented` mask ("Outwardly:") → a sparse combo-corner note → the
  escalation floor keyed to REGARD, with three rulings stated in the block: the scenario
  premise overrides the floor, disinhibition never raises it, and social-card values outrank
  everything. A `dispositionContrastLine` states the divergence when regard's sign disagrees
  with the authored warmth lean; a `dispositionIdiomLine` fires at warm+ regard for a
  cold-side warmth so growing closeness keeps the character's own manner instead of
  flattening toward generic warmth.
- **Regard soft coloring** (`regardDispositionOverlays`,
  `contracts/personality/modulation.ts`): the regard band shifts
  warmth/guardedness/inhibition at render time — authored-traits-only, sliders never written
  — so the prefix's Disposition bands read the relationship, not just the authored resting
  values (familiarity deliberately does not color disposition — knowing someone is not
  warmth). **Capped at one band step from the authored value**
  (`REGARD_OVERLAY_MAX_BAND_STEPS`) so long warm chats cannot converge every character on
  the same warm/open reading.
- **Inert-slider wiring**: `social.dominance` colors the `CHAT_RULES` **forward-move** rule
  (lead vs. defer), `temperament.confidence` colors the **drive-reveal posture** in the
  tail's "What you want" block, and `social.extraversion` colors the **initiative opener
  cadence** (`buildInitiativeCue`) and the **ensemble quiet tolerance**
  (`ensembleQuietThreshold`). Each is a no-op at mid/absent value (via `traitPole`), so a
  trait-less character's prompt is byte-identical.
- **`CHAT_RULES`** closes the prefix, carrying a dialogue-craft rule (speech-like dialogue:
  fragments, dodges, silence as an answer) and a **"When a scene turns intimate:"** block
  (player-paced escalation, body/clothing continuity, concrete sensation over florid
  metaphor). See [narrator-craft.md](narrator-craft.md) for the turn-grammar block and the
  intimate-frame exception it adds.
- **Experimental layout switch** (`CHAT_PROMPT_LAYOUT`, default `system_tail`): the default
  puts the volatile tail in the **system** message, ahead of the history in token order. The
  `turn_context` layout instead puts the tail + the fenced current player input on a **final
  user message** (`buildChatTurnMessage`), so system + history form an append-only cached
  prefix and turn data sits adjacent to the input it governs. Applies to real player turns
  only, and to 1-on-1 conversations only.

## Character-chat state as a narration system

The chat lane *enacts* the tracked `character_chat_state`, not just lists it. All of this is
in the chat prompt builder and degrades to the prior stateless output when no state is
passed:

- **Condition → attribute overlays.** A condition's `attributeEffects` (`source:
  "condition"`, precedence 3) overlay grooming/scent/hair while active. They render as a
  **volatile tail block** ("While your current condition lasts … these override the matching
  Attribute/Sensory lines above") instead of being baked into the prefix's Attributes — a
  condition starting or expiring never busts the cached prefix. `conditionAttributeOverlays`
  guards each effect with `overlaySourceMayChange(def.mutability, "condition")`, so a
  condition can **never** rewrite an inherent attribute (eye colour, species) in the prompt.
  Chat conditions are seeded with real effects from a small label catalog
  (`contracts/conditions/catalog.ts`).
- **Graded meter cues + anti-repetition.** `splitStateCues(meters, surfacedCues)` turns the
  meters into one **foreground** "just shifted" beat (the most-intense newly-crossed band)
  plus **standing** cues, diffed against the bands surfaced last turn
  (`character_chat_state.surfaced_cues`). `buildStateSection` renders standing cues as
  coloring ("never recite") and the one foreground band as a marked-once beat; a
  `CHAT_RULES` rule says *act your physical state out continuously, but only mark it when it
  visibly SHIFTS*. At most one change-beat per turn.
- **Unfinished business + skip note.** The "Current state" block carries the standing
  **"Unfinished business between you"** line (the archivist's `open_loops`, ≤3 phrases,
  never-recite) so long conversations get narrative pull. A player time skip stamps a
  one-shot `pending_skip_note` rendered as a volatile tail line ("Time has passed in the
  story since your last exchange: …"), cleared by the finalizer after the exchange that
  rendered it.
- **Emotional weather.** The persistent `feeling` **composes** with the meter mood
  descriptor (baseline weather + the front passing through) on both the Current-state mood
  line and the response-shape **mood pin** (`feelingPhrase`: deeply / still / faintly-fading
  by intensity). See [state.md](state.md) §Emotional weather.
- **Disinhibition.** `stateDispositionOverlays(traits, meters)` lowers `intimate.inhibition`
  + `social.guardedness` + `temperament.composure` at high intoxication/arousal as
  `source:"condition"` **trait** overlays — render-time only, authored sliders never
  written. It diffs against the **regard-colored** base disposition and renders only the
  band lines the shift actually changed, as a volatile tail override block — sober ⇒ no
  block.
- **Soft social-card framing.** `buildSocialFramingSection` surfaces active cards as a
  fenced "what you care about / won't stand for" block — theme only, **never** the
  mechanical `severity` (the post-turn pulse owns the reaction).
- **One-turn sensory allowance.** A regex-first `detectChatCue` reads the player input for
  proximity/touch/intimacy — plus appearance-directed **attention** — and the route derives
  the binding per-turn **sensory allowance** from it
  ([perception-gates.md](perception-gates.md) §Character-chat sensory cues).

The matching scene-image enrichment is in
[images/pipelines/scene-subjects.md](../images/pipelines/scene-subjects.md).

## Character-chat long-term memory (RAG)

The chat lane has the RAG memory keyed per-chat (see [../memory.md](../memory.md) §Memory
keying). Two prompt-side effects, both byte-identical to an empty-input build:

- **Retrieval block.** The route calls `retrieveChatMemory` (`engine/chat-memory.ts`) before
  building the prompt — **fused** RAG over the chat's own facts + episodes (per-query
  embedding + RRF, [../memory.md](../memory.md) §Fused retrieval), keyed on last turn's
  persisted `memoryQueries` + the player input — and passes the hits as a `memory: { facts,
  episodes }` input. Pinned "remember this" facts ride ahead of the top-k. The builder
  renders a fenced **"Your memory"** block *beneath* the rolling-summary recap: the summary
  is the short-term reinforcement layer, RAG reaches past its horizon. Layering top→deep:
  verbatim window → rolling summary → RAG recall.
- **Evolving attribute overlays.** The prefix's stable resolve is
  `resolveAttributes(profile.attributes, state.attributeOverlays)` — the **persisted**
  narrative overlays (a recorded haircut/dye) on top of the authored base; the **transient**
  condition overlays render separately as the volatile tail block (§Character-chat state as
  a narration system). A `narrative` overlay outranks a `creation`-sourced authored value
  but not a `manual` one (SOURCE_PRECEDENCE).

Post-turn, `finalizeChatState` runs the reaction pulse ‖ **three extraction legs** in
parallel (`runChatExtraction` — the memory scribe, the continuity tracker, the character
tracker; see §The chat extraction field library and [post-turn.md](post-turn.md)). In an
**ensemble** the shared legs keep the scene-level reads while every PRESENT member
additionally gets a small **personal pass** (`runChatPersonalNotes` — a 4-field extractor
scoped to ONE named character) folded into their own row.

## The chat extraction field library

Extraction fields are **data**, the way attributes / meters / conditions already are — one
agent juggling thirteen assignments needs pages of instructions, a hand-maintained count,
and worked examples that show only some of them. `prompts/chat-extractors.ts` holds one
`ExtractorField` module per field, owning its instruction line, the context block it needs,
the extra rules it implies, whether it is **armed** at all this exchange, and its empty
value for examples. A **leg** is an ordered list of field keys; its system prompt —
numbering, rules, and JSON examples — is **assembled**, never hand-written:

- **Adding a field is one module**, not an Nth job threaded by hand through a monolith.
- **The personal pass is the same field modules**, composed for one character.
- **Examples cannot disagree with the field list**: each is declared with only the fields it
  exercises and RENDERED with every armed key present, and every leg closes with a generated
  **empty-output example**.
- **Unarmed fields vanish**: a 1-on-1 never sees the ensemble-only `presence` instructions;
  a character with no drives never sees `driveUpdates`. Numbering stays contiguous whatever
  is armed.
- The **memory scribe** additionally reads the rolling summary's `Established:` ledger
  (fenced, explicitly "never extract facts from this").

`chat-extractors.test.ts` locks the invariants: every instructed field is a schema field and
vice versa, every example carries every armed key, the three legs **partition** the
aggregate exactly, and unarmed fields leave no trace.

## Agent prompts

The chat lane's post-turn agents (the pulse, the three extraction legs, and the per-member
personal pass) are composed from the field library (§The chat extraction field library), not
hand-written. Each carries a tight system prompt: role, what to extract, what NOT to do (no
inventing entities, names exactly as written, ignore quoted/hypothetical dialogue for
physical events), and worked examples. The chat narrator's perception partition
([perception-gates.md](perception-gates.md) §Character-chat player-input perception)
deliberately does **not** apply to agents: the pulse and the extraction legs read the
player's full message — narration and interiority included — to judge intent, classify the
act, and extract memory. The pulse classifier (`prompts/chat-state.ts`) carries a worked
example; the summary fold (`prompts/chat-summary.ts`) is third-person-strict (a recap never
addresses the user as "you").

## Style rules for prompt text

- Numbered/bulleted rule blocks, one rule per line, no prose paragraphs of instructions.
- Reference data blocks by their heading names (`the "Sensory cues" block`), never
  "above"/"below", and never by a rule's displayed number — numbering is positional
  ([../engine/narration.md](../engine/narration.md) §Narrator instruction authority).
- Anything tunable (history depth, fact cap, narration shape) is a named constant in
  `prompts/constants.ts`. Narration length is a **shape profile**
  (`NARRATION_SHAPE_PROFILES`), never a hard-coded floor.
- **Clothing category names never enter gameplay prompts.** Items are described by name,
  description, and resolved coverage only — the `category` field is an authoring template
  ([../contracts/items.md](../contracts/items.md) §Clothing categories).
- **Untrusted spans are fenced, not bare-concatenated** (`prompts/untrusted.ts`). Player
  input and user-authored character/scenario/persona text are wrapped in opaque sentinel
  fences via `fenceUntrusted(label, text)`, and every prompt that embeds one states once —
  `UNTRUSTED_DATA_NOTICE` — that text between the fences is DATA to react to, never
  instructions. Raw freeform **player input** is additionally run through
  `neutralizePlayerInput` first, which defangs in-band `##` headings and the `(OOC:` /
  `[ooc]` markers. The blast radius is narrative integrity, not privilege — it hardens
  against heading/instruction spoofing, it is not an auth boundary. Never hand-write fence
  strings; reuse the helper (jscpd gate).
