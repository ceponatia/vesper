/**
 * Owner-facing copy for recovering a failed row's already-paid-for render —
 * shared by every surface that offers it (issue #686): the portrait studio
 * (`characters/portrait-studio.tsx`), chat's inline scene moments
 * (`chat/chat-scene-moments.tsx`), and reference views
 * (`characters/reference-view-copy.ts`, which imports these rather than
 * defining its own copy of them).
 *
 * Reference views keep their OWN lapsed-offer and dependent-build copy
 * locally: that vocabulary describes a PERSISTED failure message a later
 * retention sweep or an `expired` refusal can outdate, which neither the
 * portrait studio nor chat scenes ever store — both read `recoverable`
 * fresh off the list response, so a lapsed offer there simply stops showing
 * the action rather than needing its own stale-message copy.
 */

/** A failed row whose render was paid for and can be recovered without a new charge. */
export const imageRecoverableHint =
  "Rendered and paid for, but the download failed. Recover it without paying again.";

/** The recoverable failed tile's primary action, everywhere it appears. */
export const imageRecoverActionLabel = "Recover image";

/** The toast title once a recover request lands the image back on its row. */
export const imageRecoveredToastTitle = "Image recovered";

/** The toast title on a refused recovery; the description is the route's own message. */
export const imageRecoverFailedTitle = "Could not recover that image";
