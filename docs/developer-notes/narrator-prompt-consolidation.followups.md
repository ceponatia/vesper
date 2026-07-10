# Narrator prompt consolidation — followups

Post-ship fixes and observations for [narrator-prompt-consolidation.plan.md](narrator-prompt-consolidation.plan.md)
(shipped 2026-07-10).

## 2026-07-10 — Fly screenshot review (fresh Cassandra chat, narrator Aion 3)

Owner screenshot of a brand-new chat's first exchange on the Fly deploy
(`images/Screenshot from 2026-07-10 10-29-39.png` — local-only; `docs/**/*.png` is
gitignored). Five findings; the first three shipped as prompt/pipeline fixes the same
day, the last two are eval cases. The reply's shape, for the record: one narration
opener, then a long paragraph interleaving the character's dialogue with action
beats (unattributed), then three labeled whole-line quotes separated by one-line
narration bridges, ending on two player-directed compliments.

### Fixed

1. **First-exchange scene directive** (`character-chat.ts` `firstExchange`, wired in
   `chat-pipeline.ts`). The opener was dialogue-heavy with one clause of setting. Root
   cause: on a fresh chat the Scene block is empty and `sceneChanged` can't fire
   (`detectSceneMovement` needs a movement verb; "Cassandra is over at my loft" has
   none), so **no rule directed scene establishment** — `chatLengthStory` granted
   brand-new-scene length and the model spent it all on talk. A one-turn volatile tail
   line now directs narration-forward establishment (sight plus one other sense, drawn
   from the scenario + the player's message) when no assistant reply exists yet;
   `sceneChanged`'s own directive wins when a first-message move minted a place, and
   opening beats keep their own instruction.
2. **Chat rule 3 rewritten as a mechanical attribution contract.** The reply mixed
   `"…" She tilts her head… "…"` speech+beat paragraphs (unattributed — fails both the
   tag path and the whole-line-quote path) with clean standalone quotes (attributed),
   so speaker labels appeared on only some of the character's dialogue. Slice 1's
   "reach for the tag only when who is speaking would genuinely be unclear" was a
   *reader-centric* criterion — the model judged the paragraph clear (it was, to a
   human) and skipped the tag the *segmenter* needed. Rule 3 now states the contract:
   nothing-but-the-quote auto-attributes; a line mixing speech with narration/beats
   opens with the `[Name]` tag or splits into separate quote/prose lines; when unsure,
   tag (the reader never sees it).
3. **Own-output emphasis rule, both lanes' notation legends.** The model wrote
   `*Marcus*` / `*loves*` inside quoted dialogue — rendered as literal asterisks
   (speech spans are atomic; only `_…_` is tokenized inside span bodies). The legends
   taught the sigils for *player input* and the `*Name: …*` texted-reply output
   grammar, but never an output emphasis convention, so the model defaulted to the
   markdown habit. One legend line each in `CHAT_RULES` and `MESSAGE_NOTATION_LEGEND`:
   emphasis is `_underscores_`, never single asterisks.

### Eval cases (no rule change — the rules already forbid both; adherence questions for the queued enactment measurement run)

4. **POV slip**: "Cassandra curls her legs beneath her on **Brian's couch**" — third
   person for the player against rule 2's your/you contract (the same reply used "you"
   correctly elsewhere).
5. **Mind-reading-adjacent validation**: the player's message was all unquoted
   narration including explicit interiority ("I manage to *hide* the slight pang of
   jealousy… secret young crush"); the reply arced to "You'd be better at it than you
   think, Bri." / "You're a good listener." — answering the player's inner
   self-assessment with no narrated visible tell, plus three stacked closing moves
   ending on flattery (brushes the perception partition's worked example, "Resolve,
   then one move", and rule 9's affection-is-earned).

## 2026-07-10 (later) — post-deploy observations + the separation ruling

Second screenshot pair (same Cassandra world, gallery scene, Aion 3.0):

- **Speaker labels confirmed model-side, not a UI bug**: pre-deploy replies embedded
  every quote in narration-led paragraphs (neither attribution path can catch those);
  the first post-deploy reply tagged a mixed speech+beat line and the label rendered
  immediately. The renderer re-parses stored text identically for every message, so
  per-message differences are always content differences.
- **Third-person player drift**: one conversation narrates the player wholly in third
  person ("she tugs him away", "leans into Brian's side") — rule 2 violation, but
  self-reinforcing once the history establishes the register. Owner ruling: acceptable
  for that conversation; watch whether FRESH Aion 3.0 chats start correctly. If drift
  recurs from clean starts, the candidate fix is a deterministic `gateNotes` steer
  (third-person player-name/pronoun detection over the last reply → a one-turn
  "address the player as you" note), not more static rules.
- **Separation ruling (implemented)**: a parted-ways beat (player walks the character
  home, returns to their own place) drew a reply narrating the PLAYER's side — walking
  into the loft, receiving a text, reacting. Rule 4 hardened (the player's story
  advances only through their own messages; never script even mundane connective
  beats) + new rule 16 (apart ⇒ the reply follows the character's side only, a scene
  cut to her world, reaching the player solely through comms, ending on her move).
  Known limitation: chat scene memory tracks ONE current place — a split scene isn't
  modeled as state, so rule 16 carries the behavior alone; if the archivist's `scene`
  proposals wobble between the two locations during a separation, a `places`-level
  "whose location" axis is the deeper fix.

### Consciously skipped

- **Renderer backstop for asterisk-emphasis** (tokenizing `*…*` pairs inside speech
  spans in `parseEmphasisRuns`): would hide the model's sigil misuse instead of
  training it out via the legend; revisit if narrator models keep emitting
  asterisk-emphasis despite the new line.
- **Segmenter loosening** (attributing quote-*led* paragraphs to the sole 1:1
  speaker): behaviorally equivalent to the model tagging them, but would misattribute
  incidental-speaker lines (`"Anything else?" the waiter asks.`) to the character;
  revisit only if rule 3's tightened contract under-delivers.
