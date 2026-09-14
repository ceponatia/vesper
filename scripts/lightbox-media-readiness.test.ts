import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { repoRelative, stripComments } from "@/server/test-support";

/**
 * The lightbox's media elements report readiness from the right event: audio
 * from `loadedmetadata`, video from `loadeddata`.
 *
 * The defect this kills already happened once, inside #589's own correction
 * pass. Audio was wired to `loadeddata` like the video beside it, and an audio
 * element under `preload="metadata"` — Firefox's default, and common in Safari
 * — stops at HAVE_METADATA until playback starts, so `loadeddata` never fired:
 * "Loading audio…" sat on top of a perfectly usable player, forever. Both
 * events exist, both are valid React props, both typecheck, and swapping one
 * for the other is a one-token edit that looks like a tidy-up. Video is the
 * mirror case and must NOT be moved to `loadedmetadata`, where readiness would
 * be claimed before a single frame is decoded.
 *
 * Nothing else can see it. Both Vitest projects run in `node` and include
 * `*.test.ts` only, so no suite here can mount `image-lightbox.tsx`
 * (`confirm-dialog-census.test.ts` and `image-control-vocabulary-display.test.ts`
 * state the same constraint and answer it the same way), and no type or lint
 * rule distinguishes two handlers with the same signature.
 *
 * Structure, never a snapshot: it asserts which readiness handler each element
 * carries, so restyling, reordering props and rewording every label stay green.
 * An element it cannot find THROWS rather than failing an assertion — a
 * rewritten component is a stale scanner, and reporting that as a missing
 * handler would send the next reader after the wrong thing.
 */
const LIGHTBOX = path.join(process.cwd(), "apps/web/src/components/ui/image-lightbox.tsx");

/** The component's source with comments blanked — a handler named only in prose must not satisfy a check. */
function lightboxSource(): string {
  return stripComments(fs.readFileSync(LIGHTBOX, "utf8"));
}

/**
 * The attribute text of the one `<tag …/>` element in the component.
 *
 * Bounded by the element's own `/>`, and refusing to run past a following `<`:
 * an element rewritten into the `<video>…</video>` form would otherwise hand
 * back a span covering the NEXT element's attributes and quietly answer about
 * the wrong one.
 */
function elementAttributes(source: string, tag: string): string {
  const open = new RegExp(String.raw`<${tag}\b`).exec(source);
  if (open === null) {
    throw new Error(
      `[lightbox-media] ${repoRelative(LIGHTBOX)} renders no <${tag}> — ` +
        "the component was rewritten, so this scanner is stale rather than the handler missing",
    );
  }
  const selfClose = source.indexOf("/>", open.index);
  const nextTag = source.indexOf("<", open.index + 1);
  if (selfClose === -1 || (nextTag !== -1 && nextTag < selfClose)) {
    throw new Error(
      `[lightbox-media] the <${tag}> in ${repoRelative(LIGHTBOX)} is no longer a self-closing element — ` +
        "this scanner is stale rather than the handler missing",
    );
  }
  return source.slice(open.index, selfClose);
}

/** Each media element, the readiness event it must report from, and the one it must not. */
const READINESS: ReadonlyArray<{ tag: string; handler: string; wrong: string; because: string }> = [
  {
    tag: "audio",
    handler: "onLoadedMetadata",
    wrong: "onLoadedData",
    because: "an audio element under preload=metadata never fires loadeddata until playback starts",
  },
  {
    tag: "video",
    handler: "onLoadedData",
    wrong: "onLoadedMetadata",
    because: "the first decoded frame is a video's real readiness, and metadata arrives before it",
  },
];

describe("the lightbox's media readiness", () => {
  it.each(READINESS)("has <$tag> report from $handler and never $wrong", ({ tag, handler, wrong, because }) => {
    const attributes = elementAttributes(lightboxSource(), tag);

    expect(attributes, `<${tag}> must report readiness from ${handler}: ${because}`).toContain(`${handler}=`);
    expect(attributes, `<${tag}> must not report readiness from ${wrong}: ${because}`).not.toContain(`${wrong}=`);
  });

  it.each(READINESS)("keeps <$tag> a controlled player with a failure path", ({ tag }) => {
    const attributes = elementAttributes(lightboxSource(), tag);

    // #595: a file whose codec the browser cannot decode must SAY so rather
    // than showing an empty frame, which is `onError` reaching the failed
    // state; transport controls are the rest of "plays in place".
    expect(attributes, `<${tag}> must offer transport controls`).toMatch(/\bcontrols\b/u);
    expect(attributes, `<${tag}> must route a decode failure into the failed state`).toContain("onError=");
  });

  it("leaves the image element on onLoad, the event it has always used", () => {
    // The `media` discriminator refactored all three elements through one pair
    // of handlers; the image path predates it and must not have been dragged
    // onto a media event that an <img> never fires.
    const attributes = elementAttributes(lightboxSource(), "img");

    expect(attributes).toContain("onLoad=");
    expect(attributes).toContain("onError=");
    expect(attributes).not.toContain("onLoadedData=");
    expect(attributes).not.toContain("onLoadedMetadata=");
  });
});
