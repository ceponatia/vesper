/**
 * Prompt-text tunables (docs/prompts.md §Style rules). Binding numeric engine
 * constants (history depth, fact cap, …) live in ../constants.ts; re-exported
 * here so prompt code has one import site for everything it renders.
 */
export { EPISODE_WINDOW, FACTS_CAP, NARRATIVE_HISTORY_TURNS, OPEN_THREADS_IN_CONTEXT } from "../constants";

export const PARAGRAPH_GUIDANCE =
  "Write 3–5 paragraphs per turn. Each turn should feel complete: resolve the immediate beat, end on a natural sentence, and do not trail off mid-thought. Prefer one focused scene moment over exhaustive cataloging of detail.";

/** Max characters of player input echoed inside agent prompts. */
export const AGENT_INPUT_CAP = 2000;
/** Max characters of narration echoed inside agent prompts. */
export const AGENT_NARRATION_CAP = 8000;
