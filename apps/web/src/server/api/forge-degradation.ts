import type { Diagnostic } from "@/contracts";

/** The three legs `forgeCharacter` runs, by their `generateChecked` code. */
export const FORGE_CHARACTER_LEG_CODES = ["forge.character.profile", "forge.character.attributes", "forge.character.outfit"] as const;

/**
 * What a leg records when its model output did not survive (server/ai
 * `generateChecked` / `generateCheckedBounded`):
 * - `degraded` (info): the leg's fallback or schema defaults replaced the
 *   model output, which in a create run is hand-written demo content.
 * - `timeout` (warn): the leg ran out of time and its fallback was substituted
 *   without a `degraded` line.
 * - `parse_failed` / `api_error` (error unless the caller lowers it): the call
 *   failed; the `degraded` line that follows is present only with a fallback.
 * A `repaired` line is not among them: the repaired output is the model's.
 */
export const FORGE_LEG_FALLBACK_SUFFIXES = ["degraded", "timeout", "parse_failed", "api_error"] as const;

const fallbackCodes: ReadonlySet<string> = new Set(
  FORGE_CHARACTER_LEG_CODES.flatMap((leg) => FORGE_LEG_FALLBACK_SUFFIXES.map((suffix) => `${leg}.${suffix}`)),
);

/**
 * Whether a character Forge result carries fallback content or a failure:
 * any leg recorded one of the fallback codes above, or anything recorded an
 * error. Such a result is never applied without review, because demo content
 * is only for human-reviewed drafts (server/authoring/character-forge/types.ts).
 */
export function isDegradedForgeResult(diagnostics: readonly Pick<Diagnostic, "severity" | "code">[]): boolean {
  return diagnostics.some((item) => item.severity === "error" || fallbackCodes.has(item.code));
}
