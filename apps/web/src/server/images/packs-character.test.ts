import {
  activeImagePromptBinding,
  imageNegativePack,
  imagePositivePack,
  imagePromptDialectForBinding,
  imagePromptPackContentHash,
  parseImageNegativePackManifest,
  parseImagePositivePackManifest,
  registeredImagePromptBindings,
} from "@vesper/image-core";
import { describe, expect, it } from "vitest";
import {
  qwenImageEdit2511Bindings,
  qwenImageEdit2511ChatLookPositivePack,
  qwenImageEdit2511NegativePack,
  qwenImageEdit2511PositivePack,
} from "./packs-qwen-2511";
import {
  qwenImage2512PortraitBindings,
  qwenImage2512PortraitNegativePack,
  qwenImage2512PortraitPositivePack,
} from "./packs-qwen-2512-portrait";
import { characterEndpointPacks } from "./packs-character-endpoints";

/**
 * THE CHARACTER PACK SURFACE (owner ruling 2026-09-01: keep every
 * profile the picker offers and give each one a real compiler).
 *
 * The acceptance criterion this file owns is a COVERAGE one, and it is the only
 * place anything checks it: every (model, task, profile key) the profile catalog
 * offers for character work resolves an ACTIVE binding whose dialect has a
 * registered compiler and whose packs exist. Nothing else in the tree would
 * notice a profile left behind — the seam answers `unbound`, the lane keeps its
 * legacy prompt, the render succeeds, and the only symptom is that #251 can
 * never delete the old builders.
 *
 * Pack CONTENT stays untested here, per the spec's own test-ownership ruling.
 * What a migration or a wiring mistake breaks is the hash law and the resolution
 * seams, and those are what this file pins.
 */

/**
 * The character-image surface as the seeded profile rows actually define it
 * (drizzle `0100_daffy_mystique`, `0104_add-adult-and-identity-image-models`,
 * `0107_curated-model-profiles`).
 *
 * Written out rather than read from the database because this is a PURE suite
 * and because the list is the claim: a profile added to a migration without a
 * binding is exactly the regression, and a copy that silently grew with the
 * migration would not catch it. `model-profiles.int.test.ts` owns the other
 * direction — that these rows are really what the database offers.
 *
 * Slugs are the BASE slugs. Three of these rows are community checkpoints whose
 * registry slug carries a `:version` pin, and binding resolution deliberately
 * strips it (`baseImageModelSlug` in `character-prompt-program.ts`) — a binding
 * says which ENDPOINT it is about; pinning a provider version is `versionId`'s
 * separate job.
 */
const CHARACTER_SURFACE: readonly {
  readonly slug: string;
  readonly task: "portrait" | "variant" | "scene" | "chat_look";
  readonly profileKey: string;
}[] = [
  // Qwen Image 2512 — the portrait generator, three tiers.
  { slug: "qwen/qwen-image-2512", task: "portrait", profileKey: "portrait-standard" },
  { slug: "qwen/qwen-image-2512", task: "portrait", profileKey: "portrait-fast" },
  { slug: "qwen/qwen-image-2512", task: "portrait", profileKey: "portrait-quality" },
  // Qwen Image Edit 2511 — the default editor for all three edit lanes.
  { slug: "qwen/qwen-image-edit-2511", task: "variant", profileKey: "variant-standard" },
  { slug: "qwen/qwen-image-edit-2511", task: "scene", profileKey: "scene-standard" },
  { slug: "qwen/qwen-image-edit-2511", task: "chat_look", profileKey: "chat-look-standard" },
  // Seedream 4.5.
  { slug: "bytedance/seedream-4.5", task: "portrait", profileKey: "portrait-standard" },
  { slug: "bytedance/seedream-4.5", task: "variant", profileKey: "variant-standard" },
  { slug: "bytedance/seedream-4.5", task: "scene", profileKey: "scene-standard" },
  { slug: "bytedance/seedream-4.5", task: "scene", profileKey: "ensemble-scene-2k" },
  // Seedream 5 Lite.
  { slug: "bytedance/seedream-5-lite", task: "portrait", profileKey: "portrait-standard" },
  { slug: "bytedance/seedream-5-lite", task: "variant", profileKey: "variant-standard" },
  { slug: "bytedance/seedream-5-lite", task: "scene", profileKey: "scene-standard" },
  { slug: "bytedance/seedream-5-lite", task: "scene", profileKey: "quality-scene-3k" },
  // Wan 2.7 Image Pro.
  { slug: "wan-video/wan-2.7-image-pro", task: "portrait", profileKey: "portrait-standard" },
  { slug: "wan-video/wan-2.7-image-pro", task: "variant", profileKey: "variant-standard" },
  { slug: "wan-video/wan-2.7-image-pro", task: "scene", profileKey: "scene-standard" },
  { slug: "wan-video/wan-2.7-image-pro", task: "scene", profileKey: "multi-reference-edit-2k" },
  // Stable Diffusion 3.5 Large — portrait only, on both its rows.
  { slug: "stability-ai/stable-diffusion-3.5-large", task: "portrait", profileKey: "portrait-standard" },
  { slug: "stability-ai/stable-diffusion-3.5-large", task: "portrait", profileKey: "stylized-portrait-high-guidance" },
  // The three version-pinned community rows, plus P-Image.
  { slug: "aisha-ai-official/nsfw-flux-dev", task: "portrait", profileKey: "portrait-standard" },
  { slug: "aisha-ai-official/likereality-pony-v1", task: "portrait", profileKey: "portrait-standard" },
  { slug: "prunaai/p-image", task: "portrait", profileKey: "portrait-standard" },
  { slug: "nsfw-api/sdxl-pulid", task: "variant", profileKey: "variant-standard" },
  { slug: "nsfw-api/sdxl-pulid", task: "scene", profileKey: "scene-standard" },
];

/** The strategy a task's seeded profile rows carry. */
const STRATEGY_FOR_TASK = {
  portrait: "text_to_image_description",
  variant: "instruction_edit",
  scene: "instruction_edit",
  chat_look: "instruction_edit",
} as const;

describe("character prompt-pack coverage", () => {
  /**
   * THE ACCEPTANCE CRITERION OF #256'S SECTION 3. Every character-image profile the catalog
   * offers resolves an ACTIVE binding for its own model, task and profile key,
   * and that binding is coherent end to end: a strategy matching the profile
   * row's, a dialect with a REGISTERED COMPILER, and two pack versions that
   * exist and parse under their channel's schema.
   *
   * Kills the whole class of "left behind" defects: a profile whose model never
   * got a binding (its lane silently keeps the legacy prompt), a binding naming
   * a declared-but-unimplemented dialect (every render on it refuses before
   * spend), a mistyped pack id, and a strategy that drifted from the profile row
   * (a program no binding matches). Every one of those is invisible in a render.
   */
  it.each(CHARACTER_SURFACE)("binds $slug $task/$profileKey to a coherent active row", (lane) => {
    const binding = activeImagePromptBinding({
      modelSlug: lane.slug,
      task: lane.task,
      profileKey: lane.profileKey,
      promptStrategy: STRATEGY_FOR_TASK[lane.task],
    });
    if (binding === null) throw new Error(`no active binding for ${lane.slug} ${lane.task}/${lane.profileKey}`);
    expect(binding.status).toBe("active");
    expect(imagePromptDialectForBinding(binding)).not.toBeNull();
    const positive = imagePositivePack(binding.positivePackVersionId);
    const negative = imageNegativePack(binding.negativePackVersionId);
    expect(parseImagePositivePackManifest(positive?.manifest)).not.toBeNull();
    expect(parseImageNegativePackManifest(negative?.manifest)).not.toBeNull();
  });

  /**
   * The scene chain's SECOND job shape. Its rungs degrade multi-reference edit →
   * single-reference edit → bare text-to-image, and the last states
   * `text_to_image_description` where the first two state `instruction_edit`. A
   * binding pins one strategy and the compile refuses a mismatched pair, so a
   * scene profile with only its edit row would REFUSE the moment its references
   * became unusable — turning a designed degradation into a failed render, on
   * exactly the renders that had already lost their reference.
   *
   * Both rows must share a pack pair: a scene's look must not change with which
   * rung happened to win.
   */
  it.each(CHARACTER_SURFACE.filter((lane) => lane.task === "scene"))(
    "gives $slug $profileKey a text-to-image row sharing the edit row's packs",
    (lane) => {
      const query = { modelSlug: lane.slug, task: "scene" as const, profileKey: lane.profileKey };
      const edit = activeImagePromptBinding({ ...query, promptStrategy: "instruction_edit" });
      const generate = activeImagePromptBinding({ ...query, promptStrategy: "text_to_image_description" });
      expect(generate).not.toBeNull();
      expect(generate?.id).not.toBe(edit?.id);
      expect(generate?.positivePackVersionId).toBe(edit?.positivePackVersionId);
      expect(generate?.negativePackVersionId).toBe(edit?.negativePackVersionId);
    },
  );

  /**
   * The keys the intimate-scene route and the NSFW variant bench can arrive
   * under. Both pair the PICKED profile with the intimate model (#457) and
   * replace only the model, so the render's binding is resolved on
   * `qwen/qwen-image-edit-2511` under a profile key that model has no profile
   * row of its own for — three of the four scene keys belong to Seedream 4.5,
   * Seedream 5 Lite and Wan 2.7.
   *
   * The coverage list above cannot see those pairs: it walks the profile
   * CATALOG, and the catalog never offers 2511 under another model's scene tier.
   * A missing row here is invisible in exactly the way #256 forbids — the seam
   * answers `unbound`, the scene lane drops the rung, and a staged intimate
   * render silently loses its picture.
   */
  it.each([
    { task: "variant" as const, profileKey: "variant-standard", strategies: ["instruction_edit"] as const },
    // Every scene key states BOTH job shapes: the chain's bare-prompt rung
    // states `text_to_image_description` where the two reference rungs state
    // `instruction_edit`, a binding pins one strategy, and the compile refuses a
    // mismatched pair — so a paired render that lost its references would REFUSE
    // instead of degrading.
    {
      task: "scene" as const,
      profileKey: "scene-standard",
      strategies: ["instruction_edit", "text_to_image_description"] as const,
    },
    {
      task: "scene" as const,
      profileKey: "ensemble-scene-2k",
      strategies: ["instruction_edit", "text_to_image_description"] as const,
    },
    {
      task: "scene" as const,
      profileKey: "quality-scene-3k",
      strategies: ["instruction_edit", "text_to_image_description"] as const,
    },
    {
      task: "scene" as const,
      profileKey: "multi-reference-edit-2k",
      strategies: ["instruction_edit", "text_to_image_description"] as const,
    },
  ])("binds the intimate model for $task/$profileKey", ({ task, profileKey, strategies }) => {
    for (const promptStrategy of strategies) {
      expect(
        activeImagePromptBinding({ modelSlug: "qwen/qwen-image-edit-2511", task, profileKey, promptStrategy }),
        `${profileKey} ${promptStrategy}`,
      ).not.toBeNull();
    }
  });

  /**
   * The hash law a future migration must reproduce: a seeded version's content
   * hash is exactly the hash of its manifest. Kills a seed whose hash was
   * copied, drifted, or computed over the wrong shape — the property that makes
   * "byte-identical to a known active version" checkable.
   */
  it("computes every seeded content hash from its own manifest", () => {
    const packs = [
      qwenImageEdit2511PositivePack,
      qwenImageEdit2511ChatLookPositivePack,
      qwenImageEdit2511NegativePack,
      qwenImage2512PortraitPositivePack,
      qwenImage2512PortraitNegativePack,
      ...characterEndpointPacks.flatMap((endpoint) => [endpoint.positive, endpoint.negative]),
    ];
    for (const pack of packs) {
      expect(pack.contentHash, pack.id).toBe(imagePromptPackContentHash(pack.manifest));
    }
  });

  /**
   * One pack pair per endpoint, however many lanes it serves. Kills a per-lane
   * pack fork, which would make promoting an endpoint's wording an N-row edit
   * that a later lane silently misses.
   *
   * The one thing a lane MAY own is a concept suppression — the chat-look row
   * compiles through a positive pack that omits what its cache key cannot see
   * — so a lane's positive pack is allowed to differ from the endpoint's shared
   * pack in `suppressedConcepts` and in nothing else: the wording variant, the
   * priority adjustments and the rendering intent stay one edit per endpoint.
   * A fork that moved any of those is the defect this pin still kills.
   *
   * Stated over the 2512 portrait rows and the 2511 edit rows because those two
   * seeds build their bindings by hand; the shared factory in
   * `packs-character-endpoints.ts` cannot fork a pair by construction.
   */
  it("pins one pack pair per endpoint across its lanes, suppressions aside", () => {
    for (const rows of [qwenImage2512PortraitBindings, qwenImageEdit2511Bindings]) {
      expect(new Set(rows.map((binding) => binding.negativePackVersionId)).size).toBe(1);
      const manifests = rows.map((binding) => {
        const pack = imagePositivePack(binding.positivePackVersionId);
        if (pack === null) throw new Error(`unregistered positive pack ${binding.positivePackVersionId}`);
        return { ...pack.manifest, suppressedConcepts: [] };
      });
      for (const manifest of manifests) expect(manifest).toEqual(manifests[0]);
    }
    expect(new Set(qwenImage2512PortraitBindings.map((binding) => binding.profileKey))).toEqual(
      new Set(["portrait-standard", "portrait-fast", "portrait-quality"]),
    );
  });

  /**
   * Binding ids are unique. Two rows with one id are one row with a silently
   * lost twin, and the scene lanes made this reachable: a scene profile carries
   * two rows differing only by strategy, so an id built without it would collide
   * on every scene key in the catalog.
   */
  it("registers no duplicate binding id", () => {
    const ids = registeredImagePromptBindings().map((binding) => binding.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  /**
   * Profile-keyed resolution stays STRICT. Asked with a key, resolution returns
   * that key's own row and never a sibling profile's; a key no row carries
   * resolves null rather than falling back across profiles. Kills a resolver
   * edit that ignores the key — under which any of the three 2512 portrait rows
   * would satisfy the coverage assertion above — and a fallback that would hand
   * one profile another profile's pack pins.
   */
  it("resolves the portrait binding per profile key, and only per profile key", () => {
    for (const binding of qwenImage2512PortraitBindings) {
      expect(
        activeImagePromptBinding({
          modelSlug: "qwen/qwen-image-2512",
          task: "portrait",
          profileKey: binding.profileKey,
        })?.id,
      ).toBe(binding.id);
    }
    expect(
      activeImagePromptBinding({
        modelSlug: "qwen/qwen-image-2512",
        task: "portrait",
        profileKey: "portrait-nonexistent",
      }),
    ).toBeNull();
    // The stylized key binds to SD 3.5 Large, the model its database row rides —
    // never to 2512, which it never renders on (owner correction 2026-08-29 #1).
    expect(
      activeImagePromptBinding({
        modelSlug: "qwen/qwen-image-2512",
        task: "portrait",
        profileKey: "stylized-portrait-high-guidance",
      }),
    ).toBeNull();
  });

  /**
   * The deliberate absence stays deliberate: `chat_place` is the one
   * identity-free lane in the chat set, it keeps its legacy prompt path, and no
   * binding may resolve for it on either endpoint. Binding it later must be a
   * conscious act that updates this pin.
   */
  it("leaves chat-place unbound", () => {
    for (const slug of ["qwen/qwen-image-2512", "qwen/qwen-image-edit-2511"]) {
      expect(activeImagePromptBinding({ modelSlug: slug, task: "chat_place" })).toBeNull();
    }
  });
});
