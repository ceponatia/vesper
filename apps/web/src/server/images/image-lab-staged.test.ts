import { describe, expect, it } from "vitest";
import type { ImageLabStaging } from "@vesper/image-core";
import { sceneStagingById, sceneStagings, type SceneStaging } from "@/contracts/images/scene-staging";
import { exposedRegions, type RegionExposure } from "@/contracts/items/visibility";
import {
  LANE_PROBE_NAME,
  LANE_PROBE_SUBJECT_ID,
  laneProbeProfile,
  laneProbeShadowInput,
} from "@/server/test-support";
import { stagedSceneWords } from "./image-lab-staged";
import {
  buildStagedSubjectVisual,
  stagedPremiseWorn,
  stagedSubjectExposure,
  type StagedSubjectFacts,
} from "./image-lab-staged-visual";
import { sceneSpecSchema, type SceneComposerContext } from "./prompts-scene-composer";
import { resolveScenePlan, type SceneRenderPlan } from "./prompts-scene-plan";
import { buildSceneRenderPrompt, EDIT_RENDER_PROMPT_LIMIT } from "./prompts-scene-render";
import { applySceneSubjectVisual } from "./scene-subject-visual";
import { portraitPerception } from "./standalone-subject-visual";

/**
 * The staged bench's parity pin (owner ruling 2026-08-25).
 *
 * This kind is only worth running if its prompt is production's prompt, so the
 * assertion that matters is BYTE EQUALITY against what the chat lane's own
 * resolver produces for the same staging — not "contains the template", which a
 * lane that quietly dropped the shot line or the exposure phrase would still
 * pass. Everything else here is a corollary of that one claim: the registry's
 * words arrive verbatim, the subject is undressed for exactly the regions the
 * template describes as bare, and the result still fits the budget the templates
 * were written against.
 *
 * ## Two arms, two different chat sides — and that is the point
 *
 * The bench now has a subject-facts mode, and each arm is pinned against the
 * chat-lane prompt it actually claims to reproduce:
 *
 * - `reference_only` (the ablation) is pinned against the scene builder's own
 *   prompt for a subject it was told NOTHING about — no appearance, no anchors,
 *   no figure. That is not a stale comparison for this arm: "the plan a name
 *   alone produces" is the arm's whole definition, so the un-patched builder IS
 *   its production counterpart.
 * - `production_parity` (the default) is pinned against the chat lane as it
 *   really builds a scene today: composer spec → `resolveScenePlan` → the
 *   digest patch the render job applies (`applySceneSubjectVisual`) →
 *   `buildSceneRenderPrompt`. Before the 2026-08-25 ruling there was only one
 *   arm and it was compared against the un-patched builder, which had quietly
 *   become a comparison against a BUILDER rather than against the lane — the
 *   chat lane had moved onto the digest and the bench had not.
 *
 * The chat side is otherwise built the way the chat lane really reaches an
 * intimate staged render — a composer spec whose staging carries a verbatim
 * narration quote, resolved against a present roster — so the comparison is
 * against the resolver's gates rather than against a plan handed the answer.
 *
 * ## Why the two sides may be handed the same cut
 *
 * The parity arm's two halves assemble the SAME committed cut from two
 * different seams (the bench takes the standalone assembly, the chat lane takes
 * the shadow build), and the pin is that those two seams agree. So the fixture
 * hands both the same subject, the same attributes, the same camera and the
 * same perception; what it does NOT do is hand either side a field the other
 * computed. Anything that differs — a policy, an omit set, a routed field, a
 * dropped `lowerBody` — shows up as a byte difference.
 *
 * Every staging in the catalog is checked rather than a chosen few: the entries
 * differ in exactly the ways this lane has to get right (bare regions, viewer
 * parts including intimate ones, a face the shot hides, a camera that overrides
 * the default), and a census cannot go stale when a fourteenth entry lands.
 */

/** One fixture character across both arms — the same person the lane freeze renders. */
const SUBJECT = LANE_PROBE_NAME;
const PROFILE = laneProbeProfile();
/** A `characters.updatedAt` stand-in: the read token's only source for a bench. */
const REVISION = "2026-08-25T00:00:00.000Z";

/** The quote the chat-side staging earns its place with — the bench needs none. */
const EVIDENCE = "she is arranged exactly like this";
const NARRATION = `The room goes quiet, and ${EVIDENCE}, breathing slow.`;

/** The player undressed — what both sides state, since a covered pelvis would gate the anatomy out of frame. */
const PLAYER_BARE: RegionExposure = { torso: "bare", pelvis: "bare", legs: "bare", feet: "bare" };

const SCENE: ImageLabStaging = { id: "", setting: "a rumpled bed, one lamp left on", timeOfDay: "night" };

/**
 * The plan the CHAT lane resolves for this staging: the composer proposes it
 * with a quote the narration really contains, the roster is the one present NPC
 * the solo entries require, and the coverage gate sees the bare regions the
 * template describes. Nothing is forced — if a gate dropped the entry the
 * prompts would differ and the comparisons below would fail loudly, which is the
 * behaviour this fixture wants.
 */
function chatLanePlan(entry: SceneStaging): SceneRenderPlan {
  const context: SceneComposerContext = {
    present: [
      {
        name: SUBJECT,
        wornVisible: [],
        exposure: stagedSubjectExposure(entry),
        wardrobeTracked: true,
      },
    ],
    embodiedViewer: true,
    recentNarration: [NARRATION],
    playerExposure: PLAYER_BARE,
  };
  const spec = sceneSpecSchema.parse({
    focalCharacter: SUBJECT,
    setting: SCENE.setting,
    lighting: "dim night-time lighting",
    staging: { id: entry.id, evidence: EVIDENCE },
  });
  return resolveScenePlan(spec, context);
}

/** The ablation's counterpart: the scene builder over a subject nothing described. */
function chatLaneUndescribedPrompt(entry: SceneStaging): string {
  return buildSceneRenderPrompt(chatLanePlan(entry), { referenceName: SUBJECT, allowIntimate: true });
}

/**
 * The parity arm's counterpart: the chat lane as the render job really runs it,
 * digest patch included.
 *
 * The perception is stated rather than taken from the probe's own default
 * because it is half of the CUT, not half of the lane: a bench derives the
 * camera's per-location view from the staging's premise coverage, and comparing
 * two digests taken under different perceptions would be comparing two
 * different moments rather than two assemblies of one.
 */
function chatLaneDigestPrompt(entry: SceneStaging): string {
  const exposure = stagedSubjectExposure(entry);
  const applied = applySceneSubjectVisual({
    plan: chatLanePlan(entry),
    member: { name: SUBJECT, profile: PROFILE, exposure },
    shadow: { ...laneProbeShadowInput(PROFILE), perception: portraitPerception(stagedPremiseWorn(exposure)) },
  });
  expect(applied.refusal).toBeNull();
  return buildSceneRenderPrompt(applied.plan, { referenceName: SUBJECT, allowIntimate: true });
}

/** The bench's own digest-produced subject facts, refusing loudly rather than degrading. */
function benchFacts(entry: SceneStaging): StagedSubjectFacts {
  const built = buildStagedSubjectVisual({
    characterId: LANE_PROBE_SUBJECT_ID,
    name: SUBJECT,
    profile: PROFILE,
    revision: REVISION,
    entry,
  });
  if (!built.ok) throw new Error(`the parity arm refused the fixture: ${built.refusal}`);
  return built.facts;
}

function ablationWords(entry: SceneStaging): ReturnType<typeof stagedSceneWords> {
  return stagedSceneWords(SUBJECT, entry, { ...SCENE, id: entry.id });
}

function parityWords(entry: SceneStaging): ReturnType<typeof stagedSceneWords> {
  return stagedSceneWords(SUBJECT, entry, { ...SCENE, id: entry.id }, benchFacts(entry));
}

const EVERY_STAGING = sceneStagings.map((entry) => [entry.id, entry] as const);

describe("staged scene words", () => {
  it.each(EVERY_STAGING)(
    "compiles %s byte-identically to the chat lane's own digest-fed prompt for the same staging",
    (_id, entry) => {
      expect(parityWords(entry).prompt).toBe(chatLaneDigestPrompt(entry));
    },
  );

  it.each(EVERY_STAGING)(
    "compiles the %s ablation byte-identically to the scene builder's prompt for an undescribed subject",
    (_id, entry) => {
      expect(ablationWords(entry).prompt).toBe(chatLaneUndescribedPrompt(entry));
    },
  );

  it.each(EVERY_STAGING)(
    "sends the %s template verbatim on both arms, inside the edit budget it was written against",
    (_id, entry) => {
      for (const { prompt } of [ablationWords(entry), parityWords(entry)]) {
        // The registry owns every explicit word: nothing between it and the
        // prompt may reword a template, so the check is for the entry's own text
        // with `{name}` bound — the same assertion the A/B probe refuses to
        // render without. It holds on the parity arm too, which is the claim
        // that matters there: the digest's sentences must not crowd the act out
        // of its own prompt.
        expect(prompt).toContain(entry.template.replaceAll("{name}", SUBJECT));
        // The templates are measured against this ceiling character for
        // character (see the `on_all_fours` note in the registry); past it the
        // budgeter eats the setting, lighting and quality tail.
        expect(prompt.length).toBeLessThanOrEqual(EDIT_RENDER_PROMPT_LIMIT);
      }
    },
  );

  it("describes the subject on the parity arm and says nothing about them on the ablation", () => {
    const entry = staging("astride_viewer_facing");
    const facts = benchFacts(entry);

    // The parity arm's whole claim: the sheet reached the prompt.
    expect(facts.identityAnchors.length).toBeGreaterThan(0);
    expect(parityWords(entry).prompt).toContain("Same person as the reference image");
    // ...and the ablation's whole claim: it did not.
    expect(ablationWords(entry).prompt).not.toContain("Same person as the reference image");
  });

  /**
   * The one field the two field productions deliberately differ on. The chat
   * lane folds its route-owned residual attribute sheet into `appearance`; the
   * bench does not, because the transport emits `appearance` only for a TEXTUAL
   * subject and this kind always sends an identity reference of its one
   * character. Pinning that the field cannot reach the prompt is what makes the
   * omission safe rather than a silent parity hole.
   */
  it("never lets the focal's appearance field reach a staged prompt", () => {
    const entry = staging("astride_viewer_facing");
    const scene = { ...SCENE, id: entry.id };
    const facts = benchFacts(entry);

    expect(stagedSceneWords(SUBJECT, entry, scene, { ...facts, appearance: "IMPOSSIBLE MARKER" }).prompt).toBe(
      stagedSceneWords(SUBJECT, entry, scene, facts).prompt,
    );
  });

  /**
   * The invariant the parity arm is built on: the coverage the digest reads is
   * the STAGING's premise, never a wardrobe. `stagedPremiseWorn` is the only
   * channel into the standalone assembly's exposure readout and its camera
   * perception, so a premise that did not round-trip would let a garment list
   * decide which regions the bench thinks are bare — the failure that would
   * silently switch several stagings off.
   *
   * A census rather than one case, because the four region roots NEST: `feet` is
   * a child of `legs`, so an entry that bared a foot while clothing the leg
   * could not be expressed by root ids and would silently over-cover. No entry
   * does that today; this is what says so, per entry, and what will say
   * otherwise the day one lands.
   */
  it.each(EVERY_STAGING)("expresses %s's invented exposure as coverage that round-trips", (_id, entry) => {
    const exposure = stagedSubjectExposure(entry);
    expect(exposedRegions(stagedPremiseWorn(exposure))).toEqual(exposure);
  });

  it("states the staging's own shot and viewer parts rather than the default one", () => {
    const entry = staging("astride_viewer_facing");
    const { plan } = ablationWords(entry);

    expect(plan.camera).toEqual(entry.camera);
    expect(plan.staging?.id).toBe(entry.id);
    expect(plan.viewerBody).toEqual([...entry.viewerParts]);
    // The intimate viewer part survives the per-prompt gate, which is the whole
    // reason the row states the viewer's coverage: dropped, the staged sentence
    // would be suppressed all-or-nothing and the bench would render a portrait.
    expect(ablationWords(entry).prompt).toContain("the viewer's own genitals");
  });

  it("bares exactly the regions the staging's template describes as bare", () => {
    // `astride_viewer_away` needs a bare pelvis and describes a clothed back, so
    // a bench that undressed the subject wholesale would contradict the entry's
    // own wording.
    const { prompt } = ablationWords(staging("astride_viewer_away"));

    expect(prompt).toContain("Bare below the waist, no underwear or bottoms.");
    expect(prompt).not.toContain("topless, bare chest");
    expect(prompt).not.toContain("fully nude");
  });

  it("says nothing about clothing for a staging that needs no bare region", () => {
    // `kneeling_before_viewer` carries `requiresBare: []` — the bare anatomy that
    // shot needs is the VIEWER's. With no wardrobe claim of its own the prompt
    // defers to the reference image, which is the honest instruction for a bench
    // that stated no outfit.
    const { prompt } = ablationWords(staging("kneeling_before_viewer"));

    expect(prompt).toContain("Keep the same outfit as the reference image.");
    expect(prompt).not.toContain("bare below the waist");
  });

  it("adapts the identity lock when the staging hides the subject's face", () => {
    // `kneeling_before_viewer_guided` is a `toward_viewer` shot of the crown of
    // someone's head: the camera cannot see that the face is hidden, so the
    // staging's own override has to reach the prompt through the plan.
    const { prompt } = ablationWords(staging("kneeling_before_viewer_guided"));

    expect(prompt).toContain(`${SUBJECT}'s face is not visible in this shot`);
    expect(prompt).toContain(`do not rotate ${SUBJECT} to face the camera.`);
  });

  it("derives the light from the stated time of day, and prefers an admin's own phrase", () => {
    const entry = staging("held_from_behind");

    expect(stagedSceneWords(SUBJECT, entry, { id: entry.id, timeOfDay: "dusk" }).prompt).toContain(
      "Lighting: warm dusk light.",
    );
    expect(
      stagedSceneWords(SUBJECT, entry, { id: entry.id, timeOfDay: "dusk", lighting: "one bare bulb overhead" }).prompt,
    ).toContain("Lighting: one bare bulb overhead.");
    // Nothing stated at all is the neutral phrase, not an empty line.
    expect(stagedSceneWords(SUBJECT, entry, { id: entry.id }).prompt).toContain("Lighting: soft natural light.");
  });
});

/** Registry lookup that fails loudly — a test naming an entry the catalog dropped is broken, not skippable. */
function staging(id: string): SceneStaging {
  const entry = sceneStagingById(id);
  if (!entry) throw new Error(`unknown staging id "${id}" — scene-staging.ts and this suite have drifted`);
  return entry;
}
