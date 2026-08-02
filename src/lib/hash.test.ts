import { describe, expect, it } from "vitest";
import { fnv1a32, fnv1aHex } from "./hash";

/**
 * GOLDEN DETERMINISM PINS — never "update to fix" a failure here.
 *
 * These values were computed from the five hand-rolled FNV-1a copies this module
 * replaced (image-pipeline-consolidation.plan.md C10), BEFORE any of them moved.
 * Two callers treat this hash as a contract, and both fail SILENTLY if it drifts:
 *
 * - **The character forge's seed reproducibility.** `groundSocialCards` mints
 *   `card_<base36>` ids from the label hash, and `fillVisualDefaults` indexes a
 *   vocabulary pool by it. Move the hash and the same seed stops producing the
 *   same character — nothing throws, the forge just quietly stops being
 *   reproducible.
 * - **The chat-look cache key.** `chatLookKey` hashes a chat's outfit state into
 *   the `meta.lookKey` that decides whether the cached look anchor is stale. Move
 *   the hash and every existing chat's key misses on the next turn, silently
 *   re-rendering its look anchor against the provider.
 *
 * So a failure below is NOT a stale expectation — it is the invisible breakage
 * this file exists to make loud. Fix the hash, never the pin.
 */

describe("fnv1a32 — golden determinism pins", () => {
  it("hashes the empty string to the FNV-1a offset basis", () => {
    expect(fnv1a32("")).toBe(0x811c9dc5);
    expect(fnv1a32("")).toBe(2166136261); // the decimal spelling three of the copies used
  });

  it("reproduces the pre-consolidation values for representative inputs", () => {
    expect(fnv1a32("a")).toBe(0xe40c292c);
    expect(fnv1a32("vesper")).toBe(0x0556fe14);
    // A forge card key (the normalized label groundSocialCards hashes).
    expect(fnv1a32("her art is not negotiable")).toBe(0x5d83d76a);
    // A forge visual-default seed (`${seedText}::${def.id}`).
    expect(fnv1a32("a quiet librarian with a secret::hair.color")).toBe(0xb82396fc);
  });

  it("walks UTF-16 code units, so non-ASCII and surrogate pairs stay stable", () => {
    expect(fnv1a32("Ünïcødé — 日本語 🌙")).toBe(0x8d9f29f8);
  });

  it("always returns an unsigned 32-bit integer", () => {
    for (const text of ["", "a", "vesper", "her art is not negotiable", "Ünïcødé — 日本語 🌙"]) {
      const hash = fnv1a32(text);
      expect(Number.isInteger(hash)).toBe(true);
      expect(hash).toBeGreaterThanOrEqual(0);
      expect(hash).toBeLessThanOrEqual(0xffffffff);
    }
  });

  it("pins the base36 form the forge mints card ids from", () => {
    expect(`card_${fnv1a32("her art is not negotiable").toString(36)}`).toBe("card_py3fje");
    expect(`card_${fnv1a32("rule a").toString(36)}`).toBe("card_u70kl4");
  });
});

describe("fnv1aHex — golden determinism pins", () => {
  it("reproduces the pre-consolidation 8-char hex for representative inputs", () => {
    expect(fnv1aHex("")).toBe("811c9dc5");
    expect(fnv1aHex("a")).toBe("e40c292c");
    expect(fnv1aHex("her art is not negotiable")).toBe("5d83d76a");
    expect(fnv1aHex("Ünïcødé — 日本語 🌙")).toBe("8d9f29f8");
  });

  it("zero-pads to a fixed 8 characters (a short hash must not shorten the key)", () => {
    // 0x0556fe14 — the leading zero is load-bearing for any key comparing lengths.
    expect(fnv1aHex("vesper")).toBe("0556fe14");
    for (const text of ["", "a", "vesper", "Ünïcødé — 日本語 🌙", JSON.stringify({ a: 1, b: [2, 3] })]) {
      expect(fnv1aHex(text)).toHaveLength(8);
    }
  });

  it("is the hex rendering of fnv1a32", () => {
    for (const text of ["", "a", "vesper", "her art is not negotiable"]) {
      expect(fnv1aHex(text)).toBe(fnv1a32(text).toString(16).padStart(8, "0"));
    }
  });

  it("pins the simulationHash checksum shape (lib/simulation/hash.ts hashes serialized JSON through here)", () => {
    expect(fnv1aHex(JSON.stringify({ a: 1, b: [2, 3] }))).toBe("2c571be4");
  });
});
