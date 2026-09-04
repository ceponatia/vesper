import { describe, expect, it } from "vitest";
import {
  IMAGE_PROMPT_PROGRAM_META_KEY,
  parseImagePromptProgramProvenance,
  type ImageRenderReference,
} from "@vesper/image-core";
import {
  emptyGarmentCueState,
  visualStateGarmentFixture,
  visualStateSceneFixture,
  VISUAL_STATE_SCENE_NPC,
  VISUAL_STATE_SCENE_PLAYER,
  type ChatGarmentStore,
  type VisualStateGarmentInput,
} from "@/contracts";
import type { ActiveCondition } from "@/contracts/conditions/condition";
import { conditionAttributeOverlays } from "@/contracts/conditions/overlays";
import { DiagnosticCollector } from "@/contracts/diagnostics";
import { FULLY_COVERED, type RegionExposure } from "@/contracts/items/visibility";
import { LANE_PROBE_SUBJECT_ID, laneProbeShadowInput, resolvedImageProfileFixture } from "@/server/test-support";
import { safeBuildVisualStateShadow } from "@/server/visual-state";
import {
  activeChatLookProgram,
  buildChatLookCut,
  buildChatPlacePrompt,
  CHAT_LOOK_CAMERA,
  CHAT_LOOK_CAMERA_ID,
  chatLookKey,
  type ChatLookVisualCut,
} from "./chat-look";
import { isCharacterPromptCompiled } from "./character-prompt-program";
import { qwenImageEdit2511ChatLookPositivePack } from "./packs-qwen-2511";

describe("chatLookKey (chat-wardrobe-parity — structured key)", () => {
  const bare: RegionExposure = { torso: "bare", pelvis: "bare", legs: "bare", feet: "bare" };
  const base = { wornItemIds: ["item-b", "item-a"], overlay: "", exposure: FULLY_COVERED, attributeOverlays: [] };

  it("is stable and insensitive to worn-id order, overlay case/whitespace, and overlay order", () => {
    // Worn ids are sorted, so reordering the worn list is a no-op.
    expect(chatLookKey(base)).toBe(chatLookKey({ ...base, wornItemIds: ["item-a", "item-b"] }));
    // Overlay text normalizes case/whitespace.
    expect(chatLookKey({ ...base, overlay: "a Scarf" })).toBe(chatLookKey({ ...base, overlay: "  A SCARF " }));
    const a = chatLookKey({
      ...base,
      attributeOverlays: [
        { id: "hair.color", value: "auburn", source: "narrative" },
        { id: "hair.length", value: "short", source: "narrative" },
      ],
    });
    const b = chatLookKey({
      ...base,
      attributeOverlays: [
        { id: "hair.length", value: "short", source: "narrative" },
        { id: "hair.color", value: "auburn", source: "narrative" },
      ],
    });
    expect(a).toBe(b);
  });

  it("changes when the worn list, overlay, computed exposure, or an overlay changes (a haircut invalidates)", () => {
    const key = chatLookKey(base);
    expect(chatLookKey({ ...base, wornItemIds: ["item-a"] })).not.toBe(key);
    expect(chatLookKey({ ...base, overlay: "a borrowed hoodie" })).not.toBe(key);
    expect(chatLookKey({ ...base, exposure: bare })).not.toBe(key);
    expect(
      chatLookKey({ ...base, attributeOverlays: [{ id: "hair.length", value: "short", source: "narrative" }] }),
    ).not.toBe(key);
  });

  it("folds in the garment fingerprint (OQ8) without invalidating an unmodelled chat's key", () => {
    const key = chatLookKey(base);
    // An unmodelled chat contributes "" — the hash is byte-identical to before
    // slice 6, so no cached `chat_look` invalidates just because the field exists.
    expect(chatLookKey({ ...base, garmentKey: "" })).toBe(key);
    expect(chatLookKey({ ...base, garmentKey: "   " })).toBe(key);
    // A structural arrangement change moves the key even though the id list did not:
    // this is the whole reason the fingerprint had to enter here (audit finding 4).
    expect(chatLookKey({ ...base, garmentKey: "g1|sleeve_left=rolled||" })).not.toBe(key);
    expect(chatLookKey({ ...base, garmentKey: "g1|sleeve_left=rolled||" })).not.toBe(
      chatLookKey({ ...base, garmentKey: "g1|sleeve_left=down||" }),
    );
  });

  it("folds in a covering hair-occlusion band without invalidating an uncovered chat's key", () => {
    const key = chatLookKey(base);
    // `none` and absent hash identically: no chat whose hair shows re-mints
    // because the band now exists on the input.
    expect(chatLookKey({ ...base, hairOcclusion: "none" })).toBe(key);
    // A headwear override flipping `none` → `full` moves nothing else in the key
    // (same ids, exposure, overlays), so only this term can retire the old
    // visible-hair anchor — the collision the band was added to break.
    expect(chatLookKey({ ...base, hairOcclusion: "full" })).not.toBe(key);
    expect(chatLookKey({ ...base, hairOcclusion: "partial" })).not.toBe(chatLookKey({ ...base, hairOcclusion: "full" }));
  });

  it("a legacy free-text chat (empty worn list) keys on the overlay alone — stable across the change", () => {
    const legacy = { wornItemIds: [], overlay: "a linen sundress", exposure: FULLY_COVERED, attributeOverlays: [] };
    expect(chatLookKey(legacy)).toBe(chatLookKey({ ...legacy, overlay: "  A Linen Sundress " }));
    expect(chatLookKey(legacy)).not.toBe(chatLookKey({ ...legacy, overlay: "jeans and a t-shirt" }));
  });
});

/**
 * GOLDEN DETERMINISM PINS — never "update to fix" a failure here.
 *
 * `chatLookKey` is the `meta.lookKey` stamped on every `chat_look` row, and the
 * loader (`latestChatLook`) reads a mismatch as "this look is stale". The values
 * below were computed from the hand-rolled FNV-1a this file carried BEFORE it
 * adopted the shared `@/lib/hash`, so they prove the consolidation moved
 * nothing.
 *
 * If one of them ever changes, every conversation already in the database misses
 * its cache on the next turn and silently re-renders its look anchor against the
 * provider. Nothing throws — that invisibility is exactly why these are pinned.
 * A failure here IS the breakage: fix the hash, never the pin.
 */
describe("chatLookKey — golden determinism pins", () => {
  it("pins a fully-populated key", () => {
    expect(
      chatLookKey({
        // Deliberately unsorted: the sort is part of what these values pin.
        wornItemIds: ["item-c", "item-a", "item-b"],
        // Mixed case with surrounding whitespace — the trim+lowercase is pinned too.
        overlay: "  A Borrowed Hoodie ",
        exposure: { torso: "covered", pelvis: "sheer", legs: "bare", feet: "covered" },
        attributeOverlays: [
          { id: "hair.length", value: "short", source: "narrative" },
          { id: "hair.color", value: "auburn", source: "narrative" },
        ],
        garmentKey: " g1|sleeve_left=rolled|| ",
      }),
    ).toBe("505c4537");
  });

  it("pins a legacy free-text chat's key (empty worn list, overlay alone, no garment fingerprint)", () => {
    expect(
      chatLookKey({ wornItemIds: [], overlay: "a linen sundress", exposure: FULLY_COVERED, attributeOverlays: [] }),
    ).toBe("5fb5063f");
  });

  it("pins the fully-covered, overlay-free key the cases above build on", () => {
    expect(
      chatLookKey({ wornItemIds: ["item-b", "item-a"], overlay: "", exposure: FULLY_COVERED, attributeOverlays: [] }),
    ).toBe("7a2348c8");
  });
});

/**
 * THE LOOK PROGRAM STATES ONLY WHAT ITS CACHE KEY HASHES.
 *
 * The anchor is minted once under `chatLookKey` and reused until the key
 * moves, but the committed cut it compiles from carries the current layer —
 * wetness, garment condition, active conditions — and body language, none of
 * which the key sees. A program that stated them would send two prompts under
 * one key: the cached anchor goes stale for a fact that never moved the key,
 * or a transient state is baked into the reference every later scene composes
 * from. The omission is the chat-look binding's own positive pack, so the
 * row's provenance names it.
 *
 * Kills a binding edit that points the chat-look row back at the shared 2511
 * pack, a pack edit that drops either suppressed concept, and a dialect or
 * adapter change that starts routing a current-layer fact through a concept
 * the pack does not suppress. The control assertion — the condition DID reach
 * the assembled subject slice — is what keeps the equality from passing
 * vacuously on a cut that never carried the fact.
 *
 * Two facts the pack cannot reach are withheld at the cut instead
 * (`chatLookSubjectCut`), and the last two cases pin those: a second digest
 * subject the shared factory files the room or the player under, which
 * refuses the identity-critical compile outright, and a condition's attribute
 * overlays, which move the morphology band while the key stands.
 */
describe("activeChatLookProgram — a function of the look key's inputs alone", () => {
  const SOAKED: ActiveCondition = {
    id: "cond-soaked",
    label: "soaked",
    severity: "moderate",
    startedAtMinutes: 0,
    attributeEffects: [],
  };
  const statesCurrent = (facts: readonly { concept: string }[]) =>
    facts.some((fact) => fact.concept === "subject.current_state");
  const identity: ImageRenderReference = { role: "identity", buffer: Buffer.from("identity-bytes"), name: "Nyx" };
  const resolved = resolvedImageProfileFixture({
    slug: "qwen/qwen-image-edit-2511",
    task: "chat_look",
    key: "chat-look-standard",
    referencePolicy: { requiredRoles: ["identity"] },
  });

  /** The mint's own path: `buildChatLookCut` → `activeChatLookProgram`, over one committed cut. */
  function compile(visual: ChatLookVisualCut) {
    const sink = new DiagnosticCollector();
    const cut = buildChatLookCut({ cut: visual, outfitExposed: false, exposure: FULLY_COVERED, sink });
    if (cut === null) throw new Error("the probe cut did not assemble");
    const program = activeChatLookProgram(
      {
        chatId: "chat1",
        userId: "user1",
        characterId: LANE_PROBE_SUBJECT_ID,
        lookKey: "key1",
        outfit: "a linen sundress",
        outfitExposed: false,
        visual,
      },
      cut,
      resolved,
      [identity],
      sink,
    );
    if (!isCharacterPromptCompiled(program)) throw new Error(`expected a compiled program, got ${program.kind}`);
    return program;
  }

  it("two cuts that differ only in a current-layer fact compile the same prompt", () => {
    const dry = compile({ ...laneProbeShadowInput(), conditions: [] });
    const soaked = compile({ ...laneProbeShadowInput(), conditions: [SOAKED] });
    // Control: the condition reached the slice the compile ran over, and only there.
    expect(statesCurrent(soaked.subjects[0]?.facts ?? [])).toBe(true);
    expect(statesCurrent(dry.subjects[0]?.facts ?? [])).toBe(false);
    expect(soaked.prompt).toBe(dry.prompt);
    expect(soaked.negativePrompt).toBe(dry.negativePrompt);
    // The omission is provenance-visible: the row names the chat-look pack, not the shared one.
    const provenance = parseImagePromptProgramProvenance(soaked.meta[IMAGE_PROMPT_PROGRAM_META_KEY]);
    expect(provenance?.positivePackVersionId).toBe(qwenImageEdit2511ChatLookPositivePack.id);
  });

  /**
   * A garment left at a scene locus files under the shared factory's scene
   * subject, and the player's recorded posture under the player subject. Each
   * is a digest subject with nobody's owners behind it, so the compile refuses
   * on its missing age and coverage anchors: the anchor is not stale but
   * ABSENT until the coat is picked up. Both cuts are production-shaped —
   * player subject, scene subject, both participants mapped — so the base
   * compiling at all kills the player half and the byte-equality kills the
   * coat half. The control assembles the dropped cut through the shared shadow
   * WITHOUT the look's narrowing and shows it does file the room and the
   * player, so neither equality passes on a fixture that never carried them.
   */
  it("two cuts that differ only in a garment left in the room compile the same prompt, from one subject", () => {
    const actorId = `c:${LANE_PROBE_SUBJECT_ID}`;
    const worn = visualStateGarmentFixture({ id: "g_top", categoryId: "top", locus: { kind: "worn", actorId }, layer: 1 });
    const coat = visualStateGarmentFixture({
      id: "g_coat",
      categoryId: "outerwear",
      name: "grey wool coat",
      locus: { kind: "scene", placeName: "the study", anchor: "over the desk chair" },
    });
    const store = (garments: readonly VisualStateGarmentInput[]): ChatGarmentStore => ({
      seeded: true,
      blueprints: Object.fromEntries(garments.map((garment) => [garment.instance.blueprintHash, garment.blueprint])),
      instances: garments.map((garment) => garment.instance),
      cues: emptyGarmentCueState(),
      coverage: {},
    });
    const roomed = (garments: readonly VisualStateGarmentInput[]): ChatLookVisualCut => ({
      ...laneProbeShadowInput(),
      garments: { store: store(garments), actorId, layersByGarmentId: new Map([["g_top", 1]]) },
      playerSubjectId: "player",
      sceneSubjectId: "scene",
      sceneRelations: {
        scene: visualStateSceneFixture(),
        subjectsByParticipant: new Map([
          [String(VISUAL_STATE_SCENE_NPC), LANE_PROBE_SUBJECT_ID],
          [String(VISUAL_STATE_SCENE_PLAYER), "player"],
        ]),
      },
    });
    const hung = roomed([worn]);
    const dropped = roomed([worn, coat]);
    const shared = safeBuildVisualStateShadow({
      ...dropped,
      camera: { cameraId: CHAT_LOOK_CAMERA_ID, spec: CHAT_LOOK_CAMERA },
    });
    expect(shared?.snapshot.subjects).toEqual(expect.arrayContaining(["player", "scene"]));

    const before = compile(hung);
    const after = compile(dropped);
    expect(after.subjects.map((subject) => subject.entityId)).toEqual([LANE_PROBE_SUBJECT_ID]);
    expect(after.prompt).toBe(before.prompt);
    expect(after.negativePrompt).toBe(before.negativePrompt);
  });

  /**
   * A condition's `attributeEffects` overlay attributes at a precedence the
   * key never hashes, and the morphology band reads every attribute in its
   * group: `wings.carriage` is mutable inside the `wings` group, and the
   * overlay reached the anchor as "wings: membranous, folded" while the key
   * stood. Two controls keep it honest — the registry admits the overlay (a
   * fixture the inherent-attribute guard drops would pass vacuously), and the
   * condition itself still reached the slice, because the cut withholds the
   * effects and not the condition.
   */
  it("two cuts that differ only in a condition that overlays an attribute compile the same prompt", () => {
    const EXHAUSTED: ActiveCondition = {
      ...SOAKED,
      id: "cond-exhausted",
      label: "exhausted",
      attributeEffects: [{ attributeId: "wings.carriage", value: "folded" }],
    };
    expect(conditionAttributeOverlays([EXHAUSTED]).map((overlay) => overlay.id)).toEqual(["wings.carriage"]);
    const rested = compile({ ...laneProbeShadowInput(), conditions: [] });
    const exhausted = compile({ ...laneProbeShadowInput(), conditions: [EXHAUSTED] });
    expect(statesCurrent(exhausted.subjects[0]?.facts ?? [])).toBe(true);
    expect(exhausted.prompt).toBe(rested.prompt);
    expect(exhausted.negativePrompt).toBe(rested.negativePrompt);
  });
});

describe("place prompt", () => {
  it("the place shot is the sketch, empty of people", () => {
    const prompt = buildChatPlacePrompt({ placeName: "the kitchen", sketch: "Warm terracotta tiles; copper pans." });
    expect(prompt).toContain("establishing shot of the kitchen");
    expect(prompt).toContain("Warm terracotta tiles; copper pans.");
    expect(prompt).toContain("No people anywhere in frame");
  });
});