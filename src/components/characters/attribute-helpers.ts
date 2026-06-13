import type { AttributeDefinition, AttributeValue } from "@/contracts";

/** Pure helpers behind the registry-driven attribute picker. */

export function attributeValueMap(values: readonly AttributeValue[]): Map<string, AttributeValue> {
  const map = new Map<string, AttributeValue>();
  for (const value of values) map.set(value.id, value);
  return map;
}

/** Upsert with `source: "manual"` — touching an AI value claims it (docs/authoring.md). */
export function setAttribute(
  values: readonly AttributeValue[],
  id: AttributeValue["id"],
  value: AttributeValue["value"],
): AttributeValue[] {
  const next: AttributeValue = { id, value, source: "manual" };
  const index = values.findIndex((v) => v.id === id);
  if (index < 0) return [...values, next];
  return values.map((v, i) => (i === index ? next : v));
}

export function removeAttribute(values: readonly AttributeValue[], id: string): AttributeValue[] {
  return values.filter((v) => v.id !== id);
}

/** AI chip shows for forge-sourced values until the human touches them. */
export function isAiSourced(value: AttributeValue): boolean {
  return value.source === "creation";
}

export interface SliderBounds {
  min: number;
  max: number;
  step: number;
}

/** Sensible slider bounds for number attributes missing explicit min/max. */
export function sliderBounds(def: Pick<AttributeDefinition, "min" | "max">): SliderBounds {
  const min = def.min ?? 0;
  const max = def.max ?? (def.min !== undefined ? def.min + 100 : 1);
  const range = max - min;
  const step = range > 10 ? 1 : range > 2 ? 0.5 : 0.05;
  return { min, max, step };
}

/** Default value for a definition when first added, by value type. */
export function defaultValueFor(def: AttributeDefinition): AttributeValue["value"] {
  switch (def.valueType) {
    case "enum":
      return def.allowedValues?.[0] ?? "";
    case "enum_list":
      return def.allowedValues?.[0] !== undefined ? [def.allowedValues[0]] : [];
    case "number": {
      const { min, max } = sliderBounds(def);
      return (min + max) / 2;
    }
    case "text":
      return "";
    case "flag":
      return true;
  }
}

/** Coerce a stored value into the list shape an enum_list control needs. */
export function asList(value: AttributeValue["value"]): string[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string" && value.length > 0) return [value];
  return [];
}
