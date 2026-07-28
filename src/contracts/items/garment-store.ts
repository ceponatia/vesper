import { diag, type DiagnosticSink } from "../diagnostics";
import { samePlaceName } from "../turns/chat-scene-memory";
import {
  degradedGarmentBlueprint,
  garmentBlueprintHash,
  garmentBlueprintSchema,
  GARMENT_BLUEPRINT_VERSION,
  GARMENT_ROOT_PART_ID,
  type GarmentBlueprint,
} from "./garment-blueprint";
import { GARMENT_MATERIAL_UNKNOWN, type GarmentMaterialProfileId } from "./garment-material";
import {
  capGarmentInstances,
  emptyGarmentPresentationState,
  pristineGarmentConditionState,
  CHAT_GARMENT_BLUEPRINTS_MAX,
  type ChatGarmentStore,
  type GarmentInstanceState,
  type GarmentLocus,
  type GarmentOperation,
} from "./garment-instance";
import { garmentTemplateForCategory, mintGarmentBlueprint } from "./garment-templates";

/**
 * The chat garment STORE reducer (clothing-state-graph.plan.md §Slice 2; slice-0
 * audit Part 2 ruling P + OQ2).
 *
 * Slice 1 gave the store its shape; this module is the pure machinery that makes
 * it the wardrobe truth for a conversation:
 *
 * - **materialization** — a chat whose store is unseeded grows instances from the
 *   worn definition-id lists it already has (lazily, on the next state WRITE);
 * - **the worn-list projection** — `wornItemIds` (and the player's equivalent)
 *   become a DERIVED read of the worn-locus instances, so every surface that
 *   reads ids today keeps working while the store owns the truth;
 * - **`syncWornGarments`** — the one write path: a desired worn definition-id
 *   list compiles to instance transfers (keep what is already on, re-don what
 *   sits in the wardrobe with its condition intact, mint what is missing, move
 *   the rest to the wardrobe). Outfit presets go through it, so a preset change
 *   is transfers rather than a free-text replacement (plan §Typed mutation surface);
 * - **`applyGarmentTransfers`** — the typed `transfer` operation, validated with
 *   stable diagnostics and never a throw (docs/resilience.md).
 *
 * PURE: the caller does the item IO and hands seeds in.
 */

// --- Actor handles ------------------------------------------------------------

/**
 * The PLAYER's garment actor handle. A conversation has exactly one player (the
 * player wardrobe is already chat-wide — `ChatPlayerState`), so one reserved
 * handle is enough.
 */
export const GARMENT_PLAYER_ACTOR = "player";

/**
 * A roster character's actor handle. PREFIXED so a character id can never
 * collide with the reserved player handle, and so a handle is self-describing in
 * the inspector.
 */
export function garmentActorForCharacter(characterId: string): string {
  return `c:${characterId.trim()}`;
}

/** Who a locus names, if anyone — `scene` and `gone` belong to nobody. */
export function garmentLocusActorId(locus: GarmentLocus): string | undefined {
  switch (locus.kind) {
    case "wardrobe":
      return locus.ownerId;
    case "worn":
    case "held":
      return locus.actorId;
    case "scene":
    case "gone":
      return undefined;
  }
}

// --- Store queries ------------------------------------------------------------

/** Instance lookup by id. */
export function garmentInstanceById(
  store: ChatGarmentStore,
  instanceId: string,
): GarmentInstanceState | undefined {
  return store.instances.find((instance) => instance.id === instanceId);
}

/** The blueprint an instance points at; the degraded root-only graph when the hash dangles. */
export function garmentBlueprintFor(store: ChatGarmentStore, instance: GarmentInstanceState): GarmentBlueprint {
  return store.blueprints[instance.blueprintHash] ?? degradedGarmentBlueprint();
}

/** Every instance an actor currently WEARS, in store order (the projection's order). */
export function wornGarmentInstances(store: ChatGarmentStore, actorId: string): GarmentInstanceState[] {
  return store.instances.filter((instance) => instance.locus.kind === "worn" && instance.locus.actorId === actorId);
}

/**
 * **The compatibility projection** (audit ruling P.4): the worn-locus instances'
 * definition ids, in store order — exactly what `wornItemIds` /
 * `ChatPlayerState.wornItemIds` held before this slice. Instances with no library
 * provenance (R2's minted ad-hoc garments) are absent by construction: they had
 * no id to appear as, and they keep riding the free-text overlay until slice 6
 * replaces the phrase with the digest.
 */
export function wornGarmentDefinitionIds(store: ChatGarmentStore, actorId: string): string[] {
  return wornGarmentInstances(store, actorId).flatMap((instance) =>
    instance.definitionId ? [instance.definitionId] : [],
  );
}

/**
 * True when this actor's wardrobe has actually been modelled — they own at least
 * one instance at some locus. The guard that keeps "seeded and wearing nothing"
 * (⇒ stripped) from being confused with "never materialized" (⇒ unknown, so
 * conservatively covered). The store-wide `seeded` flag cannot answer this,
 * because materialization is per-actor and a roster member may join later.
 */
export function actorHasGarmentInstances(store: ChatGarmentStore, actorId: string): boolean {
  return store.instances.some((instance) => garmentLocusActorId(instance.locus) === actorId);
}

/**
 * Garments left at a place (R3). Matched on the SNAPSHOTTED place name with the
 * same `samePlaceName` normalization scene memory uses, so returning to the study
 * finds the jacket over the chair — and a garment survives its place falling out
 * of the 12-place memory, because the locus carries the name itself rather than
 * pointing at a `ScenePlace` (audit wrong-assumption 2).
 */
export function garmentsAtScenePlace(store: ChatGarmentStore, placeName: string | undefined): GarmentInstanceState[] {
  if (!placeName?.trim()) return [];
  return store.instances.filter(
    (instance) => instance.locus.kind === "scene" && samePlaceName(instance.locus.placeName, placeName),
  );
}

// --- Blueprint materialization ------------------------------------------------

/** What one library item definition contributes when it is instantiated. */
export interface GarmentSeed {
  definitionId: string;
  /** Display name captured at mint time (a later library delete cannot blank it). */
  name: string;
  /** `clothingCategories` id — picks the sparse part template (OQ1). */
  categoryId?: string;
  /** The DEFINITION's own coverage, which the template is rescoped onto (see below). */
  coverage: readonly string[];
  materialProfileId?: GarmentMaterialProfileId;
}

/**
 * Build a blueprint for one worn definition.
 *
 * The category template supplies the TOPOLOGY; the definition supplies the
 * COVERAGE. Every template node keeps only the locations the definition actually
 * covers, and any covered location no node claims lands on the root — so
 *
 *     union(node.baselineCoverage) === set(definition.coverage)
 *
 * exactly. That is what makes materialization coverage-neutral: a "top" edited
 * down to a bandeau instantiates as a bandeau, not as the category's shoulders +
 * chest + back + waist + upper arms. (Slice 1's template invariant — union of
 * node coverage = CATEGORY coverage — is the un-rescoped case of the same rule.)
 */
export function garmentBlueprintForSeed(seed: GarmentSeed): GarmentBlueprint {
  const material = seed.materialProfileId ?? GARMENT_MATERIAL_UNKNOWN;
  const template =
    (seed.categoryId ? garmentTemplateForCategory(seed.categoryId, material) : undefined) ??
    mintGarmentBlueprint({ materialProfileId: material });
  const wanted = new Set(seed.coverage.filter((id) => id.trim().length > 0));
  const claimed = new Set<string>();
  const nodes = template.nodes.map((node) => {
    const kept = node.baselineCoverage.filter((id) => wanted.has(id));
    for (const id of kept) claimed.add(id);
    return { ...node, baselineCoverage: kept };
  });
  const leftover = [...wanted].filter((id) => !claimed.has(id));
  if (leftover.length > 0) {
    const rootIndex = nodes.findIndex((node) => node.id === template.rootNodeId);
    const target = rootIndex >= 0 ? rootIndex : 0;
    const root = nodes[target];
    if (root) nodes[target] = { ...root, baselineCoverage: [...root.baselineCoverage, ...leftover] };
  }
  return garmentBlueprintSchema.parse({ ...template, nodes });
}

/** The conservative blueprint for a definition that could not be loaded: covers nothing, does nothing. */
function unresolvedGarmentBlueprint(): GarmentBlueprint {
  return garmentBlueprintSchema.parse({
    version: GARMENT_BLUEPRINT_VERSION,
    rootNodeId: GARMENT_ROOT_PART_ID,
    nodes: [
      { id: GARMENT_ROOT_PART_ID, kind: "root", aliases: [], materialProfileId: GARMENT_MATERIAL_UNKNOWN, baselineCoverage: [] },
    ],
    edges: [],
    behaviors: [],
  });
}

/**
 * Register a blueprint in the store's content-hash map (OQ2) and return its hash.
 * Two identical shirts — or six uniformed characters — cost exactly one entry. A
 * full map keeps the existing entries and diagnoses; the dangling hash then reads
 * back as the degraded root-only graph rather than failing anything.
 */
function registerBlueprint(
  blueprints: Record<string, GarmentBlueprint>,
  blueprint: GarmentBlueprint,
  sink?: DiagnosticSink,
): string {
  const hash = garmentBlueprintHash(blueprint);
  if (blueprints[hash]) return hash;
  if (Object.keys(blueprints).length >= CHAT_GARMENT_BLUEPRINTS_MAX) {
    sink?.push(
      diag("info", "chat_garments.blueprints_full", `blueprint map at ${CHAT_GARMENT_BLUEPRINTS_MAX} — new snapshot not stored`),
    );
    return hash;
  }
  blueprints[hash] = blueprint;
  return hash;
}

// --- Material inference -------------------------------------------------------

/**
 * Priority-ordered material keywords. Deliberately CONSERVATIVE: no keyword ⇒
 * `unknown`, whose profile is opaque, mid-absorbency and barely wet-responsive,
 * so a guess can never invent exposure. Order matters where families overlap
 * (a "cashmere knit" reads as wool, "denim jacket" as denim).
 */
const GARMENT_MATERIAL_KEYWORDS: readonly (readonly [GarmentMaterialProfileId, readonly string[]])[] = [
  ["leather", ["leather", "suede", "shearling"]],
  ["denim", ["denim", "jean", "jeans", "chambray"]],
  ["silk_satin", ["silk", "satin", "chiffon", "charmeuse", "organza"]],
  ["wool", ["wool", "woolen", "woollen", "tweed", "merino", "cashmere", "alpaca", "mohair"]],
  ["synthetic_shell", ["nylon", "polyester", "spandex", "lycra", "vinyl", "latex", "pvc", "windbreaker", "puffer", "raincoat"]],
  ["knit", ["knit", "knitted", "jersey", "sweater", "jumper", "sweatshirt", "hoodie", "cardigan", "ribbed", "fleece"]],
  ["woven_cotton_linen", ["cotton", "linen", "poplin", "canvas", "twill", "oxford", "flannel", "muslin"]],
];

/**
 * Infer a material profile from a definition's free text (name + description +
 * tags). `unknown` whenever nothing matches — the plan's "conservative material"
 * for R2 minting and for every migrated garment nobody described.
 */
export function inferGarmentMaterialProfile(text: string): GarmentMaterialProfileId {
  const tokens = new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, " ")
      .split(" ")
      .filter(Boolean),
  );
  if (tokens.size === 0) return GARMENT_MATERIAL_UNKNOWN;
  for (const [profileId, keywords] of GARMENT_MATERIAL_KEYWORDS) {
    if (keywords.some((keyword) => tokens.has(keyword))) return profileId;
  }
  return GARMENT_MATERIAL_UNKNOWN;
}

// --- The worn-list sync (the ONE write path) ----------------------------------

export interface SyncWornGarmentsInput {
  store: ChatGarmentStore;
  /** Whose wardrobe this is — `garmentActorForCharacter(id)` or `GARMENT_PLAYER_ACTOR`. */
  actorId: string;
  /** The desired worn definition ids, in the order the projection must read back. */
  wornDefinitionIds: readonly string[];
  /** Loaded descriptors for definitions that still need instantiating, keyed by id. */
  seeds: ReadonlyMap<string, GarmentSeed>;
  /** Fresh instance ids (the caller passes `newId`; tests pass a counter). */
  mintId: () => string;
  /** Chat-clock minute the change happens at — the change stamp / mint time. */
  atMinutes: number;
  sink?: DiagnosticSink;
}

/**
 * Reconcile ONE actor's worn set to `wornDefinitionIds`, as instance transfers
 * (audit ruling P.5). For each wanted definition, in order:
 *
 * 1. an instance of it this actor already WEARS is kept (condition preserved);
 * 2. else one of theirs at `held` / `wardrobe`, or one left at a `scene`, is
 *    transferred back onto them — re-donning the same jacket, mud and all,
 *    rather than minting a pristine twin;
 * 3. else a new instance is minted from the seed.
 *
 * Worn instances nobody asked for move to `{kind:"wardrobe"}` — doffing is a
 * locus change, never destruction, so the garment can be found again. Another
 * actor's garments are never claimed, and a `gone` garment never comes back.
 *
 * The pass is idempotent: re-running it with the same list returns an
 * equal store (the projection order is a stable permutation of the slots the
 * actor's worn instances already occupy).
 */
export function syncWornGarments(input: SyncWornGarmentsInput): ChatGarmentStore {
  const { actorId, atMinutes, mintId, sink } = input;
  const blueprints: Record<string, GarmentBlueprint> = { ...input.store.blueprints };
  const instances = [...input.store.instances];
  const claimed = new Set<string>();
  /** Instance ids that must end up worn, in projection order. */
  const order: string[] = [];

  const indexOfInstance = (instanceId: string): number => instances.findIndex((i) => i.id === instanceId);

  for (const definitionId of input.wornDefinitionIds) {
    const alreadyWorn = instances.find(
      (i) =>
        !claimed.has(i.id) &&
        i.definitionId === definitionId &&
        i.locus.kind === "worn" &&
        i.locus.actorId === actorId,
    );
    if (alreadyWorn) {
      claimed.add(alreadyWorn.id);
      order.push(alreadyWorn.id);
      continue;
    }
    // Re-don: this actor's own held/wardrobe copies first, then anything left in
    // the room. Never another actor's garment, never a `gone` one.
    const reclaimable = instances.find((i) => {
      if (claimed.has(i.id) || i.definitionId !== definitionId) return false;
      switch (i.locus.kind) {
        case "held":
        case "wardrobe":
          return garmentLocusActorId(i.locus) === actorId;
        case "scene":
          return true;
        case "worn":
        case "gone":
          return false;
      }
    });
    if (reclaimable) {
      claimed.add(reclaimable.id);
      order.push(reclaimable.id);
      const at = indexOfInstance(reclaimable.id);
      instances[at] = {
        ...reclaimable,
        locus: { kind: "worn", actorId },
        lastChange: { kind: "transfer", atMinutes },
      };
      continue;
    }
    // Mint. A definition the caller could not load still gets an instance (so the
    // projection stays byte-identical to today's id list) — with a blueprint that
    // covers nothing, matching how an unresolvable item contributes no coverage.
    const seed = input.seeds.get(definitionId);
    const sibling = instances.find((i) => i.definitionId === definitionId);
    let hash: string;
    let name: string;
    if (seed) {
      hash = registerBlueprint(blueprints, garmentBlueprintForSeed(seed), sink);
      name = seed.name;
    } else if (sibling) {
      // A second copy of something already instantiated: reuse its snapshot.
      hash = sibling.blueprintHash;
      name = sibling.name;
    } else {
      sink?.push(
        diag(
          "info",
          "chat_garments.definition_unresolved",
          `worn item ${definitionId} could not be loaded — instantiated with an empty blueprint`,
        ),
      );
      hash = registerBlueprint(blueprints, unresolvedGarmentBlueprint(), sink);
      name = "garment";
    }
    const minted: GarmentInstanceState = {
      id: mintId(),
      blueprintHash: hash,
      definitionId,
      name,
      locus: { kind: "worn", actorId },
      presentation: emptyGarmentPresentationState(),
      condition: pristineGarmentConditionState(),
      lastChange: { kind: "mint", atMinutes },
    };
    instances.push(minted);
    claimed.add(minted.id);
    order.push(minted.id);
  }

  // Doff whatever this actor still wears but nobody asked for.
  for (let i = 0; i < instances.length; i++) {
    const instance = instances[i];
    if (!instance) continue;
    if (instance.locus.kind !== "worn" || instance.locus.actorId !== actorId) continue;
    if (claimed.has(instance.id)) continue;
    instances[i] = {
      ...instance,
      locus: { kind: "wardrobe", ownerId: actorId },
      lastChange: { kind: "transfer", atMinutes },
    };
  }

  // Put the actor's worn instances into projection order WITHOUT disturbing any
  // other slot: rewrite the indices they already occupy, in the wanted order.
  const slots: number[] = [];
  for (let i = 0; i < instances.length; i++) {
    const instance = instances[i];
    if (instance && instance.locus.kind === "worn" && instance.locus.actorId === actorId) slots.push(i);
  }
  if (slots.length === order.length) {
    const byId = new Map(instances.map((instance) => [instance.id, instance]));
    order.forEach((instanceId, position) => {
      const slot = slots[position];
      const instance = byId.get(instanceId);
      if (slot !== undefined && instance) instances[slot] = instance;
    });
  }

  return { seeded: true, blueprints, instances: capGarmentInstances(instances) };
}

/**
 * Retire every garment an actor owns (audit §1.1, scenario modal): switching the
 * player's persona replaces the body wearing them, so the old persona's
 * instances must not stay on the new one. They move to `gone{discarded}` rather
 * than being spliced out, so the store keeps one shape — and because `gone`
 * instances belong to nobody, the actor reads as UNMODELLED again and falls back
 * to the new persona's default outfit. The cap evicts them oldest-first.
 */
export function retireActorGarments(
  store: ChatGarmentStore,
  actorId: string,
  atMinutes: number,
): ChatGarmentStore {
  if (!actorHasGarmentInstances(store, actorId)) return store;
  return {
    ...store,
    instances: store.instances.map((instance) =>
      garmentLocusActorId(instance.locus) === actorId
        ? { ...instance, locus: { kind: "gone" as const, basis: "discarded" as const }, lastChange: { kind: "transfer" as const, atMinutes } }
        : instance,
    ),
  };
}

// --- Typed transfers ----------------------------------------------------------

export type GarmentTransferOperation = Extract<GarmentOperation, { kind: "transfer" }>;

export interface GarmentOperationResult {
  store: ChatGarmentStore;
  /** How many operations actually changed the store (a same-locus transfer is a legal no-op). */
  applied: number;
}

/**
 * Apply `transfer` operations in fiction order (plan §Typed mutation surface).
 * Every rejection is a DROP with a stable diagnostic, never a throw and never a
 * failed turn:
 *
 * - unknown garment → `garment_op.garment_unresolved` (audit OQ7);
 * - moving a `gone` garment → `garment_op.transfer_from_gone` (lost is lost);
 * - a non-transfer operation → `garment_op.unsupported_kind` (slices 3–4 own the
 *   presentation and condition operations; dropping is better than pretending).
 *
 * A transfer to the locus a garment already occupies is legal and simply changes
 * nothing.
 */
export function applyGarmentTransfers(
  store: ChatGarmentStore,
  operations: readonly GarmentOperation[],
  options: { atMinutes: number; sink?: DiagnosticSink },
): GarmentOperationResult {
  let instances = store.instances;
  let applied = 0;
  for (const operation of operations) {
    if (operation.kind !== "transfer") {
      options.sink?.push(
        diag("info", "garment_op.unsupported_kind", `garment operation "${operation.kind}" is not supported yet — dropped`),
      );
      continue;
    }
    const index = instances.findIndex((instance) => instance.id === operation.garmentId);
    const current = index >= 0 ? instances[index] : undefined;
    if (!current) {
      options.sink?.push(
        diag("info", "garment_op.garment_unresolved", `no garment instance "${operation.garmentId}" — transfer dropped`),
      );
      continue;
    }
    if (current.locus.kind === "gone") {
      options.sink?.push(
        diag("info", "garment_op.transfer_from_gone", `garment "${operation.garmentId}" is gone — transfer dropped`),
      );
      continue;
    }
    if (sameGarmentLocus(current.locus, operation.to)) continue;
    const next = [...instances];
    next[index] = { ...current, locus: operation.to, lastChange: { kind: "transfer", atMinutes: options.atMinutes } };
    instances = next;
    applied += 1;
  }
  return { store: applied > 0 ? { ...store, instances: capGarmentInstances(instances) } : store, applied };
}

/** Structural locus equality — the "this transfer changes nothing" test. */
export function sameGarmentLocus(a: GarmentLocus, b: GarmentLocus): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "wardrobe":
      return b.kind === "wardrobe" && a.ownerId === b.ownerId;
    case "worn":
      return b.kind === "worn" && a.actorId === b.actorId;
    case "held":
      return b.kind === "held" && a.actorId === b.actorId;
    case "scene":
      return b.kind === "scene" && samePlaceName(a.placeName, b.placeName) && a.anchor === b.anchor;
    case "gone":
      return b.kind === "gone" && a.basis === b.basis;
  }
}
