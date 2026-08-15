import { describe, expect, it } from "vitest";
import type { ImageLabStaging } from "@vesper/image-core";
import { sceneStagingById, sceneStagings, type SceneStaging } from "@/contracts/images/scene-staging";
import type { RegionExposure } from "@/contracts/items/visibility";
import { stagedSceneWords } from "./image-lab-staged";
import { sceneSpecSchema, type SceneComposerContext } from "./prompts-scene-composer";
import { resolveScenePlan } from "./prompts-scene-plan";
import { buildSceneRenderPrompt, EDIT_RENDER_PROMPT_LIMIT } from "./prompts-scene-render";

/**
 * The staged bench's parity pin (intimate-scene-lora.spec.md §"Slice 2").
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
 * The chat side is built the way the chat lane really reaches an intimate staged
 * render — a composer spec whose staging carries a verbatim narration quote,
 * resolved against a present roster — so the comparison is against the resolver's
 * gates rather than against a plan handed the answer.
 *
 * Every staging in the catalog is checked rather than a chosen few: the entries
 * differ in exactly the ways this lane has to get right (bare regions, viewer
 * parts including intimate ones, a face the shot hides, a camera that overrides
 * the default), and a census cannot go stale when a fourteenth entry lands.
 */

const SUBJECT = "Sabrina Vale";

/** The quote the chat-side staging earns its place with — the bench needs none. */
const EVIDENCE = "she is arranged exactly like this";
const NARRATION = `The room goes quiet, and ${EVIDENCE}, breathing slow.`;

/** The player undressed — what both sides state, since a covered pelvis would gate the anatomy out of frame. */
const PLAYER_BARE: RegionExposure = { torso: "bare", pelvis: "bare", legs: "bare", feet: "bare" };

const SCENE: ImageLabStaging = { id: "", setting: "a rumpled bed, one lamp left on", timeOfDay: "night" };

function subjectExposure(entry: SceneStaging): RegionExposure {
  const exposure: RegionExposure = { torso: "covered", pelvis: "covered", legs: "covered", feet: "covered" };
  for (const region of entry.requiresBare) exposure[region] = "bare";
  return exposure;
}

/**
 * The plan the CHAT lane resolves for this staging: the composer proposes it
 * with a quote the narration really contains, the roster is the one present NPC
 * the solo entries require, and the coverage gate sees the bare regions the
 * template describes. Nothing is forced — if a gate dropped the entry the
 * prompts would differ and the comparison below would fail loudly, which is the
 * behaviour this fixture wants.
 */
function chatLanePrompt(entry: SceneStaging): string {
  const context: SceneComposerContext = {
    present: [
      {
        name: SUBJECT,
        wornVisible: [],
        exposure: subjectExposure(entry),
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
  return buildSceneRenderPrompt(resolveScenePlan(spec, context), { referenceName: SUBJECT, allowIntimate: true });
}

function benchWords(entry: SceneStaging): ReturnType<typeof stagedSceneWords> {
  return stagedSceneWords(SUBJECT, entry, { ...SCENE, id: entry.id });
}

describe("staged scene words", () => {
  it.each(sceneStagings.map((entry) => [entry.id, entry] as const))(
    "compiles %s byte-identically to the chat lane's own prompt for the same staging",
    (_id, entry) => {
      expect(benchWords(entry).prompt).toBe(chatLanePrompt(entry));
    },
  );

  it.each(sceneStagings.map((entry) => [entry.id, entry] as const))(
    "sends the %s template verbatim, inside the edit budget it was written against",
    (_id, entry) => {
      const { prompt } = benchWords(entry);
      // The registry owns every explicit word: nothing between it and the prompt
      // may reword a template, so the check is for the entry's own text with
      // `{name}` bound — the same assertion the A/B probe refuses to render
      // without.
      expect(prompt).toContain(entry.template.replaceAll("{name}", SUBJECT));
      // The templates are measured against this ceiling character for character
      // (see the `on_all_fours` note in the registry); past it the budgeter eats
      // the setting, lighting and quality tail.
      expect(prompt.length).toBeLessThanOrEqual(EDIT_RENDER_PROMPT_LIMIT);
    },
  );

  it("states the staging's own shot and viewer parts rather than the default one", () => {
    const entry = staging("astride_viewer_facing");
    const { plan } = benchWords(entry);

    expect(plan.camera).toEqual(entry.camera);
    expect(plan.staging?.id).toBe(entry.id);
    expect(plan.viewerBody).toEqual([...entry.viewerParts]);
    // The intimate viewer part survives the per-prompt gate, which is the whole
    // reason the row states the viewer's coverage: dropped, the staged sentence
    // would be suppressed all-or-nothing and the bench would render a portrait.
    expect(benchWords(entry).prompt).toContain("the viewer's own genitals");
  });

  it("bares exactly the regions the staging's template describes as bare", () => {
    // `astride_viewer_away` needs a bare pelvis and describes a clothed back, so
    // a bench that undressed the subject wholesale would contradict the entry's
    // own wording.
    const { prompt } = benchWords(staging("astride_viewer_away"));

    expect(prompt).toContain("Bare below the waist, no underwear or bottoms.");
    expect(prompt).not.toContain("topless, bare chest");
    expect(prompt).not.toContain("fully nude");
  });

  it("says nothing about clothing for a staging that needs no bare region", () => {
    // `kneeling_before_viewer` carries `requiresBare: []` — the bare anatomy that
    // shot needs is the VIEWER's. With no wardrobe claim of its own the prompt
    // defers to the reference image, which is the honest instruction for a bench
    // that stated no outfit.
    const { prompt } = benchWords(staging("kneeling_before_viewer"));

    expect(prompt).toContain("Keep the same outfit as the reference image.");
    expect(prompt).not.toContain("bare below the waist");
  });

  it("adapts the identity lock when the staging hides the subject's face", () => {
    // `kneeling_before_viewer_guided` is a `toward_viewer` shot of the crown of
    // someone's head: the camera cannot see that the face is hidden, so the
    // staging's own override has to reach the prompt through the plan.
    const { prompt } = benchWords(staging("kneeling_before_viewer_guided"));

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
