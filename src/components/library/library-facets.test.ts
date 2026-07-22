import { describe, expect, it } from "vitest";
import {
  characterCardChips,
  characterFacetDefs,
  locationCardChips,
  locationFacetDefs,
  socialCardChips,
  socialCardFacetDefs,
} from "./library-facets";

const facet = <T>(defs: { id: string; value?: (c: T) => string | undefined; values?: (c: T) => readonly string[]; matches?: (v: string | undefined, o: string) => boolean }[], id: string) => {
  const def = defs.find((d) => d.id === id);
  if (!def) throw new Error(`missing facet ${id}`);
  return def;
};

describe("characterFacetDefs", () => {
  const defs = characterFacetDefs<{ speciesId?: string | null; gender?: string | null }>();

  it("collapses natal-sex gender variants into one browse chip", () => {
    const gender = facet(defs, "gender");
    expect(gender.matches?.("female", "female")).toBe(true);
    expect(gender.matches?.("androgynous_born_female", "androgynous")).toBe(true);
    expect(gender.matches?.("nonbinary_born_male", "nonbinary")).toBe(true);
    // "female" must not leak into "male", nor a born-variant into its natal sex.
    expect(gender.matches?.("female", "male")).toBe(false);
    expect(gender.matches?.("androgynous_born_female", "female")).toBe(false);
    expect(gender.matches?.(undefined, "female")).toBe(false);
  });

  it("chips show notable species, never a bare Human chip", () => {
    expect(characterCardChips({ speciesId: "elf" }).map((c) => c.label)).toEqual(["Elf"]);
    expect(characterCardChips({ speciesId: "human" })).toEqual([]);
  });
});

describe("locationFacetDefs", () => {
  it("facets on scale; chips label it", () => {
    const defs = locationFacetDefs<{ scale?: string | null }>();
    expect(facet(defs, "scale").value?.({ scale: "hall" })).toBe("hall");
    expect(facet(defs, "scale").value?.({ scale: null })).toBeUndefined();
    expect(locationCardChips({ scale: "expanse" }).map((c) => c.label)).toEqual(["Expanse"]);
    // An unknown stored scale renders no chip rather than a raw id.
    expect(locationCardChips({ scale: "weird" })).toEqual([]);
  });
});

describe("socialCardFacetDefs", () => {
  const card = (severity: number, triggers: string[] = []) => ({
    card: { kind: "taboo" as const, triggers, severity, reactionOverrides: [] },
  });
  const defs = socialCardFacetDefs<ReturnType<typeof card>>();

  it("derives the severity tier facet from the stored severity", () => {
    const tier = facet(defs, "tier");
    expect(tier.value?.(card(10))).toBe("odd");
    expect(tier.value?.(card(40))).toBe("disapproval");
    expect(tier.value?.(card(60))).toBe("shunning");
    expect(tier.value?.(card(90))).toBe("ostracized");
    expect(tier.value?.({ card: undefined } as never)).toBeUndefined();
  });

  it("matches triggers as a multi-value facet", () => {
    const trigger = facet(defs, "trigger");
    expect(trigger.values?.(card(40, ["touch", "kiss"]))).toEqual(["touch", "kiss"]);
    expect(trigger.values?.({ card: undefined } as never)).toEqual([]);
  });

  it("chips lead with the tier then at most two known trigger labels", () => {
    const chips = socialCardChips(card(90, ["unknown_concept_id"]));
    expect(chips[0]?.label).toBe("Ostracized");
    // Unknown concept ids are dropped, never rendered raw.
    expect(chips).toHaveLength(1);
  });
});
