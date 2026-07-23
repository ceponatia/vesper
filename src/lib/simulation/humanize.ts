/**
 * Pure id/verb humanizers shared by the successor prompt builders
 * (`server/engine/prompts/sim-render.ts` for co-present cuts,
 * `sim-solo-render.ts` for the dual-block solo cut, and `solo-cut.ts` for the
 * deterministic fallback prose). No IO — string shaping only — so both the
 * server prompt layer and the pure lib solo builder use ONE copy (jscpd stays
 * quiet, and the two prompt surfaces can never drift on how a raw id reads).
 */

/** Collapse id punctuation to spaces — the last-resort zone/name humanizer. */
export function humanizeId(id: string): string {
  return id.replace(/[_.\-:/]+/g, " ").trim();
}

const VOWEL_START = /^[aeiou]/i;

/** Naive verb → gerund for humanizing action ids ("prepare" → "preparing"). */
function toGerund(verb: string): string {
  if (verb.endsWith("ing")) return verb;
  if (verb.length > 2 && verb.endsWith("e") && !verb.endsWith("ee")) return `${verb.slice(0, -1)}ing`;
  return `${verb}ing`;
}

/**
 * Humanize an action-definition id into a verb phrase ("prepare_meal" →
 * "preparing a meal"), keeping only the last namespaced segment. A single-word
 * id becomes its own gerund ("resting" → "resting").
 */
export function humanizeActivity(actionDefinitionId: string): string {
  const base = actionDefinitionId.split(/[.:/]/).pop() ?? actionDefinitionId;
  const words = base.split("_").filter(Boolean);
  if (words.length === 0) return humanizeId(actionDefinitionId);
  const [verb, ...rest] = words;
  const gerund = toGerund(verb ?? base);
  if (rest.length === 0) return gerund;
  const object = rest.join(" ");
  return `${gerund} ${VOWEL_START.test(object) ? "an" : "a"} ${object}`;
}
