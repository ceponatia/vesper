"use client";

import { Fragment } from "react";
import type { MessageSpanContext } from "@/lib/message-spans";
import { messageRenderModel, type RenderPiece } from "./message-markup";

/**
 * The chat transcript span renderer (player-input-perception.plan.md slice 5), applied
 * to both player messages and narrator replies. Thoughts / `_italic_` render italic with
 * their sigils hidden, `*Name:*` comms read as a text message (label visible, body
 * italic), and `((OOC))` gets an out-of-fiction amber aside. Everything else (speech
 * quotes, narration) renders as plain text — exactly as the bubble did before.
 *
 * Pieces render inline inside the bubble's `whitespace-pre-wrap`, joined by `"\n\n"`
 * between paragraphs (blank-line breaks) and single spaces the parser trimmed, so the
 * flow matches the raw text without a second parse. Streaming is safe: an unterminated
 * sigil falls back to literal text (per `parseMessageSpans`) and flips once it closes.
 */
export function MessageContent({ content, context }: { content: string; context?: MessageSpanContext }) {
  const paragraphs = messageRenderModel(content, context);
  return (
    <>
      {paragraphs.map((pieces, pi) => (
        <Fragment key={pi}>
          {pi > 0 ? "\n\n" : null}
          {pieces.map((piece, idx) => (
            <Fragment key={idx}>
              {piece.space ? " " : null}
              <Piece piece={piece} />
            </Fragment>
          ))}
        </Fragment>
      ))}
    </>
  );
}

/**
 * The SMS-style texted-line body: a non-italic `Name:` label followed by the italic message.
 * Shared so the chat lane (comms span) and the session feed (`InlineProse` comms line) render
 * an identical texted line — ONE styling implementation.
 */
export function CommsBody({ prefix, text }: { prefix?: string; text: string }) {
  return (
    <>
      {prefix ? <span className="font-medium text-paper-300">{prefix} </span> : null}
      <em className="italic">{text}</em>
    </>
  );
}

/** One render piece → its inline element (exhaustive over the four display variants). */
function Piece({ piece }: { piece: RenderPiece }) {
  switch (piece.variant) {
    case "plain":
      return piece.text;
    case "italic":
      return <em className="italic">{piece.text}</em>;
    case "comms":
      return (
        <span>
          <CommsBody prefix={piece.prefix} text={piece.text} />
        </span>
      );
    case "ooc":
      return (
        <span
          title="Out of character — a note to the storyteller, not heard in the scene"
          className="rounded-sm bg-accent-500/12 px-1 text-accent-300 italic"
        >
          {piece.text}
        </span>
      );
  }
}
