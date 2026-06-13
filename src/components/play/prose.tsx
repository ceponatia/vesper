import { parseInlineMarkup } from "./inline-markup";
import { cx } from "@/components/ui/cx";

/**
 * Narrator prose renderer: serif, `*italic*`/`**bold**` inline (docs/ui.md).
 * `whitespace-pre-wrap` preserves the narration's own line breaks, so no
 * paragraph splitting is needed.
 */
export function InlineProse({ text, className }: { text: string; className?: string }) {
  const tokens = parseInlineMarkup(text);
  return (
    <p className={cx("whitespace-pre-wrap", className)}>
      {tokens.map((token, i) =>
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
    </p>
  );
}
