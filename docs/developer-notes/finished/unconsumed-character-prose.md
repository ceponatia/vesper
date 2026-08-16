# Authored character prose that never reaches a prompt

Status: **analysis / proposal** (2026-06-15). Supplement to
[character-schema-audit.md](../finished/character-schema-audit.md) findings **C1** and **C2**.
The character forge spends model effort drafting a `personality` sketch and
free-text `voice` notes for every character; neither field is ever read by a
prompt builder. Only `bio` reaches the narrator. This doc traces exactly what is
produced, what is consumed, why the gap is costly for a romance-first engine, and
how to close it cheaply.

## What gets written

The forge profile section (`server/authoring/character-forge.ts:155`) instructs
the model to *"Produce: a display name, a 2-4 sentence bio, a personality sketch
(quirks, humor, flaws), …"* and stores all of it:

- `profile.bio`
- `profile.personality` (`character-forge.ts:180`)
- `profile.voice` (`character-forge.ts:183-184`)

`fillBundlePlayerToken` faithfully `{{player}}`-substitutes all three at the
session boundary (`engine/bundle.ts:249-251`), so the substitution contract is
already satisfied for them.

## What actually reaches the narrator

Only **bio**:

- **NPC bio** → the canonical facts block: `buildCanonicalFactsBlock` emits
  `excerptBio(p.snapshot.bio)` (`engine/scene.ts:692`) under the *"Canonical
  character facts (authoritative truth — who characters ARE)"* header.
- **Player bio** → `playerContext`: `pipeline.ts:640` sets it to
  `excerptBio(player.snapshot.bio)`, consumed at `narrative.ts:150` as *"Player
  character context (for how the world reacts to them)."*

A full grep of `engine/prompts` and `scene.ts` for `personality` / `voice`
returns no other consumer. `snapshot.personality` is read nowhere; the free-text
`snapshot.voice` is read only by the bundle token-fill. *(The session-status
payload may echo these to the editor UI — but that is display, not a prompt, and
does not influence a turn.)*

## The voice double-representation

"Voice" exists twice and the two don't connect:

- **Free-text `profile.voice`** — forge-authored prose ("a dry, gravelly
  rasp"). Unconsumed.
- **The `voice` attribute category** — `voice.pitch`, `voice.timbre`,
  `voice.accent`, `voice.cadence` (`attributes/groups/voice.ts`), with their own
  `promptHints`. *This* is what the narrator's voice impression uses
  (`scene.ts:767` filters `def.category === "voice"` for the comms/first-voice
  impression).

So the structured voice attributes are live and the free-text field is dead and
redundant. Two representations of the same concept, only one wired.

## Why it matters

1. **It is the exact content a romance engine wants in the prompt.** Personality
   (quirks, humor, flaws) is what makes an NPC feel like a person turn to turn —
   arguably higher-value to the narrator than physical bio. It is generated and
   then discarded.
2. **Wasted model spend.** Every forge run pays for a personality sketch and
   voice notes that change nothing downstream.
3. **Silent author surprise.** An author writes/edits a rich personality in the
   editor and reasonably assumes it shapes play. It doesn't. There is no signal
   that the field is inert.
4. **Redundancy invites drift.** Two "voice" fields with different fates is the
   kind of ambiguity that produces bugs ("I set the voice and nothing changed").

## Solutions

The fields exist, are token-safe, and the injection points already exist — this
is a *surfacing* change, not new infrastructure. Recommended: **A + C**.

### A. Surface personality to the narrator

NPC personality belongs alongside bio in the **canonical facts block** (it is
"who the character IS"). In `buildCanonicalFactsBlock` (`scene.ts:686`), append a
personality clause when present:

```ts
const persona = excerptPersona(p.snapshot.personality);   // mirror excerptBio's cap
const personaPhrase = persona ? ` Personality: ${persona}` : "";
if (!agePhrase && !bioPhrase && !personaPhrase) continue;
lines.push(`- ${p.displayName}${agePhrase}.${bioPhrase}${personaPhrase}`);
```

For the **player**, extend `playerContext` (`pipeline.ts:640`) to include
personality:

```ts
playerContext: bundle.session.embodied && player
  ? joinNonEmpty([excerptBio(player.snapshot.bio), excerptPersona(player.snapshot.personality)])
  : undefined,
```

No `{{player}}` work needed (already filled). Watch the prompt-budget angle: cap
the personality excerpt like bio (`excerptBio` already truncates) so the canonical
block stays compact, and keep it in the cached/stable region of the prompt where
bio already lives.

### B. Resolve the free-text `voice` field

Pick one and document it:

- **Collapse (recommended)** — drop `profile.voice` as a stored field and stop
  the forge generating it; the `voice.*` attributes already carry voice with
  validated vocabulary and `promptHints`. Removes the redundancy outright. If the
  forge's free-form voice prose is useful, route it into a `voice.accent` /
  `voice.cadence` value or an attribute `note` instead of a parallel field.
- **Surface** — if a free-form "voice & manner" line is wanted beyond the
  structured attributes, emit it as its own narrator line (e.g. in the canonical
  block or a dedicated manner hint). Weaker: it competes with the structured
  voice impression for authority.

Collapsing is cleaner; surfacing keeps the author's prose. Either resolves C2;
leaving both as-is does not.

### C. If we decide prose isn't wanted — stop generating it

The honest alternative to surfacing is to stop the forge from drafting
`personality`/free-text `voice` and remove the fields. Not recommended (the
content is valuable), but it is a valid resolution of the drift and cheaper than
half-wiring.

## Recommended path

1. Surface NPC + player `personality` (A) — small edits to two existing builders.
2. Collapse the free-text `voice` field into the `voice.*` attributes (B,
   collapse).
3. Update `docs/authoring.md` (forge sections) and `docs/prompts.md` (what the
   canonical block contains) in the same change.

## Test plan

- `scene.test.ts`: a character with a `personality` produces a canonical-facts
  line containing it; empty personality omits the clause; the excerpt is capped.
- `pipeline.test.ts` / `narrative.test.ts`: embodied player's `playerContext`
  includes personality; observer session unchanged.
- If collapsing voice: assert the forge no longer emits `profile.voice` and the
  voice impression still reads `voice.*` attributes.

## Open questions

- **Personality in canonical facts vs. a separate channel.** Folding into
  canonical facts is simplest, but personality is *softer* than the
  "authoritative truth, never contradict" framing of that block. Worth a distinct
  "Character manner" line instead? Leaning fold-with-care (cap length, it reads as
  characterization, not a hard fact).
- **Free-text voice: collapse or keep.** (B). Leaning collapse.
- **Prompt budget.** Personality on every present NPC adds tokens to a cached
  block; fine for a handful of co-located NPCs, worth a per-character cap. Confirm
  the excerpt length.
