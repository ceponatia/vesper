# Narrator model test bench

Status: active (opened 2026-08-17)

Outcome: The owner can switch a conversation onto any of a dozen narration-tuned
models from the chat menu, so that the question of which model narrates Vesper
best is settled by reading its prose rather than by argument.

## Why

Vesper narrates through a small curated list of models, and every one of them is
a general-purpose or frontier model that happens to be permissive. The narration
fine-tunes the hobbyist roleplay community has built for exactly this job —
prose quality, character voice, spatial consistency, willingness to narrate a
scene the game has legitimately reached — have never been tried here.

That gap mattered less when the narrator was doing most of the thinking. It
matters more now. As the simulation layer takes over what is true, the narrator's
job shifts toward rendering supplied facts as prose, and that is precisely the
job a smaller, heavily narration-tuned model might do better than a large general
one — and much cheaper. Nobody knows, because there has never been anything to
compare against.

## What the owner gets

- **Eleven new narrators in the chat menu.** The narrator dropdown gains a
  roleplay and low-refusal bench alongside the models already there. Picking one
  saves immediately to the conversation, exactly as it does today, so trying a
  model is a menu choice rather than a deploy.
- **One model per lane, not one per family.** The bench spans four size classes,
  five model families and three tuning philosophies, so a comparison run varies
  the thing being tested instead of the checkpoint.
- **A settled answer on the other providers.** Whether Vesper should call
  Replicate, Civitai, or Hugging Face for narration was measured rather than
  guessed, and the measurements are recorded so the question does not reopen on
  vibes.

## Boundaries

### In scope

The narrator lane only — the model that writes prose in character chat and
successor chats, chosen per conversation.

### Non-goals

- **Changing either default.** The bench is additive. Aion 2.0 stays the session
  narrator and Aion 3.0 the chat narrator until something beats them on evidence.
- **A second narrator provider.** Investigated and rejected on measurements; see
  [the spec](narrator-model-bench.spec.md) §Providers investigated.
- **The other model seams.** The in-session agents, the scene composer, and the
  image models keep their own curated lists and are untouched.
- **Self-hosting weights.** Packaging a Hugging Face model onto Replicate GPUs is
  the escape hatch if a model that exists nowhere hosted turns out to be the one
  worth having. Nothing here commits to it.

## Slices

- **Slice 1 — the bench is pickable.** Status: complete — 2026-08-17. Eleven
  narration-tuned models join the curated narrator list and appear in the chat
  menu's narrator dropdown. Every id was checked against the live provider
  catalog and each model was called once to confirm it narrates.
- **Slice 2 — a recorded comparison.** Status: next. Run the bench over fixed
  scene fixtures through the existing narrator-comparison harness and record a
  verdict per model against the criteria below.
- **Slice 3 — a default ruling.** Status: blocked on slice 2. Either promote a
  bench model to a lane default with its verdict recorded, or record that the
  incumbents held and trim the bench to the rows worth keeping.

## Where the work stands

- **[narrator-model-bench.spec.md](narrator-model-bench.spec.md)** — complete for
  slice 1. It owns the bench roster, the per-model rationale, the context-window
  arithmetic, and the provider probe evidence. Slice 2's fixtures and scoring
  are not started.

## Success criteria

Slice 1 is met: every bench model is selectable in the chat menu, and a
conversation switched onto one produces narration rather than an error.

Slice 2 is met when each bench model has a recorded score against the criteria
below, produced from the same fixed scenes, and the owner can name the winner and
the reason. The criteria that matter for Vesper specifically, in rough order:

- **State obedience** — narrates the facts it is given rather than inventing
  contradictory ones.
- **Physical and spatial consistency** — respects position, reach, clothing and
  contact state instead of fixing inconvenient state through prose.
- **Player agency** — never decides the player's thoughts, actions, or dialogue.
- **Neutral-scene restraint** — an ordinary conversation stays ordinary. This is
  the failure mode roleplay fine-tunes are most prone to and the one most likely
  to disqualify an otherwise strong model.
- **Continuity under load** — a valid explicit or violent beat continues in the
  same register rather than refusing, euphemizing, or lurching in tone.
- **Repetition and stock phrasing** — measured over a long run, not a single turn.
- **Latency** — time to first token, which the chat lane feels directly.

## Open questions

- **Does the speaker-tag renderer survive the bench?** The narrator output
  normalizers expect this app's `[Name]` convention, and at least one bench model
  answers in `*asterisk action*` roleplay style instead. Whether that is a model
  to drop or a normalizer to widen is unresolved
  ([detail](narrator-model-bench.spec.md)).
- **Does a 32K context window actually bind in practice?** Three bench rows are
  small enough that a long verbose chat could overflow them, and what the app does
  at that boundary has not been observed
  ([detail](narrator-model-bench.spec.md)).

## Technical companion

[narrator-model-bench.spec.md](narrator-model-bench.spec.md) — the roster, the
provider probe evidence, and the context arithmetic.
