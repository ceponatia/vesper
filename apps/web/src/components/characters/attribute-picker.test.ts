/**
 * The character sheet's Chest section (docs/authoring/manual-editing.md §The
 * character editor; the applicability rule is docs/contracts/body.md §The
 * realized body, owned by species/realize.test.ts).
 *
 * Renders the real picker through react-dom/server — the accordion is
 * prop-driven, so one open section's static markup is what the browser shows —
 * and proves the two things the registry cannot: the applicable `breasts.*`
 * controls are rows of the Chest section itself, with no nested "Breasts"
 * sub-group heading, and the picker's only visibility rule is the realized
 * body, so toggling the breasts region swaps chest build + chest hair for the
 * breast rows whatever the gender label says. Falsified against the earlier
 * picker, which wrapped the breast rows in a headed, railed sub-group, and
 * against one that keys the swap off `identity.gender`.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { attributeGroups, type AttributeValue } from "@/contracts";
import { AttributePicker } from "./attribute-picker";

/** Every row label of a category, in registry order — the picker's promised order. */
const labelsOf = (category: string): string[] =>
  attributeGroups.find((g) => g.category === category)?.definitions.map((d) => d.label) ?? [];

const gender = (value: string): AttributeValue => ({ id: "identity.gender", value, source: "manual" });

/** The Chest section's markup with the region set as given (the picker is controlled). */
function chestSection(intimateRegions: readonly string[], values: readonly AttributeValue[]): string {
  const html = renderToStaticMarkup(
    createElement(AttributePicker, { values, onChange: () => undefined, intimateRegions, defaultOpenSection: "chest" }),
  );
  const section = html.split("<section").find((chunk) => chunk.includes(">chest<"));
  if (section === undefined) throw new Error("the Chest section did not render");
  return section;
}

/** Row labels in document order: each attribute row's label span carries the description as its title. */
const rowLabels = (section: string): string[] =>
  [...section.matchAll(/<(?:span|label)[^>]* title="[^"]*"[^>]*>([^<]+)<\/(?:span|label)>/g)].map((m) => m[1] ?? "");

describe("AttributePicker — the Chest section", () => {
  it("renders the breast fields as peers of the chest rows, with no nested sub-group", () => {
    // A male gender label with the breasts region on: anatomy, not gender, decides.
    const section = chestSection(["breasts", "penis", "testicles"], [gender("male")]);
    expect(rowLabels(section)).toEqual(labelsOf("breasts"));
    // No element whose whole text is the category name — the old sub-group heading.
    expect(section).not.toMatch(/>breasts</);
  });

  it("swaps back to chest build and chest hair when the region is off, whatever the gender", () => {
    const section = chestSection(["vulva"], [gender("female")]);
    expect(rowLabels(section)).toEqual(labelsOf("chest"));
  });
});
