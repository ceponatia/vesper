/// <reference types="node" />
import { createHash } from "node:crypto";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";
import { composeSimulationId } from "./contracts/identity";
import { deterministicDrawUnit } from "./contracts/scheduler";
import { PROVISIONING_STAMP_LENGTH, deriveProvisioningStamp } from "./lib/provisioning";

/**
 * PERSISTED-DIGEST EQUIVALENCE PINS — the only place this package names
 * `node:crypto`.
 *
 * Two runtime call sites used to hash with `createHash("sha256")`:
 * `contracts/scheduler.ts`'s `deterministicDrawUnit` (which decides scheduler
 * draws recorded in the event log) and `lib/provisioning.ts`'s
 * `deriveProvisioningStamp` (which NAMES a successor world — `stw-${stamp}-…`
 * is the row id of the world, its branch, its actors and its zones). A
 * browser/server portable package may not import a Node built-in, so both moved
 * to `@noble/hashes`.
 *
 * Their outputs are durable identifiers: a digest that changed by one byte
 * would silently orphan every existing world and re-roll every scheduler draw.
 * So this file does not take "sha256 is sha256" on faith — it hashes the EXACT
 * material each call site builds, both ways, and compares bytes.
 *
 * A test file may import `node:crypto`; runtime source may not. That asymmetry
 * is the point: the Node implementation is the reference, kept only here.
 *
 * A failure below is NOT a stale expectation — it means the portable hash stopped
 * agreeing with the one that minted the identifiers already in the database.
 */

/** The reference implementation these call sites were written against. */
function nodeDigest(material: string): Uint8Array {
  return new Uint8Array(createHash("sha256").update(material).digest());
}

/** Materials in the two shapes the call sites actually compose, ASCII and not. */
const DRAW_MATERIALS = [
  { worldSeed: "seed-1", branchId: "branch-1", stream: "activity", drawIndex: 0 },
  { worldSeed: "seed-1", branchId: "branch-1", stream: "activity", drawIndex: 9_007_199_254_740_991 },
  { worldSeed: "", branchId: "", stream: "", drawIndex: 0 },
  // Multi-byte UTF-8: `composeSimulationId` length-prefixes with the UTF-16
  // string length while the digest consumes UTF-8 bytes, so a name outside the
  // BMP is where a byte/char confusion would show up.
  { worldSeed: "種-🌙", branchId: "分岐-é", stream: "日本語 stream", drawIndex: 42 },
  { worldSeed: "a:b", branchId: "c:d", stream: "e:f", drawIndex: 7 },
] as const;

const STAMP_MATERIALS = [
  { ownerId: "user-1", requestId: "req-1" },
  { ownerId: "", requestId: "" },
  { ownerId: "uxtestmaina1b2c3d4e5f6g7", requestId: "stw-2026-08-13T00:00:00.000Z" },
  { ownerId: "オーナー-🌙", requestId: "リクエスト-é" },
  { ownerId: "a:b", requestId: "c:d" },
] as const;

describe("deterministicDrawUnit — digest parity with node:crypto", () => {
  it("hashes the draw material to identical bytes", () => {
    for (const input of DRAW_MATERIALS) {
      const material = composeSimulationId("draw", [
        input.worldSeed,
        input.branchId,
        input.stream,
        String(input.drawIndex),
      ]);
      expect(Array.from(sha256(utf8ToBytes(material)))).toEqual(Array.from(nodeDigest(material)));
    }
  });

  it("produces the same unit draw the node implementation did", () => {
    for (const input of DRAW_MATERIALS) {
      const material = composeSimulationId("draw", [
        input.worldSeed,
        input.branchId,
        input.stream,
        String(input.drawIndex),
      ]);
      const bytes = createHash("sha256").update(material).digest();
      const expected = (bytes.readUInt32BE(0) * 2 ** 21 + (bytes.readUInt32BE(4) >>> 11)) / 2 ** 53;
      expect(deterministicDrawUnit(input)).toBe(expected);
      expect(deterministicDrawUnit(input)).toBeGreaterThanOrEqual(0);
      expect(deterministicDrawUnit(input)).toBeLessThan(1);
    }
  });
});

describe("deriveProvisioningStamp — hex parity with node:crypto", () => {
  it("hashes the stamp material to the identical hex digest", () => {
    for (const input of STAMP_MATERIALS) {
      const material = composeSimulationId("stw-stamp", [input.ownerId, input.requestId]);
      expect(bytesToHex(sha256(utf8ToBytes(material)))).toBe(createHash("sha256").update(material).digest("hex"));
    }
  });

  it("mints the identical 24-character stamp the node implementation did", () => {
    for (const input of STAMP_MATERIALS) {
      const material = composeSimulationId("stw-stamp", [input.ownerId, input.requestId]);
      const expected = createHash("sha256").update(material).digest("hex").slice(0, PROVISIONING_STAMP_LENGTH);
      const stamp = deriveProvisioningStamp(input.ownerId, input.requestId);
      expect(stamp).toBe(expected);
      expect(stamp).toHaveLength(PROVISIONING_STAMP_LENGTH);
      expect(stamp).toMatch(/^[0-9a-f]+$/u);
    }
  });
});
