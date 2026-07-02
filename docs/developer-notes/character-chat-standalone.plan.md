# Character chat — the standalone experience — plan

Status: **draft** (not settled — the open questions at the foot need owner rulings before
this becomes buildable; several of them change the shape of the work).

Design/decisions: [character-chat-standalone.spec.md](character-chat-standalone.spec.md) —
the technical detail (schemas, file touch-points, migration shape, refactor analysis) lives
there. This plan is written in plain English: what the feature should become and why, area
by area, so it can be read without knowing the codebase.

Builds on the whole shipped character-chat family — the original sessionless chat, the
rolling summary, the light state, the scenario setup, sensory cues, state-as-narration, and
the "primary feature" arc (long-term memory + evolving attributes). This plan is the next
chapter: chat stops being a very good tab and becomes a product surface in its own right.

## Where chat stands today

Character chat is a one-on-one conversation with any saved character — no world, no
session, location conveyed only through the writing. Under the hood it is already
surprisingly deep: the character has a persistent mood, energy, intimacy and intoxication
state that drifts realistically between visits; a personality that visibly drives how they
speak; long-term memory (they remember facts about you and past scenes even hundreds of
messages later); attributes that can genuinely change over a long chat (a haircut sticks);
a scenario system (premise, outfit, taboo cards) for framing any situation; and scene
images that reflect the character's current state.

But as a *product*, chat is still shaped like the developer test-bed it started as:

- It lives as **one tab buried inside the character editor** — a place shaped for
  authoring, not for the experience the engine can now deliver. On a phone (the natural
  home of a chat feature) it competes with seven editor tabs.
- Each character has **exactly one conversation, forever**. The only lifecycle action is
  "Clear chat", which destroys everything — transcript, relationship, memory. There is no
  way to keep a finished story, start a fresh scenario alongside it, or come back to an
  old one.
- The moment-to-moment controls are thinner than every comparable chat product: you can
  edit/delete/rerun *your* lines, but you cannot ask for a **different take on the
  character's reply**, nudge the character to continue on their own, or stop a reply
  mid-stream.
- The character's memory is invisible except to developers. Players can't see what the
  character remembers, correct a wrong memory, or say "remember this."
- The relationship *number* moves, but the **relationship arc is invisible** — no history,
  no milestones, nothing that shows how far you've come with a character.
- The character tracks time between visits (they get rested, sober up) but never *acts*
  like time passed — no "it's been a week", no sense of a life lived meanwhile.
- Under the hood, chat grew feature-by-feature into a parallel mini-engine that forked
  pieces of the session engine instead of sharing them, and its orchestration lives in a
  web route instead of the engine. It works, but every future chat feature pays a tax, and
  the system has no documentation page of its own.

## The vision

Chat is the lightest, most personal way to enjoy what Vesper is best at: a character who
feels like a person. Sessions are the full tabletop experience — worlds, casts, places.
Chat should be the **companion experience**: open the app, see your conversations, pick up
where you left off with someone who remembers you, looks the way your story left them, has
visibly grown closer (or cooler) over time, and notices you've been away. It should be the
front door of the product and feel first-class on a phone.

## Improvement areas

Numbered for reference, not priority — the build order proposal is further down.

### 1. A place of its own

Give chat its own home instead of an editor tab:

- A **Chats page** in the main navigation: every conversation you have going, sorted by
  recency — portrait, character name, a snippet of the last message, and the mood /
  relationship-stage chips so the list itself feels alive.
- A **full-screen conversation page** per chat: portrait/scene panel, the transcript, and
  the composer, designed mobile-first. The scenario, state-tools, and model controls move
  into a header menu rather than crowding the top of the screen.
- **Entry points everywhere characters appear**: a "Chat" action on library cards and on
  the character page; a "Continue talking to …" card on the dashboard; chat directly from
  a public-gallery character (it quietly makes your own copy first, as sharing already
  does).
- The character editor keeps a lightweight link ("Open chat") rather than embedding the
  whole experience; the editor remains the place you *author*, the Chats page the place
  you *play*.
- First-open experience: a fresh conversation offers the character's own greeting (the
  existing "Prompt character" opening beat) and a scenario suggestion instead of a blank
  box.

### 2. Conversations, plural

One character should support many stories:

- **Multiple named conversations per character** — e.g. a long-running "main" story plus a
  fresh "what if we met as strangers" scenario — each with its own transcript,
  relationship state, premise and outfit.
- **Archive instead of destroy**: finishing or abandoning a conversation shelves it
  (readable later, restorable), replacing today's all-or-nothing Clear chat as the everyday
  action. A true delete remains available.
- **Memory that respects the fiction**: when starting a new conversation you choose
  whether it *continues the shared history* (the character remembers everything you've
  built) or is a *fresh start / alternate universe* (clean memory, the relationship starts
  where the scenario says). This is the load-bearing design choice of the whole plan — see
  Open questions.
- **Scenario presets**: save a scenario setup (premise + outfit + cards + starting
  relationship) as a reusable, nameable preset, so a favorite setup is one tap on any new
  conversation — and potentially shareable like other library content later.

### 3. Better writing in the moment

The controls every mature chat product has, plus craft-level prompt work:

- **Another take**: regenerate the character's last reply; keep the takes you've seen and
  flip between them before continuing. Today the only lever is rerunning your own line.
- **Go on**: a gentle nudge that lets the character continue unprompted mid-conversation
  (the existing opening-beat machinery, generalized).
- **Stop**: cancel a reply mid-stream cleanly.
- **Craft rules** ported/fixed from the codebase review: dialogue that sounds like speech
  (fragments, interruptions, subtext, silence as an answer), guidance for intimate scenes
  (pacing held to the player's pace, body/clothing continuity, concrete sensation over
  florid abstraction), and a handful of known prompt bugs that make the background agents
  under-perform (an agent prompt that miscounts its own fields, a summarizer that
  addresses "you" in a third-person summary, a classifier with no worked example).
- One quiet correctness fix: editing or deleting a poisoned message today cleans the
  transcript but **not** the memories already extracted from it; regeneration needs the
  same guarantee. Memories get tied to the message they came from so removing one removes
  the other.

### 4. Memory you can see and shape

Trust in a companion's memory requires visibility:

- A **"What they remember" panel** (player-facing, not the dev inspector): the character's
  remembered facts about you and your story, in plain language.
- **Forget** a wrong or unwanted memory; **pin** a memory so it's never lost or drowned
  out; **"Remember this"** — tell the character something directly and have it stick, the
  chat analogue of the session lane's inner-note.
- **Open loops**: the character keeps track of unfinished business ("she promised to tell
  you about her sister") so long conversations get narrative pull, not just recall.
- **Retrieval quality**: apply the already-drafted retrieval improvements that matter most
  for chat (a relevance floor so irrelevant memories stop leaking in; better merging of
  duplicate memories; per-query retrieval) — shared work that also benefits sessions.

### 5. A relationship that visibly grows

Make the arc a feature, not a hidden number:

- A **relationship panel**: current stage, how it has moved over time (a simple timeline /
  sparkline), and **milestones** — first meeting, stage changes, memorable beats — pulled
  from what the engine already records. (This graduates the long-parked
  relationship-timeline idea, at chat scale first.)
- The **story so far**: a readable recap of the conversation's history (the rolling
  summary, cleaned up for player eyes) so returning after weeks doesn't require rereading
  hundreds of messages.
- Transcript **export** (long-parked) fits naturally here: take your story with you.

### 6. A character who notices time

The state already drifts between visits; the character should act like it:

- **Welcome-backs**: after a real gap, the character acknowledges it naturally, once
  ("three days" reads differently at stranger vs. lover stages).
- **A life meanwhile** (light touch): on return after a long gap, one line of "what she's
  been up to" consistent with premise and personality — texture, not simulation.
- **They have something to say**: on the Chats page, a character whose situation changed
  (long absence, an open loop, a milestone anniversary) can show a subtle "has something
  to tell you" marker; tapping it lets them open the conversation. This is *pull-based* —
  no notifications are sent anywhere; how far to take proactivity is an open question.

### 7. The visual layer

- **Scene moments in the transcript**: images generated at meaningful beats appear inline
  in the conversation where they happened (not only in a strip above), making a long chat
  feel like an illustrated story. Generation stays player-triggered by default, with an
  optional "auto at big moments" setting.
- The **portrait panel** stays (post-rollback) as the character's steady presence. A fresh
  expression/mood system is explicitly **not** re-attempted inside this plan — the rollback
  ruling stands; when a better approach is designed it gets its own plan, and chat will be
  its natural first home.

### 8. One solid engine under it

The invisible slice that makes everything above cheaper and safer (absorbing the
chat-lane parts of the codebase-review follow-on batches):

- Move chat's turn orchestration out of the web route into a proper engine module, the way
  sessions already work.
- Stop maintaining forked copies of session machinery (the reaction curve, the timeout
  helper, the streaming plumbing) — share one implementation.
- Fix the background-job wrinkle that can leave a chat scene image stuck "running" forever
  after a crash.
- Split the oversized chat screen component; reuse the app's shared polling/model-select/
  draft primitives.
- Correct the handful of stale internal comments that still describe the pre-memory chat.
- Write the missing **`docs/character-chat.md`** system page so the next person (or agent)
  touching chat has the same map sessions have.

## How deep should the rebuild go?

Three honest options, smallest to largest:

- **Option A — consolidate in place.** Area 8 only: extract the engine module, de-fork the
  helpers, document. No schema change, no product change. Everything in areas 1 and 3–7
  can technically be built on top of today's one-conversation model, but area 2 cannot.
- **Option B — re-key around "a conversation" (recommended).** Introduce a real
  conversation record and hang transcript, state, summary and (per the memory ruling)
  memory off it. This is a genuine migration and touches most chat tables — the biggest
  single piece of work in the plan — but it is the honest data model for a chat *product*
  rather than a chat *tab*, and every area-2 feature (multiple stories, archive, presets,
  alternate universes) falls out of it. Do it once, early, with Option A's consolidation
  as the first step so the migration lands in clean code.
- **Option C — full unification with the session engine.** Rebuild chat as a special kind
  of session (one character, no world) so both lanes share one pipeline. Assessed in the
  spec and **recommended against**: the session engine's weight (presence, perception,
  witness tracking, world merge) is exactly what chat deliberately doesn't carry; the
  recent "primary feature" work already made the two lanes share the layers worth sharing
  (memory, contracts, reaction curve); and the migration risk is far out of proportion to
  the wins. If chat one day needs a session-grade capability (say, director-style
  steering), port that one agent — not the lane.

## What this plan absorbs

To keep the roadmap honest, the following queued/parked items are folded in here rather
than run separately:

- **Codebase-review batch 3 (§D, chat-lane consolidation)** — entirely (area 8).
- **Codebase-review batch 2 (§C)** — the chat-side items only (archivist field miscount,
  chat summary/pulse prompt fixes, dialogue + intimate craft rules as they land in the
  chat lane; the session-side ports stay in batch 2).
- **Codebase-review batch 4 (§E)** — the chat-touching cleanups (component split, poll
  hook, model select, draft-seed, ownership helper on chat routes, stale comments).
- **RAG-improvements draft** — the chat-relevant retrieval ideas (relevance floor,
  per-query retrieval + fusion, supersedence by identity; the shared eval harness), built
  against chat first where they're easiest to observe.
- **Deferred / parked ideas graduating here**: relationship & meter timeline (chat-scale
  slice), transcript export, the summary plan's "rebuild summary" lever and fold-tuning
  leftovers, and the state/summary row-convergence cleanup.

Coordination note: the queued **intimacy-notes** plan is content authored for the intimate
tier; its design assumes the session lane's exposure machinery, which chat lacks. If it
ships first, this plan's craft work (area 3) must give chat an equivalent
moment-of-intimacy gate; the spec carries the detail.

## Suggested build order

Gated on the open questions below; a reasonable sequence once they're ruled:

1. **Foundations** (area 8, Option A work): engine extraction, de-forking, docs page,
   component split. Everything after gets cheaper. No visible product change.
2. **The conversation model** (area 2 schema + archive + Clear-chat replacement): the
   load-bearing migration, done while the code is freshly consolidated.
3. **The destination** (area 1): Chats page, full-screen conversation, entry points,
   mobile pass — the big visible payoff, built on the new model.
4. **In-the-moment controls** (area 3): another-take, go-on, stop, memory provenance.
5. **Craft & prompt intelligence** (area 3 remainder): rules, fixes, eval passes.
6. **Memory surface** (area 4): the panel, forget/pin/remember, open loops, retrieval
   floor.
7. **The living relationship** (areas 5 + 6): timeline, milestones, story-so-far,
   welcome-backs, "has something to say".
8. **Visual polish** (area 7): inline scene moments.

Slices 4–8 are individually shippable and reorderable by taste; 1→2→3 is the spine.

## Not in scope (this plan)

- **Locations, presence, items, wardrobe-as-state, story threads, the world simulation** —
  chat remains one character, location via narration only (standing ruling; but see the
  group-chat open question).
- **A new avatar/expression system** — parked by the rollback ruling; new plan when ready.
- **Voice (TTS / speech input)** — raised as an open question, expected answer "park".
- **Push notifications / server-initiated messaging** — "has something to say" is
  deliberately pull-based; anything push-shaped is a separate decision.
- **Monetization/billing-shaped concerns** (model cost controls beyond the existing
  curated lists).

## Open questions

Restated per convention; the spec carries the detail behind each.

1. **Chat's place in the app (area 1).** Own top-level destination with the editor keeping
   only a link — yes? And does the dashboard lead with chats once it exists?
2. **The memory ruling (area 2)** — the load-bearing one. When a second conversation with
   the same character starts, what does she remember? Recommended: per-conversation choice
   at creation — "continue our shared history" (shares the relationship-level memory) vs
   "fresh start" (clean slate) — implemented as memory groups under the hood.
3. **How deep the rebuild goes.** Option B (re-key around conversations) is recommended;
   Option A is the fallback if area 2 is descoped; Option C is assessed and not
   recommended. Confirm.
4. **Memory visibility (area 4).** Is a player-facing memory panel with forget/pin/remember
   desirable, or does exposing the machinery break the illusion? (Recommended: yes, but
   framed diegetically — "what they remember about you," not a database view.)
5. **Proactivity ceiling (area 6).** Is pull-based "has something to say" the right
   ceiling, or is true proactive messaging (notifications, scheduled openers) on the
   product's horizon? (Recommended: pull-based now.)
6. **Group chat.** The "one character, permanently" ruling predates chat-as-flagship. Does
   it stand, or should a 2–3-character world-less chat get an exploratory slice *after*
   this plan? (Not planned here either way; asking because the answer shapes the
   conversation model's headroom — a `participants` list costs little now and a lot
   later.)
7. **Voice.** Park TTS/voice-input entirely, or reserve a slot? (Recommended: park.)
8. **Roadmap placement.** Where does this sit relative to intimacy-notes and the remaining
   review batches? (The roadmap entry added with this plan is provisional, top of Next.)

## Related

- Spec: [character-chat-standalone.spec.md](character-chat-standalone.spec.md).
- Shipped family: [finished/character-chat.plan.md](finished/character-chat.plan.md),
  [finished/character-chat-summary.plan.md](finished/character-chat-summary.plan.md),
  [finished/character-chat-state.plan.md](finished/character-chat-state.plan.md),
  [finished/character-chat-scenario.plan.md](finished/character-chat-scenario.plan.md),
  [character-chat-sensory.plan.md](character-chat-sensory.plan.md),
  [character-chat-state-narration.plan.md](character-chat-state-narration.plan.md),
  [finished/character-chat-primary.plan.md](finished/character-chat-primary.plan.md) ·
  [finished/character-chat-primary.spec.md](finished/character-chat-primary.spec.md).
- Absorbed findings: [codebase-review.md](codebase-review.md) §C (chat items) / §D / §E
  (chat items); [RAG-improvements.plan.md](RAG-improvements.plan.md);
  [deferred.plan.md](deferred.plan.md) (#4 timeline, #8 export).
- Coordination: [intimacy-notes.plan.md](intimacy-notes.plan.md) (chat-side gating),
  [avatar-3d.plan.md](avatar-3d.plan.md) (rollback ruling; future avatar plan).
