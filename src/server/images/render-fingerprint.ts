import { createHash } from "node:crypto";
import {
  profileRenderControlsFingerprintJson,
  type ProfileRenderControlsFingerprintInput,
  type ProfileRenderPlan,
} from "@vesper/image-core";

/**
 * The application's half of the render fingerprint: Node SHA-256 execution.
 *
 * Deciding WHAT represents a configuration is `@vesper/image-core`'s job — it
 * reads the compiled plan and produces one deterministic string. Hashing that
 * string is Node work, and the package stays browser/server portable, so the
 * execution stays here (monorepo-image-core.spec.render-kernel.md §"Fingerprint
 * split": the package constructs, the application hashes).
 *
 * This is an ownership split, not a behavior change. `profileRenderControlsHash`
 * returns byte-for-byte what it returned when both halves lived in one function,
 * which is what lets every stored `resolved_controls_hash` keep comparing equal.
 */

/** Hex sha256 of a string. One spelling, shared by prompt and control hashes. */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * The stored fingerprint of an actually-executing configuration.
 *
 * A trial cell pins this value at planning time and re-checks it at execution;
 * a difference is a `cell_conflict` rather than a render, because a cell that
 * ran a configuration other than the one it pinned poisons the grid's evidence.
 */
export function profileRenderControlsHash(
  plan: ProfileRenderPlan,
  extra: ProfileRenderControlsFingerprintInput,
): string {
  return sha256Hex(profileRenderControlsFingerprintJson(plan, extra));
}
