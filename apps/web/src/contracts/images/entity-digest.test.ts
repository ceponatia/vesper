import { describe, expect, it } from "vitest";
import {
  entityReadToken,
  itemImageOperation,
  locationImageOperation,
  projectItemDigest,
  projectLocationDigest,
} from "./entity-digest";

/**
 * The item and location projections (model-aware-image-prompts.plan.md
 * §"Item and location module").
 *
 * These cases are the surviving half of the deleted `buildItemImagePrompt` /
 * `buildLocationImagePrompt` tests. The product decisions they protected are
 * unchanged — clothing hangs in its own shape, an open scale is an outdoor
 * view, an entity shot has nobody in it — but they are now facts rather than
 * sentences, so the assertions moved down to where the decision is made. How
 * those facts are WORDED is `@vesper/image-core`'s dialect and is tested there;
 * asserting prose here would be two layers proving one claim.
 */

const item = { id: "itm1", name: "Brass compass", kind: "object" as const, revision: "2026-08-18T00:00:00.000Z" };
const place = { id: "loc1", name: "Tidal Flats", scale: "expanse" as const, revision: "2026-08-18T00:00:00.000Z" };

const factValue = (facts: readonly { concept: string; value: unknown }[], concept: string): string =>
  String(facts.find((fact) => fact.concept === concept)?.value ?? "");

describe("item projection", () => {
  it("presents clothing unsupported and everything else isolated", () => {
    // Names no support, deliberately: "invisible ghost mannequin" rendered a
    // plainly visible dress form 12/12 across two fixtures, and this wording 0/12
    // (model-aware-image-prompts.trial.qwen-2512-negative.md, Trial B). A future
    // edit that reintroduces the industry term reintroduces the mannequin.
    const clothing = factValue(projectItemDigest({ ...item, kind: "clothing" }).facts, "item.presentation");
    expect(clothing).toContain("its own shape");
    expect(clothing).not.toMatch(/mannequin|dress form|bust|torso|hanger/i);
    expect(factValue(projectItemDigest(item).facts, "item.presentation")).toContain("seamless surface");
    expect(factValue(projectItemDigest({ ...item, kind: "container" }).facts, "item.presentation")).toContain(
      "seamless surface",
    );
  });

  it("keeps the shot's required facts required and the authored prose droppable", () => {
    const digest = projectItemDigest({ ...item, description: "a scuffed pocket compass", appearance: "tarnished brass" });
    const required = digest.facts.filter((fact) => fact.disposition === "required_visual").map((fact) => fact.concept);
    expect(required.sort()).toEqual(["item.identity", "item.presentation"]);
    // The two authored fields are present but optional — a long description must
    // be what a budget squeeze eats, never the claim naming the object.
    expect(digest.facts.filter((fact) => fact.disposition === "optional_visual")).toHaveLength(2);
  });

  it("renders a nameless row rather than refusing it", () => {
    const digest = projectItemDigest({ ...item, name: "  " });
    expect(factValue(digest.facts, "item.identity")).toContain("an object");
    expect(digest.label).toBe("the object");
  });
});

describe("location projection", () => {
  it("reads open scales as outdoor views and the rest as interiors", () => {
    expect(factValue(projectLocationDigest(place).facts, "location.presentation")).toContain("outdoor");
    expect(factValue(projectLocationDigest({ ...place, scale: "room" }).facts, "location.presentation")).toContain(
      "interior",
    );
  });

  it("carries the ambient light and drops the channels a picture cannot show", () => {
    const digest = projectLocationDigest({ ...place, description: "salt marsh", light: "low sun" });
    expect(factValue(digest.facts, "location.lighting")).toBe("low sun");
    expect(factValue(digest.facts, "location.contents")).toBe("salt marsh");
  });
});

/**
 * Both entity operations assert an EMPTY frame, which is what replaced the old
 * builders' hand-appended "no people" tail. It is load-bearing twice over: it
 * compiles the positive sentence, and it switches off every anatomy, hand, skin
 * and single-subject negative block, none of which has anything to defend in a
 * photograph of a compass or an empty room.
 */
it("asserts nobody is in an entity shot", () => {
  expect(itemImageOperation().subjectCount).toBe(0);
  expect(locationImageOperation("room").subjectCount).toBe(0);
});

/**
 * The read token is what makes "retry this exact composition" mean something:
 * unchanged rows must mint the same token, and an edited row must not.
 *
 * Falsified against a token derived from the read time or a random id, either of
 * which would make every retry look like a different world.
 */
it("mints a stable read token that moves only when a source revision moves", () => {
  const revisions = [{ owner: "item.library", entityId: "itm1", revision: "r1" }];
  expect(entityReadToken(revisions)).toBe(entityReadToken(revisions));
  expect(entityReadToken(revisions)).not.toBe(
    entityReadToken([{ owner: "item.library", entityId: "itm1", revision: "r2" }]),
  );
});
