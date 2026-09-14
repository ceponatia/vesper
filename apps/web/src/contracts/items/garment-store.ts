import { diag, type Diagnostic, type DiagnosticSink } from "../diagnostics";
import { samePlaceName } from "../turns/chat-scene-memory";
import {
  degradedGarmentBlueprint,
  garmentBlueprintHash,
  garmentBlueprintSchema,
  isDegradedGarmentBlueprint,
  type GarmentBlueprint,
} from "./garment-blueprint";
import {
  garmentBlueprintDiagnostics,
  validateGarmentBlueprint,
  type GarmentBlueprintIssue,
} from "./garment-blueprint-validation";
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
import type { HairOcclusion } from "./hair-occlusion";

/**
 * The chat garment STORE reducer.
 *
 * `garment-instance.ts` gives the store its shape; this module is the pure
 * machinery that makes it the wardrobe truth for a conversation:
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
 *   is transfers rather than a free-text replacement;
 * - **`applyGarmentTransfers`** — the typed `transfer` operation, validated with
 *   stable diagnostics and never a throw (docs/resilience.md).
 *
 * Both write paths and the durable read share ONE structural gate. A graph that
 * fails `validateGarmentBlueprint` never becomes trusted clothing state: it is
 * not registered and nothing is minted from it on the way IN
 * (`syncWornGarments`, `instantiateGarment`), and on the way OUT
 * (`validateGarmentStoreBlueprints`, which every durable/rollback read of the
 * store runs) a stored entry that fails is replaced by the MARKED degraded root,
 * so every instance pointing at it resolves `reliable: false` and its wearer
 * degrades to covered rather than reading bare.
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

/** A blueprint read that says whether the coverage it carries can be trusted. */
export interface GarmentBlueprintResolution {
  blueprint: GarmentBlueprint;
  /**
   * `false` when the instance's hash dangles or the stored snapshot is itself
   * degraded (`isDegradedGarmentBlueprint`). An unreliable read means "coverage
   * could not be read", never "confirmed wearing something that covers nothing"
   * — consumers deriving EXPOSURE from this instance must degrade to covered,
   * never to bare.
   */
  reliable: boolean;
}

/**
 * Resolve an instance's blueprint WITH reliability. A dangling hash resolves to
 * the marked degraded sentinel; either way `reliable` is the one flag the
 * modelled wardrobe path needs to keep a lost snapshot from reading as a
 * positive nudity claim.
 */
export function resolveGarmentBlueprint(
  store: ChatGarmentStore,
  instance: GarmentInstanceState,
): GarmentBlueprintResolution {
  const stored = store.blueprints[instance.blueprintHash];
  const blueprint = stored ?? degradedGarmentBlueprint();
  return { blueprint, reliable: stored !== undefined && !isDegradedGarmentBlueprint(blueprint) };
}

/**
 * The blueprint an instance points at; the degraded root-only graph when the
 * hash dangles. Reads that decide exposure should prefer
 * `resolveGarmentBlueprint` — this shape keeps the many consumers that only
 * enumerate parts/behaviors (handles, presentation, readouts) on one call.
 */
export function garmentBlueprintFor(store: ChatGarmentStore, instance: GarmentInstanceState): GarmentBlueprint {
  return resolveGarmentBlueprint(store, instance).blueprint;
}

/**
 * The shared structural gate on the way IN. A non-empty result means this graph
 * is NOT fit to become durable clothing state: the caller must neither register
 * it nor mint from it. The validator's own codes are pushed verbatim and handed
 * back (a boundary never invents a parallel "invalid graph" code), carrying the
 * caller's identifying facts so the bad row can be found.
 */
function blueprintIssues(
  blueprint: GarmentBlueprint,
  path: string,
  context: Record<string, unknown>,
  sink?: DiagnosticSink,
): readonly GarmentBlueprintIssue[] {
  const validation = validateGarmentBlueprint(blueprint);
  if (validation.ok) return [];
  if (sink) for (const diagnostic of garmentBlueprintDiagnostics(validation, path, context)) sink.push(diagnostic);
  return validation.issues;
}

/**
 * The structural gate on the way OUT — the durable read's half of the rule.
 *
 * `chatGarmentStoreSchema` shape-parses each stored blueprint independently, but
 * a graph can be perfectly shaped and still be structurally impossible: a
 * `part_of` cycle, a lost root, an orphaned part, a body location that is not in
 * the registry (the live case — an item definition whose `coverage` named an
 * unknown id, snapshotted onto the root at mint time). Such an entry parses,
 * carries no `degraded` mark, and would hand the visibility resolver coverage
 * that silently drops the regions it cannot place — which is how a clothed body
 * reads bare.
 *
 * So every boundary that parses the store from JSON runs this: an entry that
 * fails validation is replaced by `degradedGarmentBlueprint()` — the MARKED safe
 * root — under its existing key, so each instance pointing at it resolves
 * `reliable: false` and `resolveChatWardrobe` degrades that wearer's exposure to
 * covered (docs/character-chat/wardrobe.md §"Failure is marked, never bare").
 *
 * Per-entry independence is the schema's rule and it is kept here: one bad entry
 * degrades ALONE, its siblings, the `instances` and `seeded` untouched. An entry
 * the parse ALREADY marked `degraded` is left exactly as it is — it is already
 * the marked state this function produces, the parse already recorded the loss,
 * and re-reporting it would file a warning on every later load of the same
 * conversation. A store with nothing to replace is returned by IDENTITY, so a
 * healthy read stays byte-identical through the rollback anchor.
 */
export function validateGarmentStoreBlueprints(
  store: ChatGarmentStore,
  sink?: DiagnosticSink,
  path = "chat.garments.blueprints",
): ChatGarmentStore {
  let replaced: Record<string, GarmentBlueprint> | undefined;
  for (const [hash, blueprint] of Object.entries(store.blueprints)) {
    if (isDegradedGarmentBlueprint(blueprint)) continue;
    const validation = validateGarmentBlueprint(blueprint);
    if (validation.ok) continue;
    replaced ??= { ...store.blueprints };
    replaced[hash] = degradedGarmentBlueprint();
    if (sink) {
      for (const diagnostic of garmentBlueprintDiagnostics(validation, path, { blueprintHash: hash })) {
        sink.push(diagnostic);
      }
    }
  }
  return replaced === undefined ? store : { ...store, blueprints: replaced };
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
  /** The definition's RESOLVED hair-occlusion band, snapshotted like `name` (absent = `none`). */
  hairOcclusion?: HairOcclusion;
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

/**
 * Register a blueprint in the store's content-hash map (OQ2). Two identical
 * shirts — or six uniformed characters — cost exactly one entry.
 *
 * A full map first garbage-collects entries NO instance references (evicting an
 * instance orphans its snapshot, and orphans are what fill a long chat's map —
 * `gone` garments still pin theirs until the cap evicts them). `stored: false`,
 * possible only while every entry is still referenced, means the hash was NOT
 * stored and the caller must not mint an instance pointing at it: a dangling
 * hash resolves to the degraded sentinel, and "could not store the snapshot"
 * must degrade openly rather than as a covers-nothing garment.
 */
function registerBlueprint(
  blueprints: Record<string, GarmentBlueprint>,
  blueprint: GarmentBlueprint,
  instances: readonly GarmentInstanceState[],
): { hash: string; stored: boolean } {
  const hash = garmentBlueprintHash(blueprint);
  if (blueprints[hash]) return { hash, stored: true };
  if (Object.keys(blueprints).length >= CHAT_GARMENT_BLUEPRINTS_MAX) {
    const referenced = new Set(instances.map((instance) => instance.blueprintHash));
    for (const stored of Object.keys(blueprints)) {
      if (!referenced.has(stored)) delete blueprints[stored];
    }
  }
  if (Object.keys(blueprints).length >= CHAT_GARMENT_BLUEPRINTS_MAX) return { hash, stored: false };
  blueprints[hash] = blueprint;
  return { hash, stored: true };
}

/** The one degradation message for a map that stayed full after garbage collection. */
function blueprintsFullDiag(detail: string): Diagnostic {
  return diag("warn", "chat_garments.blueprints_full", `blueprint map at ${CHAT_GARMENT_BLUEPRINTS_MAX} — ${detail}`);
}

/**
 * Instantiate ONE garment from a blueprint at a given locus — the ad-hoc minting
 * path: an unowned garment the fiction introduces becomes a real chat-scoped
 * instance minted from a validated minimal category
 * template. The blueprint joins the content-hash map like any other, so a
 * borrowed hoodie costs one entry however many times it is borrowed.
 *
 * Safe in the direction that matters: a mint can only ADD a garment's own
 * template coverage and never subtract anyone's, so it cannot decide intimate
 * coverage. `seeded` is deliberately left alone — minting is not materialization,
 * and flipping the flag would skip the lazy worn-list migration.
 *
 * This path always mints (its caller has already promised the garment to the
 * fiction), so a map that stays full after garbage collection is stored PAST the
 * cap rather than left dangling. The overfill is bounded at one: every other
 * entry survived GC because an instance references it, and the store schema's
 * parse-time cap trims orphans first, so the over-cap snapshot outlives reload
 * for as long as its instance does.
 *
 * The ONE thing it will not do is mint from a structurally invalid graph. The
 * blueprint is validated before it reaches the map; on a failure the store comes
 * back UNTOUCHED, `instance` is absent and `rejected` carries the validator's
 * own issues, so the caller drops the garment — and names the refusal in the
 * validator's stable vocabulary — rather than registering a graph the read side
 * could never trust. The in-repo mint (`mintGarmentBlueprint`) is code-owned and
 * always valid, which makes this the boundary for graphs arriving from anywhere
 * else — never a reason to skip it, because "no caller can do that today" is not
 * an invariant.
 */
export function instantiateGarment(
  store: ChatGarmentStore,
  input: {
    id: string;
    blueprint: GarmentBlueprint;
    name: string;
    locus: GarmentLocus;
    atMinutes: number;
    /** Library provenance, when there is any (an ad-hoc mint has none). */
    definitionId?: string;
    /** The resolved band to snapshot beside `name`; an ad-hoc mint carries none. */
    hairOcclusion?: HairOcclusion;
  },
  sink?: DiagnosticSink,
): { store: ChatGarmentStore; instance?: GarmentInstanceState; rejected?: readonly GarmentBlueprintIssue[] } {
  const rejected = blueprintIssues(
    input.blueprint,
    "garment_store.instantiate",
    { garmentId: input.id, name: input.name, ...(input.definitionId ? { definitionId: input.definitionId } : {}) },
    sink,
  );
  if (rejected.length > 0) return { store, rejected };
  const blueprints = { ...store.blueprints };
  const registration = registerBlueprint(blueprints, input.blueprint, store.instances);
  if (!registration.stored) {
    blueprints[registration.hash] = input.blueprint;
    sink?.push(blueprintsFullDiag("snapshot stored past the cap so the minted instance cannot dangle"));
  }
  const instance: GarmentInstanceState = {
    id: input.id,
    blueprintHash: registration.hash,
    ...(input.definitionId ? { definitionId: input.definitionId } : {}),
    name: input.name,
    ...(input.hairOcclusion ? { hairOcclusion: input.hairOcclusion } : {}),
    locus: input.locus,
    presentation: emptyGarmentPresentationState(),
    condition: pristineGarmentConditionState(),
    lastChange: { kind: "mint", atMinutes: input.atMinutes },
  };
  return {
    store: { ...store, blueprints, instances: capGarmentInstances([...store.instances, instance]) },
    instance,
  };
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
 *
 * It is also ALL-OR-NOTHING on a structurally invalid seed: a seed whose
 * blueprint fails `validateGarmentBlueprint` abandons the pass and returns the
 * input store by identity, so the bad graph is never registered, no instance is
 * minted from it, and nothing this actor already wears is doffed on the strength
 * of a graph nobody could read (see the mint arm).
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
    // projection stays byte-identical to today's id list) — carrying the MARKED
    // degraded sentinel, so the read side knows its coverage was never real. A
    // map still full after garbage collection mints NOTHING: the item stays
    // un-materialized (a later reconcile retries) rather than becoming a worn
    // instance whose hash dangles and reads covers-nothing.
    const seed = input.seeds.get(definitionId);
    const sibling = instances.find((i) => i.definitionId === definitionId);
    let hash: string;
    let name: string;
    // Snapshotted beside the name so an orphaned instance still hides hair.
    let hairOcclusion: HairOcclusion | undefined;
    if (seed) {
      const seedBlueprint = garmentBlueprintForSeed(seed);
      // The structural gate. A definition's own `coverage` is the one input here
      // that is neither code-owned nor registry-checked, so an id that is not a
      // coverage-relevant body location rides it in and lands on the root node.
      // That graph must not be registered and must not be minted from — but the
      // reconcile does not simply drop the garment either, because reconciling
      // this actor to the readable remainder is what would DOFF whatever the bad
      // definition covers and persist a modelled-and-emptier wardrobe, i.e. read
      // the region bare. So the actor's whole pass is abandoned and their store
      // slice comes back untouched, exactly as `syncChatGarments` treats a
      // withheld id: a modelled actor keeps the prior outfit, an unmodelled one
      // keeps the ids in the worn column, and a repaired definition materializes
      // normally on the next reconcile. The cost is a lost outfit CHANGE, never
      // a bare body (docs/character-chat/wardrobe.md §"Failure is marked, never
      // bare").
      if (blueprintIssues(seedBlueprint, "garment_store.sync", { actorId, definitionId }, sink).length > 0) {
        return input.store;
      }
      const registration = registerBlueprint(blueprints, seedBlueprint, instances);
      if (!registration.stored) {
        sink?.push(blueprintsFullDiag(`"${definitionId}" left un-materialized rather than minted dangling`));
        continue;
      }
      hash = registration.hash;
      name = seed.name;
      hairOcclusion = seed.hairOcclusion;
    } else if (sibling) {
      // A second copy of something already instantiated: reuse its snapshot.
      hash = sibling.blueprintHash;
      name = sibling.name;
      hairOcclusion = sibling.hairOcclusion;
    } else {
      const registration = registerBlueprint(blueprints, degradedGarmentBlueprint(), instances);
      if (!registration.stored) {
        sink?.push(blueprintsFullDiag(`"${definitionId}" left un-materialized rather than minted dangling`));
        continue;
      }
      sink?.push(
        diag(
          "info",
          "chat_garments.definition_unresolved",
          `worn item ${definitionId} could not be loaded — instantiated with the degraded blueprint`,
        ),
      );
      hash = registration.hash;
      name = "garment";
    }
    const minted: GarmentInstanceState = {
      id: mintId(),
      blueprintHash: hash,
      definitionId,
      name,
      ...(hairOcclusion ? { hairOcclusion } : {}),
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

  // Spread first: the cue memory (slice 6) is store state a reconcile must carry
  // through, never re-mint — losing it would re-fire every standing garment cue.
  return { ...input.store, seeded: true, blueprints, instances: capGarmentInstances(instances) };
}

/**
 * Retire every garment an actor owns: switching the
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
 * Apply `transfer` operations in fiction order.
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
