import { describe, expect, it } from "vitest";
import { attributeRegistry } from "@/contracts";
import {
  BUST_SCALE_TO_BREAST_SIZE,
  CHEST_BUILD_NORMALIZATION,
  STRUCTURAL_CHEST_VALUES,
  sweepChatState,
  sweepEntries,
  sweepProfile,
} from "./sweep-chest-size-anatomy";

/**
 * Pure tests for the chest-build / breast-size anatomy sweep. The DB glue is a
 * CAS loop copied from the registry-defaults backfill; the risk lives in the
 * pure core: that a translation target is a real registry value (a typo would
 * rewrite good data into a value that fails `parseValue`), that the only usable
 * size value is preserved or translated rather than discarded, that structural
 * values are reported instead of invented into breast sizes, and that a second
 * pass is a no-op.
 */

const row = (id: string, value: string) => ({ id, value, source: "manual", sourceId: "x", note: "keep me" });

describe("translation tables target valid registry values", () => {
  it("every bust-scale target parses as a breasts.size and every normalization as a chest.size", () => {
    for (const target of Object.values(BUST_SCALE_TO_BREAST_SIZE)) {
      expect(attributeRegistry.parseValue("breasts.size", target).ok, target).toBe(true);
    }
    for (const target of Object.values(CHEST_BUILD_NORMALIZATION)) {
      expect(attributeRegistry.parseValue("chest.size", target).ok, target).toBe(true);
    }
    // The structural words are live chest-build vocabulary — never bust scale.
    for (const value of STRUCTURAL_CHEST_VALUES) {
      expect(attributeRegistry.parseValue("chest.size", value).ok, value).toBe(true);
      expect(BUST_SCALE_TO_BREAST_SIZE[value], value).toBeUndefined();
    }
  });
});

describe("body with the breasts region", () => {
  it("translates the only usable size value into breasts.size, keeping provenance", () => {
    const { next, report } = sweepEntries([row("chest.size", "very_full"), row("chest.hair", "none")], true, "id");
    expect(report.cases.translated_to_breast_size).toBe(1);
    expect(next).toEqual([{ ...row("breasts.size", "very_large") }, row("chest.hair", "none")]);
  });

  it("drops the superseded chest.size when breasts.size already exists — breasts.size wins untouched", () => {
    const breast = row("breasts.size", "ample");
    const { next, report } = sweepEntries([row("chest.size", "full"), breast], true, "id");
    expect(report.cases.superseded_dropped).toBe(1);
    expect(next).toEqual([breast]);
  });

  it("reports a structural value verbatim instead of inventing a breast size", () => {
    const raw = [row("chest.size", "barrel")];
    const { next, report } = sweepEntries(raw, true, "id");
    expect(report.changes).toBe(0);
    expect(report.cases.structural_untranslatable).toBe(1);
    expect(report.reported).toEqual(["barrel"]);
    expect(next).toBe(raw);
  });
});

describe("body without the breasts region", () => {
  it("normalizes removed euphemisms onto the chest-build scale and keeps structural values", () => {
    const { next, report } = sweepEntries([row("chest.size", "very_full"), row("chest.size", "broad")], false, "id");
    expect(report.cases.normalized_chest_build).toBe(1);
    expect(next).toEqual([row("chest.size", "broad"), row("chest.size", "broad")]);
  });

  it("never touches breasts.size rows — the region toggle, not the sweep, governs them", () => {
    const raw = [row("breasts.size", "modest"), row("chest.size", "average")];
    const { next, report } = sweepEntries(raw, false, "id");
    expect(report.changes).toBe(0);
    expect(next).toBe(raw);
  });
});

describe("rerun safety and the storage wrappers", () => {
  it("a second pass over swept output plans zero changes", () => {
    const on = sweepEntries([row("chest.size", "modest")], true, "id");
    expect(sweepEntries(on.next, true, "id").report.changes).toBe(0);
    const off = sweepEntries([row("chest.size", "modest")], false, "id");
    expect(sweepEntries(off.next, false, "id").report.changes).toBe(0);
  });

  it("a profile sweeps by its own body-config; unrelated elements pass through by reference", () => {
    const loose = { nonsense: true };
    const withBreasts = sweepProfile({ intimateRegions: ["vulva", "breasts"], attributes: [row("chest.size", "slight"), loose] });
    expect(withBreasts.next).toMatchObject({ intimateRegions: ["vulva", "breasts"] });
    const attributes = (withBreasts.next as { attributes: unknown[] }).attributes;
    expect(attributes[0]).toEqual(row("breasts.size", "nearly_flat"));
    expect(attributes[1]).toBe(loose);
    const without = { intimateRegions: [], attributes: [row("chest.size", "slight")] };
    expect(sweepProfile(without).next).toBe(without);
  });

  it("a chat-state row sweeps overlays and condition effects with the character's breasts state", () => {
    const swept = sweepChatState(
      {
        overlays: [row("chest.size", "full")],
        conditions: [{ id: "c", label: "c", attributeEffects: [{ attributeId: "chest.size", value: "modest" }] }],
      },
      true,
    );
    expect(swept.report.cases.translated_to_breast_size).toBe(2);
    expect(swept.overlays).toEqual([row("breasts.size", "full")]);
    expect(swept.conditions).toEqual([{ id: "c", label: "c", attributeEffects: [{ attributeId: "breasts.size", value: "modest" }] }]);
  });
});
