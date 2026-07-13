# Roadmap

The single ordered index of development plans. **Order here is the only place
priority lives** — reprioritizing is a one-line move, never a file rename (see
`CLAUDE.md` → working-docs convention, and [deferred.plan.md](deferred.plan.md)
§"Plan docs: drop hard phase numbers").

Status legend: **draft** (not settled) · **next** (queued) · **active** (in
progress) · **shipped — <date>** · **parked**.

> Order is priority, top-down. Each entry links its plan; the plan links its
> spec/detail.

## To be Planned

This section is for the product owner to add ideas for features and improvements. AI agents
must _not_ add anything to this section. AI agents _may_ remove items from this section once
they have incorporated them into the roadmap below and either created a new plan or updated
an existing plan that will include this work.

_(Currently empty — the two character-chat ideas that were here graduated to plans on
2026-06-30; see the top of **Next** below.)_

## Active (building now)

_(nothing — pull the next entry from Next)_

## Next (queued)

- **Chat action beats** — [chat-action-beats.plan.md](chat-action-beats.plan.md)
  (next — spawned 2026-07-13 from the UX batch's slice-4 ruling). The four chat
  action chips stop being silent deterministic state nudges: a chip tap becomes
  a server-cued exchange the narrator plays as a real beat, deterministic
  effect kept.
- **Chat wardrobe parity** —
  [chat-wardrobe-parity.plan.md](chat-wardrobe-parity.plan.md) (next — ruled
  2026-07-13; depends on the UX batch's outfit presets). Chat wardrobe reaches
  full session parity in three rungs: preset-as-state, item-level worn list
  with computed exposure (the session classifier reused), equip/unequip UI in
  the chat character sheet. First concrete step of the **chat-as-test-bed
  direction** (see `CLAUDE.md`).
- **Intimacy notes** — [intimacy-notes.plan.md](intimacy-notes.plan.md) · spec
  [intimacy-notes.spec.md](intimacy-notes.spec.md) (design settled — all seven
  questions ruled 2026-07-13). Third species/heritage
  note (`intimacy`) + per-character disposition, surfaced to the narrator only at
  the intimate exposure tier. Standalone — builds on the shipped species note split +
  the phase-4 exposure mask; feeds mood's intimacy-beat inputs but doesn't gate them.
- **Attribute narrator guidance — per-value glosses + vocabulary audit** —
  [attribute-narrator-guidance.plan.md](attribute-narrator-guidance.plan.md) (next —
  design settled 2026-07-08). Optional `narratorGuidance` map on enum attribute
  definitions, rendered inline like disposition bands so the narrator knows what
  `willowy` means *here*; strict orthogonality rule (a gloss never describes another
  attribute's dimension) + an entangled-vocabulary audit (rename members like
  `willowy` that bake in height) with a stored-value sweep.
- **Visual world map** — [world-map.plan.md](world-map.plan.md). Slice 1 (read-only
  force-directed graph) shipped 2026-06-18; slices 2–3 (editable layout, play-screen
  minimap) remain — optional polish on a feature already delivering its core value.
- **World simulation ("the world moves")** — the former "phase 5" cluster, not
  yet started, and now **direction-dependent**: character chat is the test bed
  for what the world/session model will eventually look like (owner direction
  2026-07-13 — see `CLAUDE.md`), so the movement-authority and
  scheduled-arrivals specs were retired (deleted) 2026-07-13 rather than built
  against the possibly-deprecated session model.
  [pre-narrator-agents.spec.md](pre-narrator-agents.spec.md) remains as
  findings (its intake half shipped). A future `world-simulation.plan.md` — or
  the chat-successor equivalent — re-derives what it needs when this becomes
  active.
- **RAG improvements** — [RAG-improvements.plan.md](RAG-improvements.plan.md)
  (draft; seven retrieval ideas under evaluation — the least-settled item here).
- **At-rest encryption — user chat content unreadable on Neon** —
  [at-rest-encryption.plan.md](at-rest-encryption.plan.md) (draft — planned
  2026-07-11 from an owner question; position here is provisional). App-side
  AES-256-GCM envelopes over both lanes' transcripts, memory rows, and derived
  sinks so Neon holds only ciphertext (key in Fly secrets); the load-bearing
  open ruling is D1 — encrypt fact/episode embeddings and move scoped
  similarity ranking app-side, since plaintext embeddings are invertible.
- **Codebase-review follow-on batches (2 & 4, session-side remainder)** — findings
  [codebase-review.md](finished/codebase-review.md) §C–E; no plans yet (each needs its
  `<topic>.plan.md` when it becomes active): **prompt intelligence** (§C — session-lane
  cast voices, content-framing/no-refusal port, intimate + dialogue craft rules for the
  session lane, forge upgrades), **dedup & cleanup sweep** (§E — non-chat items).
  **Batch 3 (§D chat-lane consolidation) and the chat-side items of §C/§E are absorbed
  into [finished/character-chat-standalone.plan.md](finished/character-chat-standalone.plan.md)** (top of
  this list). Sequenced after batch 1 per the 2026-07-02 agreement; where the remainder
  slots versus the feature work above is the author's call.

## Someday / parking lot

Unpromoted ideas live in [deferred.plan.md](deferred.plan.md): the relationship &
meter timeline (UX-audit #4), the full **NPC-puppeting** system
([npc-puppeting.deferred.md](npc-puppeting.deferred.md) — only Slice 2's deflection
directive shipped), comms expansions, item acquisition during play, the remaining
UX-audit deferrals (transcript export #8, scene-image pin #9, first-run tour #10,
production-build perf pass §5), observer / god-mode POV, monorepo split (permanently
deferred), and companion-role-as-romance-eligibility (park, don't build).

## Shipped (historical record — newest first; see each plan for detail)

- **Chat supporting cast + narrator input** —
  [chat-supporting-cast.plan.md](chat-supporting-cast.plan.md) — 2026-07-13 —
  recurring named side characters as a lightweight scenario tier (scene-memory
  pattern applied to people: `supporting_cast` on the chat scenario, archivist
  field 10 with roster/player exclusion, the volatile-tail cast block + rule
  3/16 carve-outs, the Supporting Cast panel + lightbox editor), plus the
  composer **You ↔ Narrator** toggle (`inputMode: "narrator"` — story
  narration that never reads as the player's POV; pulse skipped,
  storyteller-labeled extraction). Deferred: cast images, promote-to-character.
- **UX improvements — chat, item library, character form** —
  [ux-improvements.plan.md](ux-improvements.plan.md) — 2026-07-13 — all nine
  slices in one day: clone wiring + stale-copy fix, chat transcript keyset
  pagination + jump-to-latest, the status-strip outfit chip + roster outfit
  lines, admin-gated sheet debug traces, the item ✦ draft-from-description
  assist (registry-grounded, carve-outs included), item delete in-use warnings
  + read-only public items/locations, the editor **autosave** refactor
  (create-on-new placeholders, save-on-change/blur, forge-draft review
  preserved; world editor exempt — its save forges) + attribute-accordion
  value summaries, **named outfit presets** replacing `defaultOutfit` (lazy
  lift, preset switcher, archivist preset matching, rhythm auto-dress on time
  skips), and the polish batch. Spawned: chat-action-beats +
  chat-wardrobe-parity (Next).
- **Sensory grounding** — [sensory-grounding.plan.md](sensory-grounding.plan.md) —
  2026-07-12 — the chat Sensory-focus block now joins the player's targeted body
  region to that region's own authored attributes (sense-ranked — "I lick her foot"
  finally surfaces `feet.smell`), directs the narrator to OPEN the reply with the
  sensation itself, forbids verbatim value echoes, degrades an ungrounded focus to
  the close-range allowance, and sense-gates `.scent`/`.smell`/`.taste` id suffixes
  in the session lane whatever their category.
- **Forge gaps** — [forge-gaps.plan.md](forge-gaps.plan.md) — 2026-07-12 — the forge now
  drafts the starting relationship + personal social cards from the concept; a
  `renderVisual` attribute tier keeps scene renders consistent; secret reveal gates
  ceiling mid-arc; drive caps truncate (with editor counters) instead of clipping
  silently; the narrator stripper cuts trailing "Note for the parser" blocks.
- **Story-thread lifecycle guards** — no plan (two small fixes from the 2026-07-08
  docs-accuracy audit) — 2026-07-12 — the thread reducer now gates `resolve` to
  `investigation` kind (`merge.thread.resolve_blocked` diagnostic; ruled: the admin
  manual-close route archives ongoing threads instead) and touch/develop/propose
  only match live (open/cooling) threads by id or title, so a closed thread can
  never be revived (a same-title propose opens a fresh thread). See
  [../story-threads.md](../story-threads.md).
- **Chat initiative — the remainder slices (plan complete)** —
  [chat-initiative.plan.md](chat-initiative.plan.md) — 2026-07-12 — the §8.4 v2
  marker (unseen-milestone seen-cursor `milestones_seen_at`, migration 0043 —
  ruled: loops + milestones only, never real time), light `profile.schedule`
  authoring (day-part vocabulary, the Profile tab's Daily-rhythm card, the
  forge section, the opener's rhythm line), and the opener selfie (the
  "thinking of you" photo — register-conditional license + the opener-scoped
  pulse's `sentPhoto` read).
- **Character drives — the authoring surface (plan complete)** —
  [character-drives.plan.md](character-drives.plan.md) — 2026-07-12 — the forge
  profile leg drafts drives (concept-led ≤1 secret, band-validated reveal gates
  — rulings), the Disposition tab's "Desires & secrets" card, Forge-the-rest
  additive fill up to the 3-cap + Disposition re-draft coverage, and the
  `chat-secret-hold`/`-reveal` fixtures (`secretCue` metric; live judged run
  rides the owner-gated enactment measurement run —
  [deferred.plan.md](deferred.plan.md) §Owner-gated live eval runs).
- **Foot coverage sub-parts** — registry data edit (no plan; direct owner request) —
  2026-07-12 — `feet` splits into `toes` · `top of foot` · `sole` · `heel` so
  footwear can carve holes (peep-toe, strapped sandal, flip-flop). Footwear's
  `["feet"]` template still auto-covers the whole foot via expand; the exposure
  classifier (`items/visibility.ts`) now reads any covered foot part as shod, so
  a sandal isn't mislabelled "barefoot". See `docs/contracts/body.md` +
  `items.md` §Coverage editing.
- **Multi-character & forge wrap-up — the owner-rulings pass (all 13 rulings)** —
  [multi-character-chat.followups.md](finished/multi-character-chat.followups.md) — 2026-07-12 —
  forge re-draft = full tab re-sync + the portrait review dialog; preset
  relationship records, the matrix player column, third-person pair law; the
  chat-wide/per-character schema split (scenario on the chat row — migrations
  0041/0042), per-member note-takers + deterministic folds, group-scene
  selfies/callbacks/sensory-focus/enactment, per-character sheets +
  `?characterId=` state targeting.
- **Multi-character chat — the substrate (all four slices)** —
  [multi-character-chat.plan.md](finished/multi-character-chat.plan.md) — 2026-07-12 —
  a conversation holds up to 4 full characters: roster routes + panel,
  per-character state with presence + activity recency (migration 0037), the
  one-block ensemble prompt frame (roster-of-1 byte-identical, asserted),
  player-owns-himself authority + cutaways, away-freeze, referenced-only pulse,
  tier-1 per-member memory legs, witness memory writes, archivist presence
  confirmation. Substrate simplifications recorded in the plan.
- **Relationship model v2 — familiarity × regard (complete; slice 6 matrix)** —
  [relationship-model.plan.md](finished/relationship-model.plan.md) — 2026-07-12 —
  the matrix: `character_chat_relationships` + library-default
  `character_relationships` (migration 0038), creation/join seeding, the
  in-chat pair editor (shared-cell, mirrored stances, asymmetric toggle), the
  character editor's Relationships tab, presence × salience tier injection
  with the don't-teleport guard. Slices 1–4 shipped 2026-07-07. Leftovers
  (preset band pickers, third-person pair-law port, multi-char eval fixtures)
  + the slice-7 sessions earmark are recorded in the plan.
- **Library UX — the follow-up pass** —
  [library-ux.plan.md](finished/library-ux.plan.md) — 2026-07-12 — facets for the other
  libraries (characters species/gender/world-usage, locations scale/world-usage,
  social-card tier/trigger), the tabbed Gallery image hub (scenes/portraits/
  entity art, view modes, avatar chip filters, favorites migration 0036,
  multi-select delete, keyset paging past the 500 cap), the Library nav hub
  (Chats · Worlds · Library · Gallery + shared collection tab strip), and the
  scope+sort fast-follow (every shareable list API honors `?scope`/`?sort` —
  both were silent no-ops). Leftover: list keyset pagination waits for real
  catalog scale (recorded in the plan). Core pass shipped 2026-07-08.
- **Character sheet forge — in-sheet completion, per-tab re-drafts,
  portrait-derived attributes** —
  [character-sheet-forge.plan.md](finished/character-sheet-forge.plan.md) —
  2026-07-12 — the editor's ✦ Forge-the-rest fills every empty field without
  touching player-authored content (save-first, result lands unsaved for
  review); per-tab ↻ Re-draft rewrites one tab narrator-formatted from the
  whole sheet (`manual` values kept, conflicts reported); ◉ From-portrait
  derives appearance attributes from the avatar via the codebase's first
  vision capability. Built + deployed 2026-07-09; owner live review passed
  2026-07-12. Leftovers: the two report-only conflict flips stay in the plan's
  §Open questions, flip on request.
- **Chat initiative — the reopen opener (core)** —
  [chat-initiative.plan.md](chat-initiative.plan.md) — 2026-07-12 — the pickup
  strip's "Let {who} start ✦" runs a continue exchange with a server-built cue
  (`chat-initiative.ts`): her own material (loops + non-secret wants), the "a
  life meanwhile" license folded in (no separate life-event agent — build
  decision, D8-safe), the comms-when-apart register, one-beat restraint. D3
  held: player-tapped only, marker stays loops-keyed. Remainder shipped later
  the same day — see the entry above.

- **Character drives — engine core (desires & secrets as gated inner life)** —
  [character-drives.plan.md](character-drives.plan.md) — 2026-07-11 — ≤3
  authored wants (`profile.drives` + runtime state, migration 0035) rendered
  as tail LAW: open steers, guarded withholds-until-asked, a secret below its
  gate (default familiarity ≥ familiar, ruled) is protected with the ruled
  full-but-scoped lie license and flips to an invited reveal at the gate;
  archivist `driveUpdates` (8th field) tracks progress/reveal/resolve, a
  reveal lands the new `secret_shared` milestone (❖, callback-boosted), and
  the panel lists open wants + revealed secrets only (ruled). The remainder
  (authoring surface + eval fixtures) shipped 2026-07-12 — see the entry above.
- **Chat scene references — current-look and place anchors** —
  [chat-scene-references.plan.md](finished/chat-scene-references.plan.md) — 2026-07-11 —
  chat renders anchor on an outfit-true `chat_look` (identity-locked edit,
  keyed by outfit+exposed+overlays, keep-latest, minted on archivist changes in
  image-active chats — rulings) instead of the always-dressed avatar; scene-
  memory places get lazily-minted `chat_place` establishing shots, and chat
  scenes go multi-reference (look + place) through the previously-unused
  multi-edit rung. Cache = the images table (`meta.lookKey`); no migrations.
  Docs: character-chat.md §Scene reference anchors, images.md.
- **Social-card tag-override editor + character editor re-tab** — no plan
  (owner one-off, 2026-07-11) — full override rows on `SocialCardFields`
  (free-form tag with canonical datalist, kind, optional intensity, hint) with
  `normalizeTag`-insensitive matching in `resolveCardForTags`; likes/dislikes
  (new `PreferencesEditor`) + the social-cards editor moved Disposition →
  Personality tab for room (the `disposition` re-draft scope still owns
  preferences — noted in `lib/character-scopes.ts`). Docs: authoring.md,
  guide/social-cards.md.
- **Chat selfies — character-sent photo messages** —
  [chat-selfies.plan.md](finished/chat-selfies.plan.md) — 2026-07-11 — the character
  sends photos back: `SELFIE_FRAMING` (the player-POV rule inverted), always
  the identity-locked reference route (ruled), player-request regex +
  apart-only unprompted offers (ruled — comms register = the texting signal;
  `selfie_history` cooldown ring, migration 0034), queue decided post-turn by
  the pulse's `sentPhoto` read so declines stay declines, and the ruled
  retry-once policy (content rejection retries sanitized; second failure = a
  "Failed" transcript placeholder enlarging to the sent prompt). Docs:
  character-chat.md §Selfies, images.md, prompts.md.
- **Chat image input — player-sent photos the character sees** —
  [chat-image-input.plan.md](finished/chat-image-input.plan.md) — 2026-07-11 — up to 4
  photos per message (owner ruling: multi-image now): composer attach + canvas
  downscale → `chat_upload` assets (input-only, Gallery-hidden, hard-deleted
  with message/chat), ONE batched vision read persisted on message meta
  (regenerate never re-spends; degraded reads retry), a fenced seen-channel
  tail block + static rule 17 (owner ruling), pulse/archivist see the reads,
  photo-only sends allowed. No migration. Docs: character-chat.md §Player
  photos, images.md, prompts.md.
- **Emotional weather — persistent feeling, regard momentum, reply pacing** —
  [emotional-weather.plan.md](finished/emotional-weather.plan.md) — 2026-07-11 — a
  pulse-proposed persistent `feeling` (curve-derived intensity, exchange-decayed,
  composed with the meter mood line — owner rulings: compose; ~10-exchange bruise;
  new `apologize` concept halves it; damped ±10% curve feedback), warmth-streak +
  bruise momentum on regard (`chat-feeling.ts`, migration 0033, trace `regardScale`),
  and the UI reveal-hold pacing (`lib/chat-pacing.ts`). Leftover: the live judged
  `mt-chat-feeling-hurt` run (owner-gated spend). Docs: character-chat.md
  §Emotional weather, prompts.md.
- **Memory callbacks — unprompted "remember when" beats** —
  [memory-callbacks.plan.md](finished/memory-callbacks.plan.md) — 2026-07-11 — a
  lull-gated, once-per-~10-exchanges tail cue offering one old, milestone-boosted,
  topic-distant episode, worded by regard band (warm nostalgia / plain / pointed —
  owner ruling); `callback_history` anti-repeat ring (migration 0032), degrades to
  a plain turn with `chat_memory.callback.failed`. Leftover: the live judged eval
  run (owner-gated spend). Docs: character-chat.md §Memory callbacks, prompts.md.
- **Chat scene-model picker — hot-swap dropdown on the scene strip** —
  `contracts chatSceneModels` + `character_chat_state.scene_model` (migration 0031)
  (no plan — owner request) — 2026-07-11 — a save-on-select dropdown left of
  Generate scene, persisted per conversation: "Avatar reference" keeps the
  identity-locked Qwen edit; picking a Venice t2i model (Chroma/Lustify/…)
  renders that scene text-to-image without the avatar (the only real model swap
  Venice offers — its edit family is Qwen-only). Docs: images.md §Scene images,
  character-chat.md §API, ui.md §Scene images.
- **Chat starting-outfit seed — garment phrase, not item ids** —
  `engine/chat-state.ts` + `images/avatar.ts`
  ([chat-scene-fidelity.plan.md](finished/chat-scene-fidelity.plan.md) §Seed fallback followup;
  owner report) — 2026-07-11 — the blank-Starting-Outfit fallback joined
  `profile.defaultOutfit` raw item ids into the scenario text, so the narrator ignored
  the outfit and the modal showed ids. The pure seed now writes the id-join as a marker
  and every IO-capable consumer resolves it to the readable phrase
  (`resolveSeededOutfit` → `defaultOutfitPhrase`: occlusion-filtered, subtype-led,
  description + sensory appearance); pre-fix stored rows self-heal on load, failed
  lookups degrade to composer inference.
- **Chat dialogue attribution — side-NPC quotes no longer wear the character's chip** —
  `lib/segmenter.ts` + chat rule 3 (no plan — small fix, owner report + screenshot) —
  2026-07-11 — a reply that uses a `[Name]` tag anywhere is tag-disciplined: its
  untagged whole-line quotes stay narrator prose (a side NPC's own quoted paragraph,
  the Amanda case) instead of auto-attributing to the sole character; tag-free replies
  keep the one-on-one auto-attribution. Prompt rule 3 now requires tagging every
  character line once any line is tagged, and in-prose attribution (never a bare
  quoted paragraph) for anyone else. Render-time only — stored transcripts re-render
  correctly. Docs: prompts.md §Dialogue tagging, character-chat.md §9.
- **Face jewelry, accessory subtypes & the attribute-form accordion** —
  [face-jewelry-and-attribute-form.plan.md](finished/face-jewelry-and-attribute-form.plan.md)
  — 2026-07-11 — lips/nose body locations; jewelry/headwear/eyewear subtype
  vocabularies (prompt-bearing, coverage templates) in the item form, classify
  pass and image/narrator prompts; nose + lip piercing attributes; registry
  defaults stored at blank creation; the attributes tab's single-open
  show-all-fields accordion.
- **Narrator tandem-repeat collapse** — `src/server/ai/narrator-repeats.ts` (no plan —
  small fix, owner report) — 2026-07-11 — Aion 3.0 sometimes re-emits its whole reply
  (or its trailing paragraphs) verbatim after a blank-line gap; both narrator lanes now
  compose `collapseRepeatedBlocksStream` after the wrapper-tag stripper, so the duplicate
  never reaches the live feed, the persisted row, or the history context. Deliberately
  narrow: paragraph-aligned, whitespace-insensitive verbatim suffix repeats only —
  paraphrased near-repeats and short stylistic echoes pass through.
- **Chat scene fidelity — outfit tracking, location sketches, identity anchors** —
  [chat-scene-fidelity.plan.md](finished/chat-scene-fidelity.plan.md) — 2026-07-10 — the
  archivist's 7th field tracks outfit changes into chat state (seeded from the character
  form when Starting Outfit is blank); scene memory + a background `chat_scene_sketch`
  agent replace the image's placeholder room; whitelisted identity anchors reinforce the
  reference-avatar lock.
- **Narrator prompt consolidation — external-review response, all six slices** —
  [narrator-prompt-consolidation.plan.md](finished/narrator-prompt-consolidation.plan.md) —
  2026-07-10 — the accepted points of the external GPT prompt review, implemented
  with rollback comments at every replaced line: per-shape chat length story
  (`chatLengthStory` — kills the aggressive_concise vs three-paragraph-baseline
  contradiction), NPC initiative licensed-not-mandated + trait/age quota softened
  (both lanes; validation rides the owner-gated enactment measurement run —
  [deferred.plan.md](deferred.plan.md) §Owner-gated live eval runs),
  scene-consistent incidental people, the deterministic per-turn **chat sensory
  allowance** (`deriveChatSensoryAllowance` + one binding tail line; rules 11–12 and
  the cue-invite sensory arms collapsed into it), the intake `react_emotionally` →
  `acknowledge_emotional_beat` rename, the experimental `CHAT_PROMPT_LAYOUT=
  turn_context` layout (default OFF pending eval A/B), and multi-turn `mt-chat-*`
  transcript eval scenarios with longitudinal metrics (q-end%, repeat 5-gram%,
  sensory-turn%, paragraph inflation). Declined with reasons: mature-content
  reframe, POV rewrite, reflex-license removal.
- **Chat rerun data-loss fix** — no plan doc (incident fix; forensics in
  conversation) — 2026-07-09 — Rerun clicked while a reply streamed deleted the
  prompt server-side then 409'd off the exchange lock (the flow predated the
  2026-07-02 lock and was never reconciled): rerun is now an atomic server-side
  exchange kind — stop the in-flight reply first, bounded-wait lock acquire
  (new `acquireKeyedLockWithin`), then one transaction that snips only
  successors (SQL-ordered, no ms-truncation) and reuses the prompt row as the
  guard; a 409 leaves the transcript byte-identical, and the client no longer
  issues deletes (optimistic snip restores on failure). Chat streams gained
  first-token (60s) + overall (300s) watchdogs so a hung model can't hold the
  chat lock, and the provisional Aion 3.0 reasoning knob was reverted pending
  verification. Six new int cases incl. transcript-untouched-on-409 +
  rollback-degradation diagnostics.
- **Chat reply discipline + scene memory** — no plan doc (built direct on owner
  instruction) — 2026-07-09 — the 1-on-1 chat turn grammar: a "Shaping each
  reply" prefix block (resolve-then-one-move with a worked example pair,
  ~three-paragraph baseline exceeded only for new scenes / major events,
  freshness rule — never re-describe unchanged setting/outfit/scent) + sparse
  intimate dialogue with the check-in refrain banned; an accumulating **chat
  scene memory** (`scene_memory` jsonb on `character_chat_state`, migration
  `0030` — capped places/details/connections, deterministic pre-turn movement
  switch + archivist `scene` proposals merged oldest-out, injected as a Scene
  tail block with establish-once / don't-recap directives, rollback-safe via
  `pre_exchange_state`); the deterministic **response-shape + mood-pin** tail
  line; **hook-cadence + check-in gates** over the last replies (span-parser
  question detection); **sense-targeted Sensory focus** blocks
  (smell/taste/touch/study × body region → scent baseline + hygiene band +
  outfit + conditions, bounded-imagination clause, intimate targets gated); and
  Aion 3.0's missing `NARRATOR_REASONING` knob (`effort: low`, provisional).
  Docs: `prompts.md`, `character-chat.md`, `testing.md`.
- **Dialogue attribution — render-owned speaker presentation** — no plan doc
  (built direct on owner instruction) — 2026-07-09 — the `[Name]` tag demoted
  from presentation to one attribution input: the session segmenter moved to
  pure `lib/segmenter.ts` (one parser for sessions, chat, and the eval
  harness) with an opt-in standalone-quote rule (a whole-line double-quoted
  utterance in a 1-on-1 attributes to the character; embedded quotes stay
  prose — flavor NPCs live in narration by design); chat replies render
  in-bubble per-speaker segments (tags hidden, small name labels, comms lines
  keep SMS styling without double-labels); chat rule 3 makes the tag optional
  and licenses flavor-NPC speech in prose; the session feed renders `*Name: …*`
  texted lines SMS-style (closes the perception plan's comms-styling
  follow-up). Transcripts stay byte-verbatim; session prompt contract
  unchanged. Docs: `prompts.md` §Dialogue tagging, `ui.md`,
  `character-chat.md`.
- **Player-input perception — markup lane, RAG fence, session port (slices 3–7)** —
  [player-input-perception.plan.md](finished/player-input-perception.plan.md) — 2026-07-09 —
  the plan's whole remainder in one multi-agent run: exemption lines in the
  pulse/archivist/intake prompts; the pure `lib/message-spans` parser + "Message
  notation" legend + comms/OOC tail notes + the round-trippable `*Name: …*`
  texted-reply grammar (eval variants + deterministic `commsReply` metric);
  transcript span rendering (sigils hidden, OOC amber aside) + the `((` composer
  auto-close/badge; the fact `channel` fence (migration `0029` — narrator-bound
  retrieval SQL-fenced to `perceived`; pulse + dev inspector unfenced; detail
  [../memory.md](../memory.md) §Fact channel); and the session-lane port (rulebook
  perception block + legend, recipient-resolved comms notes, session archivist
  channel filing, play-feed rendering). Left: slice 8 (semantic fallback) gated on
  the leak measurement; the live probe/eval runs are owner-gated spend; two small
  comms follow-ups recorded in the plan.
- **Chat narrator POV — player-POV story narration** —
  [chat-narrator-pov.plan.md](finished/chat-narrator-pov.plan.md) — 2026-07-08 — the chat model
  is now also the story's camera behind the player's eyes: the narrator-camera rule +
  player-body boundary (perception + light reflex writable; the player's actions,
  speech, and named emotions never), the attention/motion-gated visual rule (one
  detail, never an inventory), Attributes/outfit/sensory blocks reframed as what
  reaches the player's eye and senses, an `attention` arm on the chat cue invite, and
  `chat-pov-*` eval fixtures + `povCue` metric. Leftover: the live scored eval run
  (owner-gated spend).
- **Player-input perception — the prompt-only partition (slices 1–2)** —
  [player-input-perception.plan.md](finished/player-input-perception.plan.md) — 2026-07-08 —
  the chat narrator now reads the player's message in channels: quoted = heard,
  unquoted narration = seen if visible, interiority = invisible (no mind-reading,
  with a worked example and graceful no-quotes degradation); `chat-thought-leak`
  fixtures + a deterministic planted-token `thoughtLeak` metric. The markup lane, RAG
  visibility fence, and session port remain in **Next**.
- **Character chat — the standalone experience** —
  [finished/character-chat-standalone.plan.md](finished/character-chat-standalone.plan.md) · spec
  [finished/character-chat-standalone.spec.md](finished/character-chat-standalone.spec.md) — 2026-07-02 —
  all nine slices in one arc: chat became a product surface (/chat hub + full-screen
  conversation, conversations-plural on a re-keyed schema, presets, takes/go-on/stop),
  then slices 6–9 finished it — prompt-cache split + craft rules, the measured-floor
  RAG upgrade (fusion, pinned "remember this", open loops) + the complete dev
  inspector + retrieval eval harness, the relationship that governs behavior
  (stage law/history/milestones/panel/export/rebuild) + in-game-only time with player
  skips, and inline anchored scene moments with opt-in auto-at-big-moments. Post-ship
  review (2026-07-06) fixed four rollback/lock correctness bugs —
  [finished/character-chat-standalone.followups.md](finished/character-chat-standalone.followups.md).
  Leftover: the live enactment measurement run (owner-gated —
  [deferred.plan.md](deferred.plan.md) §Owner-gated live eval runs).
- **Mood-reactive avatars — rollback** —
  [avatar-3d.plan.md](avatar-3d.plan.md) §Rollback, 2026-07-02. The emotion-image layer
  (slices 1–3 below) removed at the owner's request — the generated frames didn't work well.
  Gone: `avatar_seed` job + all enqueues, `avatar-expressions.ts`/`avatar-manifest.ts`, the
  lazy-gen + manifest routes, `contracts/avatar/`, the merge `ReactionBeat`, `avatarCue` on
  chat/status payloads, `SpriteAvatar` + its CSS; existing frames deleted via
  `scripts/delete-avatar-expression-frames.ts` (run per environment). Kept: `AvatarPanel` as
  a plain larger-portrait box in chat + the Scene tab. Plan parked; a better system will be
  planned fresh.
- **Review fixes — correctness & security (codebase-review batch 1)** —
  [codebase-review.plan.md](finished/codebase-review.plan.md) · findings
  [codebase-review.md](finished/codebase-review.md), 2026-07-02. All 17 items: the three
  silently-dead gameplay systems revived (condition→mood keys on the normalized label via
  `conditionKey`; the chat first-exchange upsert carries the outfit/cards columns through
  one shared `upsertChatState`; the director prompt surfaces the `taste` exposure axis),
  the race/data-loss edges closed (per-chat exchange lock → 409 `chat_busy` via new
  `engine/keyed-lock.ts`, serialized summary folds, fenced memory write, transactional
  Clear, batch-image 400s, provenance leaf-`.catch`), the security trio (production
  seed-credential guard, `BETTER_AUTH_SECRET` boot check, strict curated model-id
  resolvers), and four client fixes (registry-driven meter pips via threshold `pipLabel`s,
  debounce ref, lightbox focus trap, serialized chat-model PATCHes). No migration; verify
  + full int suite green. Batches 2–4 remain queued (bottom of Next).
- **Character chat as a primary feature** —
  [finished/character-chat-primary.plan.md](finished/character-chat-primary.plan.md) · spec
  [finished/character-chat-primary.spec.md](finished/character-chat-primary.spec.md), 2026-07-01. Chat now works like
  the session lane for a *single* character (location via narration only): **RAG long-term memory**
  (per-chat facts + episodes) atop the window + rolling summary, **mutable attributes** that evolve
  over a chat, and a **dev memory inspector**. The load-bearing keying decision (D1) landed on
  **widening** `facts`/`episodes` to a nullable session + `(ownerId, characterId)` key via a
  `MemoryScope` union (migration `0018`); the post-turn fan-out is pulse ‖ archivist-lite (D2), the
  archivist also carries the attribute proposer (D3) and next-turn queries; the three resets
  collapsed to one **Clear Chat** (D4). Migrations `0018`–`0020`.
- **Character chat — state as a narration system** —
  [character-chat-state-narration.plan.md](finished/character-chat-state-narration.plan.md) · spec
  [character-chat-state-narration.spec.md](finished/character-chat-state-narration.spec.md), 2026-06-30.
  The chat narrator now **enacts** the tracked `character_chat_state` instead of listing it:
  condition→attribute overlays (a designed-but-unbuilt seam, guarded so a condition can't rewrite
  an inherent attribute), graded meter cues with a **band-change anti-repetition gate** (new
  `surfaced_cues` column, migration `0017`) so a state is marked once when it *shifts* then rides as
  coloring, render-time **disinhibition** (intoxication lowers inhibition/guardedness/composure),
  soft social-card framing (theme not severity), a regex-first **one-turn intent cue**
  (`engine/chat-intent.ts`), a **state-aware chat scene image** (`visualStateNote` + overlays), and a
  "State → narration" debug readout. Owner decisions D1–D7 recorded in the spec; `pnpm verify` green
  (1620 tests). Graduated the deferred state-aware chat scene image.
- **Character-chat model persists per character** — docs [ui.md](../ui.md) (chat tab),
  2026-06-30. The Chat tab's narrator dropdown now saves the pick to a new
  `characters.chatModel` scalar on change (mirrors `worlds.narrativeModel`; migration
  `drizzle/0016`) — value hoisted to `character-edit-page.tsx` so it survives the tab
  unmounting, resolved through `resolveChatModelId` (unknown/empty ⇒ chat default), and
  kept off both the resettable `character_chat_state` row and the editor's profile draft.
- **Mood-reactive avatars — slice 3 (auto-asset gen + in-session play)** _(rolled back
  2026-07-02 — see the rollback entry above)_ —
  [avatar-3d.plan.md](avatar-3d.plan.md) §"Slice 3 — finalized design" · spec
  [avatar-3d.spec.md](avatar-3d.spec.md), 2026-06-30. Automated the per-character **expression
  frame set** (all 11 `EmotionLabel`s, seeded at avatar-ready via a new `avatar_seed` engine
  job + lazy-gen on demand through `POST …/avatar/expressions`, identity-locked Venice edits,
  cached forever) so the **whole unbounded cast** is expressive — `server/images/avatar-expressions.ts`
  (Venice concurrency semaphore + negative-cache that retries transient failures but tombstones
  content rejections; **Model-B** delete-on-face-change instead of a clone-breaking
  `sourceImageId` filter). Plus a **live standing companion avatar in session play** (Scene tab):
  per-participant `avatarCue` on the status payload, a **stable** focal (companion→tier→id), and a
  one-shot **reaction beat** sourced from the merge — `planReactionAffinity` now emits a
  `ReactionBeat` on both the carded branch **and** the un-carded **touch** branch (the romance
  beats), threaded additively to `agentResults.reaction` and fired once via a mount-baseline
  guard. Two adversarial workflows (design + impl review) gated it; no migration. **Deferred:**
  pose frames, touch reactions in the narrator line, a global detached-job recovery sweep. Decision-gated
  upgrade lanes remain (Rive rig, then R3F/VRM 3D; voice deferred).
- **Character chat — opportunistic sensory cues** —
  [character-chat-sensory.plan.md](finished/character-chat-sensory.plan.md), 2026-06-29. Prompt-only: a
  closeness-gated **"Sensory cues"** block surfaces `presentation.scent_baseline` (via `sensoryCues`
  in `prompts/character-chat.ts`) _only when the beat earns it_ — promoted out of the flat Attributes
  list, exposure-mask hint dropped, plus a `CHAT_RULES` rule (one cue on closeness/notice/intimacy,
  never forced or listed). Voice stays an always-on Attributes line; intimate scent/taste gated out
  (`isIntimateAttributeCategory`). Tests + a `chat-sensory-closeness` eval fixture + an opt-in
  `sensoryRelevant` deterministic metric. Escalation (one-turn chat "beat cue" wrapper) deferred.
- **Narrator prompt focus — Phase-3 focus A/B (planner does not earn its keep)** —
  [narrator-prompt-focus.plan.md](finished/narrator-prompt-focus.plan.md) · eval
  [narrator-prompt-focus.eval-results.md](finished/narrator-prompt-focus.eval-results.md) §Run 3, 2026-06-29. Ran the
  gated `--axis focus` A/B (fresh focus-on vs `--no-focus` pair, pairwise re-judge by
  `gemini-3.1-pro-preview`): the intake `focus` planner is a **53/47 wash** vs the free Phase-2 derivation
  (50/50 on byte-identical controls; it _lost_ `onBeat`/`noUnrequestedLogistics` and risked over-reaction on
  GLM). Ruling: **don't build the deferred character-chat focus analogue**; keep but don't grow the
  zero-cost session planner. (Live OpenRouter spend — 36 generations + 17 judge calls.)
- **Narrator prompt focus — eval rulings (profile + reasoning)** —
  [narrator-prompt-focus.plan.md](finished/narrator-prompt-focus.plan.md) · eval
  [narrator-prompt-focus.eval-results.md](finished/narrator-prompt-focus.eval-results.md), 2026-06-29. Turned eval
  Run 2 into code: the shape profile is now a **per-lane resting default** (`NARRATION_LANE_DEFAULTS` —
  session `concise_immersive`, chat `aggressive_concise`), resolving the global-vs-per-lane tension the
  per-model split exposed (the dev toggle still force-overrides both lanes); and `narrativeProviderOptions`
  gained a **per-model reasoning knob** (`NARRATOR_REASONING` — Aion 2.0 `effort:low`, GLM 5.2 `effort:low`,
  Owl Alpha `enabled:false`), applied to both lanes. Decision 1 re-ruled from "global-only"; tests + dev
  toggle ("Default (per-lane)" state) updated. No-spend (rulings already had the data).
- **Personality enactment — sliders & age drive dialogue/action** —
  [personality-enactment.plan.md](finished/personality-enactment.plan.md), 2026-06-28. Made the authored
  trait **sliders** (and the new real age) actually steer how characters talk and act: character-chat
  now **surfaces the sliders at all** (it never did) as a binding Disposition block; the session
  disposition block + a new Prose rule shift from "stay consistent" to **enact**; the **director**
  agent gets present-character disposition so its next-turn steer fits temperament. Shared
  `dispositionBands` renderer; age/life-stage characterization rule (the `character-age-field` follow-up).
- **Character real age vs apparent age** —
  [character-age-field.plan.md](finished/character-age-field.plan.md), 2026-06-28. New free-text
  `profile.age` (basic info) split from the visual `identity.apparent_age` attribute: the
  **narrator** reads real age (`formatAge` — canonical facts + character-chat identity), the
  **portrait studio** keeps apparent age, and **scene image generators drop it**
  (`characterAppearanceSummary` skips it) so renders lean on the avatar reference. Wired through
  editor, forge, fixtures + seed.
- **Narrator prompt focus & proportionate reaction — behavioral eval harness** —
  [narrator-prompt-focus.plan.md](finished/narrator-prompt-focus.plan.md), 2026-06-28. `pnpm eval:narration`
  (`scripts/eval/narration/`) — assembles **real** prompts (the shipped builders) for six golden
  scenarios, sweeps (scenario × model × shape profile × reasoning), streams via OpenRouter, and reports
  deterministic metrics (paragraphs / segments / distinct speakers / tokens / TTFT / latency / provider)
  - an LLM-judge rubric. `--no-focus` is a Phase-2-vs-Phase-3 A/B; `--dry-run` inspects prompts with no
    spend; conservative defaults. Never in `pnpm verify` / CI. Automates the interim eval + probes P1–P3.
- **Narrator prompt focus & proportionate reaction — Phase 3** —
  [narrator-prompt-focus.plan.md](finished/narrator-prompt-focus.plan.md), 2026-06-27. The structured
  narration-focus planner, built in the **preferred intake-schema-extension form** (no new LLM
  leg): an optional `focus` sub-object on `IntentBrief` (`primaryResponse` / `reactionScale` /
  `allowedNewTopic` / `suggestedShape`) the intake agent emits, consumed by `buildResponseShape` to
  enrich the "## Response shape" steers — finer beat verb, explicit new-topic license, an optional
  `Shape:` line. `.optional()` (absent ⇒ deterministic Phase-2 derivation); the **authored reaction
  band always overrides** the planner's `reactionScale`. Built ahead of the interim-eval gate on
  direct instruction.
- **Narrator prompt focus & proportionate reaction — Phase 2** —
  [narrator-prompt-focus.plan.md](finished/narrator-prompt-focus.plan.md), 2026-06-27. Added the
  deterministic, restatement-only **"Response shape"** line to the turn context (right after the
  digest): per-turn **current-beat** (stay on the input; new topic only via a Direction/thread),
  **reaction-scale** (absence of a strong band → "ordinary, don't escalate"; weak → "small";
  strong → defer to `## Reaction`), and **speaker-focus** (only addressed-and-present NPCs answer)
  steers. Pure `buildResponseShape` (no new LLM call); the primary-reaction verdict is evaluated
  **once** (`evaluatePrimaryReaction`) and shared with the `## Reaction` line so they can't
  disagree. Built ahead of the interim-eval gate on direct instruction.
- **Narrator prompt focus & proportionate reaction — Phase 1** —
  [narrator-prompt-focus.plan.md](finished/narrator-prompt-focus.plan.md), 2026-06-27. Killed the
  `3–5 paragraphs` floor for hot-swappable narration **shape profiles** (`concise_immersive`
  default + `aggressive_concise`, a global dev A/B knob with a dev-only `POST /api/dev/narration-shape`
  toggle in the Inspector); added response-first + proportionate-reaction + multi-party-restraint
  rules to the session rulebook and `CHAT_RULES` (both lanes), leaning on the existing `## Reaction`
  band; self-motivated NPC initiative kept for living-world texture; authored Style directives
  override. Phases 2–3 + eval remain in Next.
- **Mood-reactive avatars — slices 1–2 (cue contract + chat PoC)** _(rolled back
  2026-07-02 — see the rollback entry above)_ —
  [avatar-3d.plan.md](avatar-3d.plan.md) · spec [avatar-3d.spec.md](avatar-3d.spec.md), 2026-06-27.
  The renderer-neutral `contracts/avatar/` cue contract + pure `deriveAvatarCue` (read over the shipped
  Mood projection + social-reaction beat + posture + atmosphere, serialized onto the chat snapshot), and
  a CSS-keyframe `SpriteAvatarRenderer` + standing companion panel mounted in character-chat —
  breathing/drift/crossfade + one-shot reaction beats over the existing portrait, with ~5 hand-seeded
  Lysandra expression frames (`scripts/seed-avatar-expressions.ts`). Implementation deviated from the
  spec (no Zustand/XState/`motion` dep yet; manifest = `portrait_variant` rows tagged
  `meta.avatarExpression`; blink deferred) — recorded in the plan. **Slice 3** (auto-asset gen for the
  unbounded cast) stays in Next.
- **Merge reducer decomposition — all 5 slices** —
  [merge-decomposition.plan.md](finished/merge-decomposition.plan.md) · spec
  [merge-decomposition.spec.md](finished/merge-decomposition.spec.md), 2026-06-27. The 2655-line
  `engine/merge.ts` is fully decomposed: a `merge/` folder behind the `WorkingState` ADT
  (dirty-tracking owned internally, `no-restricted-syntax` gate), the pure resolution toolkit
  in `grounding.ts`, one `phases/*.ts` file per phase, the orchestrator (`PhaseContext` + an
  ordered `PHASES` list) in `plan.ts`, the lone DB-write transaction in `apply.ts`, and a
  narrowed public barrel. Behavior-preserving (MergePlan + every DB write byte-identical;
  189 pure + 13 integration tests green).
- **Character chat — scenario setup modal** —
  [character-chat-scenario.plan.md](finished/character-chat-scenario.plan.md), 2026-06-27. The chat tab's
  Starting Relationship + Scenario controls fold into one **Scenario setup** modal (sibling of State
  tools), grown into a no-session test harness: a per-chat **active social-card** set (seeded from the
  character's own cards, then authoritative — the pulse resolves against it) so taboos/rules are
  testable without a world/session, plus a free-text **starting outfit** + an **exposed** toggle that
  drive chat scene images — **detaching the structured clothing** the chat can't equip (`defaultOutfit`
  stays for avatar/portrait/sessions). Three new `character_chat_state` columns (`outfit`,
  `outfit_exposed`, `active_social_cards`; migration 0015). Also added the `foot_contact` interaction
  concept earlier the same arc so the foot-fetish card triggers precisely.
- **Social-reaction cards — library-reuse UI** —
  [social-reaction-cards.plan.md](finished/social-reaction-cards.plan.md) §"Deferred slice", 2026-06-26.
  The `social_cards` library finally gets its surface: `social_card` wired into the shared
  library machinery (`ShareableKind`/`LibraryKind`, clone, owner-or-public reads, semantic
  search), full CRUD at `/api/social-cards` (+ `/clone`), a `/social-cards` page + standalone
  **card builder** (with a live reaction preview, reusing the shared `SocialCardFields`),
  **Import from / Save to library** on the inline editor (snapshot-copy both ways via
  `cardFromLibraryParts`), and the **public discovery gallery** — the deferred `searchLibraryIds`
  `scope` query, debuted on cards (the auth.plan.md "public browse gallery + clone UI entry point"
  deferral graduates here; other shareable kinds pass `scope` through but their list API still
  ignores it — the fast-follow). Int-tested (scope/clone/visibility) + pure snapshot test.
- **Prod branch + promotion workflow** —
  [deployment.md](../deployment.md) §"Branch model & promotion", 2026-06-26. Long-lived
  protected `prod` branch on the existing `origin` remote (dev stays `main`). New CI
  (`.github/workflows/ci.yml`) runs `pnpm verify` on PRs/pushes to both branches; `prod`
  protection requires the `verify` check + a PR (force-push/delete blocked, enforced for
  admins). A `workflow_dispatch` "Promote dev → prod" button
  (`.github/workflows/promote.yml`) opens the `main → prod` PR. Prod **deploy** is
  intentionally not wired yet (needs a prod Fly app + Neon prod DB + `FLY_API_TOKEN`).
- **Social-reaction cards — engine + inline authoring** —
  [social-reaction-cards.plan.md](finished/social-reaction-cards.plan.md), 2026-06-25. Importable
  **taboo / social-rule cards** (`contracts/personality/cards.ts`) that resolve a classified
  social act to a `SocialReaction` riding the §6 curve — one `severity` → tier → ramped
  intensity, with per-tag override flips (the foot-fetish enjoy). Wired into all three
  reaction call sites (session merge, pre-narration line, world-less chat); **world cards**
  live inline on `worldStyle.socialCards`, **character cards** on `CharacterProfile.socialCards`
  (both snapshot arrays riding the live-read cascade — no join/instance tables). The
  continuity agent's freeform `normBreaches` was re-pointed to `cardBreaches`, with
  `planCardBreachReactions` folding **per-witness affinity** through the curve + directives —
  the freeform `world.style.norms` surface is fully removed. Forge proposes a starter card
  set; the world editor + character Disposition tab author cards inline. Deferred: the
  `social_cards` **library-reuse UI** (CRUD/page/import-picker/clone — table shipped, still
  in Next).
- **Scene atmosphere — scene-tone producer** —
  [scene-atmosphere.plan.md](finished/scene-atmosphere.plan.md) · spec
  [scene-atmosphere.spec.md](finished/scene-atmosphere.spec.md), 2026-06-24. Built the producer the mood
  core slice was missing: the **director** emits an optional `atmosphere` enum (one field, no
  new leg); `resolveAtmosphere` carries it onto the brief (sticky — director tone, else the
  prior, with an intimate-frame floor to `romantic`); the drift loop feeds it to the already-
  built `atmosphereMoodBaselineShift` for NPCs co-located with the player (a tense room settles
  a present character lower, composure-damped). Unblocks mood's last v1 input; later serves the
  avatar's `environment.atmosphere`. Deferred: authored location tone, status surfacing, a
  danger→`tense` floor.
- **Mood — app-wide emotional state** (complete) —
  [mood.plan.md](finished/mood.plan.md) · spec [mood.spec.md](finished/mood.spec.md),
  2026-06-24. A new `src/contracts/mood/` module: the locked **11-label `EmotionLabel`**,
  the pure/total **`deriveEmotionLabel`** projection (a derived activation axis × valence +
  affinity + conditions, with a transient reaction beat), and the **event→mood table** split
  into impulse (one-time) vs standing (baseline-shift) modes. **Welcome/unwelcome touch**
  (affinity-stage gated + preference override), the **condition→mood baseline shift**, and the
  **scene-atmosphere baseline shift** (its producer is the sibling Shipped entry above) are
  wired into the engine merge; a shared **`MoodChip`** surfaces the label on both the cast card
  and the character-chat strip. Mood's own scope is done; the two leftover ideas live in other
  plans — the relationship/meter timeline ([deferred.plan.md](deferred.plan.md) #4) and the
  avatar's projection consumption (Mood-reactive avatars, in Next).
- **Character chat — light state** —
  [character-chat-state.plan.md](finished/character-chat-state.plan.md) · spec
  [character-chat-state.spec.md](finished/character-chat-state.spec.md), 2026-06-24. The
  sessionless 1-on-1 chat is now state-aware: a `character_chat_state` row (full meter
  set, affinity, conditions, mindNote, premise, chat clock), a free time-drift spine
  (within-visit decay + between-visit recovery toward rested, **no affinity decay**),
  affinity seeded from a new authored `playerRelationship` profile field, a per-chat
  **premise** (chat-only scenario), and a cheap reaction pulse that reuses the
  personality §6 curve to move affinity/mood + refresh the mindNote (degrades to
  drift-only). Surfaced as a prompt "Current state" + scenario block, a `GET/PATCH/POST
…/chat/state` API, a status strip + stage-change toast + premise bar, and three
  reset scopes (all/chat/state). **Slice 4** added the texture (arousal-from-intimate,
  action chips, light conditions) and test-bed affordances (a **state-tools modal**
  with the last-turn debug trace, and the **Prompt Character** opening beat). Only the
  state-aware chat scene image was deferred → [deferred.plan.md](deferred.plan.md).
- **Default player character** — [player-character.plan.md](finished/player-character.plan.md),
  2026-06-23. A `/settings` page (reached from the nav account menu) where the user sets
  a light default player character — name + short persona on `users.playerPersona`,
  read through the single `resolvePlayerPersona` resolver and threaded into character
  chat so a character greets the player by name (closes the faceless-player UX-audit P1).
  Inline-blob storage; graduates to a real library character later via the same resolver.
- **Security hardening** — [security-hardening.plan.md](finished/security-hardening.plan.md),
  2026-06-23. Closed the full-surface scan: image-decode pixel/format/length limits
  (OOM fix), rate limits on every paid-model/heavy-write route, security headers +
  narrowed dev-origins, request-body caps, prompt-injection fencing, LLM-output array
  bounds, Postgres localhost bind + cred guard, and seven defense-in-depth lows.
  Deferred: origin/CSRF (covered by Better Auth); `script-src` nonce tightening.
- **Auth & entity visibility** — [auth.plan.md](finished/auth.plan.md) · ref
  [auth.md](../auth.md), 2026-06-23. Better Auth accounts (401 on no session, no
  auto-mint) + a private/public visibility seam with copy-on-use cloning. Also closed
  security cluster A + the auth migration. Deferred: the public browse gallery + clone
  UI entry point — **graduated 2026-06-26 for social cards** (the `searchLibraryIds` `scope`
  query + clone CTA; see the Social-reaction cards library-reuse entry above); characters /
  locations / items pass `scope` through but their list API still ignores it (fast-follow).
- **World instances — copy cascade** —
  [world-instances.plan.md](finished/world-instances.plan.md), 2026-06-23. Worlds hold
  snapshot copies of entities instead of live library FKs, so deletes never break copies.
- **Character chat — rolling background summary** —
  [character-chat-summary.plan.md](finished/character-chat-summary.plan.md), 2026-06-21. A
  watermark-anchored running summary gives the 1-on-1 chat memory past its 40-turn window.
- **Scene images — multi-reference & providers** —
  [scene-images.plan.md](finished/scene-images.plan.md) · spec
  [scene-images.spec.md](finished/scene-images.spec.md), 2026-06-19. Provider-capability
  layer + `image_references` table; Venice/Qwen multi-edit (Flux removed).
- **Attribute mutability & change-path integrity** —
  [attribute-mutability.plan.md](finished/attribute-mutability.plan.md) · spec
  [attribute-mutability.spec.md](finished/attribute-mutability.spec.md), 2026-06-19. Enforced the
  `mutability` invariant at the merge boundary + a shared value-vocabulary module.
- **Personality & evolving state** —
  [personality-and-state.plan.md](finished/personality-and-state.plan.md) · spec
  [personality-and-state.spec.md](finished/personality-and-state.spec.md), 2026-06-18.
  All five slices: the authored **likes/dislikes loop** (intake concept-tags a player's
  act; a deterministic affinity-aware curve decides the reaction), the puppet guardrail,
  atomic personality **traits** + scaling + lexicon, the **mood** valence meter +
  mood↔affinity coupling, and affinity trait-coupling + widened stages. Left as their own
  plans: the **event→mood table** (→ Mood), the **card layer** (→ Social-reaction cards),
  and the full NPC-puppeting system (deferred).
- **UX-audit remediation** — [ux-audit.plan.md](finished/ux-audit.plan.md), 2026-06-18. Triaged the
  end-to-end audit: world-forge intake fields, forge-canon reconciler, artwork progress,
  contrast theme, session-lock window.
- **Visual world map (Slice 1)** — [world-map.plan.md](world-map.plan.md), 2026-06-18.
  Read-only force-directed location graph (slices 2–3 still in Next).
- **Non-human species & body features** —
  [non-human-species.plan.md](finished/non-human-species.plan.md) · spec
  [non-human-species.spec.md](finished/non-human-species.spec.md), 2026-06-18. 8-species
  catalog + wings/horns/tail morphology across image-gen + editors.
- **Character chat — sessionless 1-on-1** —
  [character-chat.plan.md](finished/character-chat.plan.md), 2026-06-17. Talk to a library
  character directly (no world/session/RAG) to tune its voice; Chat tab + scene + Gallery.
- **Phase 4 — the body model** — [phase-4-plan.md](finished/phase-4-plan.md), 2026-06-14.
  Intimate anatomy, sensory, species scaffolding.
- **Phase 3 — presence & perception v1** — [phase-3-plan.md](finished/phase-3-plan.md).
- **Phase 2** — [phase-2-plan.md](finished/phase-2-plan.md).
- **Phase 1 — foundation** — [phase-1-plan.md](finished/phase-1-plan.md) (+
  [multi-character-phase-1-plan.md](finished/multi-character-phase-1-plan.md)).
