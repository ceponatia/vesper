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
 * This module owns the HEADINGS as well as the sentences, and for the same
 * reason the affordance block's heading is a constant: the chat lane's
 * sensory-allowance carve-out (`chatVisualStateCueCarveOut`) names the cue block
 * by heading, and a heading that drifted between the block and the carve-out
 * would leave the allowance exempting a block the prompt no longer calls that.
 * One constant, one owner, imported by everyone who names it.
 *
 * Pure — no state, no flag read, no IO — and it imports nothing from the lane
 * builders that call it, so the direction is one-way: `character-chat.ts` and
 * `sim-render.ts` → here.
 */

/** The must-not-contradict fence's heading. */
export const VISUAL_STATE_CONSTRAINT_BLOCK_HEADING = "True right now — do not contradict";
/** The optional-detail offer's heading — also named by the sensory-allowance carve-out. */
export const VISUAL_STATE_CUE_BLOCK_HEADING = "Visible detail worth noticing this turn";

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
