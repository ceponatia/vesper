import { humanizeId } from "@vesper/simulation-core/humanize";
import { capitalizeFirst } from "@vesper/simulation-core/world-read";

const WORLD_COMMAND_LABELS: Readonly<Record<string, string>> = {
  advance_time: "Wait a while",
  do_activity: "Try another activity",
  end_engagement: "End the conversation",
  end_scene: "End this scene",
  give_item: "Hand over an item",
  move: "Go somewhere else",
  move_actor: "Go somewhere else",
  move_together: "Walk together",
  send_message: "Send a message",
  start_activity: "Try another activity",
  travel: "Travel somewhere else",
};

const COMMAND_LIKE = /^[a-z0-9]+(?:[_.:/-][a-z0-9]+)+$/u;

/** Keep authored prose intact, but never put an identifier-looking label in front of a player. */
export function displayWorldActionLabel(label: string, actionId: string): string {
  const trimmed = label.trim();
  const source = trimmed || actionId;
  return COMMAND_LIKE.test(source) ? capitalizeFirst(humanizeId(source)) : capitalizeFirst(source);
}

/** Human player-facing copy for the engine's legal command-type alternatives. */
export function displayWorldAlternative(alternative: string): string {
  const trimmed = alternative.trim();
  if (!trimmed) return "";
  return WORLD_COMMAND_LABELS[trimmed] ?? capitalizeFirst(humanizeId(trimmed));
}

/**
 * Prefer actor identity when the world envelope supplies it. The duplicate
 * ordinal fallback keeps keys unique and deterministic for older envelopes
 * where only display names were available.
 */
export function worldCastKey(
  cast: ReadonlyArray<{ actorId?: string; name: string }>,
  index: number,
): string {
  const member = cast[index];
  if (!member) return `cast-${index}`;
  if (member.actorId) return member.actorId;
  let duplicateOrdinal = 0;
  for (let candidateIndex = 0; candidateIndex < index; candidateIndex += 1) {
    if (cast[candidateIndex]?.name === member.name) duplicateOrdinal += 1;
  }
  return `${member.name}\u0000${duplicateOrdinal}`;
}
