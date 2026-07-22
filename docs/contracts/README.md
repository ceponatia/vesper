[← Vesper docs](../README.md)

# Contracts

`src/contracts/` is the pure, IO-free heart of the domain — the registries and validation schemas that everything else checks itself against. Each core system below has its own focused doc, while some modules are covered as sections within a related doc (e.g. mood under meters, personality under relationships, species under body, world under state). Start with whichever part you're touching; every doc links back here.

## Reading order

| Doc | What it covers |
| --- | --- |
| [attributes.md](attributes.md) | The attribute registry: definitions, the shared registry spine, and value provenance |
| [body.md](body.md) | The body-location tree, body plans, species/heritage, the realized body, and colloquial targets |
| [items.md](items.md) | Item definitions and visibility, clothing categories, object subtypes, and coverage editing |
| [simulation.md](simulation.md) | Successor-engine identity, command/event/result envelopes, replay, observation, and NarrativeCut contracts |
| [meters.md](meters.md) | Continuous 0–1 meters and the mood module |
| [conditions.md](conditions.md) | Discrete, temporary states (e.g. "soaked", "exhausted") |
| [relationships.md](relationships.md) | Affinity stages, the bond classifier, and disposition (traits, preferences, tags, modulation, the guardrail) |
| [facts.md](facts.md) | The fact taxonomy and the `FactDraft` shape |
| [state.md](state.md) | The pinned JSONB shapes: the authored character, persona, scene-gen, and game time |

## How the contracts are built

The design follows `~/projects/aionchat/packages/contracts` (registry-driven, provenance-carrying, validation-heavy) but starts with a smaller vocabulary and is built to grow: **adding an attribute, meter, or fact kind is a one-file data change, never a schema migration.**

## Extension checklist

To add an attribute, meter, condition, or fact kind:

1. Edit the relevant registry file.
2. Run `vitest contracts` (the registry-invariant tests).
3. Done.

If you also need it persisted as its own column (rare — most state rides in validated JSONB), see [database.md](../database.md) for the migration workflow.
