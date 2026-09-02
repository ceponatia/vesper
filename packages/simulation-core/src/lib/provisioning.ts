import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { z } from "zod";
import { composeSimulationId } from "../contracts/identity";
import { simulationHash } from "./hash";

/**
 * Pure identity derivation for successor-world provisioning (ruling E20-3).
 *
 * Provisioning used to mint `stamp = newId()` per call, so every retry after a
 * partial failure built a SECOND complete world and the seeders'
 * `(branchId, idempotencyKey)` dedupe could never fire. The stamp is now
 * DERIVED from the client's idempotency key, which makes every
 * `stw-${stamp}-…` id — world, branch, actors, zones, seeder command keys, the
 * branch-derived relationship-seed keys — stable across retries. A resume then
 * completes a half-built world instead of duplicating it.
 *
 * No IO, no clock, no ambient randomness: the same key always names the same
 * world, on any machine, forever.
 *
 * The digest comes from `@noble/hashes` rather than `node:crypto` because this
 * package is browser/server portable and its runtime source may not import a
 * Node built-in. sha256 is sha256, so the stamps are unchanged — and they are
 * PERSISTED world identities, so `sha256-parity.test.ts` pins byte equality
 * against `node:crypto` for this exact material format rather than trusting the
 * claim.
 */

/**
 * Stamp width, matching `newId()`'s cuid2 (24 chars). Hex is a strict subset of
 * cuid2's lowercase-alphanumeric alphabet, so every `stw-${stamp}-…` id keeps
 * exactly the shape the old minted ids had — and 96 bits of sha256 makes a
 * collision between two distinct keys unreachable in practice.
 */
export const PROVISIONING_STAMP_LENGTH = 24;

/**
 * The world identity for one `(ownerId, requestId)` provisioning key.
 * Length-prefixed through {@link composeSimulationId} so a delimiter-bearing
 * owner or request id can never alias another pair's stamp.
 */
export function deriveProvisioningStamp(ownerId: string, requestId: string): string {
  const material = composeSimulationId("stw-stamp", [ownerId, requestId]);
  return bytesToHex(sha256(utf8ToBytes(material))).slice(0, PROVISIONING_STAMP_LENGTH);
}

/**
 * The client's idempotency token: bounded and whitespace-free so it is a safe
 * database key and safe hash material. REQUIRED on the create body — unlike the
 * sim-command lane (which degrades a missing token to a server-minted id,
 * losing only cross-request dedupe for that call), a missing token here would
 * mean provisioning could not promise "one world per tap" at all.
 */
export const provisioningRequestIdSchema = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => value.trim() === value, "request ids cannot have surrounding whitespace")
  .refine((value) => !/\s/u.test(value), "request ids cannot contain whitespace");

/**
 * The `error` a provisioning record carries once the world it recorded no
 * longer exists — the chat (and with it the whole `sim_worlds` graph) was
 * deleted after the record reached `ready`.
 *
 * A stable, greppable marker rather than a free-text message. Two writers set
 * it — the chat delete that made the world disappear, and the front door when
 * its own replay check finds the graph gone — and the front door READS it, so
 * a record retired by a delete answers the same typed refusal a record it
 * caught itself would. An operator reading the ledger can also tell this apart
 * from a genuine build failure, which is why the marker survives the refusal
 * instead of being cleared. It is never returned to the caller;
 * `sim_provisioning_requests.error` is operator-facing.
 */
export const PROVISIONING_STALE_AFTER_DELETE =
  "stale_after_delete: the chat/world this request created no longer exists";

/** What a provisioning request asked for — the hash's canonical input. */
export interface ProvisioningPayload {
  characterId: string;
  /** The trimmed title, or "" when the caller left it to the default. */
  title: string;
}

/**
 * Canonical hash of what was asked for, reusing the shared `simulationHash`
 * canonicalization (the same one `sim_command_requests` records). A same-key
 * resubmit carrying a DIFFERENT payload is a client bug — never an unrelated
 * replay — so the route answers `idempotency_mismatch` instead.
 */
export function provisioningPayloadHash(payload: ProvisioningPayload): string {
  return simulationHash({ characterId: payload.characterId, title: payload.title });
}
