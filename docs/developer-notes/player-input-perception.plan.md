# Player-input perception — NPCs hear quotes, see the visible, never read minds

Status: **active — slices 1–2 shipped 2026-07-08** (built ahead of order as the base for
[chat-narrator-pov.plan.md](chat-narrator-pov.plan.md), per the owner's build-order call).
Shipped: the `CHAT_RULES` "Reading the player's message" block (perception model + worked
example, rules 2/8 routed through it — note the rules renumbered when the POV plan added
its narrator-camera rules 4/12 in the same change), and the `chat-thought-leak` /
`chat-thought-leak-noquotes` eval fixtures + deterministic `thoughtLeak` planted-token
metric (`run.ts`). Remaining: slice 3 (state-agent exemption audit), the markup arc
(4–6 incl. the RAG visibility fence), the session port (7), and the gated fallback (8).

## Problem

The chat narrator (and by extension the session narrator) treats the player's whole
message as something the character heard. A player message is really three channels
mixed in one text box:

> "Hey, Sabrina... how are you..." I stammer slightly, my face flushed. There's no
> way Sabrina wants to talk to a dork like me...

- **Heard** — the quoted dialogue: `"Hey, Sabrina... how are you..."`.
- **Seen** — externally visible manner narrated around it: the stammer, the flush.
  Sabrina perceives these and may react to them.
- **Private** — the player's interiority: *"There's no way Sabrina wants to talk to a
  dork like me..."*. Sabrina cannot know this. Today she frequently replies to it
  directly ("You're not a dork!"), which breaks the fiction — the NPC read the
  player's mind.

The **state agents keep full visibility**: pulse/archivist/intake legitimately use
narration and interiority to judge intent, classify the act, and extract memory.
The partition applies only to what the *character in the scene* can perceive —
i.e. to the narrator's reply. (With one caveat the memory system introduces — see
§RAG is a mind-reading backdoor.)

**Owner constraints (design rulings, 2026-07-08):**

- Fix this prompt-first. No player-facing classification burden — no mode buttons,
  no required syntax beyond the one flat game rule below.
- **The flat rule: dialogue MUST be in quotes.** The tools should tolerate unquoted
  dialogue gracefully (players will slip), but we don't need that fallback perfect —
  players are expected to abide by the rule.
- A light **optional markup grammar** (§Markup lane) is in scope: sigils that help
  the narrator and agents *when used*, never required. Asterisk/underscore spans are
  auto-italicized in the rendered transcript with the sigils hidden.
- A structural (server-side) *semantic* assist for unmarked interiority is a
  fallback slice, gated on the prompt-only attempt under-delivering — and even that
  must stay invisible to the player.

## Root cause

`CHAT_RULES` in `src/server/engine/prompts/character-chat.ts` actively teaches the
wrong model:

- Rule 2 (line ~386): "`${playerName}`'s message is what they just said or did to
  `${name}` — react to it." Everything in the message is framed as said/done *at*
  the character.
- Rule 7: "Respond directly to what the user just said" — reinforces
  everything-is-speech.
- No rule anywhere distinguishes quoted speech / visible narration / interiority, and
  no rule forbids mind-reading. The viewpoint rule (rule 2) forbids the narrator
  *writing* the player's thoughts, but says nothing about *responding to* thoughts the
  player wrote.

The session lane has the same gap (`prompts/narrative.ts` rule 3: "The player's
input is the turn's core — answer it first") but the chat lane is the current focus;
the session port is a later slice.

## The perception model (what the rules must teach)

1. **Quoted text is speech.** The character hears exactly what's inside quotes.
   - **Quotes-for-prose exception:** a quoted span is the player speaking aloud
     *now* unless the surrounding narration frames it otherwise — reported speech
     (*she told me "get out" yesterday*), scare quotes / titles (short 1–3-word
     spans embedded mid-sentence: *I head to the "bar", really just a plank on two
     barrels*). This is a semantic judgment the narrator model handles well from a
     one-line rule; the flat dialogue-must-be-quoted rule sets the default
     (quoted ⇒ speech), so prose-quotes are the rarer, context-marked exception.
     A mis-read scare quote is a mild, self-correcting error — the deterministic
     parser (§Markup lane) does not need to resolve this perfectly.
2. **Unquoted text is narration** — the camera, not the player's voice. The character
   perceives only what would be perceptible in the scene: actions, gestures,
   expressions, tone, appearance changes ("I stammer", "my face flushed" → she sees
   a stammer and a flush).
3. **Interiority is invisible.** First-person thoughts, feelings, judgments, fears,
   self-talk, and meta commentary in the narration ("There's no way she'd…",
   "I hope she doesn't notice…") reach nobody. The character must not answer,
   echo, paraphrase, or *uncannily intuit* them — no responding to the thought's
   content dressed up as perceptiveness. She may respond to the visible correlates
   (the flush, the hesitation) and *guess* wrongly like a real person would.
4. **The no-quotes case degrades gracefully.** When a message contains **no** quotes
   at all, plainly conversational text addressed to the character ("hey Sabrina,
   how's it going") is speech. Quote-awareness sharpens the split only when the
   player actually uses the convention — the partition must never strike a casual
   unquoted player mute. (Per the owner ruling this fallback is best-effort, not a
   guarantee.)
5. **State agents are exempt.** Pulse, archivist, and intake read the full message —
   narration and interiority included — to determine intent, classify the act, and
   extract memory. Nothing in this plan reduces their input.

## Markup lane — the optional sigil grammar

Optional markup that upgrades ambiguity into determinism *when the player uses it*.
Never required; a message with no sigils flows through the prompt-only partition
above. Explicit sigils turn the hardest problem (semantic interiority detection)
into a cheap regex-grade parse.

| Markup | Meaning | Notes |
| --- | --- | --- |
| `"..."` | Spoken dialogue | The one **required** rule |
| `*...*` | **Thought** (default); **comms** when `Name:`-shaped | Optional; italicized in the UI, sigils hidden |
| `_..._` | Italic styling only | No semantics — pure text style |
| `(...)` / `((...))` | **OOC / direction to the narrator** | The most entrenched RP convention; lets the player steer ("(skip ahead to evening)") without polluting the fiction. Agents exclude it from in-world memory entirely |
| `` `...` `` | In-world **written** text — a note passed, a sign, a letter | Distinct from live comms (asynchronous artifact). Nice-to-have — may defer to avoid sigil sprawl |
| `[...]` | **Avoid in input** | Output already uses `[Name]` dialogue tags; overloading invites confusion |
| `<...>` | **Avoid** | Collides with the injection-fencing markers and HTML |

Stop there — every added sigil is cognitive load on exactly the players we're trying
not to burden. Quotes + asterisks + parens covers speech/thought/comms/OOC, which is
the whole perception model. Whispering, singing, etc. need no sigils — narration
handles them ("I whisper, …").

### Asterisk semantics in detail

- **Comms shape:** `*Brian: Hey, u up?*` (leading name-colon) → an SMS/DM. The
  sender is the player persona; in the 1-on-1 chat lane the recipient is
  unambiguous. A `*to Sabrina: ...*` form reads more naturally as *sending* and
  makes the recipient explicit for the session lane — which form(s) to accept is an
  open question below.
- **Thought shape:** any other multi-word, clause-shaped asterisk span → interiority.
- **Emphasis guard (false-positive):** `you *really* think so?` — a single-word or
  short mid-sentence asterisk span is emphasis, not a thought. Classify a span as
  thought/comms only when it is multi-word and stands as its own clause/line;
  otherwise it's style-only (italicize and move on). Same treatment as underscores.
- **Convention collision (flag):** in the wider RP world (character.ai, SillyTavern,
  Discord RP) asterisks near-universally mean *actions* (`*walks in*`). Vesper can
  reassign them (unquoted plain text already IS the action channel here), but the
  prompt legend and an eventual UI hint must state it explicitly, and the failure
  is graceful: an action mis-marked as a thought just doesn't get reacted to — a
  missed beat, never a mind-read.

### Delivery: legend in the prefix, per-turn notes only for derived facts

Sigils persist in the transcript, so history messages carry them too — a per-turn
"this is a text message" note explains only the current message and goes stale as it
scrolls into the window. Instead:

- **A "Message notation" legend in the §9 stable prefix** (next to `CHAT_RULES`):
  teaches the sigil meanings once, byte-identical across turns (cache-friendly),
  and makes the narrator read sigils correctly across the whole verbatim window.
- **A volatile-tail note only for *derived* facts** the sigils alone don't state —
  e.g. "The asterisked line is a text message from Brian to you; you are not
  face-to-face for it" when the parser resolves a comms span. This mirrors the
  cue-invite/skip-note pattern that already works (pre-rendered one-liners with the
  house "never recite" discipline). Never append notes to the user message itself —
  that would pollute the stored transcript and export.

### Comms needs a symmetric OUTPUT grammar

If the player texts, the character should text back — so the narrator needs a
defined format for *her* texted reply (e.g. `[Sabrina] *"omg. yes."*` or a parallel
`*Sabrina: ...*` form) so the renderer can italicize it and the parser can tell her
texted words from her spoken words when the exchange scrolls into history. And a
text message implies the parties are **not co-located**, which in the chat lane can
collide with a scenario premise that says you're in the same room — the tail note
must tell the narrator how to reconcile it (proposal: the comms frame temporarily
overrides assumed co-presence for that beat).

### RAG is a mind-reading backdoor

Even with a perfectly behaved narrator, the archivist extracts facts from the full
message — thoughts included — and those facts come back later as "What you know
(established between you) — **treat as true**." A thought like *she'd never talk to
a dork like me* becomes a stored fact ("player feels insecure around her"), and next
session Sabrina "knows" it through memory even though she never perceived it. The
perception partition must extend into the fact store:

- Thoughts stay in scope for the **pulse** (intent) and may be recorded.
- Facts derived from unperceived channels get a **visibility/channel marker** so
  they are either excluded from the narrator's "What you know" block or rendered as
  intuition-grade background ("you sense…"), never established knowledge.
- Per the forward-compatible-schema preference: a text `channel` (or `visibility`)
  field on facts with headroom (e.g. `perceived | private | ooc`), not a boolean.
  OOC spans are excluded from in-world memory entirely.

## Slices

Sequencing: 1–3 are the prompt-only fix (ship first, current focus); 4–6 are the
markup arc; 7–8 follow validation.

### 1. Chat-lane rules rewrite (the core fix) — shipped 2026-07-08

In `src/server/engine/prompts/character-chat.ts`:

- Add a **"Reading the player's message"** block to `CHAT_RULES` (it lives in the §9
  stable prefix — byte-identical across turns, so prompt-cache-safe) teaching the
  perception model above, including the quotes-for-prose exception (¶1) and the
  no-quotes graceful degradation (¶4). The prompt files already use worked
  micro-examples where precision matters (`agents.ts` Example A/B); include one — a
  Sabrina-style message with the correct read spelled out (heard: the quoted line;
  seen: stammer + flush; unknown: the self-deprecating thought). These narrator
  models respond far better to one concrete example than to three abstract rules.
- Rewrite rule 2's tail: replace "message is what they just said or did to `${name}`
  — react to it" with wording that routes through the perception block ("react to
  what `${name}` could actually hear and see in it").
- Rewrite rule 7: "Respond directly to what the user just said" → "…to what
  `${name}` just heard and saw" (same anti-drift purpose, perception-correct).
- Add the explicit **no-mind-reading** prohibition next to the existing rule-2
  "never put words, thoughts, or actions in their mouth" clause (that clause stops
  the narrator *authoring* player interiority; this one stops it *consuming* it).
- Tests: extend `character-chat.test.ts` wording assertions (mirroring the existing
  viewpoint-rule tests) + refresh the prompt snapshots. Verify the prefix-byte-
  stability test still passes (the block is static text, so it should trivially).

Manual verification: `previewChatPrompt` (dev inspector, "what reaches the
narrator") to confirm placement, then live probes on the Fly deploy with the
Sabrina-style message shape against the curated chat models (GLM 5.2 default at
minimum), using "another take" to sample variance.

### 2. Eval fixtures — measure the leak — shipped 2026-07-08 (base fixtures; markup variants wait on slice 4)

`scripts/eval/narration/fixtures.ts` gets a `chat-thought-leak` scenario (or a small
family): a message mixing a quoted line, a visible action, and interiority that
contains a **planted distinctive token** appearing nowhere else in the prompt (e.g.
the thought calls the player a "dork" — the word exists only in the private channel).

- **Deterministic metric:** the reply's *dialogue* must not contain or directly
  answer the planted token ("You're not a dork" = fail). Reacting to the visible
  flush/stammer = pass (and is desirable — assert its presence as a soft signal).
- **Judge rubric axis:** did the character respond only to what she could perceive?
  Did she mind-read?
- A no-quotes variant guards slice 1's graceful-degradation requirement: an unquoted
  conversational message must still be treated as speech (the fix must not make the
  character ignore unquoted players).
- When slice 4 lands, add markup variants: an asterisked thought (planted-token
  test again — sigils should make it *stronger*), a `*Name: ...*` comms message
  (does the reply come back as a text, in the output grammar?), and an emphasis
  false-positive (`*really*` must not be treated as a thought).
- Same harness conventions as the rest: `pnpm eval:narration`, never in `verify`,
  live runs are owner-gated spend. Run before/after slice 1 wording tuning.

### 3. State-agent prompts — assert the exemption

Audit `prompts/chat-state.ts`, `prompts/chat-archivist.ts`, and (session)
`prompts/intake.ts`: confirm nothing in them would make an agent *discard*
narration/interiority, and add one clarifying line where cheap ("The player's
narration and inner thoughts are in scope for you — use them to judge intent")
so a future reader doesn't port the narrator's partition into the agents by
symmetry. Pulse especially benefits: the interiority is a strong intent signal
for the §6 reaction curve.

### 4. Markup lane — parser, legend, tail notes, output grammar

- **Deterministic span parser** (pure — `src/lib` or `src/contracts`, no IO; in the
  regex-first spirit of `engine/chat-intent.ts`): segment a message into spans
  `{ kind: speech | narration | thought | comms | ooc | written | styled }` with the
  emphasis guard and the `Name:` comms-shape detection. Outermost sigil wins for
  nested content (`*She said "no" — I can't believe it*` is one thought span).
  Snapshot/table tests over the shapes in §Markup lane.
- **"Message notation" legend** in the chat prompt prefix (per §Delivery).
- **Derived-fact tail notes**: when the parser finds comms/OOC spans in the current
  message, render the one-line volatile-tail note (comms: sender/recipient +
  co-presence reconciliation; OOC: "the parenthetical is the player speaking to the
  storyteller, not in-world — honor it, never have a character hear it").
- **Comms output grammar**: define the narrator's texted-reply format, add it to
  the legend/rules, and verify the parser round-trips it from history.
- Raw message stays untouched in the transcript and for the state agents; the
  parser output feeds the prompt notes, the agents' filing hints (slice 6), and the
  renderer (slice 5).

### 5. UI rendering — italicize, hide sigils

A light span renderer for chat transcript messages (both player messages and
narrator replies — `components/characters/chat-message.tsx` neighborhood):
asterisk and underscore spans render italic with the sigils hidden; backtick
written-text spans get a distinct treatment if that sigil ships. Reuses the slice-4
parser (it's pure) — never a second regex implementation (jscpd gate). Export
(`GET …/export`) keeps the raw sigils (markdown-compatible anyway).

### 6. RAG visibility fence — close the memory backdoor

Per §RAG is a mind-reading backdoor:

- Add the `channel`/`visibility` text field to facts (schema + migration via the
  standard `db:generate` flow; degraded default `perceived` so existing rows and a
  failed classification never block a write — resilience rules).
- Archivist prompt: file facts with the channel they were established through
  (quoted/visible ⇒ `perceived`; thought-derived ⇒ `private`; parenthetical ⇒
  `ooc`, generally not stored at all). The slice-4 parser output can ride along as
  a hint when sigils were used.
- `buildMemorySection` (chat prompt): `perceived` facts render as today ("treat as
  true"); `private` facts either drop from the narrator prompt or render under an
  intuition-grade framing — decide during the slice; `ooc` never renders.
- Pulse keeps reading everything (no change).
- Degradation tests: unknown/missing channel ⇒ `perceived` + diagnostic.

### 7. Session-lane port (after chat validates)

Port the perception block + notation legend to the session rulebook
(`prompts/narrative.ts` — the rule-3 neighborhood, plus the Prose rules if wording
overlaps). The session lane has extra perceivers (multiple present NPCs, the
perception/exposure system), so the wording generalizes to "characters perceive only
what is audible/visible to them" — which the presence/exposure machinery already
partially enforces spatially; this adds the speech-vs-thought axis. Comms spans need
recipient resolution there (`*to Name:*` earns its keep). Update `docs/prompts.md`
and the session rule tests. Sequenced behind slice 1–2 validation so we port wording
already proven on the chat lane.

### 8. Fallback (build only if 1–2 under-deliver): semantic segmentation for unmarked interiority

The markup lane (slice 4) already covers players who opt in; this fallback is only
for **unmarked** interiority leaking despite slice 1, and it must stay invisible:

- Candidates: a heuristic subset (sentences with no quotable/visible verb), or
  reusing an existing agent leg's output (pulse/intake already read the message —
  one could cheaply tag "private" spans) rather than adding a new LLM call.
- The narrator would receive the message plus a one-line perceived/private framing
  (volatile tail, per-turn). The transcript and state agents keep the raw message.
- Explicitly **not** v1, and player-facing classification UI is rejected outright
  (owner ruling) — this fallback must remain invisible.

## Open questions

- **Asterisks vs the RP action convention** (slice 4): confirm the owner ruling to
  reassign asterisks to thought/comms despite the wider-RP "asterisks = actions"
  habit (unquoted text is already Vesper's action channel, and the failure mode is
  a missed beat, not a mind-read — but it should be a deliberate call).
- **Comms sender form** (slice 4): accept `*Name: ...*` only, `*to Name: ...*` only,
  or both? `to Name:` is clearer for *sending* and the session lane needs an
  explicit recipient; `Name:` matches how people actually type an SMS. Leaning
  both, normalized by the parser.
- **Private facts in the narrator prompt** (slice 6): drop entirely, or render as
  intuition-grade background ("you sense…")? Dropping is safest; intuition framing
  is richer but risks the uncanny-paraphrase failure the whole plan exists to kill.
- **Backtick written-text sigil** (slice 4/5): ship in v1 or defer? It's the most
  expendable sigil — narration ("I slide a note across: `meet me at 8`") already
  reads fine without special handling.
- **Ambiguous unquoted address** (slice 1 wording): in a mixed message ("*She looks
  tired today. you doing okay?*" — no quotes on the address), should the
  conversational fragment count as speech? Leaning yes (graceful degradation
  favors hearing too much over striking players mute), but the example in the
  prompt should model the common case, not this edge. Settle during slice 1
  probing.
- **Bar for slice 8**: what leak rate on the slice-2 eval justifies building the
  semantic fallback? Proposal: prompt-only ships if the planted-token leak is ≤1 in
  10 takes on the default chat model; otherwise escalate. Owner call at
  measurement time.

## Docs to update on ship

- `docs/prompts.md` — new subsection (§Player-input perception) under the
  character-chat cluster covering the perception model + notation legend;
  cross-note in §Agent prompts that state agents see the full message.
- `docs/character-chat.md` — one line in the prompt-build step pointing at the new
  section; the markup grammar belongs in player-facing help too when the UI slice
  lands.
- `docs/memory.md` — the fact `channel` field and its narrator-rendering rule
  (slice 6).
- `docs/ui.md` — the transcript span renderer (slice 5).
