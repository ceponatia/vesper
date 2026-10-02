import type { ImageRecord } from "@/lib/client/api";

/**
 * Who sent a selfie, read from the scene's own recorded cast (`references`) —
 * never from where the row is filed (a group chat's selfies are filed under
 * the chat's primary). A selfie's cast is exactly its sender, so the sender is
 * the single `character` reference; anything else is unattributed (null).
 */
export function selfieSenderName(image: Pick<ImageRecord, "references">): string | null {
  const characters = image.references.filter((ref) => ref.kind === "character");
  const only = characters.length === 1 ? characters[0] : undefined;
  const name = only?.name?.trim();
  return name ? name : null;
}

/** Labels for a selfie moment; a null sender gets neutral wording, never another name. */
export function selfieLabels(sender: string | null): { ariaLabel: string; title: string; alt: string } {
  if (sender === null) return { ariaLabel: "Photo message", title: "A photo", alt: "Photo" };
  return { ariaLabel: `Photo from ${sender}`, title: `A photo from ${sender}`, alt: sender };
}
