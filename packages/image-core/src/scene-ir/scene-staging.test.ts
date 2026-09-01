import { describe, expect, it } from "vitest";
import {
  adoptSceneStagingSurfaceForm,
  createSceneStagingSurfaceForms,
  findSceneStagingSurfaceDigestMismatches,
  type SceneStagingId,
  type SceneStagingSurfaceFormEntry,
  type SceneStagingSurfaceFormTable,
} from "./scene-staging";

/**
 * The surface form's containment properties, and the digest check that makes a revision mean
 * something — the runtime half of a guarantee that is otherwise the compiler's.
 *
 * Most of what keeps registry prose from becoming a general escape hatch is structural and
 * unobservable at runtime: a caller cannot name the text's key, and a table cannot omit or
 * invent an arrangement. What IS observable is load-bearing and easy to break by
 * "simplifying" the carrier into a plain object with a `text` field — the text would then be
 * readable everywhere and would ride into every stored record, and nothing else in the
 * repository would notice.
 */

/** Stands in for SHA-256: this package may not evaluate `node:crypto`, and identity is what is under test. */
const stubDigest = (text: string): string => text.length.toString(16).padStart(64, "0");

function entry(id: SceneStagingId): SceneStagingSurfaceFormEntry {
  const text = `registry wording for ${id}`;
  return { text, revision: 1, digest: stubDigest(text) };
}

/** Total by construction, exactly as a registry's own table must be. */
const table: SceneStagingSurfaceFormTable = {
  held_from_behind: entry("held_from_behind"),
  held_from_behind_bare: entry("held_from_behind_bare"),
  kneeling_before_viewer: entry("kneeling_before_viewer"),
  kneeling_before_viewer_guided: entry("kneeling_before_viewer_guided"),
  astride_viewer_facing: entry("astride_viewer_facing"),
  astride_viewer_away: entry("astride_viewer_away"),
  bent_over_surface: entry("bent_over_surface"),
  on_all_fours: entry("on_all_fours"),
  lying_beneath_viewer: entry("lying_beneath_viewer"),
  lying_face_down: entry("lying_face_down"),
  spooned_from_behind: entry("spooned_from_behind"),
  pressed_to_wall_facing: entry("pressed_to_wall_facing"),
  pressed_to_wall_away: entry("pressed_to_wall_away"),
};

describe("scene staging surface forms", () => {
  it("yields the registry's text only to a caller that adopts it", () => {
    const form = createSceneStagingSurfaceForms(table).formFor("bent_over_surface");

    expect(adoptSceneStagingSurfaceForm(form)).toBe("registry wording for bent_over_surface");
  });

  it("keeps the text out of serialization, leaving the revision and digest as the recorded facts", () => {
    const forms = createSceneStagingSurfaceForms(table);
    const encoded = JSON.stringify(forms.formFor("on_all_fours"));

    expect(encoded).not.toContain("registry wording");
    expect(encoded).toContain("on_all_fours@1");
    expect(encoded).toContain(forms.digestFor("on_all_fours"));
  });
});

describe("findSceneStagingSurfaceDigestMismatches", () => {
  it("passes a registry whose digests describe its own text", () => {
    expect(findSceneStagingSurfaceDigestMismatches(table, stubDigest)).toEqual([]);
  });

  it("names the arrangement and revision whose wording moved without its digest", () => {
    const stale: SceneStagingSurfaceFormTable = {
      ...table,
      on_all_fours: { ...table.on_all_fours, text: "a quietly rewritten sentence" },
    };

    expect(findSceneStagingSurfaceDigestMismatches(stale, stubDigest)).toEqual([
      {
        stagingId: "on_all_fours",
        revision: "on_all_fours@1",
        declared: table.on_all_fours.digest,
        actual: stubDigest("a quietly rewritten sentence"),
      },
    ]);
  });
});
