import { reviewedImageQualityPolicy, reviewedImageQualitySlugs } from "@vesper/image-core";
import { describe, expect, it } from "vitest";
import { fnv1aHex } from "@/lib/hash";
import { attr, makeProfile } from "@/server/test-support";
import type { AttributeValue } from "@/contracts/attributes";
import { buildChatLookPrompt, buildChatPlacePrompt } from "./chat-look";
import { buildAvatarPrompt } from "./prompts-avatar";
import { emptySceneRenderPlan, type SceneRenderPlan } from "./prompts-scene-plan";
import { buildSceneRenderPrompt } from "./prompts-scene-render";
import { buildVariantInstruction } from "./prompts-variant";

/**
 * The Stage 0 payload freeze (model-aware-image-prompts.plan.md §"Stage 0 —
 * research and current-behavior freeze").
 *
 * Every lane below still runs its ORIGINAL prose builder, and each will
 * eventually be re-expressed as a prompt program compiled from a world digest.
 * The cutover's whole method is a shadow comparison — compile the candidate
 * beside production, prove the facts survive, then switch — and that comparison
 * is only worth anything if "production" has not quietly moved underneath it.
 *
 * So these hashes are a FREEZE, not a snapshot of nice-to-have wording. A failure
 * here means one of three things, and only the third permits a new hash:
 *
 * - an unintended edit reached a frozen builder, and the fix is to revert it;
 * - this lane is being cut over, in which case the pin is deleted along with the
 *   builder — not updated to match a new string;
 * - a deliberate, reviewed product change altered the lane while it is still on
 *   its old prompt path. Re-pin, and say why in `BASELINE` with a date and the
 *   change that caused it.
 *
 * The third case is real and was underestimated when this file was written: the
 * narrative/visual age split (#143) made chat look age-neutral, and this test is
 * what surfaced it. Re-pinning silently would have been the failure mode — a
 * frozen lane whose baseline quietly follows its own edits is not frozen, and the
 * shadow comparison it protects would be measuring the thing being replaced. A
 * re-pin with a recorded reason keeps the freeze meaningful; the note is the
 * difference between the two.
 *
 * Structural assertions about these same prompts live in `prompts.test.ts` and
 * stay there: this file deliberately says nothing about what the text CONTAINS,
 * because a hash that also had opinions would fail twice for one cause.
 */

const baseAttr = (id: AttributeValue["id"], value: AttributeValue["value"]): AttributeValue =>
  attr(id, value, "base");

/**
 * One frozen character, shared by every lane, so a fixture edit fails all of them
 * together rather than looking like real drift in one.
 */
const FROZEN_PROFILE = makeProfile({
  bio: "A harbor-town glassblower with salt in her hair.",
  personality: "Wry, guarded, fiercely loyal once you earn it.",
  attributes: [
    baseAttr("identity.gender", "female"),
    baseAttr("identity.apparent_age", "late_twenties"),
    baseAttr("hair.color", "auburn"),
    baseAttr("hair.length", "shoulder_length"),
    baseAttr("eyes.color", "grey"),
    baseAttr("build.frame", "athletic"),
  ],
});

const FROZEN_WARDROBE = [
  { name: "canvas work coat", description: "scorched at the cuffs", coverage: ["torso", "arms"], layer: 3 },
];

const FROZEN_SCENE: SceneRenderPlan = {
  ...emptySceneRenderPlan(),
  focal: {
    name: "Mira",
    action: "leaning over the cooling bench",
    outfitSummary: "canvas work coat",
    appearance: "Hair color: auburn; Eye color: grey",
    ageAnchor: "She appears to be in her late twenties.",
    identityAnchors: "auburn hair, grey eyes",
  },
  others: [{ name: "Sayed", action: "in the doorway", outfitSummary: "wool coat", appearance: "Hair color: black" }],
  setting: "a rain-streaked glassworks",
};

/**
 * The frozen lanes.
 *
 * `chars` rides beside the hash so a failure says something before anyone opens a
 * diff: a length that moved by four characters is a wording tweak, one that
 * moved by eighty is a clause appearing or vanishing.
 */
const FROZEN: readonly { readonly lane: string; readonly prompt: () => string }[] = [
  {
    lane: "avatar.realistic",
    prompt: () => buildAvatarPrompt("Mira", FROZEN_PROFILE, "realistic", FROZEN_WARDROBE),
  },
  {
    lane: "avatar.stylized",
    prompt: () => buildAvatarPrompt("Mira", FROZEN_PROFILE, "stylized", FROZEN_WARDROBE),
  },
  {
    lane: "variant.pose",
    prompt: () =>
      buildVariantInstruction("pose", "sitting on the workshop stool", {
        ageAnchor: "She appears to be in her late twenties.",
      }),
  },
  {
    lane: "variant.outfit",
    prompt: () => buildVariantInstruction("outfit", "a heavy linen apron"),
  },
  {
    lane: "chat.look",
    prompt: () => buildChatLookPrompt({ outfit: "a canvas work coat", outfitExposed: false }),
  },
  {
    lane: "chat.place",
    prompt: () =>
      buildChatPlacePrompt({ placeName: "the glassworks", sketch: "Rain on the skylights, kilns banked low." }),
  },
  {
    lane: "scene.text_to_image",
    prompt: () => buildSceneRenderPrompt(FROZEN_SCENE),
  },
  {
    lane: "scene.single_reference",
    prompt: () => buildSceneRenderPrompt(FROZEN_SCENE, { referenceName: "Mira", allowIntimate: true }),
  },
  {
    lane: "scene.multi_reference",
    prompt: () =>
      buildSceneRenderPrompt(FROZEN_SCENE, {
        multiReferences: [
          { name: "Mira", kind: "character" },
          { name: "Sayed", kind: "character" },
        ],
      }),
  },
];

/**
 * Frozen 2026-08-19, before any character-bearing lane's cutover.
 *
 * Re-pins, newest first — every one names the reviewed change that caused it:
 *
 * - `chat.look` 2026-08-19: the narrative/visual age split (#143) removed the
 *   apparent-age anchor from this lane, so the prompt lost that sentence
 *   (453 → 413 characters). A deliberate product change, not prompt drift.
 */
const BASELINE: Readonly<Record<string, { readonly hash: string; readonly chars: number }>> = {
  "avatar.realistic": { hash: "c6dd7ea2", chars: 510 },
  "avatar.stylized": { hash: "38c60558", chars: 519 },
  "variant.pose": { hash: "e344beeb", chars: 355 },
  "variant.outfit": { hash: "c070533a", chars: 262 },
  "chat.look": { hash: "455a434e", chars: 413 },
  "chat.place": { hash: "889fbf13", chars: 170 },
  "scene.text_to_image": { hash: "69ea4ebe", chars: 630 },
  "scene.single_reference": { hash: "85f18ee1", chars: 883 },
  "scene.multi_reference": { hash: "51c70434", chars: 1090 },
};

describe("positive payload freeze", () => {
  it("every uncut lane still compiles the prompt it was frozen with", () => {
    const actual = Object.fromEntries(
      FROZEN.map(({ lane, prompt }) => {
        const text = prompt();
        return [lane, { hash: fnv1aHex(text), chars: text.length }];
      }),
    );
    expect(actual).toEqual(BASELINE);
  });
});

/**
 * The negative side of the freeze.
 *
 * It is short because there is almost nothing to freeze: no uncut lane authors a
 * negative prompt at all. Every exclusion those lanes want is embedded in their
 * positive prose (`scripts/image-prompt-exclusions.test.ts` is the census of
 * exactly which), which is the condition this plan exists to end.
 *
 * The single exception is the one hidden provider default Vesper neutralizes:
 * the LikeReality Pony wrapper ships `negative_prompt: "nsfw, naked"`, which
 * silently contradicts authored wardrobe and exposure state. Clearing it is a
 * PROVIDER-DEFAULT OVERRIDE, not a Vesper negative pack, and the difference has
 * to survive the migration — the day this lane compiles a real negative program,
 * that program still has to clear the wrapper default rather than assume an
 * empty field.
 */
describe("negative payload freeze", () => {
  it("sends no authored negative text, and clears exactly one provider default", () => {
    const authored = reviewedImageQualitySlugs
      .map((slug) => ({ slug, value: reviewedImageQualityPolicy(slug)?.controlDefaults.negativePrompt }))
      .filter((entry) => entry.value !== undefined);
    expect(authored).toEqual([{ slug: "aisha-ai-official/likereality-pony-v1", value: "" }]);
  });
});
