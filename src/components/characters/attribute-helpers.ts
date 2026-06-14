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

/**
 * First enum member eligible to be an automatic default — skips any the
 * registry marks `autoDefaultExcludes` (e.g. minor apparent ages), falling back
 * to the bare first value if exclusion would leave nothing.
 */
function firstAutoDefault(def: AttributeDefinition): string | undefined {
  const values = def.allowedValues;
  if (!values || values.length === 0) return undefined;
  const excl = def.autoDefaultExcludes;
  if (excl && excl.length > 0) {
    const eligible = values.find((v) => !excl.includes(v));
    if (eligible !== undefined) return eligible;
  }
  return values[0];
}

/** Default value for a definition when first added, by value type. */
export function defaultValueFor(def: AttributeDefinition): AttributeValue["value"] {
  switch (def.valueType) {
    case "enum":
      return firstAutoDefault(def) ?? "";
    case "enum_list": {
      const first = firstAutoDefault(def);
      return first !== undefined ? [first] : [];
    }
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
