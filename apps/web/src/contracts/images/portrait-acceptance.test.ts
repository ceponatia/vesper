import { describe, expect, it } from "vitest";
import { projectPortraitAcceptance } from "./portrait-acceptance";

/**
 * The one place the two portrait pointers are compared
 * (docs/images/identity-packs.md §The source is the ACCEPTED portrait). Every
 * surface — the character read, the accept routes, the studio badge — takes its
 * answer from here, so the comparison is worth pinning at the layer that owns it.
 *
 * The middle case is the feature: an accepted portrait with a newer candidate on
 * screen is still the identity, and reporting it as current would tell the owner
 * their experiment is already live. The last case kills the obvious wrong
 * implementation, `acceptedImageId === avatarImageId`, which calls a character
 * with no portrait at all "accepted".
 */
describe("projectPortraitAcceptance", () => {
  const accepted = new Date("2026-02-01T10:00:00.000Z");

  it("reports the accepted portrait as current only when it is the candidate on screen", () => {
    expect(
      projectPortraitAcceptance({ avatarImageId: "img-a", acceptedAvatarImageId: "img-a", acceptedAt: accepted }),
    ).toEqual({ acceptedImageId: "img-a", acceptedAt: accepted.toISOString(), isCurrent: true });

    expect(
      projectPortraitAcceptance({ avatarImageId: "img-b", acceptedAvatarImageId: "img-a", acceptedAt: accepted }),
    ).toEqual({ acceptedImageId: "img-a", acceptedAt: accepted.toISOString(), isCurrent: false });
  });

  it("a character with nothing accepted is never current, portrait or no portrait", () => {
    expect(
      projectPortraitAcceptance({ avatarImageId: "img-a", acceptedAvatarImageId: null, acceptedAt: null }),
    ).toEqual({ acceptedImageId: null, acceptedAt: null, isCurrent: false });

    expect(projectPortraitAcceptance({ avatarImageId: null, acceptedAvatarImageId: null, acceptedAt: null })).toEqual({
      acceptedImageId: null,
      acceptedAt: null,
      isCurrent: false,
    });
  });

  it("drops an acceptance time left standing over nothing", () => {
    // A row that lost its accepted pointer without its timestamp is corruption,
    // not a state: the projection reports no acceptance rather than a date the
    // studio would render beside "No accepted portrait".
    expect(
      projectPortraitAcceptance({ avatarImageId: "img-a", acceptedAvatarImageId: null, acceptedAt: accepted }),
    ).toEqual({ acceptedImageId: null, acceptedAt: null, isCurrent: false });
  });
});
