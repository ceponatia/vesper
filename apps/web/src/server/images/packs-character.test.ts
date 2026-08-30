import {
  activeImagePromptBinding,
  imageNegativePack,
  imagePositivePack,
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
 * coherent binding, the four portrait rows share one pack (owner ruling
 * 2026-08-29 #2), and the deliberate absences stay absent. Pack CONTENT is
 * deliberately untested here, per the spec's own test-ownership ruling — the
 * hash law and the resolution seams are what a migration or a wiring mistake
 * would break.
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
   * The seam the shadow compile and the Round 2 cutover both cross: for each
   * lane, the operation contract's task and strategy resolve an ACTIVE binding
   * that agrees with them, and both bound pack versions are registered and
   * parse under their channel's manifest schema. Kills a binding whose
   * strategy drifted from the lane's operation (a program no binding matches),
   * an unregistered pack id, and a manifest that fails its own contract.
   */
  it("resolves a coherent active binding for every tranche-1 lane", () => {
    for (const lane of LANES) {
      const binding = activeImagePromptBinding({ modelSlug: lane.slug, task: lane.operation.task });
      expect(binding, `${lane.slug} ${lane.operation.task}`).not.toBeNull();
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
   * Ruling 2 as an assertion: binding rows exist for ALL FOUR portrait profile
   * keys and every one of them pins the SAME pack pair. Kills a per-profile
   * pack fork and a portrait key quietly left unbound.
   */
  it("binds all four portrait profile keys to one shared pack pair", () => {
    const rows = registeredImagePromptBindings().filter(
      (binding) => binding.modelSlug === GENERATE_SLUG && binding.task === "portrait",
    );
    expect(new Set(rows.map((binding) => binding.profileKey))).toEqual(
      new Set(["portrait-standard", "portrait-fast", "portrait-quality", "stylized-portrait-high-guidance"]),
    );
    expect(new Set(rows.map((binding) => binding.positivePackVersionId))).toEqual(
      new Set([qwenImage2512PortraitPositivePack.id]),
    );
    expect(new Set(rows.map((binding) => binding.negativePackVersionId))).toEqual(
      new Set([qwenImage2512PortraitNegativePack.id]),
    );
    // The 2511 side shares its own pair the same way — one pack pair per endpoint.
    expect(new Set(qwenImageEdit2511Bindings.map((binding) => binding.positivePackVersionId)).size).toBe(1);
  });

  /**
   * The profile-keyed resolution the shadow wiring uses (Round 2): asked WITH a
   * profile key, `activeImagePromptBinding` returns exactly that key's own row —
   * never a sibling portrait profile's — and a key no row carries resolves null
   * instead of falling back across profiles. Kills a resolver that ignores the
   * key (any of the four rows would satisfy the keyless assertion above) and a
   * fallback that would silently hand one profile another profile's pack pins.
   */
  it("resolves the portrait binding per profile key, and only per profile key", () => {
    for (const binding of qwenImage2512PortraitBindings) {
      expect(
        activeImagePromptBinding({ modelSlug: GENERATE_SLUG, task: "portrait", profileKey: binding.profileKey })?.id,
      ).toBe(binding.id);
    }
    expect(
      activeImagePromptBinding({ modelSlug: GENERATE_SLUG, task: "portrait", profileKey: "portrait-nonexistent" }),
    ).toBeNull();
  });

  /**
   * The deliberate absence stays deliberate: chat-place is identity-free and
   * keeps its legacy prompt path, so no binding may resolve for it. Binding it
   * later must be a conscious act that updates this pin.
   */
  it("leaves chat-place unbound", () => {
    expect(activeImagePromptBinding({ modelSlug: GENERATE_SLUG, task: "chat_place" })).toBeNull();
    expect(activeImagePromptBinding({ modelSlug: EDIT_SLUG, task: "chat_place" })).toBeNull();
  });
});
