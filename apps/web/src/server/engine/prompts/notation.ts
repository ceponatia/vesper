import { parseMessageSpans, spanChannel } from "@/lib/message-spans";

/**
 * Shared archivist channel hint: the
 * parser-derived "the player used notation this message" note both lane archivists
 * surface, so neither re-implements the sigil grammar (jscpd gate + the
 * single-parser rule) nor clones the other's copy. When the player marks interiority
 * (`*…*` ⇒ private) or an out-of-character aside (`((…))` ⇒ skip), the deterministic
 * spans turn the fact-channel classification into a cheap parse; everything else
 * defaults to `perceived` anyway, so a message with no such sigil returns "" and the
 * archivist judges semantically. Like the tail notes, this describes the notation's
 * STRUCTURE rather than echoing the raw (untrusted) thought text back outside a fence.
 *
 * `perceiverClause` is the lane-specific phrase naming who did NOT perceive the thought —
 * the chat lane's single character ("Mara did NOT perceive it"), or the session lane's
 * cast ("no character in the scene perceived it").
 */
export function channelHint(
  message: string,
  ctx: { knownNames?: readonly string[]; playerName?: string; perceiverClause: string },
): string {
  const spans = parseMessageSpans(message, { playerName: ctx.playerName, knownNames: ctx.knownNames });
  const hasPrivate = spans.some((s) => spanChannel(s.kind) === "private");
  const hasOoc = spans.some((s) => s.kind === "ooc");
  if (!hasPrivate && !hasOoc) return "";
  const lines: string[] = [];
  if (hasPrivate) {
    lines.push(
      `- The *asterisked* passage is the player's private thought — ${ctx.perceiverClause}. File any fact drawn only from it with "channel":"private".`,
    );
  }
  if (hasOoc) {
    lines.push(`- The ((double-parenthesized)) text is out-of-character direction — record NO fact from it.`);
  }
  return `Channel notes (the player used notation this message):\n${lines.join("\n")}`;
}
