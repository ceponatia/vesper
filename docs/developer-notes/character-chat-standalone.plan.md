# Character chat — the standalone experience — plan

Status: **draft** — first PM review folded in (2026-07-02): the rulings taken so far are
recorded in the spec's **## Decisions** section; the remaining open questions at the foot
still need rulings before this becomes buildable.

Design/decisions: [character-chat-standalone.spec.md](character-chat-standalone.spec.md) —
the technical detail (schemas, file touch-points, migration shape, refactor analysis,
rulings) lives there. This plan is written in plain English: what the feature should
become and why, area by area, so it can be read without knowing the codebase.

Builds on the whole shipped character-chat family — the original sessionless chat, the
rolling summary, the light state, the scenario setup, sensory cues, state-as-narration, and
the "primary feature" arc (long-term memory + evolving attributes). This plan is the next
chapter: chat stops being a very good tab and becomes a product surface in its own right.

## Why now

Character chat is the current product focus. The world/session experience has hit issues
that make it not fun and a lot of work to simply get running — above all NPC location
navigation, which has never been solved in a useful way: when a character isn't where you
are and can't easily be brought to you, the rest of the game is effectively
non-functional. Chat sidesteps that entire class of problem by making location pure
narrative flavor. It gives up some detail and machinery in exchange — and that trade is
worth it: if we flesh out a great character chat system, what we build and learn here
becomes the raw material for improving the world/session system later. Chat is the
proving ground, not the consolation prize.

## Where chat stands today

Character chat is a one-on-one conversation with any saved character — no world, no
session, location conveyed only through the writing. Under the hood it is already
surprisingly deep: the character has a persistent mood, energy, intimacy and intoxication
state that drifts between visits; a personality that is supposed to drive how they speak;
long-term memory (they remember facts about you and past scenes even hundreds of messages
later); attributes that can genuinely change over a long chat (a haircut sticks); a
scenario system (premise, outfit, taboo cards) for framing any situation; and scene images
that reflect the character's current state.

**An honest caveat from testing**: much of that depth is built but unproven. In the PM's
own play-testing, the personality sliders and the mood / energy / intimacy / intoxication
state have **not produced a noticeable effect** on how the character actually behaves.
Measuring that — and then tuning until the effect is unmistakable — is itself a headline
item of this plan (area 3), not an afterthought.

As a _product_, chat is still shaped like the developer test-bed it started as:

- It lives as **one tab buried inside the character editor** — a place shaped for
  authoring, not for the experience the engine can now deliver. On a phone (the natural
  home of a chat feature) it competes with seven editor tabs. Breaking it out of the
  character page is also what opens the door to **multi-character chats** later —
  conversations with a small group, distinct from worlds in some key ways (see Open
  questions).
- Each character has **exactly one conversation, forever**. The only lifecycle action is
  "Clear chat", which destroys everything — transcript, relationship, memory. There is no
  way to keep a finished story, start a fresh scenario alongside it, or come back to an
  old one. A conversation system of its own fixes this — and is the same structure that
  would host multiple chats per character or per group.
- The moment-to-moment controls are thinner than every comparable chat product. Today's
  single Rerun action was a quick fix for chats that broke; the goal is a **thorough
  edit-and-rerun toolset** — at least the session lane's parity (edit / delete / rerun any
  line) and beyond it: a different take on the character's reply, a nudge to continue
  unprompted, a clean stop mid-stream.
- The character's memory and tracked state are nearly invisible **even to us**. The dev
  inspector shows the last turn's trace, but there is no surface to see and edit
  _everything_ stored for a character and chat — which is exactly what tuning the systems
  above requires. (Ruled: these surfaces are for development, not players — the aim is
  memory and state good enough that players never think about them.)
- The relationship _number_ moves, but it is neither visible nor consequential — no
  history, no milestones, and in testing it doesn't noticeably change how the character
  behaves. That's partly because the systems that would _consume_ relationship status
  mostly don't exist yet. This plan builds the first real consumers (area 6).
- The character tracks **real-world** time between visits (they get rested, sober up), but
  that contradicts how the fiction should work: game time is not real time, and a player
  who steps away for a week should find the character exactly where they left off — no
  time passed. **In-game** time is what should affect behavior. The current hidden
  wall-clock drift needs to be rethought (area 7).
- Under the hood, chat grew feature-by-feature into a parallel mini-engine that forked
  pieces of the session engine instead of sharing them, and its orchestration lives in a
  web route instead of the engine. A real consolidation pass is expected and accepted —
  chat should be **its own feature with its own style**, sharing parts with the session
  lane where that's honest, never a toned-down copy of it.

## The vision

Chat is the lightest, most personal way to enjoy what Vesper is best at: a character who
feels like a person. Sessions are the full tabletop experience — worlds, casts, places.
Chat should be the **companion experience**: open the app, see your conversations, pick up
where you left off with someone who remembers you, looks the way your story left them, has
visibly grown closer (or cooler) over time, and greets a reopened scene naturally. It
should be the front door of the product, feel first-class on a phone — and everything
proven here (memory, personality enactment, relationship mechanics) feeds back into the
session lane later.

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
  whole experience; the editor remains the place you _author_, the Chats page the place
  you _play_.
- First-open experience: a fresh conversation offers the character's own greeting (the
  existing "Prompt character" opening beat) and a scenario suggestion instead of a blank
  box.
- Built with **multi-character headroom**: the new structure assumes a conversation _may_
  one day hold more than one character, even though this plan ships one-on-one only (see
  Open questions for what a group chat would even be).

### 2. Conversations, plural

One character should support many stories:

- **Multiple named conversations per character** — e.g. a long-running "main" story plus a
  fresh "what if we met as strangers" scenario — each with its own transcript,
  relationship state, premise and outfit.
- **Archive instead of destroy**: finishing or abandoning a conversation shelves it
  (readable later, restorable), replacing today's all-or-nothing Clear chat as the everyday
  action. A true delete remains available.
- **Memory that respects the fiction**: when starting a new conversation you choose
  whether it _continues the shared history_ (the character remembers everything you've
  built) or is a _fresh start / alternate universe_ (clean memory, the relationship starts
  where the scenario says). This is the load-bearing design choice of the whole plan — see
  Open questions.
- **Scenario presets**: save a scenario setup (premise + outfit + cards + starting
  relationship) as a reusable, nameable preset, so a favorite setup is one tap on any new
  conversation — and potentially shareable like other library content later.

### 3. Prove the depth shows

The engine tracks a lot; the writing must visibly reflect it, and today we can't say it
does. Before (or alongside — see Open questions) building more features on top:

- **Measure**: behavioral evaluation scenarios that compare the same conversation with a
  system on vs. off — state on/off, personality sliders at opposite extremes, relationship
  at stranger vs. lover, sober vs. drunk — judged blind. If a reader can't tell which is
  which, the system isn't working, however elegant its internals.
- **Tune until unmistakable**: iterate the prompt wording (and, where wording isn't
  enough, the mechanics) until the differences are obvious in normal play, then keep the
  scenarios as a permanent regression harness so future changes can't quietly flatten the
  character again.
- This graduates the parked personality-enactment follow-up ("measure whether slider
  extremes visibly diverge") and gives every later area (relationship mechanics, time,
  craft rules) the same yardstick.

### 4. Better writing in the moment

The controls every mature chat product has, plus craft-level prompt work:

- **A thorough edit-and-rerun toolset** (session parity and beyond): edit or delete any
  line, rerun from any of your lines, **another take** on the character's last reply (keep
  the takes you've seen and flip between them before continuing), **go on** (the character
  continues unprompted), and **stop** (cancel a reply mid-stream cleanly).
- **Craft rules** ported/fixed from the codebase review: dialogue that sounds like speech
  (fragments, interruptions, subtext, silence as an answer), guidance for intimate scenes
  (pacing held to the player's pace, body/clothing continuity, concrete sensation over
  florid abstraction), and a handful of known prompt bugs that make the background agents
  under-perform (an agent prompt that miscounts its own fields, a summarizer that
  addresses "you" in a third-person summary, a classifier with no worked example).
- One quiet correctness fix: editing or deleting a poisoned message today cleans the
  transcript but **not** the memories already extracted from it; rerun and
  another-take need the same guarantee. Memories get tied to the message they came from so
  removing one removes the other.

### 5. Memory quality — and a complete dev inspector

Ruled: memory/state surfaces are **development tools, not player features** — the goal is
to test and perfect memory until players never have to think about it. So:

- A **complete dev inspector**: see and edit _every_ stored item for a character and chat
  — remembered facts, episode summaries, the rolling summary, the state row, evolving
  attribute overlays — not just the last turn's trace. View, edit, delete, and pin
  (force-include) anything, so tuning sessions can reproduce and fix memory misbehavior
  directly.
- **Open loops**: the character keeps track of unfinished business ("she promised to tell
  you about her sister") so long conversations get narrative pull, not just recall.
- **Retrieval quality**: apply the already-drafted retrieval improvements that matter most
  for chat (a relevance floor so irrelevant memories stop leaking in; better merging of
  duplicate memories; per-query retrieval) — shared work that also benefits sessions.
- One small player-facing candidate survives as an open question: **"remember this"** —
  telling the character something to hold onto, without ever browsing the memory store.

### 6. A relationship that matters

Make the arc both visible and consequential — today it is neither:

- **Consequential first**: relationship stage should actually change behavior — how
  forward or guarded the character is, what they'll initiate, what they'll go along with,
  how they greet you, what escalation they accept or deflect. These are the first real
  _consumers_ of the number the engine already tracks; whether stages act as hard gates
  (the character declines below a stage) or strong coloring — or both — is an open
  question.
- **Then visible**: a relationship panel with the current stage, how it has moved over
  time (a simple timeline), and **milestones** — first meeting, stage changes, memorable
  beats — pulled from what the engine already records. (This graduates the long-parked
  relationship-timeline idea, at chat scale first.)
- The **story so far**: a readable recap of the conversation's history so returning after
  weeks doesn't require rereading hundreds of messages.
- Transcript **export** (long-parked) fits naturally here: take your story with you.

### 7. In-game time, not wall-clock time

Ruling: **real-world time never passes in the fiction.** A player who steps away for a
week returns to a character for whom no time has passed. In-game time is what should
affect behavior. Concretely:

- **Rethink the hidden drift**: today the character's meters recover based on real elapsed
  time between visits — that contradicts the ruling and should be replaced (or at minimum
  demoted; see Open questions) by in-game time.
- **Time skips as a player choice**: when reopening a conversation (or at any point), the
  player chooses whether fictional time passes — _continue the scene_, _later that day_,
  _the next morning_, _weeks later_. The choice advances the in-game clock, drives meter
  recovery (she sobers up overnight, not over your lunch break), and licenses the
  character to acknowledge the gap in-fiction ("morning — sleep well?").
- **A life meanwhile** (light touch): when a skip happens, one line of "what she's been up
  to" consistent with premise and personality — texture, not simulation.
- **They have something to say**: on the Chats page, a character with unfinished business
  (an open loop, an unseen milestone) can show a subtle marker; tapping it lets them open
  the conversation about the right thing. Approved as an experiment — it's pull-based (no
  notifications, computed only when you open the app) and keyed to the fiction, never the
  wall clock.

### 8. The visual layer

- **Scene moments in the transcript**: images generated at meaningful beats appear inline
  in the conversation where they happened (not only in a strip above), making a long chat
  feel like an illustrated story. Generation stays player-triggered by default, with an
  optional "auto at big moments" setting.
- The **portrait panel** stays (post-rollback) as the character's steady presence. The
  mood-reactive avatar idea remains good and will be re-addressed in the future — the
  rolled-back implementation simply felt bad and offered too little. Any new approach gets
  its own plan; chat will be its natural first home. Not re-attempted here.

### 9. One solid engine under it

The invisible slice that makes everything above cheaper and safer (absorbing the
chat-lane parts of the codebase-review follow-on batches). Significant refactoring here is
expected and accepted — chat becomes truly its own feature:

- Move chat's turn orchestration out of the web route into a proper engine module, the way
  sessions already work.
- Stop maintaining forked copies of session machinery (the reaction curve, the timeout
  helper, the streaming plumbing) — share one implementation where sharing is honest.
- Fix the background-job wrinkle that can leave a chat scene image stuck "running" forever
  after a crash.
- Split the oversized chat screen component; reuse the app's shared polling/model-select/
  draft primitives.
- Correct the handful of stale internal comments that still describe the pre-memory chat.
- Write the missing **`docs/character-chat.md`** system page so the next person (or agent)
  touching chat has the same map sessions have.

## How deep the rebuild goes — ruled

Three options were assessed; the PM has ruled for **Option B** (spec **Decisions** D1):

- **Option A — consolidate in place** (area 9 only, no schema change): now the _first
  step_ of Option B rather than a destination.
- **Option B — re-key around "a conversation"** (**chosen**): introduce a real
  conversation record and hang transcript, state, summary and (per the memory ruling)
  memory off it — with multi-character headroom built into the structure. The biggest
  single piece of work in the plan, done once, early, in freshly consolidated code. Chat
  becomes truly its own feature with its own style choices — elements shared with the
  session lane where honest, never a toned-down copy.
- **Option C — full unification with the session engine**: assessed and **rejected**
  (analysis stays in the spec §9). If chat ever needs a session-grade capability, port
  that one agent — not the lane.

## What this plan absorbs

To keep the roadmap honest, the following queued/parked items are folded in here rather
than run separately:

- **Codebase-review batch 3 (§D, chat-lane consolidation)** — entirely (area 9).
- **Codebase-review batch 2 (§C)** — the chat-side items only (archivist field miscount,
  chat summary/pulse prompt fixes, dialogue + intimate craft rules as they land in the
  chat lane; the session-side ports stay in batch 2).
- **Codebase-review batch 4 (§E)** — the chat-touching cleanups (component split, poll
  hook, model select, draft-seed, ownership helper on chat routes, stale comments).
- **RAG-improvements draft** — the chat-relevant retrieval ideas (relevance floor,
  per-query retrieval + fusion, supersedence by identity; the shared eval harness), built
  against chat first where they're easiest to observe.
- **Personality-enactment follow-up** — the parked "measure whether slider extremes
  visibly diverge, and re-tune" item graduates into area 3.
- **Deferred / parked ideas graduating here**: relationship & meter timeline (chat-scale
  slice), transcript export, the summary plan's "rebuild summary" lever and fold-tuning
  leftovers, and the state/summary row-convergence cleanup.

Coordination note: the queued **intimacy-notes** plan is content authored for the intimate
tier; its design assumes the session lane's exposure machinery, which chat lacks. If it
ships first, this plan's craft work (area 4) must give chat an equivalent
moment-of-intimacy gate; the spec carries the detail.

## Suggested build order

Gated on the remaining open questions; a reasonable sequence once they're ruled:

1. **Foundations** (area 9, the Option-A step): engine extraction, de-forking, docs page,
   component split. Everything after gets cheaper. No visible product change.
2. **Measurement baseline** (area 3): the eval scenarios and first blind-judged runs — can
   start in parallel with 1 (the harness already exists) and its findings steer slices
   5–7.
3. **The conversation model** (area 2 schema + archive + Clear-chat replacement, with
   multi-character headroom): the load-bearing migration, done in clean code.
4. **The destination** (area 1): Chats page, full-screen conversation, entry points,
   mobile pass — the big visible payoff, built on the new model.
5. **In-the-moment controls** (area 4): the edit/rerun toolset, another-take, go-on, stop,
   memory provenance.
6. **Craft & tuning** (areas 3+4 remainder): prompt fixes and rules, iterated against the
   measurement harness until the depth shows.
7. **Memory quality + the dev inspector** (area 5).
8. **The living relationship & in-game time** (areas 6 + 7): stage-driven behavior, the
   timeline, time skips, open-loop markers.
9. **Visual polish** (area 8): inline scene moments.

Slices 5–9 are individually shippable and reorderable by taste; 1→3→4 is the spine, with 2
running alongside.

## Not in scope (this plan)

- **Locations, presence, items, wardrobe-as-state, story threads, the world simulation** —
  chat remains location-free by design; that is its whole advantage.
- **Group chat as a shipped feature** — this plan ships one-on-one only, but the new
  conversation structure is built with multi-character headroom (see Open questions).
- **A new avatar/expression system** — parked by the rollback ruling; the idea stays alive
  and gets its own plan when re-approached.
- **Voice (TTS / speech input)** — open question, expected answer "park".
- **Push notifications / server-initiated messaging** — "has something to say" is
  deliberately pull-based; anything push-shaped is a separate decision.
- **Monetization/billing-shaped concerns** (model cost controls beyond the existing
  curated lists).

## Open questions

Restated per convention; the spec carries the detail behind each. Rulings already taken
(Option B; dev-only memory surfaces; in-game-time principle; proactivity experiment;
avatar parked; chat as current focus) are recorded in the spec's **## Decisions**.

1. **Memory across conversations (still the load-bearing one).** When a second
   conversation with the same character starts, what does she remember? Recommended:
   per-conversation choice at creation — "continue our shared history" vs "fresh start" —
   implemented as memory groups. Group-chat headroom raises the stakes: memory should
   belong to the _character relationship_, not the conversation, so a character can carry
   what she knows into a future group scene.
2. **The time model, concretely.** The principle is ruled (in-game time only). Does the
   wall-clock drift get **removed outright** in favor of player-chosen time skips
   (recommended), or kept as a hidden convenience until skips prove themselves? And should
   a reopened conversation _ask_ ("continue the scene / later / next day") or default to
   "continue" with the skip available in a menu (recommended: default continue, one-tap
   skip)?
3. **What is a group chat, to you?** You noted multi-character chats "would differ from
   worlds in some key ways" — which ways matter most (e.g. no locations/movement, characters
   talking to _each other_ freely, lighter setup, player as pure participant)? Not building
   it here, but the answer shapes the headroom being reserved (participant list, per-
   character state, turn-taking assumptions).
4. **Measure first, or build alongside?** Given testing shows no noticeable
   state/personality effect today, should the measurement baseline (area 3) gate the
   feature slices (fix enactment before building consumers on top), or run in parallel and
   steer as it learns (recommended)?
5. **Relationship teeth.** What should stage actually gate? Recommended: strong coloring
   everywhere (initiative, warmth, address forms) plus a few hard gates on intimate
   escalation below a stage floor (deflected in character, overridable by an explicit
   scenario premise). Confirm the hard-gate part — it changes how refusals read.
6. **"Remember this."** With memory browsing ruled dev-only: does the lightweight
   player-side "remember this" (tell the character something to keep, no browsing)
   survive, or is all memory interaction dev-only for now?
7. **Dashboard.** Once the Chats page exists, does the home dashboard lead with
   conversations ("Continue talking to…") ahead of worlds/sessions?
8. **Voice.** Park TTS/voice-input entirely, or reserve a slot? (Recommended: park.)

## Related

- Spec: [character-chat-standalone.spec.md](character-chat-standalone.spec.md) (includes
  the **Decisions** record).
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
  [personality-enactment.plan.md](personality-enactment.plan.md) (measurement follow-up);
  [deferred.plan.md](deferred.plan.md) (#4 timeline, #8 export).
- Coordination: [intimacy-notes.plan.md](intimacy-notes.plan.md) (chat-side gating),
  [avatar-3d.plan.md](avatar-3d.plan.md) (rollback ruling; future avatar plan).
