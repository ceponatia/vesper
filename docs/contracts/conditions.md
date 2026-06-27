[← Contracts index](README.md)

# Conditions

Conditions are discrete, temporary states a character can be in — "soaked", "exhausted", "sprained ankle". They're aionchat-style and defined in `conditions/condition.ts`.

A condition can overlay attribute values while it's active:

```ts
type ConditionEffect = { attributeId: AttributeId; value: string | string[] | number | boolean };
// no source of its own — applied AS source "condition"
```

```ts
type ActiveCondition = {
  id: string;
  label: string;                    // "soaked", "exhausted", "sprained ankle"
  severity?: "minor" | "moderate" | "severe";
  startedAtMinutes: number;         // game clock
  durationMinutes?: number;         // engine expires it
  source?: { kind: "narrative" | "item" | "environment" | "manual"; id?: string };
  attributeEffects: ConditionEffect[];
  senseEffects?: { sight?: "reduced" | "blocked"; hearing?: "reduced" | "blocked" };
  promptHint?: string;
};
```

| Field | Meaning |
| --- | --- |
| `id` | Stable identifier. |
| `label` | Human-readable name. |
| `severity` | `minor` / `moderate` / `severe` (optional). |
| `startedAtMinutes` | When it began, on the game clock. |
| `durationMinutes` | How long it lasts; the engine expires it. |
| `source` | Where it came from — `narrative` / `item` / `environment` / `manual`, with an optional id. |
| `attributeEffects` | Attribute values overlaid while active, written with `source: "condition"` and `sourceId` = the condition id. |
| `senseEffects` | Perception impairment — per-sense `reduced` / `blocked` (see [perception.md](../perception.md) §Darkness). |
| `promptHint` | Optional phrasing hint for the narrator. |
