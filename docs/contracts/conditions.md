# Conditions

Discrete temporary states (`conditions/condition.ts`), aionchat-style:

```ts
type ConditionEffect = { attributeId: AttributeId; value: unknown };   // no source — applied AS source "condition"

type ActiveCondition = {
  id: string;
  label: string;                    // "soaked", "exhausted", "sprained ankle"
  severity?: "minor" | "moderate" | "severe";
  startedAtMinutes: number;         // game clock
  durationMinutes?: number;         // engine expires it
  source?: { kind: "narrative" | "item" | "environment" | "manual"; id?: string };
  attributeEffects?: ConditionEffect[];  // overlaid while active with source: "condition", sourceId: condition id
  senseEffects?: { sight?: "reduced" | "blocked"; hearing?: "reduced" | "blocked" };  // perception impairment (see [perception.md](perception.md) §Darkness)
  promptHint?: string;
};
```
