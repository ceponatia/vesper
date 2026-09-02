import { describe, expect, it } from "vitest";
import {
  affordancePerceptionView,
  characterProfileSchema,
  crookedNoseAttributes,
  emptyVisualCueState,
  VISUAL_STATE_VISIBILITY_UNKNOWN,
  type AffordanceExposure,
  type AffordancePerceptionView,
  type VisualCueState,
} from "@/contracts";
import { assembleVisualStateSnapshot, buildVisualStateShadow } from "@/server/visual-state";
import { simVisualStateCueKey, simVisualStateInput, simVisualStateLines } from "./sim-visual-state";
import { visualCueScopeKey } from "./visual-cue-store";

/**
 * The SUCCESSOR lane's visual-state seam: what the lane can honestly hand the
 * projection, what that leaves the narrator able to see, and how the branch's
 * cue state is keyed and threaded. The lane's recorded missing owners are
 * already owned by `server/visual-state/assemble.test.ts` and are not re-proved
 * here.
 *
 * What these kill:
 *
 * - a lane adapter that widens the perception view by ASSERTION — declaring bare
 *   skin visible because no wardrobe owner answered. The first case pins the real
 *   answer under the owners that exist, so inventing an exposure map to make the
 *   lane "work" fails here rather than shipping a narrator told what nobody knows;
 * - a build that drops the stored cue state and starts every cut from empty,
 *   which would make a continuously visible family read as newly revealed every
 *   single turn;
 * - a cue row keyed by the chat or a memory group rather than the BRANCH, which
 *   would let a fork inherit another branch's later mention history.
 */

const BRANCH = "branch_vs_sim";
const PLAYER_ACTOR = "actor_player";
const PRIMARY_ACTOR = "actor_nora";

/** The successor cut this lane can actually describe: an authored profile and a clock. */
function input(cutId = "cut_1") {
  const built = simVisualStateInput({
    chatId: "chat_vs_sim",
    branchId: BRANCH,
    playerActorId: PLAYER_ACTOR,
    primaryActorId: PRIMARY_ACTOR,
    cutId,
    storySecond: 9 * 3_600,
    primary: {
      name: "Nora",
      profile: characterProfileSchema.parse({ age: "29", attributes: crookedNoseAttributes() }),
    },
  });
  if (built === null) throw new Error("the fixture profile must produce an input");
  return built;
}

/**
 * Every body location this snapshot names, marked visible — a TEST-ONLY stand-in
 * for the exposure owner the successor world does not have. It exists to prove
 * the rest of the path is wired, and production must never construct one.
 */
function exposeEveryLocation(): AffordancePerceptionView {
  const { snapshot } = assembleVisualStateSnapshot(input());
  const exposure: Record<string, AffordanceExposure> = {};
  for (const feature of snapshot.features) {
    if (feature.locus.kind === "body") exposure[feature.locus.locus.bodyLocationId] = "visible";
  }
  return affordancePerceptionView({ exposure, channels: { sight: "available" } });
}

function build(overrides: { cues?: VisualCueState; exposed?: boolean; cutId?: string } = {}) {
  const base = input(overrides.cutId);
  return buildVisualStateShadow({
    ...base,
    cues: overrides.cues ?? emptyVisualCueState(),
    ...(overrides.exposed === true ? { perception: exposeEveryLocation() } : {}),
  });
}

function linesOf(shadow: ReturnType<typeof build>) {
  return simVisualStateLines(shadow, {
    primaryActorId: PRIMARY_ACTOR,
    playerActorId: PLAYER_ACTOR,
    primaryName: "Nora",
  });
}

describe("the successor visual-state input", () => {
  it("resolves NOTHING today, and the missing exposure owner is the single reason", () => {
    const shadow = build();
    const digest = shadow.narrator.digests.find((entry) => entry.subjectId === PRIMARY_ACTOR);

    // The honest answer under the owners this lane has: no wardrobe owner means
    // no exposure entries, an unlisted body location reads `unknown`, and unknown
    // fails the visibility read closed for every body-locus fact the profile
    // projects. Widening the view to make this pass IS the defect.
    expect(shadow.narrator.candidates).toHaveLength(0);
    expect(digest?.constraints ?? []).toHaveLength(0);
    expect(digest?.selected ?? []).toHaveLength(0);
    expect(linesOf(shadow)).toBeNull();

    // ...and it is exposure alone, not light, distance, angle, motion or consent:
    // every suppression is the one code, naming the location nobody answered for.
    expect(shadow.narrator.suppressions.length).toBeGreaterThan(0);
    for (const entry of shadow.narrator.suppressions) {
      expect(entry.code).toBe(VISUAL_STATE_VISIBILITY_UNKNOWN);
      expect(entry.detail).toMatch(/^exposure:/u);
    }
  });

  it("carries a grounded fact to the narrator once a body location is exposed", () => {
    const lines = linesOf(build({ exposed: true }));

    // The fence speaks the projection's own words for an authored attribute —
    // proof the whole path (profile → snapshot → visibility → selection →
    // renderer) is wired, and that the one thing missing is an exposure owner.
    expect(lines?.constraints ?? []).toContainEqual(expect.stringContaining("crooked"));
    expect(lines?.constraints.join("\n") ?? "").toContain("Nora's");
    // Nothing an unavailable owner would have authored reaches the prompt: no
    // wardrobe clause, because no wardrobe was projected to contradict.
    expect(lines?.constraints.join("\n") ?? "").not.toContain("wearing");
    // Every kind this lane can project is mandatory identity, and a mandatory
    // fact never competes for an optional cue slot — so the successor's cue
    // block stays empty until the lane gains a non-identity owner.
    expect(lines?.cues ?? []).toHaveLength(0);
  });
});

describe("the successor's branch-scoped cue state", () => {
  it("keys the row by the branch, so no chat and no other branch can share it", () => {
    const key = simVisualStateCueKey({
      branchId: BRANCH,
      playerActorId: PLAYER_ACTOR,
      primaryActorId: PRIMARY_ACTOR,
    });
    expect(key).toEqual({
      memoryGroupId: `world_branch:${BRANCH}`,
      viewpointId: PLAYER_ACTOR,
      subjectId: PRIMARY_ACTOR,
    });
    // A chat keeps its raw memory-group id (the rows already stored under it);
    // the successor's prefix is what makes the two key spaces disjoint, and the
    // branch id is what separates one fork from another.
    expect(visualCueScopeKey({ kind: "chat", memoryGroupId: BRANCH })).toBe(BRANCH);
    expect(visualCueScopeKey({ kind: "world_branch", branchId: "branch_other" })).not.toBe(key.memoryGroupId);
  });

  it("ranks against the state it was given instead of starting every cut empty", () => {
    const seen = "wardrobe.arrangement|body:torso";
    const prior: VisualCueState = {
      sequence: 4,
      cues: {
        [seen]: {
          repeatKey: seen,
          visibleFingerprint: "fp",
          firstVisibleAtMinutes: 60,
          lastVisibleAtMinutes: 120,
          lastVisibleSequence: 4,
          mentionCount: 1,
        },
      },
      spoken: {},
    };

    const continued = build({ cues: prior, cutId: "cut_2" }).narrator.cueStateAfterVisibility;
    // The stored state reached the build: this cut is the fifth this observer
    // recorded, and the family it already holds keeps the moment it was FIRST
    // seen rather than being rediscovered.
    expect(continued.sequence).toBe(5);
    expect(continued.cues[seen]?.firstVisibleAtMinutes).toBe(60);

    // A different branch is a different row, so it starts from nothing seen.
    const fresh = build({ cues: emptyVisualCueState(), cutId: "cut_2" }).narrator.cueStateAfterVisibility;
    expect(fresh.sequence).toBe(1);
    expect(fresh.cues[seen]).toBeUndefined();
  });
});
