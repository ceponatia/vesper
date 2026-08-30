import {
  activeImagePromptBinding,
  imageNegativePack,
  imagePositivePack,
  imagePromptBindingForShadow,
  imagePromptPackContentHash,
  parseImageNegativePackManifest,
  parseImagePositivePackManifest,
  registeredImagePromptBindings,
  type ImageOperationContract,
} from "@vesper/image-core";
import { describe, expect, it } from "vitest";
import {
  characterChatLookImageOperation,
  characterPortraitImageOperation,
  characterSceneImageOperation,
  characterVariantImageOperation,
} from "@/contracts/images/character-digest";
import {
  qwenImageEdit2511Bindings,
  qwenImageEdit2511NegativePack,
  qwenImageEdit2511PositivePack,
} from "./packs-qwen-2511";
import {
  qwenImage2512PortraitBindings,
  qwenImage2512PortraitNegativePack,
  qwenImage2512PortraitPositivePack,
} from "./packs-qwen-2512-portrait";

/**
 * The tranche-1 character pack seeds: every lane in Round 1's scope resolves a
 * coherent CANDIDATE binding through the shadow resolver while staying
 * invisible to production's active resolver (owner correction 2026-08-29 #2),
 * the three 2512 portrait rows share one pack (owner ruling 2026-08-29 #2)
 * with the SD 3.5 key deliberately unbound (correction #1), and the
 * deliberate absences stay absent. Pack CONTENT is deliberately untested
 * here, per the spec's own test-ownership ruling — the hash law and the
 * resolution seams are what a migration or a wiring mistake would break.
 */

const EDIT_SLUG = "qwen/qwen-image-edit-2511";
const GENERATE_SLUG = "qwen/qwen-image-2512";

const LANES: readonly { slug: string; operation: ImageOperationContract }[] = [
  { slug: EDIT_SLUG, operation: characterVariantImageOperation() },
  { slug: EDIT_SLUG, operation: characterSceneImageOperation({ subjectCount: 1 }) },
  { slug: EDIT_SLUG, operation: characterChatLookImageOperation() },
  { slug: GENERATE_SLUG, operation: characterPortraitImageOperation() },
];

describe("tranche-1 pack resolution", () => {
  /**
   * The seam the shadow compile crosses: for each lane, the operation
   * contract's task and strategy resolve a coherent CANDIDATE binding through
   * the shadow resolver, and both bound pack versions are registered and
   * parse under their channel's manifest schema. Kills a binding whose
   * strategy drifted from the lane's operation (a program no binding matches),
   * an unregistered pack id, and a manifest that fails its own contract.
   */
  it("resolves a coherent candidate binding for every tranche-1 lane via the shadow resolver", () => {
    for (const lane of LANES) {
      const binding = imagePromptBindingForShadow({ modelSlug: lane.slug, task: lane.operation.task });
      expect(binding, `${lane.slug} ${lane.operation.task}`).not.toBeNull();
      expect(binding?.status).toBe("candidate");
      expect(binding?.promptStrategy).toBe(lane.operation.strategy);
      const positive = imagePositivePack(binding?.positivePackVersionId ?? "");
      const negative = imageNegativePack(binding?.negativePackVersionId ?? "");
      expect(positive).not.toBeNull();
      expect(negative).not.toBeNull();
      expect(parseImagePositivePackManifest(positive?.manifest)).not.toBeNull();
      expect(parseImageNegativePackManifest(negative?.manifest)).not.toBeNull();
    }
  });

  /**
   * THE POINT of the candidate status (owner correction 2026-08-29 #2):
   * `activeImagePromptBinding` returning null IS the staged-rollout contract —
   * "this lane has not been cut over" — so the shadow phase's rows must be
   * invisible to it. Kills a registration that quietly armed production
   * resolution for a lane whose shadow trial has not run, and a shadow
   * resolver edit that stops seeing its own rows. Cutover flips a row to
   * `active` and must update this pin.
   */
  it("keeps every candidate row invisible to the active resolver", () => {
    for (const lane of LANES) {
      expect(
        activeImagePromptBinding({ modelSlug: lane.slug, task: lane.operation.task }),
        `${lane.slug} ${lane.operation.task}`,
      ).toBeNull();
    }
    // The entity lanes ARE cut over: their rows stay active, production keeps
    // resolving them, and the shadow resolver sees them too (candidate OR
    // active), so a promotion never changes the shadow's answer.
    for (const task of ["item", "location"] as const) {
      expect(activeImagePromptBinding({ modelSlug: GENERATE_SLUG, task })).not.toBeNull();
      expect(imagePromptBindingForShadow({ modelSlug: GENERATE_SLUG, task })).not.toBeNull();
    }
  });

  /**
   * The hash law a future migration must reproduce: a seeded version's content
   * hash is exactly the hash of its manifest. Kills a seed whose hash was
   * copied, drifted, or computed over the wrong shape — the property that
   * makes "byte-identical to a known active version" checkable.
   */
  it("computes every seeded content hash from its own manifest", () => {
    for (const pack of [
      qwenImageEdit2511PositivePack,
      qwenImageEdit2511NegativePack,
      qwenImage2512PortraitPositivePack,
      qwenImage2512PortraitNegativePack,
    ]) {
      expect(pack.contentHash, pack.id).toBe(imagePromptPackContentHash(pack.manifest));
    }
  });

  /**
   * Ruling 2 plus correction 1 as one assertion: binding rows exist for exactly
   * the THREE portrait profile keys that run on this endpoint, every one pins
   * the SAME pack pair, and `stylized-portrait-high-guidance` is DELIBERATELY
   * UNBOUND — its database profile rides SD 3.5 Large, and a binding is a real
   * (profile, model, dialect, packs) combination, never a namespace
   * reservation for a profile name (owner correction 2026-08-29 #1). Kills a
   * per-profile pack fork, a 2512 portrait key quietly left unbound, and a row
   * that re-binds the SD profile to an endpoint it never renders on. Binding
   * the stylized key later requires the `sd35_large_prose` dialect and must
   * update this pin.
   */
  it("binds the three 2512 portrait keys to one pack pair and leaves the SD 3.5 key unbound", () => {
    const rows = registeredImagePromptBindings().filter(
      (binding) => binding.modelSlug === GENERATE_SLUG && binding.task === "portrait",
    );
    expect(new Set(rows.map((binding) => binding.profileKey))).toEqual(
      new Set(["portrait-standard", "portrait-fast", "portrait-quality"]),
    );
    expect(new Set(rows.map((binding) => binding.positivePackVersionId))).toEqual(
      new Set([qwenImage2512PortraitPositivePack.id]),
    );
    expect(new Set(rows.map((binding) => binding.negativePackVersionId))).toEqual(
      new Set([qwenImage2512PortraitNegativePack.id]),
    );
    expect(
      registeredImagePromptBindings().some((binding) => binding.profileKey === "stylized-portrait-high-guidance"),
    ).toBe(false);
    // The 2511 side shares its own pair the same way — one pack pair per endpoint.
    expect(new Set(qwenImageEdit2511Bindings.map((binding) => binding.positivePackVersionId)).size).toBe(1);
  });

  /**
   * The profile-keyed resolution the shadow wiring uses (Round 2): asked WITH a
   * profile key, `imagePromptBindingForShadow` returns exactly that key's own
   * row — never a sibling portrait profile's — and a key no row carries
   * resolves null instead of falling back across profiles. Kills a resolver
   * that ignores the key (any of the three rows would satisfy the keyless
   * assertion above) and a fallback that would silently hand one profile
   * another profile's pack pins. The deliberately-unbound SD 3.5 key
   * (correction 1) resolves null through the same strictness.
   */
  it("resolves the portrait binding per profile key, and only per profile key", () => {
    for (const binding of qwenImage2512PortraitBindings) {
      expect(
        imagePromptBindingForShadow({ modelSlug: GENERATE_SLUG, task: "portrait", profileKey: binding.profileKey })?.id,
      ).toBe(binding.id);
    }
    for (const unbound of ["portrait-nonexistent", "stylized-portrait-high-guidance"]) {
      expect(
        imagePromptBindingForShadow({ modelSlug: GENERATE_SLUG, task: "portrait", profileKey: unbound }),
        unbound,
      ).toBeNull();
    }
  });

  /**
   * The deliberate absence stays deliberate: chat-place is identity-free and
   * keeps its legacy prompt path, so no binding may resolve for it — through
   * EITHER resolver, because a candidate row would already put the lane in
   * shadow. Binding it later must be a conscious act that updates this pin.
   */
  it("leaves chat-place unbound", () => {
    for (const slug of [GENERATE_SLUG, EDIT_SLUG]) {
      expect(activeImagePromptBinding({ modelSlug: slug, task: "chat_place" })).toBeNull();
      expect(imagePromptBindingForShadow({ modelSlug: slug, task: "chat_place" })).toBeNull();
    }
  });
});
