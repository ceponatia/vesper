import { describe, expect, it } from "vitest";
import { images } from "@/server/db";
import { isShareableImageKind } from "./asset-storage";

describe("shareable image kinds", () => {
  // The cross-owner surfaces (public file serving, a public character's preview
  // strip, clone) subtract a DENY list, so a kind added to the schema enum would
  // be shareable by default. Derived from the enum, this fails until whoever
  // adds a kind decides which side it belongs on. Chat content — scenes and
  // selfies included (#436) — must never appear here.
  it("only authored entity art may cross an owner boundary", () => {
    const shareable = images.kind.enumValues.filter((kind) => isShareableImageKind(kind));
    expect([...shareable].sort()).toEqual(["avatar", "entity", "portrait_variant"]);
  });
});
