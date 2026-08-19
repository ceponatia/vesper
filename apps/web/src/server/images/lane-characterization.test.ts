import { describe, expect, it } from "vitest";
import { resolveAttributes } from "@/contracts/attributes/value";
import {
  duplicatedVisualFacts,
  LANE_PROBE_NAME,
  laneProbeBareExposure,
  laneProbeDressedExposure,
  laneProbeProfile,
  laneProbeWardrobe,
  presentVisualFacts,
  VISUAL_FACT_PROBES,
} from "@/server/test-support";
import { buildCharacterSceneContext, type SceneCastMember } from "./character-scene";
import { buildChatLookPrompt } from "./chat-look";
import { apparentAgeAnchor } from "./prompts-appearance";
import { buildAvatarPrompt } from "./prompts-avatar";
import { resolveScenePlan } from "./prompts-scene-plan";
import { sceneSpecSchema } from "./prompts-scene-composer";
import { buildSceneRenderPrompt } from "./prompts-scene-render";
import { buildVariantInstruction } from "./prompts-variant";

/**
 * The pre-migration freeze for every character-bearing image lane
 * (image-lane-consolidation.plan.md Stage 1).
 *
 * One character is rendered through all six lanes and the same probe set is read
 * off each compiled prompt (`server/test-support/image-lane-probe.ts` states why
 * facts are probed instead of prompt strings snapshotted). The frozen lists below
 * are a record of what each lane emits TODAY, gaps included — they are not a
 * statement that today is correct. Stages 3–5 are expected to change them, and
 * the guardrail is that changing one is a deliberate edit with the plan's
 * acceptance gates behind it, never a silent side effect of a refactor.
 *
 * Reading the matrix: the lanes disagree, and the disagreements ARE the plan's
 * premise.
 *
 * - The avatar lane states identity, morphology, age and wardrobe from the sheet,
 *   and drops everything below the waist (waist-up framing).
 * - The text-to-image scene lane states the whole sheet through
 *   `characterAppearanceSummary`, which applies no coverage gate — so it
 *   describes skin a garment is covering, while the reference lanes, routing the
 *   same fact through the exposure-gated reveal line, do not.
 * - The reference scene lanes narrow to identity anchors plus the reveal line,
 *   losing species, gender and morphology entirely: they lean on the reference
 *   image for those.
 * - The chat-look lane states apparent age and the requested outfit and NOTHING
 *   else — no identity, morphology, or exposure fact at all. Same for the
 *   variant lane. Both take their age anchor as a caller-supplied string, which
 *   is the coupling Stage 4 replaces with a mandatory `age` segment.
 *
 * A lane that gains a fact it never had, or loses one it has, fails here first.
 */

const profile = laneProbeProfile();
const dressed = laneProbeWardrobe();
const dressedExposure = laneProbeDressedExposure();
const bareExposure = laneProbeBareExposure();

const castMember = (over: Partial<SceneCastMember> = {}): SceneCastMember => ({
  characterId: "probe-character",
  name: LANE_PROBE_NAME,
  profile,
  avatarImageId: null,
  outfit: "a floor-length wine-red silk kimono",
  exposure: dressedExposure,
  ...over,
});

/** The scene plan a lane renders, built through the production context + resolve seam. */
function scenePlan(member: SceneCastMember = castMember()) {
  const context = buildCharacterSceneContext({
    cast: [member],
    room: "a lamplit study, rain on the window",
    recentChat: [`${LANE_PROBE_NAME} settles into the chair by the window.`],
  });
  return resolveScenePlan(
    sceneSpecSchema.parse({ focalCharacter: LANE_PROBE_NAME, pose: "settling into the chair", setting: "a lamplit study" }),
    context,
  );
}

const bareMember = castMember({ outfit: "", exposure: bareExposure });

/**
 * Freeze one lane: exactly these facts, and none of them stated twice.
 *
 * The two halves are one assertion because `presentVisualFacts` collapses every
 * positive count to a key, so a lane that starts emitting the age or the garment
 * twice would slip through a presence-only freeze — and duplication is a stated
 * migration failure mode in its own right (spec.prompts: "fail on lost,
 * duplicated, newly exposed … facts"). Two builders that both describe a person
 * read as emphasis to an image model and spend the budget twice.
 */
function expectLaneFacts(prompt: string, expected: readonly string[]): void {
  expect(presentVisualFacts(prompt)).toEqual(expected);
  expect(duplicatedVisualFacts(prompt)).toEqual([]);
}

describe("image lane characterization — dressed subject", () => {
  it("avatar: sheet identity, morphology, age and wardrobe; nothing below the waist", () => {
    expectLaneFacts(buildAvatarPrompt(LANE_PROBE_NAME, profile, "realistic", dressed), [
      "gender",
      "ethnicity",
      "species",
      "hairColor",
      "eyeColor",
      "skinTone",
      "horns",
      "wings",
      "tail",
      "apparentAge",
      "garment",
    ]);
  });

  it("scene, text-to-image: the appearance summary carries the sheet, exposure-blind", () => {
    expectLaneFacts(buildSceneRenderPrompt(scenePlan(), {}), [
      "gender",
      "ethnicity",
      "species",
      "hairColor",
      "eyeColor",
      "skinTone",
      "horns",
      "wings",
      "tail",
      "garment",
      "legBuild",
      // `toenails` is the drift this plan exists to remove, not an intended
      // feature: `characterAppearanceSummary` applies NO coverage gate, so the
      // painted toenails under the slippers reach a text-to-image render — while
      // the reference lanes below, which route the same fact through the
      // exposure-gated reveal line, correctly stay silent about them. Stage 2
      // gives both one coverage-aware selection; until then this cell records
      // that the two disagree.
      "toenails",
    ]);
  });

  it("scene, single reference: identity anchors replace the full appearance summary", () => {
    expectLaneFacts(buildSceneRenderPrompt(scenePlan(), { referenceName: LANE_PROBE_NAME }), [
      "hairColor",
      "eyeColor",
      "skinTone",
      "garment",
      // Shape reads through clothing; the covered `skin` facts do not.
      "legBuild",
    ]);
  });

  it("scene, multi reference: the same anchors through the second assembler", () => {
    const prompt = buildSceneRenderPrompt(scenePlan(), {
      multiReferences: [
        { name: LANE_PROBE_NAME, kind: "character" },
        { name: "the study", kind: "location" },
      ],
    });
    // Identical to the single-reference lane's fact set, which is the one thing
    // the two assemblers currently agree on — they reach it through different
    // wording, ordering and budgets (audit finding 4).
    expectLaneFacts(prompt, ["hairColor", "eyeColor", "skinTone", "garment", "legBuild"]);
  });

  it("chat look: the requested outfit and no other character fact, age included", () => {
    const prompt = buildChatLookPrompt({ outfit: "a floor-length wine-red silk kimono", outfitExposed: false });
    // Age left the chat-look lane with the narrative/visual age split (#143):
    // the builder no longer takes an anchor, so the garment is the only fact.
    expectLaneFacts(prompt, ["garment"]);
  });

  it("portrait variant: apparent age and the requested change, and no other character fact", () => {
    const prompt = buildVariantInstruction(
      "outfit",
      "wearing a floor-length wine-red silk kimono",
      apparentAgeAnchor(LANE_PROBE_NAME, resolveAttributes(profile.attributes, [])),
    );
    expectLaneFacts(prompt, ["apparentAge", "garment"]);
  });
});

describe("image lane characterization — bare subject", () => {
  it("scene, text-to-image: exposure is stated, intimate anatomy is not (censored route)", () => {
    expectLaneFacts(buildSceneRenderPrompt(scenePlan(bareMember), {}), [
      "gender",
      "ethnicity",
      "species",
      "hairColor",
      "eyeColor",
      "skinTone",
      "horns",
      "wings",
      "tail",
      "bareTorso",
      "legBuild",
      "toenails",
      // No `bustSize`/`nipples`: intimate anatomy rides the reveal line, which
      // this route never emits — the gate is the route, and holds even though
      // the region is bare.
    ]);
  });

  it("scene, single reference, uncensored: the intimate reveal line joins", () => {
    const prompt = buildSceneRenderPrompt(scenePlan(bareMember), {
      referenceName: LANE_PROBE_NAME,
      allowIntimate: true,
    });
    expectLaneFacts(prompt, [
      "hairColor",
      "eyeColor",
      "skinTone",
      "bareTorso",
      "legBuild",
      "toenails",
      "bustSize",
      "nipples",
    ]);
  });

  it("avatar: bare or dressed, the portrait studio states no intimate anatomy", () => {
    const prompt = buildAvatarPrompt(LANE_PROBE_NAME, profile, "realistic", []);
    const present = presentVisualFacts(prompt);
    expect(present).not.toContain("bustSize");
    expect(present).not.toContain("nipples");
    // …and the waist-up cut still holds with nothing worn.
    expect(present).not.toContain("legBuild");
    expect(present).not.toContain("toenails");
  });
});

describe("image lane invariants that hold across the migration", () => {
  const lanes = (): ReadonlyArray<{ lane: string; prompt: string }> => [
    { lane: "avatar", prompt: buildAvatarPrompt(LANE_PROBE_NAME, profile, "realistic", dressed) },
    { lane: "scene_t2i", prompt: buildSceneRenderPrompt(scenePlan(), {}) },
    { lane: "scene_ref", prompt: buildSceneRenderPrompt(scenePlan(), { referenceName: LANE_PROBE_NAME }) },
    {
      lane: "scene_multi",
      prompt: buildSceneRenderPrompt(scenePlan(), {
        multiReferences: [
          { name: LANE_PROBE_NAME, kind: "character" },
          { name: "the study", kind: "location" },
        ],
      }),
    },
    {
      lane: "chat_look",
      prompt: buildChatLookPrompt({ outfit: "a floor-length wine-red silk kimono", outfitExposed: false }),
    },
    { lane: "variant", prompt: buildVariantInstruction("outfit", "wearing a floor-length wine-red silk kimono") },
  ];

  it("no lane emits a non-visual attribute", () => {
    const leaks = lanes().filter(({ prompt }) => presentVisualFacts(prompt).includes("voiceTimbre"));
    expect(leaks.map((l) => l.lane)).toEqual([]);
  });

  it("no lane describes covered intimate SKIN, even on an uncensored route", () => {
    // The dressed fixture covers the torso, so `breasts.nipples` — an
    // `imageReveal: "skin"` fact — must stay silent everywhere, including the
    // uncensored routes, where the gate is coverage and not the route.
    //
    // `breasts.size` is deliberately NOT asserted: it is `imageReveal: "shape"`,
    // the silhouette that reads through clothing, so an uncensored dressed render
    // states it on purpose. Nor are the lower-body skin facts, which do not hold
    // across lanes yet (see the text-to-image toenails cell above) and are
    // therefore frozen per lane rather than asserted as an invariant.
    const uncensored = [
      buildSceneRenderPrompt(scenePlan(), { allowIntimate: true }),
      buildSceneRenderPrompt(scenePlan(), { referenceName: LANE_PROBE_NAME, allowIntimate: true }),
      buildSceneRenderPrompt(scenePlan(), {
        multiReferences: [{ name: LANE_PROBE_NAME, kind: "character" }],
        allowIntimate: true,
      }),
    ];
    for (const prompt of [...lanes().map((l) => l.prompt), ...uncensored]) {
      expect(presentVisualFacts(prompt)).not.toContain("nipples");
    }
  });

  it("states apparent age in the two lanes that still carry it, and in no other", () => {
    // The 2026-07-29 owner ruling made the avatar not the sole age source: an
    // edit model re-reads an ambiguous reference a step older every generation,
    // so a text anchor had to hold it. The narrative/visual age split (#143)
    // then narrowed WHICH lanes say it — scene renders and chat look became
    // age-neutral, and the portrait pair kept the anchor because those are the
    // lanes an edit model drifts.
    const anchor = apparentAgeAnchor(LANE_PROBE_NAME, resolveAttributes(profile.attributes, []));
    expect(anchor).toContain("late twenties");

    for (const prompt of [
      buildAvatarPrompt(LANE_PROBE_NAME, profile, "realistic", dressed),
      buildVariantInstruction("outfit", "wearing a kimono", anchor),
    ]) {
      expect(presentVisualFacts(prompt)).toContain("apparentAge");
    }

    // Age-neutral since #143. Stated as an explicit absence rather than left
    // unasserted, because "this lane says no age" is the product decision — a
    // lane that quietly regained one would otherwise pass.
    for (const prompt of [
      buildSceneRenderPrompt(scenePlan(), {}),
      buildSceneRenderPrompt(scenePlan(), { referenceName: LANE_PROBE_NAME }),
      buildChatLookPrompt({ outfit: "a kimono", outfitExposed: false }),
    ]) {
      expect(presentVisualFacts(prompt)).not.toContain("apparentAge");
    }
  });

  it("the probe vocabulary itself stays stable", () => {
    // A probe key rename would silently re-bless every matrix above, so the key
    // set is frozen too. Adding a probe is a deliberate edit here.
    expect(VISUAL_FACT_PROBES.map((probe) => probe.key)).toEqual([
      "gender",
      "ethnicity",
      "species",
      "hairColor",
      "eyeColor",
      "skinTone",
      "horns",
      "wings",
      "tail",
      "apparentAge",
      "garment",
      "bareTorso",
      "legBuild",
      "toenails",
      "bustSize",
      "nipples",
      "voiceTimbre",
    ]);
  });
});
