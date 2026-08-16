[← Contracts index](README.md)

# Pinned state shapes

The **binding** schemas behind the JSONB columns in [database.md](../database.md).
They live in `contracts/world/` and `contracts/state/`, and each
exports an `empty*()` default used as the `parseOr` fallback. The character-chat lane's own tracked
shapes (`character_chat_state`, the scenario, scene memory, plans) are covered by
[../character-chat/state.md](../character-chat/state.md); the successor engine's shapes by
[../engine/README.md](../engine/README.md).

## Where each shape is stored

| Shape              | Lives on                | What it is                                            |
| ------------------ | ----------------------- | ----------------------------------------------------- |
| `CharacterProfile` | `characters.profile`    | The authored character.                               |
| `PersonaProfile`   | `personas.profile`      | The player as a library entity (bio, body, wardrobe). |
| `SceneGenState`    | image-gen cadence state | Scene-image generation cadence + reference mode.      |

## CharacterProfile

The authored character: bio, personality, body-config, attributes, default outfit, disposition, and
schedule. The single most-read shape in the app — the chat prompt builders, the forge, and the
avatar/scene image pipelines all consume it.

```ts
type CharacterProfile = {
  bio: string; personality: string; voice?: string;
  age: string;                                // real/chronological age, free text — narrator-facing (formatAge); ≠ the visual identity.apparent_age attribute
  speciesId: string;                          // registry id ("human" / "succubus" / "faerie" / …)
  heritageId?: string;                        // optional heritage within the species (overlay); absent ⇒ bare species
  bodyPlanId: string;                         // registry id ("humanoid" seeded)
  intimateRegions: string[];                  // body-config: present intimate region groups (default []); see body.md §realized body
  bodyFeatures?: string[];                    // additive feature groups; absent ⇒ species defaults, [] ⇒ explicit none
  attributes: AttributeValue[];               // base/creation-sourced
  tags: string[];                             // reusable disposition tags social-reaction cards key overrides on
  preferences: Preference[];                  // bespoke likes/dislikes resolved against a classified social act
  socialCards: SocialReactionCard[];          // the character's own default lines/taboos
  traits: TraitValue[];                       // atomic personality traits — numeric scalars with registry-defined bands
  drives?: Drive[];                           // ≤3 desires & secrets ([relationships.md] disposition; a secret carries a scoped reveal gate)
  playerRelationship: AuthoredRelationshipRecord & { note: string };
                                              // authored default stance toward the player: familiarity × regard band picks +
                                              // kind/history/mask texture + one-line note; seeds a new chat's live scalars at band
                                              // midpoints (legacy {stage, note} heals via stageToBandIds). See relationships.md
  microExemplars?: { situation: string; line: string }[];  // worked dialogue examples (voice few-shots)
  voiceAnchors?: { petPhrases: string[]; cadence?: string; neverSays: string[] };  // near-generation voice levers
  intimacy?: string;                          // how the character reads as a lover; surfaces only above the chat intimate gate
  aliases: string[];
  outfits: Array<{ id: string; name: string; items: string[] }>;  // named looks over library item ids; first = default (legacy defaultOutfit lifts into an "Everyday" preset)
  schedule?: Array<{ startMinute: number; endMinute: number; locationName: string; activity: string;
                     days?: number[]; outfitPresetId?: string }>;  // weekday mask, 0 = Sunday; absent ⇒ every day
};
```

See [body.md](body.md) §The realized body for `intimateRegions` / `bodyFeatures`, [attributes.md](attributes.md)
for `AttributeValue`, and [relationships.md](relationships.md) for `traits` / `preferences` / `drives` /
`playerRelationship`. The forge that drafts every field is [../authoring.md](../authoring.md).

## PersonaProfile

The player as a library entity (`contracts/players/persona-profile.ts`, persona-library.plan.md) — who
*you* are in a chat, with a body and a wardrobe but no personality/disposition/schedule (the narrator
never writes the player's lines). Carries bio, voice, `intimacy` (inverted semantics — what the player
*responds to*), species/heritage/bodyPlan, `intimateRegions`, `bodyFeatures`, `attributes`, and `outfits`.
`PlayerPersona` is the prompt-facing projection every consumer reads through `resolveChatPersona`
([../auth.md](../auth.md)); it has no library `title` field.

## SceneGenState

Controls how often chat scene images are generated. There's no subject field — the composer picks the
focal character from the conversation's roster.

```ts
type SceneGenState = {                        // no subject field: the composer picks the focal character
  interval: number;                           // every N turns; 0 = off
  lastGeneratedTurn?: number;                 // turn number when an image was last generated
  status: "idle" | "generating" | "failed";   // (../images/pipelines.md §Scene images)
  referenceMode: "single" | "multi";          // single = one identity anchor; multi = multi-reference edit, up to the model's reference cap
};
```

## Game time

`apps/web/src/lib/clock.ts` (pure) derives `GameTime` from a story clock's `clock_minutes` + calendar-start anchor
(the chat scenario carries `clock_minutes` + `calendar_start`; see
[../character-chat/state.md](../character-chat/state.md) §Story clock). It provides:

- `weekdayIndex` / `dayIndex` — for schedule day masks and per-day deterministic seeds, and
- a `daylightBand` helper — **dawn** 05–07 · **day** 07–18 · **dusk** 18–20 · **night** otherwise —

so consumers never re-derive hours themselves.
