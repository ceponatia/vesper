# The profile leg

One `generateChecked` call drafts the profile leg's prose and behavioral families.
Full creation requests all families; scoped generation requests only the fields owned by the
selected editor section in `lib/character-scopes.ts`.
Each family below is grounded against its own registry before it reaches the draft, and a family
that fails grounding drops with a diagnostic rather than breaking the draft
([README.md](README.md) §Guardrails).

## Core prose and identity

Bio, personality, voice notes, library tags, and a suggested display name.

**Real age** (`profile.age`) is free text: the character's true or chronological age, distinct from
the visual `identity.apparent_age` attribute the attribute agent sets. The two need not align — a
centuries-old being who reads late-thirties — and the narrator reads `age` while the portrait
studio reads apparent age.

## Social disposition

Inferred from the personality:

- **`dispositionTags`** — normalized against the canonical tag registry, free-form tolerated.
- **`preferences`** — bespoke likes and dislikes whose `target` is grounded against the
  interaction-concept vocabulary; unknown targets drop with
  `forge.character.profile.unknown_preference`.
- **`traits`** — atomic trait scalars. The prompt lists the trait registry with each axis range and
  a few `lexicon` example words per trait, so the model maps the personality words it used onto the
  closest trait and infers the rest. Values are grounded against the registry and clamped to the
  axis, source `creation`; unknown ids drop with `forge.character.profile.unknown_trait`.

These land on `profile.tags` / `profile.preferences` / `profile.traits`, distinct from the library
`tags` used for search.

## Micro-exemplars

2–3 `{situation, line}` worked dialogue examples, grounded by `groundMicroExemplars` (rows with no
line drop, text is trimmed, the list caps at `MICRO_EXEMPLARS_MAX` = 3) onto
`profile.microExemplars`.

They are few-shots of how the character actually talks — a deflection, a boundary, a tease —
rendered near generation in the chat prefix so voice, disposition and age land in the prose rather
than only in the sliders. They belong to **Voice & manner**
([in-sheet-forge.md](in-sheet-forge.md)), are hand-editable in that section
(`MicroExemplarsEditor`, beside Voice notes), and fill-merge all-or-nothing like the outfit: any
authored row keeps them all.

## Voice anchors

A structured `profile.voiceAnchors` of `{ petPhrases (≤6), cadence (one line), neverSays (≤6) }`,
grounded by `groundVoiceAnchors` through the `voiceAnchorsSchema` boundary parse — trims, drops
blanks, caps the lists.

These are the concrete near-generation levers that keep a voice consistent across a long chat:
phrases the character reaches for, a rhythm note, and words or registers off-limits for them. They
render two ways in the chat prefix — a stable **"Your voice, concretely"** anchors block, and a
one-line **"Voice check"** re-anchor beside the mood pin near generation — belong to
**Voice & manner**, are hand-editable there (`VoiceAnchorsEditor`), and fill-merge
all-or-nothing via `hasVoiceAnchors`.

## Intimate disposition

A short, tasteful `profile.intimacy` note on how the character reads as a lover. It is **always
included in full character generation**: the gate lives at *surfacing*, not authoring. Scoped
generation includes it only when the selected section owns it.

It is hand-editable in **Personality** and belongs to that section's generation scope.
It fill-merges like `voice` — an authored note is fixed, a
blank one takes the generated one. It reaches the narrator only above the chat intimate gate
([../character-chat/perception-gates.md](../character-chat/perception-gates.md) §The chat intimate
gate).

## Drives

Owner rulings 2026-07-12. Up to 3 `{want, why, secrecy: open|guarded|secret, revealBand?}` entries
onto `profile.drives`, **concept-led with at most one `secret`** — a secret carries the chat lane's
scoped lie license, so the forge only mints one when the concept genuinely supports a hidden past
or concealed motive.

`groundDrives` enforces the budget (a second secret demotes to `guarded` with
`forge.character.profile.extra_secret`), dedupes by normalized want, truncates over-length text,
and validates a secret's `revealBand` against the relationship band vocabulary — an unknown band
drops to the ruled default (familiarity ≥ familiar) with
`forge.character.profile.unknown_reveal_band`.

A drafted secret's reveal gate is also **ceilinged mid-arc** (familiarity ≤ `familiar`, regard ≤
`close`): the model left alone gates secrets at "deeply_known", which a normal chat arc never
reaches, so a band past the ceiling demotes to the ruled default with
`forge.character.profile.extreme_reveal_band`. Humans can still pick any band in the editor, and
the prompt asks for the secret's actual substance in its `why` so the eventual reveal has something
coherent to land on.

## Daily rhythm

Up to 4 `{dayPart: morning|afternoon|evening|night, activity, locationName, days?}` rows, grounded
by `groundSchedule` into `profile.schedule`'s stored minute windows. The day-part vocabulary lives
in `contracts/world/profile.ts` (`SCHEDULE_DAY_PARTS`); rows missing an activity or a place drop,
duplicate windows drop, and over-cap rows drop with `forge.character.profile.schedule_capped`.

Chat initiative openers read the schedule as one rhythm line (`formatScheduleRhythm`), and chat
time-skips re-dress the character from a row's `outfitPresetId`.

## Two concept-conditional families

Owner rulings 2026-07-12.

**Starting relationship** — drafted when the concept places the player in the character's life
("engaged to the player nine years ago", "her favorite client"): band picks plus
kind/history/mask/premise note, grounded by `groundPlayerRelationship` onto
`profile.playerRelationship`. Unknown bands self-heal to the axis default with
`forge.character.profile.unknown_relationship_band`, text truncates at the storage caps, the
human-phrased mask maps onto the presented lean, and an all-default draft grounds to *nothing* so an
untouched starting relationship stays untouched. Its editor lives in **Relationships**.

**Personal social cards** — drafted when the concept names a hard social line ("hates being haggled
over her art"): up to 2 cards, grounded by `groundSocialCards` against the interaction-concept
vocabulary. Unknown triggers drop with `unknown_card_trigger`; a trigger the drafted preferences
already opine on drops with `card_trigger_shadowed`, because a bespoke preference resolves ahead of
any card and such a card would be dead weight; a card left trigger-less drops with
`card_without_triggers`; ids are minted server-side. See [social-cards.md](social-cards.md).

## Demo mode

Demo mode seeds a sample disposition — tags, preferences, traits, drives, schedule, starting
relationship and one card — so the keyless path exercises the whole leg.
