import { type NarratorPromptGroup, type NarratorPromptNode } from "@/contracts/narrator-prompts";
import { promptUnit } from "../charter";

/** An unreplaceable context section — the default for everything outside the craft layer. */
export function context(id: string, text: string): NarratorPromptNode {
  return promptUnit(id, "runtime_context", text);
}

/**
 * The `"\n\n"` join every prompt side already used, as a node. `dropEmpty` is what
 * makes it identical to today's `.filter(Boolean).join("\n\n")` — and what keeps an
 * override from leaving a blank line where a dropped craft block used to be.
 */
export function sectionGroup(id: string, children: readonly NarratorPromptNode[]): NarratorPromptGroup {
  return { kind: "group", id, separator: "\n\n", dropEmpty: true, children };
}
