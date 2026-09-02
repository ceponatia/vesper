# Perception, gates, and fences

What the chat narrator is allowed to perceive, describe, and claim. The lane has no
per-sense exposure mask and no proximity model, so every ceiling here is derived per turn
from committed state and the player's own message. The prompt these blocks ride in is
assembled in [prompts.md](prompts.md); the craft rules they bound are
[narrator-craft.md](narrator-craft.md).

## The chat intimate gate

`profile.intimacy` and the species archetype are gated by the lane's own signal.
`chatSceneIsIntimate` (`contracts/turns/chat-intimacy.ts`) is built from the three signals
it actually has:

1. the **character's** coverage-computed bare state (`intimateRegionsBare` — torso or
   pelvis);
2. the **player's**, computed the same way from their persona's worn items;
3. **arousal** ≥ `CHAT_INTIMATE_AROUSAL_AT` (0.55) — a scene can be intimate with the
   clothes on.

**Any one signal opens it** (the "any axis" ruling, owner 2026-07-13), and it defaults
**shut** on missing input: a chat that has shown nothing earns nothing. Both coverage
signals are computed from worn items, never a manual flag — [wardrobe.md](wardrobe.md) §The
player's wardrobe explains why the player's side has no `exposed` toggle at all, and this
gate is the reason.

`buildChatIntimateSection` renders, only above the gate: each qualifying character's merged
note (the species/heritage archetype **appended** with their own `profile.intimacy`,
heritage-replaces-species), plus the **player persona's** `intimacy`, which carries
**inverted semantics** — what they *respond to*, not how they behave — so it gets its own
wording and is rendered **once**. In an ensemble the gate is **per member** (one couple in
the room doesn't hand everyone an intimate disposition) and away members never contribute;
the minor fence applies per member. It lives in the **volatile tail** by necessity: the gate
flips with state, so a prefix block would bust the prompt cache on every flip.

**Still soft-framed, deliberately:** the intimate *trait bands* keep their "when the moment
turns intimate" wording, and `buildDisinhibitionSection` consumes them as its dedupe
baseline.

## Character-chat sensory cues

With no exposure mask, the lane gates the senses through a deterministic per-turn **sensory
allowance** instead of scattered prose teachings.

- **The data** stays in the stable prefix: the builder spends the shared appearance read's
  closeness-gated facts (`proximitySensory` — `kind === "sensory"` and not the `voice`
  category, [prompts.md](prompts.md) §The narrator appearance read) as the **"Sensory
  cues"** block whose closing bullet defers to the allowance. Exclusions: **voice** (audible
  at any distance — stays a normal Attributes line) and **intimate scent/taste** (the read
  refuses it outright; no exposure signal in chat earns it). Renders nothing for an
  unscented character.
- **The permission** is the volatile-tail **"Sensory allowance this turn"** line: the route
  derives `none | visual_accent | close_range_hook | focused_description` per real player
  turn via `deriveChatSensoryAllowance` (`engine/chat-intent.ts`, a pure mapping over the
  detectors already running: `detectSensoryFocus` ⇒ `focused_description`;
  intimate/touch/proximity cues ⇒ `close_range_hook`; `attention` ⇒ `visual_accent`; else
  `none`; arousal alone raises nothing). The physical detectors consume only current,
  non-negated, non-hypothetical evidence from the shared `lib/chat-input-evidence.ts`
  span/sentence parse; visual attention remains its own lower-risk policy, so a denied touch
  beside an observed feature earns at most `visual_accent`. `chatSensoryAllowanceLine`
  renders the result as a binding ceiling — `none` forbids person-level sensory/appearance
  detail beyond what the character's own movement makes newly visible; `focused_description`
  renders no line because the **Sensory focus** block is that turn's richer grant.
  CHAT_RULES 10–11 defer to it.

## Physical consistency (constraints and premise checks)

Behind `CHAT_PHYSICAL_CONSTRAINTS` (default off) the digest's **binding** tier carries one
more block, compiled from committed state and the current message
(`chat-physical-guidance-render.ts`; the compiler's own rules are
[physical-guidance.md](physical-guidance.md)):

```text
Physical consistency for this exchange:
These rules override any general appearance or sensory-detail allowances for this exchange.
- Premise check: the player's wetness-cause claim conflicts with committed state. Do not adopt rain as the cause of the wetness in Wren's hair. Do not correct the player aloud unless Wren would naturally do so.
- Binding constraint: do not describe Wren's hair as loose, cascading, streaming, or whipping; it remains secured in a braid.
```

- **Placement.** Binding tier, directly after the narrator-input note and before the
  notation note: both of those are about *how to read the message*, and a fence outranks a
  markup gloss. Threaded as a **top-level** `physicalGuidance` prompt input, not through
  `promptStateSlice` — a correction is about the message in front of the narrator and a
  constraint is only selected because this turn made it relevant, so neither is standing
  state.
- **Precedence, stated in the block.** The second line exists because the same prompt
  already carries a **Sensory allowance** line worded as a ceiling on *description*, while
  these are fences on *claims* — and a model reading both without a ranking splits the
  difference.
- **Order is the compiler's**, not the renderer's: premise corrections (≤2) then consistency
  constraints (≤3).
- **Two wording laws.** A constraint-only turn contains **no instruction to mention a body
  detail** (raising the number of checkable claims is exactly the failure this block
  replaces); and a correction **never voices the committed truth** — it names the claim not
  to adopt and stops, because the truth may be hidden and "actually it was a bath" both
  leaks it and invites the narrator to argue with the player. A constraint's truth clause
  ("it remains secured in a braid") ships only when perception licensed it, which the shared
  candidate builder decides, not the renderer.
- **Absent/empty ⇒ zero bytes**, conditional-spread + length-guarded like the cue block, so
  a flag-off prompt is byte-identical (int-tested by splicing the ON block back out).

## Character-chat player-input perception

The player's message is three channels mixed in one text box: **heard** — the quoted
dialogue; **seen** — externally visible manner narrated around it (a stammer, a flush);
**private** — interiority the character cannot know. `CHAT_RULES` carries a **"Reading the
player's message"** block (stable prefix, cache-safe) teaching the partition: quoted text is
speech heard exactly (with a quotes-for-prose exception for reported speech); unquoted text
is the story's narration, of which the character perceives only what would be visible or
audible; inner thoughts reach no one — the character must not answer, echo, or *uncannily
intuit* them, though she may react to the visible correlates and guess (even wrong) like a
real person; and a no-quotes message that reads as plain conversation is simply spoken
(graceful degradation). A worked example spells out the correct read. **State agents are
exempt**: pulse/archivist deliberately read the full message, interiority included — it is a
strong intent signal ([prompts.md](prompts.md) §Agent prompts).

**The optional markup lane** upgrades ambiguity into determinism *when the player opts in*.
A single deterministic parser, `@/lib/message-spans.ts` (`parseMessageSpans`, pure and
regex-first — the ONE implementation the tail note, the transcript renderer, and the
archivist channel hint all share), segments a message into ordered spans `{ kind: speech |
narration | thought | comms | ooc | written | styled }`: `"quoted"` → speech; `*…*` →
**thought** by default, **comms** when `Name:`/`to Name:`-shaped, or **styled** emphasis for
a short mid-sentence span (the emphasis guard — `you *really* think?` is styling, not a
thought); `_…_` → styled; `((…))` → **ooc** (double parens only); unmarked → narration.
Delivery is split: the sigils' **meanings** live in a static **"Message notation" legend**
in the `CHAT_RULES` stable prefix (byte-identical across turns) — it also states the **house
reversal** of the RP "asterisks = actions" habit (unquoted prose is the action channel here)
and defines the narrator's texted-reply **output grammar** `*Name: her words*` (which
`formatCommsReply` emits and the parser round-trips from history). The per-turn **derived**
facts ride a volatile tail note (`chatNotationNote`, never touching the stored message): a
comms span renders sender/recipient + the co-presence reconciliation ("a text from X to you;
answer as a text back"), an OOC span renders "honor it as direction, but never have the
character hear it".

## Character-chat player-POV narration

The chat model is the character **and the scene's narrator**, with the story's camera behind
the player's eyes. Rule 4 licenses narrating the player's **involuntary perception** — the
way the character looks and moves, a scent that reaches them when close — addressed to them
as "you", including the small reflexes it stirs (a breath that catches); it forbids writing
the player's deliberate actions, speech, or decisions, and naming their emotions or arousal.
The player's story advances ONLY through their own messages; the narrator never scripts even
mundane connective beats (arriving home, checking a phone). **Rule 15, the separation arm**:
when the character and player are not in the same place, the reply follows the CHARACTER's
side only (a scene cut to her world), reaching the player solely through a channel that
carries (the `*Name: …*` texted line, a call), ending on her move. The **visual channel** is
attention/motion-gated, *not* proximity-gated (sight carries at any distance): the player's
attention on the character flows through the sensory allowance as `visual_accent`, while
rule 11 keeps the self-motion arm — when the character enters/moves/adjusts clothing, one
concrete visual detail from the player's eye, never a head-to-toe inventory. `detectChatCue`
(`engine/chat-intent.ts`) carries the **`attention`** signal (gaze verbs aimed at a person,
appearance compliments, possessive + body/clothing nouns).

## Life stage & the minor fence

Numeric age *does something*. `contracts/world/life-stage.ts` is a registry of bands (child
/ teen / young adult / adult / middle-aged / elder) keyed by year ranges; `lifeStageForAge`
maps a **bare human-scaled numeral** ("15") and nothing looser (blank, "ancient", "15 years
old", or a number > 120 map to nothing, so fantasy ages never get a human register forced on
them). Three surfaces per band:

- **`promptHint`** — one phrase appended to the age line (the chat identity: "You are 16
  years old — a teenager — teen diction…"; the ensemble member id line). The `adult` band's
  hint is deliberately `""`.
- **`registerRules`** — a binding **"Life stage"** block (chat stable prefix, second person)
  for the bands whose register genuinely constrains prose: child/teen (concrete diction,
  school-sized knowledge, *never wise beyond your years*) and elder (unhurried,
  era-anchored). Chat rule 7 binds to the block by heading name; ensemble member sheets
  carry the register compressed to one third-person line (`lifeStageThirdPersonLine`).
- **`minor`** — child/teen. The fence (the numeric `isMinorAge` read) removes every intimate
  surface for an authored minor, wherever authored data would otherwise leak one: the
  intimate trait bands, the intimate-disposition notes (`buildChatIntimateSection` — the
  species/character `intimacy` note, skipped whatever the gate says; in an ensemble the
  fence is per member, so an adult's note still stands beside a fenced minor, and a fenced
  character earns no player note either), the disinhibition loosening block, the chat
  intimate-craft rules block, the selfie license, and the relationship law's escalation
  bullet (`composeRelationshipLaw` `omitEscalation`).

`CONTENT_FRAMING` is scoped to match: "everyone taking part in romantic or intimate content
is an adult"; a **minor primary** flips the 1-on-1 frame to romance-strictly-out-of-scope
(handled in character — confusion, a subject change — never a meta refusal); an **ensemble
containing a minor** keeps the adult frame for its adult members and appends the cast fence
line. All of it is authored-age-keyed, so the prefix stays byte-stable across turns.
