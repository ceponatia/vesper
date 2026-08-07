import { streamCharacterChat, type ChatTurn } from "@/server/engine";

/**
 * Shared, campaign-neutral narrator A/B machinery.
 *
 * The old affordance-cue campaign owns a useful but closed, domain-specific
 * runner. Garment cues, visual state and later prompt treatments all need the
 * same small mechanical core: independent arm histories, production narrator
 * streaming, deterministic blinding and strict quote verification. This module
 * deliberately knows nothing about hair, garments or a decision rule; campaigns
 * supply their own fixtures, prompts and judges.
 */

export interface NarratorComparisonTurn<Arm extends string> {
  player: string;
  prompts: Readonly<Record<Arm, string>>;
}

export interface NarratorArmRun {
  replies: string[];
  promptChars: number;
  replyChars: number;
}

/** The model history for one arm, including the current player line. */
export function narratorArmHistory(
  turns: readonly Pick<NarratorComparisonTurn<string>, "player">[],
  replies: readonly string[],
  turnIndex: number,
): ChatTurn[] {
  const history: ChatTurn[] = [];
  for (let index = 0; index < turnIndex; index += 1) {
    const turn = turns[index];
    const reply = replies[index];
    if (!turn || reply === undefined) continue;
    history.push({ role: "user", content: turn.player });
    history.push({ role: "assistant", content: reply });
  }
  const current = turns[turnIndex];
  if (current) history.push({ role: "user", content: current.player });
  return history;
}

/** One production narrator call. Empty output is an instrument failure, never evidence. */
export async function generateNarratorReply(input: {
  system: string;
  history: readonly ChatTurn[];
  characterName: string;
  playerName: string;
  model: string;
}): Promise<string> {
  let text = "";
  for await (const delta of streamCharacterChat({
    system: input.system,
    history: [...input.history],
    name: input.characterName,
    names: { speakers: [input.characterName], plain: [input.playerName] },
    model: input.model,
  })) {
    text += delta;
  }
  const reply = text.trim();
  if (reply.length === 0) {
    throw new Error(`empty narration from ${input.model}; the comparison cannot score a failed provider call`);
  }
  return reply;
}

/** Run every turn of one arm, preserving that arm's own generated history. */
export async function runNarratorArm<Arm extends string>(input: {
  turns: readonly NarratorComparisonTurn<Arm>[];
  arm: Arm;
  characterName: string;
  playerName: string;
  model: string;
}): Promise<NarratorArmRun> {
  const replies: string[] = [];
  let promptChars = 0;
  let replyChars = 0;
  for (let index = 0; index < input.turns.length; index += 1) {
    const turn = input.turns[index];
    if (!turn) continue;
    const system = turn.prompts[input.arm];
    const history = narratorArmHistory(input.turns, replies, index);
    promptChars += system.length + history.reduce((sum, entry) => sum + entry.content.length, 0);
    const reply = await generateNarratorReply({
      system,
      history,
      characterName: input.characterName,
      playerName: input.playerName,
      model: input.model,
    });
    replies.push(reply);
    replyChars += reply.length;
  }
  return { replies, promptChars, replyChars };
}

/** Stable arm ordering for blind output/review; never uses process randomness. */
export function deterministicArmOrder<Arm extends string>(key: string, arms: readonly Arm[]): Arm[] {
  let hash = 0;
  for (const character of key) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return hash % 2 === 0 ? [...arms] : [...arms].reverse();
}

/**
 * Strict quote check shared by domain judges: case/whitespace/typographic quote
 * normalization only. Fuzzy matching would re-admit hallucinated evidence.
 */
export function normalizedQuoteAppears(quote: string, text: string): boolean {
  const normalize = (value: string) =>
    value
      .normalize("NFKC")
      .replace(/[“”]/gu, '"')
      .replace(/[‘’]/gu, "'")
      .replace(/\s+/gu, " ")
      .trim()
      .toLowerCase();
  const needle = normalize(quote);
  return needle.length > 0 && normalize(text).includes(needle);
}

/** Remove a Markdown heading and its body through the next heading of equal level. */
export function stripMarkdownSection(prompt: string, heading: string): string {
  const marker = `## ${heading}`;
  const start = prompt.indexOf(marker);
  if (start < 0) return prompt;
  const next = prompt.indexOf("\n## ", start + marker.length);
  const before = prompt.slice(0, start).replace(/\n+$/u, "");
  const after = next < 0 ? "" : prompt.slice(next + 1).replace(/^\n+/u, "");
  return [before, after].filter(Boolean).join("\n\n");
}
