import { z } from "zod";

/**
 * PURE. The portrait studio's variant kinds — the one spelling of the list.
 *
 * They live in contracts because all three layers need the same tuple and sit on
 * lint-enforced boundaries: the studio's dropdown (a component, which may not
 * import `server/*`), the POST route's body schema, and the server's prompt
 * builder. Before this module each layer carried its own literal, so adding a
 * kind meant editing the same list in three files and any one of them could be
 * missed — a request the route accepts and the builder has no framing for.
 */

/**
 * `nsfw_test` is an owner-facing bench kind rather than an everyday variant: it
 * renders the canonical portrait through the anatomy LoRA with the character
 * sheet's intimate attributes spelled out, so the weights that chat scenes use
 * can be exercised from the studio against a known face. It deliberately says
 * nothing about clothing — the whole point is that the typed instruction owns
 * that — which is why it is a kind of its own and not a flag on `pose`.
 */
export const portraitVariantKinds = ["pose", "outfit", "expression", "setting", "nsfw_test"] as const;
export type PortraitVariantKind = (typeof portraitVariantKinds)[number];
export const portraitVariantKindSchema = z.enum(portraitVariantKinds);

/** Dropdown/caption text for a kind — the stored id with its underscores opened up. */
export function portraitVariantKindLabel(kind: string): string {
  return kind.replaceAll("_", " ");
}
