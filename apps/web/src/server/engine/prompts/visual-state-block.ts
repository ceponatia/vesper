import {
  VISUAL_STATE_CONSTRAINT_BLOCK_HEADING,
  VISUAL_STATE_CUE_BLOCK_HEADING,
} from "./character-chat";

/**
 * THE VISUAL-STATE PROMPT BLOCKS, in one wording for every narrator lane.
 *
 * The visual-state projection produces two lists per subject — must-not-contradict
 * CONSTRAINTS and the ≤2 optional CUES the attention selection chose — and both
 * lanes that carry them must say the same thing about what they are. A narrator
 * that met "do not contradict" in a chat and a differently-worded fence in a
 * successor turn would be reading two instructions for one record, and the two
 * would drift the first time either was tuned.
 *
 * The two blocks are deliberately separate, and the order is fixed:
 *
 * - **Constraints** are a fence. They exist to stop the narrator contradicting
 *   what is already committed, they carry NO "weave one in" invitation, and
 *   nothing about them is change-gated — a coat that has been on for six
 *   exchanges is exactly as contradictable on the seventh.
 * - **Cues** are an offer, under the same one-detail restraint every other cue
 *   block in the app uses. The clause after the dash is why the detail is live,
 *   never something for the narrator to say.
 *
 * The constraint block comes first so the offer reads against a fence that is
 * already standing.
 *
 * Pure: the headings come from `character-chat.ts` (which also writes these two
 * blocks inline for the chat lane and owns the heading constants, because the
 * sensory-allowance carve-out names the cue block by heading), and this module
 * adds no state, no flag read and no IO. A caller decides whether to call it.
 */

export interface VisualStatePromptLines {
  /** Must-not-contradict clauses, in the digest's own order. */
  readonly constraints: readonly string[];
  /** The selected optional cues, best first — already within the selection's budget. */
  readonly cues: readonly string[];
}

function bulleted(lines: readonly string[]): string {
  return lines.map((line) => `- ${line}`).join("\n");
}

/** Blank and duplicate-whitespace lines dropped — an empty block is no block. */
function usable(lines: readonly string[]): string[] {
  return lines.map((line) => line.trim()).filter((line) => line.length > 0);
}

/** The must-not-contradict fence, or "" when the selection committed nothing. */
export function visualStateConstraintBlock(constraints: readonly string[]): string {
  const lines = usable(constraints);
  if (lines.length === 0) return "";
  return `${VISUAL_STATE_CONSTRAINT_BLOCK_HEADING} (facts already committed — say nothing that conflicts with them; there is no obligation to mention any of them):\n${bulleted(lines)}`;
}

/** The optional-detail offer, or "" when the selection chose nothing. */
export function visualStateCueBlock(cues: readonly string[]): string {
  const lines = usable(cues);
  if (lines.length === 0) return "";
  return `${VISUAL_STATE_CUE_BLOCK_HEADING} (weave at most one into the beat, in action — never an inventory, never restated once said; the clause after the dash is why it is live, not something to say):\n${bulleted(lines)}`;
}

/**
 * Both blocks as one prompt section, fence first. `""` when neither list has a
 * usable line — the caller renders no node at all, which is what keeps a lane
 * with nothing visible byte-identical to a lane with the feature switched off.
 */
export function visualStatePromptBlock(lines: VisualStatePromptLines): string {
  return [visualStateConstraintBlock(lines.constraints), visualStateCueBlock(lines.cues)]
    .filter((block) => block.length > 0)
    .join("\n\n");
}
