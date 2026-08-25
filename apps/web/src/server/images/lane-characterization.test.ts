import { describe, expect, it } from "vitest";
import { resolveAttributes } from "@/contracts/attributes/value";
import type { CharacterProfile } from "@/contracts/world/profile";
import {
  duplicatedVisualFacts,
  LANE_PROBE_NAME,
  LANE_PROBE_SECOND_NAME,
  laneProbeAvatarSegments,
  laneProbeBareExposure,
  laneProbeCastMember,
  laneProbeCastScenePlan,
  laneProbeCastSubjects,
  laneProbeDressedExposure,
  laneProbeMarkedProfile,
  laneProbeProfile,
  laneProbeScenePlan,
  laneProbeShadowInput,
  laneProbeVariantSegments,
  laneProbeWardrobe,
  presentVisualFacts,
  SECOND_SUBJECT_VISUAL_FACT_PROBES,
  VISUAL_FACT_PROBES,
} from "@/server/test-support";
import type { SceneCastMember } from "./character-scene";
import { buildChatLookSegments } from "./chat-look-segments";
import { apparentAgeAnchor } from "./prompts-appearance";
import type { AvatarWardrobeItem } from "./prompts-avatar";
import { buildSceneRenderPrompt } from "./prompts-scene-render";
import type { VariantKind } from "./prompts-variant";
import { applySceneCastVisual, applySceneSubjectVisual } from "./scene-subject-visual";

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
 * - The CHAT-LOOK lane (cut over to the Stage 4 digest assembly, 2026-08-25;
 *   `buildChatLookSegments`) states the requested outfit plus the digest's
 *   mandatory morphology anchors, and nothing else. That is deliberate rather
 *   than a gap: it is an identity-locked EDIT of the character's own portrait,
 *   so hair, eye and skin colour keep coming from the reference photograph
 *   unstated, while a species appendage is exactly what an edit model
 *   "corrects" away when only the picture asserts it. It carries no age (the
 *   narrative/visual split) and no exposure or current-state fact (the outfit
 *   line states coverage once as the operation, and the anchor's cache key
 *   cannot see transient body state).
 * - The VARIANT lane (cut over to the Stage 4 digest assembly, 2026-08-25;
 *   `buildVariantSegments`) states the requested change as an operation
 *   contract, the identity lock, an age anchor it now derives itself rather
 *   than taking as a caller-supplied string, and the digest's morphology
 *   anchors — the one fact-set gain. Hair, eye and skin colour stay unstated by
 *   owner ruling: the reference photograph is the better source, so this lane
 *   has no residual attribute sheet at all. It states no exposure (coverage
 *   belongs to the reference, and may be exactly what the instruction changes).
 *
 * A lane that gains a fact it never had, or loses one it has, fails here first.
 *
 * The Stage 4 CAST ≥2 scene (`applySceneCastVisual`, 2026-08-25) has no frozen
 * row of its own on purpose. Its per-subject fact sets are already pinned
 * exactly by the legacy-vs-digest comparison, which can state them as a delta
 * from the legacy production and therefore says something a second frozen list
 * here would not. What the cast build IS used for below is the cross-lane
 * invariants, because a leak that needs two people in one prompt — one
 * character described from another's cut, one character's coverage gating
 * everybody's skin — has nowhere else to show up.
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
 * The variant/edit lane, through the PRODUCTION Stage 4 assembly
 * (`buildVariantSegments` — the same standalone visual cut the avatar lane
 * uses, under this lane's full-figure camera and its exposure-omitting policy).
 * Eligibility is asserted for the same reason: a freeze over a prompt the
 * production path would refuse to send before provider spend proves nothing.
 */
function variantPrompt(kind: VariantKind, instruction: string): string {
  const built = laneProbeVariantSegments(kind, instruction);
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

/**
 * The cast ≥2 scene, through the PRODUCTION Stage 4 cast production
 * (`applySceneCastVisual`): the focal beside a bystander from the second
 * fixture, each drawn from their OWN committed cut.
 *
 * There is deliberately NO frozen fact matrix for this lane. The
 * legacy-vs-digest comparison already pins both subjects' fact sets exactly
 * (`lane-cutover-comparison.test.ts`), and a second copy of them here would be
 * one more place to re-bless when the lane moves. What this build is used for
 * is the cross-lane invariants below, which no other suite states — and which
 * are the ones a second person in frame can break.
 */
function castScenePlan() {
  const subjects = laneProbeCastSubjects();
  const applied = applySceneCastVisual({
    plan: laneProbeCastScenePlan(subjects.map((subject) => subject.member)),
    members: subjects,
  });
  expect(applied.refusal).toBeNull();
  return applied.plan;
}

/** The cast lane's two-character reference rung — where each subject gets identity anchors. */
const CAST_MULTI_REFERENCES = {
  multiReferences: [
    { name: LANE_PROBE_NAME, kind: "character" as const },
    { name: LANE_PROBE_SECOND_NAME, kind: "character" as const },
  ],
};

const bareMember = laneProbeCastMember({ outfit: "", exposure: bareExposure });

/**
 * The chat-look mint, through the PRODUCTION Stage 4 assembly
 * (`buildChatLookSegments` — the committed chat cut's visual digest plus this
 * lane's three route-owned sentences). The refusal assertion matters for the
 * same reason the avatar and scene helpers assert eligibility: a freeze over a
 * prompt production the mint would refuse to send proves nothing.
 */
function chatLookPrompt(subject: CharacterProfile = laneProbeProfile()): string {
  const built = buildChatLookSegments({
    outfit: "a floor-length wine-red silk kimono",
    outfitExposed: false,
    shadow: laneProbeShadowInput(subject),
    exposure: laneProbeDressedExposure(),
  });
  expect(built.refusal).toBeNull();
  return built.prompt;
}

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

  it("chat look: the digest's morphology anchors join the requested outfit — and nothing else", () => {
    // Re-frozen for the Stage 4 cutover. The row GAINS horns/wings/tail and
    // gains nothing else, which is the whole shape of this lane's ruling: a
    // look mint is an identity-locked EDIT of the character's own portrait, so
    // hair, eye and skin colour keep coming from the reference photograph
    // unstated (restating them is how an edit model is invited to repaint
    // them), while a species appendage is exactly the anchor an edit model
    // "corrects" away when only the picture asserts it.
    //
    // Age stays absent (the narrative/visual split, #143), and no exposure or
    // current-state fact appears: the outfit line states coverage once as the
    // operation, and the cached anchor's key cannot see transient body state.
    expectLaneFacts(chatLookPrompt(), ["horns", "wings", "tail", "garment"]);
  });

  it("portrait variant: the digest's morphology anchors join the age and the requested change", () => {
    // Re-frozen for the Stage 4 variant cutover (`buildVariantSegments`). The
    // row GAINS horns/wings/tail and nothing else, which is the owner ruling
    // stated as a fact set: the prompt takes only what the digest naturally
    // projects — species morphology and cataloged distinctive marks — because
    // those are the anchors an edit model "corrects" away. Hair, eye and skin
    // colour stay ABSENT on purpose: they come off the reference photo, which
    // is a better source than a sentence, so this lane deliberately has no
    // residual attribute sheet. The age anchor is no longer caller-supplied —
    // the assembly derives it — which is the coupling Stage 4 removed.
    expectLaneFacts(variantPrompt("outfit", "wearing a floor-length wine-red silk kimono"), [
      "horns",
      "wings",
      "tail",
      "apparentAge",
      "garment",
    ]);
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
    { lane: "chat_look", prompt: chatLookPrompt() },
    { lane: "variant", prompt: variantPrompt("outfit", "wearing a floor-length wine-red silk kimono") },
    // The Stage 4 cast lane joins the invariant sweep even though it has no
    // frozen row: a leak class that needs two people in one prompt to appear
    // has no other suite to appear in.
    { lane: "scene_cast", prompt: buildSceneRenderPrompt(castScenePlan(), {}) },
  ];

  it("no lane emits a non-visual attribute", () => {
    const leaks = lanes().filter(({ prompt }) => presentVisualFacts(prompt).includes("voiceTimbre"));
    expect(leaks.map((l) => l.lane)).toEqual([]);
    // …and the sensory skip is per SUBJECT, not per render: the bystander's own
    // timbre must be silent in the same prompt the focal's is, read off their own
    // disjoint vocabulary.
    const cast = buildSceneRenderPrompt(castScenePlan(), {});
    expect(presentVisualFacts(cast, SECOND_SUBJECT_VISUAL_FACT_PROBES)).not.toContain("voiceTimbre");
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

    // The bystander half, and the reason it is worth its two lines: an
    // uncensored cast render emits `intimateAppearance` for EVERY subject in
    // frame, not only the anchored one, so a coverage gate that read the focal's
    // exposure for everybody would describe a fully dressed second character's
    // bare chest. That torso is covered, and the shape (`breasts.size`) is
    // deliberately not asserted, exactly as the focal's is not.
    const castUncensored = buildSceneRenderPrompt(castScenePlan(), {
      ...CAST_MULTI_REFERENCES,
      allowIntimate: true,
    });
    expect(presentVisualFacts(castUncensored, SECOND_SUBJECT_VISUAL_FACT_PROBES)).not.toContain("nipples");
    expect(presentVisualFacts(castUncensored)).not.toContain("nipples");
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

    // Both lanes now DERIVE the anchor rather than being handed one, so the
    // shared expectation is that each states the same band the fixture holds.
    for (const prompt of [avatarPrompt(dressed), variantPrompt("outfit", "wearing a kimono")]) {
      expect(presentVisualFacts(prompt)).toContain("apparentAge");
    }

    // Age-neutral since #143. Stated as an explicit absence rather than left
    // unasserted, because "this lane says no age" is the product decision — a
    // lane that quietly regained one would otherwise pass.
    for (const prompt of [
      buildSceneRenderPrompt(scenePlan(), {}),
      buildSceneRenderPrompt(scenePlan(), { referenceName: LANE_PROBE_NAME }),
      chatLookPrompt(),
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

    // The chat-look mint states the mark ZERO times, and that is the honest
    // reading of a seam Stage 4 measured rather than a cut this lane chose.
    // Recognition marks reach a lane by two different roads: the STANDALONE
    // snapshot road (the avatar and variant lanes) projects a cataloged
    // distinctive value into the digest as a mark, while the chat SHADOW road
    // (this lane and the scene lane) does not project one at all — verified by
    // suppression: the avatar build records `nose/shape` as `lane_curated`,
    // and both chat builds record no `nose/shape` fact whatever. The scene
    // lane never noticed because its route-owned residual sheet says it
    // anyway; the chat-look mint has no residue, so the silence shows.
    //
    // Left silent on purpose rather than patched here. This lane edits FROM an
    // identity reference, and the owner's ruling for its sibling edit lane is
    // that identity detail the reference photo already carries stays unstated
    // (2026-08-25 — the variant lane gains body-shape anchors only). Closing
    // the projection asymmetry belongs to `visual-state.plan.md`, which owns
    // the projection; when it lands, this lane gains the mark for free and
    // this assertion flips to `toContain`.
    const look = chatLookPrompt(marked);
    expect(presentVisualFacts(look)).not.toContain("noseShape");
    expect(duplicatedVisualFacts(look)).toEqual([]);
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
