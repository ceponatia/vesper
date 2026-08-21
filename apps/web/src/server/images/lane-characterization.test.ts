import { describe, expect, it } from "vitest";
import { resolveAttributes } from "@/contracts/attributes/value";
import {
  duplicatedVisualFacts,
  LANE_PROBE_NAME,
  laneProbeAvatarSegments,
  laneProbeBareExposure,
  laneProbeCastMember,
  laneProbeMarkedProfile,
  laneProbeProfile,
  laneProbeScenePlan,
  laneProbeShadowInput,
  laneProbeWardrobe,
  presentVisualFacts,
  VISUAL_FACT_PROBES,
} from "@/server/test-support";
import type { SceneCastMember } from "./character-scene";
import { buildChatLookPrompt } from "./chat-look";
import { apparentAgeAnchor } from "./prompts-appearance";
import type { AvatarWardrobeItem } from "./prompts-avatar";
import { buildSceneRenderPrompt } from "./prompts-scene-render";
import { buildVariantInstruction } from "./prompts-variant";
import { applySceneSubjectVisual } from "./scene-subject-visual";

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
 * - The avatar lane (cut over to the Stage 3 digest assembly, 2026-08-21) states
 *   identity, morphology, age and wardrobe — morphology now through the visual
 *   digest, the rest still from the sheet — and drops everything below the waist
 *   (waist-up framing). Its fact set is unchanged from the pre-cutover freeze.
 * - The SCENE lanes (cut over to the cast-1 digest production, WP-C 2026-08-21;
 *   `applySceneSubjectVisual`) now share ONE coverage-aware selection. Two
 *   deliberate fact-set changes came with that, each frozen below:
 *   - the text-to-image lane STOPPED describing covered `imageReveal: "skin"`
 *     detail (the recorded toenails-under-slippers leak is closed — the freeze
 *     comment that used to mark the drift now marks the fix);
 *   - every scene lane GAINED the digest's mandatory morphology anchors
 *     (horns/wings/tail), closing the recorded "reference lanes lose morphology
 *     entirely" gap — a species appendage is exactly the anchor an edit model
 *     "corrects" away when only the reference asserts it.
 * - The chat-look lane states apparent age and the requested outfit and NOTHING
 *   else — no identity, morphology, or exposure fact at all. Same for the
 *   variant lane. Both take their age anchor as a caller-supplied string, which
 *   is the coupling Stage 4 replaces with a mandatory `age` segment.
 *
 * A lane that gains a fact it never had, or loses one it has, fails here first.
 */

const profile = laneProbeProfile();
const dressed = laneProbeWardrobe();
const bareExposure = laneProbeBareExposure();

/**
 * The avatar lane, through the PRODUCTION Stage 3 assembly (`buildAvatarSegments`
 * — standalone visual digest + semantic segments, via the shared probe builder).
 * Re-frozen 2026-08-21 with an UNCHANGED fact set: the digest's morphology
 * segment took over the feature groups the sheet traversal used to state, and
 * every other fact still arrives exactly once. The helper also asserts render
 * eligibility, because a freeze over a prompt production that would refuse to
 * send proves nothing.
 */
function avatarPrompt(wardrobe: ReadonlyArray<AvatarWardrobeItem>, style: "realistic" | "stylized" = "realistic"): string {
  const built = laneProbeAvatarSegments(wardrobe, style);
  expect(built.missingRequired).toEqual([]);
  return built.prompt;
}

/**
 * The scene plan a lane renders, built through the production seams end to end:
 * context → composer-spec resolve (`laneProbeScenePlan`) → the cast-1 digest
 * patch the render job applies once the committed camera exists
 * (`applySceneSubjectVisual`). The refusal assertion matters here for the same
 * reason the avatar helper asserts eligibility — a freeze over a plan the
 * production path would refuse to render proves nothing.
 */
function scenePlan(member: SceneCastMember = laneProbeCastMember()) {
  const applied = applySceneSubjectVisual({
    plan: laneProbeScenePlan(member),
    member,
    shadow: laneProbeShadowInput(member.profile),
  });
  expect(applied.refusal).toBeNull();
  return applied.plan;
}

const bareMember = laneProbeCastMember({ outfit: "", exposure: bareExposure });

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
    expectLaneFacts(avatarPrompt(dressed), [
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

  it("scene, text-to-image: the digest-fed description is coverage-aware", () => {
    // Re-frozen for the WP-C cast-1 cutover. One change from the pre-cutover
    // row, and it is the fix the plan promised: `toenails` — a covered
    // `imageReveal: "skin"` fact the exposure-blind appearance summary used to
    // leak into text-to-image prompts — is now ABSENT, because the residual
    // sheet applies the same coverage gate the reveal lanes always had. Every
    // other fact is unchanged: identity and the sheet still state the person,
    // and the morphology anchors now arrive through the digest's mandatory
    // clauses instead of the sheet's feature-group traversal (same facts, one
    // owner).
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
    ]);
  });

  it("scene, single reference: identity anchors now carry the digest's morphology", () => {
    // Re-frozen for WP-C: the row GAINS horns/wings/tail. The pre-cutover
    // reference lanes carried no morphology fact at all — they leaned entirely
    // on the reference image, and a species appendage is exactly the anchor an
    // edit model "corrects" away when nothing in the text asserts it (the same
    // reasoning that put morphology in the avatar's digest segment). The
    // attribute anchors (hair/eyes/skin) and the reveal line are unchanged.
    expectLaneFacts(buildSceneRenderPrompt(scenePlan(), { referenceName: LANE_PROBE_NAME }), [
      "hairColor",
      "eyeColor",
      "skinTone",
      "horns",
      "wings",
      "tail",
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
    // wording, ordering and budgets (audit finding 4). Re-frozen with the same
    // morphology gain as the single-reference row: this fixture is a CAST OF
    // ONE handed multi-reference transport (the character plus a location
    // image), so it exercises the cast-1 digest production — the cast ≥2 field
    // path stays legacy and is pinned by `character-scene.test.ts`'s two-member
    // suite, not here.
    expectLaneFacts(prompt, ["hairColor", "eyeColor", "skinTone", "horns", "wings", "tail", "garment", "legBuild"]);
  });

  it("chat look: the requested outfit and no other character fact, age included", () => {
    const prompt = buildChatLookPrompt({ outfit: "a floor-length wine-red silk kimono", outfitExposed: false });
    // Age left the chat-look lane with the narrative/visual age split (#143):
    // the builder no longer takes an anchor, so the garment is the only fact.
    expectLaneFacts(prompt, ["garment"]);
  });

  it("portrait variant: apparent age and the requested change, and no other character fact", () => {
    const prompt = buildVariantInstruction("outfit", "wearing a floor-length wine-red silk kimono", {
      ageAnchor: apparentAgeAnchor(LANE_PROBE_NAME, resolveAttributes(profile.attributes, [])),
    });
    expectLaneFacts(prompt, ["apparentAge", "garment"]);
  });
});

describe("image lane characterization — bare subject", () => {
  it("scene, text-to-image: exposure is stated, intimate anatomy is not (censored route)", () => {
    // Byte-identical fact set to the pre-cutover freeze: with nothing covered,
    // the new coverage gate excludes nothing, so `toenails` correctly STAYS —
    // proving the dressed row's absence is the gate, not a lost fact.
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
    // Re-frozen for WP-C with the same single change as the dressed reference
    // row — the digest's morphology anchors join. The reveal machinery
    // (exposure-gated skin, route-gated intimate detail) is unchanged.
    expectLaneFacts(prompt, [
      "hairColor",
      "eyeColor",
      "skinTone",
      "horns",
      "wings",
      "tail",
      "bareTorso",
      "legBuild",
      "toenails",
      "bustSize",
      "nipples",
    ]);
  });

  it("avatar: bare or dressed, the portrait studio states no intimate anatomy", () => {
    const prompt = avatarPrompt([]);
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
    { lane: "avatar", prompt: avatarPrompt(dressed) },
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
      avatarPrompt(dressed),
      buildVariantInstruction("outfit", "wearing a kimono", { ageAnchor: anchor }),
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

  it("a cataloged distinctive mark is stated exactly once per lane — the residue owns the phrasing", () => {
    // The duplication seam the digest cutover opened (WP-C report): a
    // recognition-catalog attribute with a distinctive value (`nose.shape:
    // "crooked"`) projects into the visual digest as a mark AND survives the
    // route-owned residual attribute sheet, so a lane that lets both speak
    // states the same fact twice — the exact failure mode the spec's comparison
    // rule names ("fail on … duplicated … character facts"). Both cutover lanes
    // resolve it the same way: the catalog-derived residue set rides the shared
    // clause resolver as `{ omit }`, so the residue keeps the only statement.
    const marked = laneProbeMarkedProfile();

    const avatar = laneProbeAvatarSegments(dressed, "realistic", marked);
    expect(avatar.missingRequired).toEqual([]);
    expect(presentVisualFacts(avatar.prompt)).toContain("noseShape");
    expect(duplicatedVisualFacts(avatar.prompt)).toEqual([]);

    const member = laneProbeCastMember({ profile: marked });
    const scene = buildSceneRenderPrompt(scenePlan(member), {});
    expect(presentVisualFacts(scene)).toContain("noseShape");
    expect(duplicatedVisualFacts(scene)).toEqual([]);
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
      // Added with the WP-D duplication pin (2026-08-21): authored only by the
      // marked fixture, so no matrix above gained a cell.
      "noseShape",
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
