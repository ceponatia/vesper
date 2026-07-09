import { Fragment } from "react";
import { CommsBody } from "@/components/characters/message-content";
import { commsLine } from "@/components/characters/message-markup";
import { parseInlineMarkup } from "./inline-markup";
import { cx } from "@/components/ui/cx";

/** One line's `*italic*`/`**bold**` inline markup → elements (unmatched markers stay literal). */
function InlineTokens({ text }: { text: string }) {
  return (
    <>
      {parseInlineMarkup(text).map((token, i) =>
        token.kind === "strong" ? (
          <strong key={i} className="font-semibold">
            {token.text}
          </strong>
        ) : token.kind === "em" ? (
          <em key={i}>{token.text}</em>
        ) : (
          <span key={i}>{token.text}</span>
        ),
      )}
    </>
  );
}

/**
 * Narrator prose renderer: serif, `*italic*`/`**bold**` inline (docs/ui.md).
 * `whitespace-pre-wrap` preserves the narration's own line breaks, so no
 * paragraph splitting is needed.
 *
 * A line that is SOLELY a `*Name: …*` comms span renders as the SMS-style texted line
 * (name label + italic body, sigils hidden) — the same treatment the chat lane gives a
 * narrator's texted reply (dialogue-attribution). Detection reuses the ONE span parser
 * (`commsLine`); every other line keeps the ordinary inline-markup rendering, so `**bold**`
 * and italics are undisturbed.
 */
export function InlineProse({ text, className }: { text: string; className?: string }) {
  const lines = text.split("\n");
  return (
    <p className={cx("whitespace-pre-wrap", className)}>
      {lines.map((line, li) => {
        const comms = commsLine(line);
        return (
          <Fragment key={li}>
            {li > 0 ? "\n" : null}
            {comms ? <CommsBody prefix={comms.prefix} text={comms.text} /> : <InlineTokens text={line} />}
          </Fragment>
        );
      })}
    </p>
  );
}
