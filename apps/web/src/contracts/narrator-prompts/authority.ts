/**
 * The narrator prompt's **authority layers** and the small node IR the builders
 * emit so one of those layers can be replaced.
 *
 * ## Why an IR at all
 *
 * The Prompt Lab lets the owner hand-write the narrator's *instructions* and run
 * one conversation on them while another stays on production. That only measures
 * anything if the rest of the prompt is untouched: the character sheet, the
 * committed state, the per-turn fences and the output contract must all still be
 * there. So the builders stop being "a big array joined with newlines" and start
 * emitting classified nodes, and ONE composer decides whether to render the
 * production instruction text or the owner's.
 *
 * The classification is the product law, not a refactor convenience:
 *
 * - `behavior` — narrator craft. Role, prose camera, pacing, richness, dialogue
 *   style, topic discipline. **This is the only layer a test prompt replaces.**
 * - `runtime_context` — authored/committed facts. Who the character is, what is
 *   true right now, what was remembered.
 * - `runtime_invariant` — fences that bound the reply whatever its style:
 *   player-agency law, perception ceilings, untrusted-data fencing, the minor
 *   fence, physical-consistency corrections.
 * - `transport_contract` — anything software downstream parses. The `[Name]`
 *   speaker-tag grammar the chat renderer segments on, the successor's strict
 *   JSON schema, the retry correction block.
 *
 * ## The sentence-level split rule (owner ruling 2026-08-26)
 *
 * Several charter units are ONE string that crosses the boundary — the viewpoint
 * rule ends with "never put words, thoughts, or actions in their mouth", which is
 * agency law, not camera craft. Classifying such a unit wholesale as `behavior`
 * would let an experiment "improve player agency" by deleting the law that
 * protects it.
 *
 * So units are split **at sentence boundaries**, and a sentence that still mixes
 * authorities takes the **strictest** one (`narratorPromptAuthorityRank`). Two
 * consequences, both deliberate:
 *
 * 1. Production stays byte-identical by construction — the split pieces rejoin
 *    with the separator they were already written with.
 * 2. The strictness tiebreak fails SAFE: a protective clause riding along with a
 *    craft clause survives every experiment; the reverse can never happen.
 */

export const narratorPromptAuthorities = [
  "behavior",
  "runtime_context",
  "runtime_invariant",
  "transport_contract",
] as const;

export type NarratorPromptAuthority = (typeof narratorPromptAuthorities)[number];

/**
 * Strictness order for the sentence-level tiebreak: when one sentence carries
 * two authorities, the higher rank wins, so a mixed sentence is never
 * replaceable. `behavior` is deliberately the only rank a test prompt can drop.
 */
export const narratorPromptAuthorityRank: Record<NarratorPromptAuthority, number> = {
  behavior: 0,
  runtime_context: 1,
  runtime_invariant: 2,
  transport_contract: 3,
};

/** The strictest of the given authorities — the sentence-level split's tiebreak. */
export function strictestAuthority(
  ...authorities: readonly NarratorPromptAuthority[]
): NarratorPromptAuthority {
  let winner: NarratorPromptAuthority = "behavior";
  for (const authority of authorities) {
    if (narratorPromptAuthorityRank[authority] > narratorPromptAuthorityRank[winner]) winner = authority;
  }
  return winner;
}

/**
 * One classified piece of prompt text. `id` is stable and semantic
 * (`camera_style`, `player_agency`) — never a displayed rule number, which moves
 * the moment a behavior rule is dropped from the middle of a numbered list.
 */
export interface NarratorPromptUnit {
  kind: "unit";
  id: string;
  authority: NarratorPromptAuthority;
  text: string;
}

/**
 * Exact bytes with no authority of their own — a heading, a separator line, a
 * block label. Always rendered, in both modes.
 */
export interface NarratorPromptLiteral {
  kind: "literal";
  text: string;
}

/**
 * Where the owner's handwritten instructions land when a test prompt is active.
 *
 * An explicit slot rather than "filter out behavior and splice the body in
 * somewhere": with a slot, placement is a property of the builder that a
 * reviewer can see, not an emergent consequence of a filter. Renders nothing in
 * production.
 */
export interface NarratorPromptBehaviorSlot {
  kind: "behavior_slot";
  id: string;
}

/**
 * An ordered join of children.
 *
 * `separator` and `dropEmpty` exist to reproduce today's byte-exact joins:
 * `[...].join("\n")` keeps empty strings (and so keeps blank lines), while
 * `[...].filter(Boolean).join("\n\n")` does not. Getting this wrong is exactly
 * how a "pure seam extraction" silently rewrites the production prompt.
 *
 * `prefix`/`suffix` render only when at least one child rendered, so a numbered
 * rule whose every sentence was dropped leaves no dangling label behind.
 */
export interface NarratorPromptGroup {
  kind: "group";
  id?: string;
  separator: string;
  /** Drop children that render to "" before joining. Mirrors `.filter(Boolean)`. */
  dropEmpty?: boolean;
  prefix?: string;
  suffix?: string;
  children: readonly NarratorPromptNode[];
}

/**
 * A contiguously numbered rule list (`How to respond:` 1…16).
 *
 * Numbers are **generated from position**, never authored into the text. Today's
 * lists are contiguous 1…n with every item present, so production renders
 * byte-identically; when an override drops behavior rules the survivors renumber
 * themselves instead of leaving gaps. Nothing anywhere may reference a rule by
 * its displayed number — bind to heading names instead, as the prompt style rules
 * already require.
 */
export interface NarratorPromptNumberedList {
  kind: "numbered_list";
  id: string;
  /** Rendered above the items when at least one item survives (e.g. "How to respond:"). */
  heading?: string;
  /** Separator between the heading and the items, and between items. */
  separator: string;
  items: readonly NarratorPromptNode[];
}

export type NarratorPromptNode =
  | NarratorPromptUnit
  | NarratorPromptLiteral
  | NarratorPromptBehaviorSlot
  | NarratorPromptGroup
  | NarratorPromptNumberedList;

/**
 * How to render a node tree.
 *
 * - `production` — every unit renders; the behavior slot renders nothing. This
 *   MUST be byte-identical to the pre-Prompt-Lab prompt, which the existing
 *   snapshot/byte-stability tests are the gate for.
 * - `override` — every `behavior` unit renders nothing; the behavior slot renders
 *   the resolved custom body. Context, invariants and transport contracts are
 *   untouched.
 */
export type NarratorPromptRenderMode =
  | { kind: "production" }
  | { kind: "override"; body: string };

function renderNode(node: NarratorPromptNode, mode: NarratorPromptRenderMode): string {
  switch (node.kind) {
    case "literal":
      return node.text;
    case "unit":
      return mode.kind === "override" && node.authority === "behavior" ? "" : node.text;
    case "behavior_slot":
      return mode.kind === "override" ? mode.body : "";
    case "group": {
      const rendered = node.children.map((child) => renderNode(child, mode));
      const kept = node.dropEmpty ? rendered.filter((text) => text.length > 0) : rendered;
      if (kept.every((text) => text.length === 0)) return "";
      return `${node.prefix ?? ""}${kept.join(node.separator)}${node.suffix ?? ""}`;
    }
    case "numbered_list": {
      const kept = node.items.map((item) => renderNode(item, mode)).filter((text) => text.length > 0);
      if (kept.length === 0) return "";
      const numbered = kept.map((text, index) => `${index + 1}. ${text}`);
      return node.heading ? [node.heading, ...numbered].join(node.separator) : numbered.join(node.separator);
    }
  }
}

/** Render one node tree. See `NarratorPromptRenderMode` for the two modes. */
export function renderNarratorPrompt(
  nodes: readonly NarratorPromptNode[],
  mode: NarratorPromptRenderMode,
): string {
  return renderNode({ kind: "group", separator: "", children: nodes }, mode);
}

/**
 * Every unit in a tree, in render order — the classification tests' handle on a
 * builder. With the unit's authority AND text in hand a test can state the whole
 * law generically ("every non-behavior unit's exact text survives an override,
 * every behavior unit's does not") instead of hand-listing ids that go stale.
 */
export function narratorPromptUnits(nodes: readonly NarratorPromptNode[]): NarratorPromptUnit[] {
  const units: NarratorPromptUnit[] = [];
  const walk = (node: NarratorPromptNode): void => {
    if (node.kind === "unit") units.push(node);
    else if (node.kind === "group") node.children.forEach(walk);
    else if (node.kind === "numbered_list") node.items.forEach(walk);
  };
  nodes.forEach(walk);
  return units;
}

/** Every unit id in a tree, in render order. */
export function narratorPromptUnitIds(nodes: readonly NarratorPromptNode[]): string[] {
  return narratorPromptUnits(nodes).map((unit) => unit.id);
}

/** Total characters a tree contributes per authority — the provenance's token-shape read. */
export function narratorPromptAuthorityWeights(
  nodes: readonly NarratorPromptNode[],
): Record<NarratorPromptAuthority, number> {
  const weights: Record<NarratorPromptAuthority, number> = {
    behavior: 0,
    runtime_context: 0,
    runtime_invariant: 0,
    transport_contract: 0,
  };
  const walk = (node: NarratorPromptNode): void => {
    if (node.kind === "unit") weights[node.authority] += node.text.length;
    else if (node.kind === "group") node.children.forEach(walk);
    else if (node.kind === "numbered_list") node.items.forEach(walk);
  };
  nodes.forEach(walk);
  return weights;
}
