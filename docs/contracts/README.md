# Contracts

`src/contracts/` is the pure, IO-free heart of the domain: registries and zod schemas everything else validates against. The architecture follows `~/projects/aionchat/packages/contracts` (registry-driven, provenance-carrying, validator-heavy) with a smaller starter vocabulary, built to grow — adding an attribute, meter, or fact kind is a data change in one file, never a schema migration.

This system is documented across the files below (one per `src/contracts/` subfolder area). Each is a focused doc; start here, then read the part you're touching.

## Reading order

| Doc | What it covers |
| --- | --- |
| [attributes.md](attributes.md) | Attribute registry, definitions, the shared registry spine, provenance |
| [body.md](body.md) | Body-location tree, plans, species/heritage, the realized body, colloquial targets |
| [items.md](items.md) | ItemDefinition + visibility, clothing categories, object subtypes, coverage editing |
| [meters-actions.md](meters-actions.md) | Continuous 0–1 meters and registered timed actions |
| [conditions.md](conditions.md) | Discrete temporary states |
| [relationships.md](relationships.md) | Affinity stages, bond classifier, disposition (traits, preferences, tags, modulation, guardrail) |
| [perception.md](perception.md) | Presence / attention / salience / witness contract shapes |
| [facts.md](facts.md) | Fact taxonomy and the `FactDraft` shape |
| [state.md](state.md) | Pinned JSONB state shapes, link access, game time |
| [turns.md](turns.md) | Agent result schemas, the chunk event, the intent brief |

## Extension checklist

Adding an attribute/meter/condition/fact-kind: edit the registry file → run `vitest contracts` (registry invariant tests) → done. If you also need it persisted distinctly (rare — most state rides in validated JSONB), see [database.md](../database.md) for the migration workflow.
