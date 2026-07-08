# Chat narrator — player-POV story narration

Status: **next** (planned 2026-07-08 from owner direction; design proposed inline —
the §Open questions are the owner calls).

Related: [character-chat-sensory.plan.md](character-chat-sensory.plan.md) (the shipped
opportunistic-cue discipline this widens), [player-input-perception.plan.md](player-input-perception.plan.md)
(the queued CHAT_RULES rewrite this must coordinate with — see §Sequencing),
[attribute-narrator-guidance.plan.md](attribute-narrator-guidance.plan.md) (glosses make the
visual channel's raw material meaningful), [../prompts.md](../prompts.md) §Character-chat
sensory cues, [../character-chat.md](../character-chat.md),
[multi-character-chat.plan.md](multi-character-chat.plan.md) ("player-owns-himself narration
authority" — the same boundary this plan draws must hold there).

---

## Goal

The chat narrator handles the character's dialogue, actions, and feelings well, but its
prose reads like a character reporting herself, not a story being told. What's missing is
**narrative flavor written for the player's POV** — the story-camera channel a prose
narrator provides:

> You see her long, tanned legs peeking out of the slit in her dress.

> As you bring her foot closer to your lips, the smell of vinegar tickles your nose.

Two distinct missing channels, plus a boundary:

1. **The player's eye (visual).** Concrete description of the character's appearance,
   clothing, and movement as the player sees it — at any distance, when attention or
   motion earns it. The engine already *has* the material (attributes, outfit) but frames
   it only as the character's self-identity, never as what the player sees.
2. **The player's body (near senses).** Sensation landing in the player — scent reaching
   *your* nose, warmth against *your* skin. The shipped sensory-cue system surfaces the
   character's sensory attributes, but nothing says the sensation registers in the
   player's senses; models write "her scent is noticeable" instead of "the scent tickles
   your nose".
3. **The boundary that makes it safe.** The narrator may write the player's *involuntary
   perception* — never their voluntary actions, speech, decisions, or claimed emotions.
   Today's rules don't draw this line, so models over-apply "never put words, thoughts,
   or actions in their mouth" and avoid the player's experience entirely.

The target is *woven* flavor, not more prose: one grounded perceptual detail inside an
existing beat, riding the same opportunistic discipline the sensory-cues work shipped —
not head-to-toe inventories, not description on every turn.

---

## Current architecture findings

All in `src/server/engine/prompts/character-chat.ts` and `src/server/engine/chat-intent.ts`
unless noted.

### The prompt frames the model wholly as the character — there is no narrator role
Rule 2 (`character-chat.ts:386`) defines untagged prose as "Describe ${name}'s actions,
gestures, expressions, and feelings"; rule 3 (`:388`) calls it "actions, gestures, and
description … e.g. ${name} leans against the doorframe, watching you." Every example and
every framing is character-side. No rule anywhere says the prose is also the *story's
camera* — what the player perceives of the character and the scene. The grammar already
fits (the player is "you", the character is third person — the target examples are legal
under rule 2's viewpoint), but nothing licenses or steers it.

### Rule 2's ownership clause over-teaches
"never put words, thoughts, or actions in their mouth" (`:386`) correctly stops the
narrator *authoring* the player — but with no counterweight, models generalize it to "say
nothing about the player's experience", which kills "the smell tickles your nose"
narration. The missing distinction: **involuntary perception is the narrator's to write;
voluntary action/speech/judgment is the player's.**

### Attributes and outfit are identity data, never appearance data
The Attributes framing (`:549`) is "who you are — express these naturally, never list
them" — self-embodiment. The outfit state line (`:232`) is "You're wearing X" — a fact
addressed to the character. Neither says "this is what ${player} sees of you; when
attention or movement lands on it, show it." The dress-slit example needs exactly that
reframing: the data is present, the license to *describe it visually* is not.

### The sensory-cue system is proximity-scoped and has no visual channel
The shipped block (`sensoryCues` `:330`, `buildSensorySection` `:353`), rule 10 (`:395`),
and the one-turn cue invite (`chat-intent.ts` — proximity/touch/intimate regexes) all gate
on *closeness*. Correct for scent/warmth — but **sight works at distance** and is gated by
*attention and motion* (the player looks; she crosses her legs; the dress shifts), a
signal nothing detects and no rule addresses. And the invite lines (`chatCueInviteLine`,
`chat-intent.ts:45`) describe the cue as the character's property ("${name}'s breath",
"if ${name} has a sensory cue"), never as sensation arriving in the player's body.

### The concision steer competes with flavor
Chat's resting shape is `aggressive_concise` (`prompts/constants.ts`,
`NARRATION_LANE_DEFAULTS`), and rules 8–9 push against embellishment — rightly. Any
flavor rule must be worded as *woven into the beat, replacing nothing, adding no length*,
or the shape profile will eat it (and if it still does, that's an eval finding — see
§Open questions).

### What already works in our favor
- The intimate block (`:400-404`) already demands concrete sensation ("touch, heat,
  breath, weight, sound") — it just never says the sensation lands in the *player's*
  body too. Smallest edit, biggest payoff for the vinegar-class example.
- `feet.scent` and any future non-intimate, non-voice sensory attribute already reach the
  Sensory cues block — the material for example 2 flows; only the POV framing is missing.
- The session lane's glance impressions + exposure mask already do attention-gated
  appearance description; this plan ports the *idea* (prompt-only), not the machinery —
  same call the sensory-cues plan made.

---

## Design decisions (proposed)

1. **Name the second role.** Rework rules 2–3's framing: the model is ${name} **and the
   scene's narrator**; untagged prose is the story's camera, and the camera sits behind
   the player's eyes. Perceptual sentences addressed to "you" ("You catch…", "You can
   see…") and third-person visual description of the character are the narrator's job,
   not a viewpoint violation. Add one worked micro-example (the house style — the
   perception plan reached the same conclusion): a beat that pairs an action with a
   player-POV detail, e.g. *She crosses her legs, and the slit of her dress parts over a
   long, tanned thigh.*

2. **Draw the player-body boundary explicitly.** New clause beside rule 2's ownership
   sentence: the narrator MAY write what the player's senses involuntarily register —
   what you see, hear, smell, the warmth or texture against your skin — and MAY NOT
   write the player's voluntary actions, speech, decisions, or name their emotions or
   arousal (those are the player's to declare). Involuntary *reflex* (breath catching,
   a shiver) is proposed-in but is an owner call (§Open questions).

3. **The visual channel is attention/motion-gated, not proximity-gated.** New craft rule
   (rule-10 neighborhood): when the player looks, notices, or compliments; when ${name}
   enters, moves, or adjusts clothing; or when appearance becomes newly relevant — give
   ONE concrete visual detail from the player's eye, grounded in the Attributes/outfit
   data. Never a head-to-toe inventory, never on ordinary static turns, never repeated
   for an unchanged look. (The "changed state marks once, then rides" discipline of rule
   11, applied to appearance.)

4. **Reframe the data blocks as shared identity + appearance.** Attributes framing
   becomes "who you are and what ${player} sees of you — express and *show* these
   naturally, never list them"; the outfit line gains "let it show — describe what
   ${player} sees of it when movement or attention makes it noticeable" (plus the
   exposed flag reading as visual license, not just tone). The Sensory cues framing and
   `chatCueInviteLine` arms shift from character-property wording to arrival wording —
   "the scent reaching them", "what registers in their senses".

5. **Intimate block: sensation lands in the player too.** Extend "Ground it in concrete
   sensation" with "— landing in the player's body as much as ${name}'s: what you taste,
   smell, and feel against your skin is the scene's texture."

6. **Extend the cue invite with an `attention` signal** (escalation lane, mirroring the
   shipped regex-first pattern). `detectChatCue` gains `attention: boolean` — the player
   looking/watching/glancing/checking out/admiring/complimenting, and mention of
   body-part or clothing nouns. `chatCueInviteLine` gets an arm: "The player's attention
   is on ${name}'s appearance — this is a turn where one concrete visual detail (drawn
   from her attributes and what she's wearing) lands well, woven into her reaction."
   One-turn, never persisted, no model call — identical contract to the existing hints.

7. **Keep the restraint discipline.** Everything above is opportunistic-not-mandatory,
   one-detail-max, woven-into-action, never-recite — the same rules the sensory-cues
   plan proved out. `aggressive_concise` stays the resting shape; flavor is framed as
   *inside* the beat, not appended to it.

## Sequencing vs player-input-perception

Both plans rewrite the rule-2 neighborhood of `CHAT_RULES`. They are complementary, not
overlapping: the perception plan partitions what the **character can perceive of the
player's message** (input side); this plan governs what the **narrator writes of the
player's perception** (output side). Build this **after** that plan's slices 1–2 (or in
the same sitting, merging the rule-2 wording edits once) — two independent rewrites of
the same sentences would collide. The two boundaries also reinforce each other: "she
can't read your mind" and "the narrator may write your senses but not your mind" are one
coherent perception model, and the prompt should read that way.

---

## Slices

### 1. Prompt rewrite (the core)
In `character-chat.ts`: the narrator-role reframing of rules 2–3 + the worked
micro-example (D1), the player-body boundary clause (D2), the new visual craft rule (D3),
the Attributes/outfit/Sensory-cue reframings (D4), the intimate-block extension (D5).
Tests in `character-chat.test.ts`: wording assertions for the new rule/boundary/framing
(mirroring the existing viewpoint-rule tests), a regex guard that no "always describe"
mandate exists, prefix-byte-stability still holds (all static text), snapshot refresh.

### 2. Attention cue invite
`chat-intent.ts`: the `attention` field + regexes (D6), the new `chatCueInviteLine` arm,
priority order (intimate > touch > proximity > attention — most-charged wins, unchanged
contract). Table tests beside the existing ones; false-positive guards ("I look at the
menu" — pair the look-verb with a person-directed object or body/clothing noun).

### 3. Eval fixtures + metric
`scripts/eval/narration/fixtures.ts`, same conventions (never in `verify`; live runs are
owner-gated spend):
- `chat-pov-visual` — she approaches in described clothing / the player looks her over;
  expectation: one concrete player-eye visual detail drawn from attributes/outfit, woven
  into the beat; no inventory.
- `chat-pov-sensory` — a closeness/contact beat where a sensory attribute should land in
  the player's senses (the vinegar-class case; a `feet.scent`-authored profile makes it
  deterministic material).
- Control: the existing `chat-compliment` (distant, ordinary) must NOT grow description —
  the restraint regression guard.
- Deterministic metric (flagged scenarios only, like `sensoryRelevant`): reply matches a
  second-person-perception pattern (`you see|notice|catch|feel|smell|taste|hear` +
  sensory-noun neighborhood) — presence expected on the two new fixtures, absence on the
  control. Judge-rubric axis: "does the prose read as story narration from the player's
  POV, or as the character reporting herself?"

### 4. Docs
`docs/prompts.md`: extend §Character-chat sensory cues into (or add a sibling)
§Character-chat player-POV narration — the two channels, the boundary, the attention
invite. `docs/character-chat.md`: one line in the prompt-build step. This plan's status +
roadmap on ship.

---

## Open questions

- **The reflex line (D2).** Is involuntary player reflex (breath catch, shiver,
  goosebumps) narrator-writable, or only pure perception? Proposed: perception + light
  reflex yes; emotion/arousal claims never. Owner call — it's the difference between
  "the smell tickles your nose" (clearly in) and "your pulse quickens" (borderline).
- **Does `aggressive_concise` suppress the flavor?** If the slice-3 eval shows the shape
  profile eating the perceptual detail, the fix is a one-line wording tweak to the chat
  profile ("concise means no padding — a grounded sensory detail inside the beat is not
  padding"), not a new shape. Measure first.
- **Build order with player-input-perception** (§Sequencing): after its slices 1–2, or
  merged into one CHAT_RULES sitting? Leaning after — proven wording is easier to extend
  than to co-draft.
- **Session-lane port.** The session lane already has exposure-mask/glance machinery but
  its *narrator-eye wording* could take the same player-body arrival framing. Out of
  scope here; note for the perception plan's slice-7 port to carry both if this
  validates.

## Acceptance criteria

- The prompt names the narrator role and licenses player-POV perception with an explicit
  voluntary/involuntary boundary; the target-example shapes are legal and steered-for.
- Attributes/outfit/sensory framings carry the "what the player sees / what reaches
  their senses" reading; the intimate block grounds sensation in the player's body too.
- An attention-shaped input raises a one-turn visual invite; ordinary distant turns are
  byte-identical in behavior (control fixture stays flat).
- All new steering keeps the opportunistic discipline: one detail, woven, never listed,
  never mandated. No "always describe" wording exists (regex-guarded).
- `character-chat.test.ts` + `chat-intent` tests cover the above; `pnpm verify` green;
  `docs/prompts.md` updated in the same change; both fixtures + the metric land.

## Risks & mitigations

- **Purple prose / over-description.** The one-detail-max + attention/motion gate + the
  control fixture; the deterministic metric flags over-use on the control.
- **Narrating the player's insides.** The D2 boundary clause with a worked example; the
  perception plan's no-mind-reading work is the sibling guard on the input side.
- **Leering tone when unearned.** The visual channel keys to *player attention or
  character motion*, never to mere presence of intimate attributes; intimate visual
  attributes stay out of chat entirely (unchanged sensory-cues gate).
- **CHAT_RULES churn vs the perception plan.** §Sequencing; one merge point, decided
  before slice 1 starts.
- **Prompt-cache impact.** All slice-1 edits are static prefix text — one cache bust per
  deploy, then stable; the attention invite rides the existing volatile-tail line.

## Out of scope

Porting the session exposure mask / glance impressions into chat (the sensory-cues plan
already rejected this; still right); the session-lane wording port (noted for the
perception plan's port slice); multi-character chat (its plan owns ensemble narration
authority — the D2 boundary must simply not contradict it); any new structured state.
