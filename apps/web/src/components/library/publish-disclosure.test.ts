import { describe, expect, it } from "vitest";
import {
  CHARACTER_PUBLISH_CONFIRM,
  CLONE_DISCLOSURE,
  MADE_PRIVATE_TOAST,
  PUBLISHED_TOAST,
  publishConfirmRequired,
  type ShareableKind,
} from "./publish-disclosure";

const KINDS: readonly ShareableKind[] = ["character", "location", "item", "social_card"];
const NON_CHARACTER = KINDS.filter((k) => k !== "character");

/**
 * Regression guard for the publish disclosure (owner ruling 2026-07-31). The
 * first pass shipped copy that omitted two of the three facts a clone actually
 * carries; these assertions fail if any of them goes missing again.
 */
describe("character publish confirmation", () => {
  const body = CHARACTER_PUBLISH_CONFIRM.paragraphs.join(" ");

  it("names the private fields a copy takes", () => {
    expect(body).toContain("full profile");
    expect(body).toContain("narrator guidance");
    expect(body).toContain("drives");
    expect(body).toContain("intimacy notes");
    expect(body).toContain("voice anchors");
  });

  it("says images are duplicated too — cloneEntityImages copies them", () => {
    expect(body).toContain("images are duplicated");
  });

  it("warns that unpublishing cannot recall copies already made", () => {
    expect(body).toContain("Unpublishing later stops new copies");
    expect(body).toContain("will not recall copies people have already made");
  });

  it("offers a cancel that leaves it private", () => {
    expect(CHARACTER_PUBLISH_CONFIRM.cancelLabel).toBe("Keep private");
    expect(CHARACTER_PUBLISH_CONFIRM.confirmLabel).toBe("Publish");
    expect(CHARACTER_PUBLISH_CONFIRM.title).toBe("Publish this character?");
  });
});

describe("publishConfirmRequired", () => {
  it("confirms only when a character goes private → public", () => {
    expect(publishConfirmRequired("character", "public")).toBe(true);
  });

  it("keeps unpublishing one click for every kind", () => {
    for (const kind of KINDS) expect(publishConfirmRequired(kind, "private")).toBe(false);
  });

  it("keeps non-character publishing one click", () => {
    for (const kind of NON_CHARACTER) expect(publishConfirmRequired(kind, "public")).toBe(false);
  });
});

describe("inline disclosure", () => {
  it("character's one-liner summarises the confirm without contradicting it", () => {
    const line = CLONE_DISCLOSURE.character;
    expect(line).toContain("full character profile");
    expect(line).toContain("images");
    expect(line).toContain("won't recall copies people already made");
  });

  it("every kind discloses that publishing enables duplication", () => {
    for (const kind of KINDS) expect(CLONE_DISCLOSURE[kind]).toContain("Publishing lets anyone duplicate");
  });
});

describe("post-change toasts", () => {
  it("the character publish toast repeats profile + images", () => {
    expect(PUBLISHED_TOAST.character).toContain("full profile");
    expect(PUBLISHED_TOAST.character).toContain("images");
  });

  it("made-private never promises copies come back", () => {
    expect(MADE_PRIVATE_TOAST).toContain("Copies people already made stay theirs");
    expect(MADE_PRIVATE_TOAST).not.toContain("Only you can see this");
  });
});
