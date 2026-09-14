import { describe, expect, it } from "vitest";
import type { AttributeValue } from "../attributes";
import {
  APPEARANCE_REVISION_FAMILY,
  APPEARANCE_REVISION_META_KEY,
  appearanceRevisionOf,
  compareAppearanceRevision,
  readAppearanceRevision,
} from "./appearance-revision";

/**
 * THE APPEARANCE REVISION (issue #551).
 *
 * The stamp decides, on every reference-anchored render, whether a person's
 * hair and build are stated in text or preserved from the photograph. Both ways
 * of getting it wrong are silent in the output — a render that restates hair the
 * image already carries, and a render that says nothing about hair because it
 * trusted an image that no longer has it — so this suite owns the three claims
 * the seam builds on:
 *
 * - the same appearance always digests to the same string, whatever order the
 *   attributes arrive in (two sites compute it at two moments; a revision that
 *   moved with list order would compare every reference as stale);
 * - a real appearance change moves it, and a change to something no render
 *   draws does not (an over-sensitive revision never earns `matches` and the
 *   contract does nothing; an under-sensitive one hands hair to a stale image);
 * - an absent or foreign stamp is `unknown`, never a verdict.
 */

const BASE: readonly AttributeValue[] = [
  { id: "identity.apparent_age", value: "late_twenties", source: "base" },
  { id: "identity.gender", value: "female", source: "base" },
  { id: "skin.tone", value: "brown", source: "base" },
  { id: "hair.color", value: "platinum", source: "base" },
  { id: "hair.length", value: "shoulder_length", source: "base" },
  { id: "eyes.color", value: "blue", source: "base" },
  { id: "build.frame", value: "sturdy", source: "base" },
  { id: "voice.timbre", value: "gravelly", source: "base" },
];

const replacing = (id: string, value: string): readonly AttributeValue[] =>
  BASE.map((entry) => (entry.id === id ? { ...entry, value } : entry));

describe("appearanceRevisionOf", () => {
  it("digests one appearance to one string, whatever order the attributes arrive in", () => {
    const forward = appearanceRevisionOf(BASE);
    const reversed = appearanceRevisionOf([...BASE].reverse());

    expect(forward).toBe(appearanceRevisionOf(BASE));
    // The mint and the compile seam read the same resolved attributes from two
    // different assemblies; only the SET is guaranteed to agree on order.
    expect(reversed).toBe(forward);
    expect(forward.startsWith(`${APPEARANCE_REVISION_FAMILY}:`)).toBe(true);
  });

  it("moves when the hair moves, and again when the build moves", () => {
    const base = appearanceRevisionOf(BASE);

    // A haircut: the acceptance scenario's own change.
    expect(appearanceRevisionOf(replacing("hair.length", "chin_length"))).not.toBe(base);
    expect(appearanceRevisionOf(replacing("build.frame", "delicate"))).not.toBe(base);
  });

  it("ignores an attribute no render ever draws", () => {
    // `voice.timbre` is a real attribute the character carries and no image
    // states. A revision that moved with it would report an appearance change
    // for a conversation about how somebody sounds, and every reference
    // anchored on that character would restate hair it had no reason to.
    expect(appearanceRevisionOf(replacing("voice.timbre", "breathy"))).toBe(appearanceRevisionOf(BASE));
  });
});

describe("compareAppearanceRevision", () => {
  const current = appearanceRevisionOf(BASE);

  it("reads an identical stamp as `matches` and a moved one as `differs`", () => {
    expect(compareAppearanceRevision(current, current)).toBe("matches");
    expect(compareAppearanceRevision(appearanceRevisionOf(replacing("hair.length", "chin_length")), current)).toBe(
      "differs",
    );
  });

  it("reads a missing stamp as `unknown`, never as a change", () => {
    // Every reference minted before this contract existed, and every uploaded
    // portrait. `differs` here would put an appearance-change clause on renders
    // nothing is known about.
    expect(compareAppearanceRevision(null, current)).toBe("unknown");
    expect(compareAppearanceRevision(undefined, current)).toBe("unknown");
    expect(compareAppearanceRevision("", current)).toBe("unknown");
    expect(compareAppearanceRevision(current, null)).toBe("unknown");
  });

  it("reads a stamp from another revision family as `unknown`", () => {
    // The family says WHICH input set the digest was taken over. Two families
    // answer different questions, so the day the input set is revised, every
    // stamp written under the old one has to degrade rather than report that
    // every character in the product just changed appearance.
    expect(compareAppearanceRevision("v0:1a2b3c4d", current)).toBe("unknown");
    expect(compareAppearanceRevision("1a2b3c4d", current)).toBe("unknown");
  });
});

describe("readAppearanceRevision", () => {
  const revision = appearanceRevisionOf(BASE);
  const meta = { [APPEARANCE_REVISION_META_KEY]: { "chr-1": revision } };

  it("reads the named subject's stamp off a rendered row", () => {
    expect(readAppearanceRevision(meta, "chr-1")).toBe(revision);
  });

  it("degrades to null on anything a stored row can actually hold", () => {
    // Image metadata is a trust boundary: these rows predate the contract, and
    // a reader that threw would fail a render over provenance.
    expect(readAppearanceRevision(meta, "chr-2")).toBeNull();
    expect(readAppearanceRevision(null, "chr-1")).toBeNull();
    expect(readAppearanceRevision("not an object", "chr-1")).toBeNull();
    expect(readAppearanceRevision([], "chr-1")).toBeNull();
    expect(readAppearanceRevision({}, "chr-1")).toBeNull();
    expect(readAppearanceRevision({ [APPEARANCE_REVISION_META_KEY]: "v1:1a2b3c4d" }, "chr-1")).toBeNull();
    expect(readAppearanceRevision({ [APPEARANCE_REVISION_META_KEY]: { "chr-1": 7 } }, "chr-1")).toBeNull();
  });
});
