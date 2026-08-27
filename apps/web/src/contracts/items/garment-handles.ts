import { garmentBehaviorBindingFor, type GarmentBlueprint } from "./garment-blueprint";
import { garmentBlueprintFor, garmentLocusActorId, garmentsAtScenePlace } from "./garment-store";
import type { ChatGarmentStore, GarmentInstanceState, GarmentLocusKind } from "./garment-instance";

/**
 * The continuity extractor's HANDLE TABLE. Models propose semantic operations,
 * never raw state: the continuity prompt enumerates only in-scope opaque garment
 * and part handles, and the extractor returns those handles, not names to
 * fuzzy-match.
 *
 * This module is the enumeration half: a pure, deterministic, bounded projection
 * of the chat garment store into the short opaque strings the archivist prompt
 * shows and the extractor copies back. The mapping half — proposals carrying
 * those strings back into typed `GarmentOperation`s — lives in
 * `contracts/turns/chat-garment-ops.ts`.
 *
 * The scheme:
 *
 * - **garment** — `<actorSlug>.<garmentSlug>`, e.g. `sabrina.shirt`, `you.jeans`,
 *   `scene.jacket` for something left in the room. Collisions inside one exchange
 *   take a `_2`, `_3` suffix in emission order, so the table is collision-free by
 *   construction and stable for a given store.
 * - **part** — `<garmentHandle>.<partId>`, e.g. `sabrina.shirt.sleeve_left`. Part
 *   ids are the blueprint's own opaque slugs (never displayed prose), so the
 *   model copies a string it can see rather than naming a sleeve in English.
 *
 * Two bounds keep the block affordable on EVERY exchange: only parts that can
 * change a read earn a handle (a bound behavior or real baseline coverage, plus
 * the explicitly enumerated ROOT — audit OQ7), and the table is capped, trimming
 * `scene` before `held` before `worn`.
 */

/** Max garments enumerated for one exchange — the block is rendered every turn. */
export const GARMENT_HANDLE_MAX_GARMENTS = 12;
/** Max part handles shown per garment (the root always makes the cut). */
export const GARMENT_HANDLE_MAX_PARTS = 8;

/** One enumerated garment: what the prompt renders and what a proposal resolves against. */
export interface GarmentHandleEntry {
  /** The opaque handle the prompt enumerates and the extractor copies back. */
  handle: string;
  /** The instance this handle names. */
  garmentId: string;
  /** Display name — prompt prose only, never a matching key. */
  name: string;
  /** Where it is, in words ("worn by Sabrina", "left in the study"). */
  where: string;
  locusKind: GarmentLocusKind;
  /** Part ids SHOWN to the model: root + parts that can change a read (OQ7). */
  partHandles: readonly string[];
  /** EVERY part id the blueprint has — what a returned part handle may resolve to. */
  partIds: readonly string[];
}

/** An actor a proposal may name (a wearer for `introduce`, a destination for `move`). */
export interface GarmentHandleActor {
  /** The handle prefix used by this actor's garments (`sabrina`, `you`). */
  handle: string;
  /** `garmentActorForCharacter(id)` or `GARMENT_PLAYER_ACTOR`. */
  actorId: string;
  /** Display label for the prompt line. */
  label: string;
}

/** The whole in-scope table for one exchange. */
export interface GarmentHandleTable {
  entries: readonly GarmentHandleEntry[];
  actors: readonly GarmentHandleActor[];
  /** True when the caps dropped something — the prompt can say the list is partial. */
  trimmed: boolean;
}

/** The empty table: nothing modelled, so the extractor's operation field never arms. */
export function emptyGarmentHandleTable(): GarmentHandleTable {
  return { entries: [], actors: [], trimmed: false };
}

/** An actor the caller offers for enumeration (in the order handles should be minted). */
export interface GarmentHandleActorInput {
  actorId: string;
  /** Display name ("Sabrina", "You"). */
  label: string;
  /** Preferred handle slug; defaults to a slug of the label. `you` for the player. */
  slug?: string;
}

/** Lowercase `a-z0-9_` token — the only characters a handle ever contains. */
function slugToken(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .slice(0, 24);
  return slug.replace(/_+$/u, "");
}

/**
 * A garment's slug: the HEAD NOUN of its name ("white cotton tee" → `tee`,
 * "grey wool cardigan" → `cardigan`). Short strings are cheap for a model to copy
 * exactly, and the `_2` suffix below makes duplicates unambiguous anyway.
 */
function garmentSlug(name: string): string {
  const words = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, " ")
    .split(" ")
    .filter(Boolean);
  const head = words.length > 0 ? words[words.length - 1] : undefined;
  return slugToken(head ?? "") || "garment";
}

/** Claim `base`, or the first free `base_2` / `base_3` — emission order decides. */
function claim(taken: Set<string>, base: string): string {
  if (!taken.has(base)) {
    taken.add(base);
    return base;
  }
  for (let n = 2; n < 100; n += 1) {
    const candidate = `${base}_${n}`;
    if (!taken.has(candidate)) {
      taken.add(candidate);
      return candidate;
    }
  }
  taken.add(base);
  return base;
}

/**
 * Which parts earn a handle (OQ7 — "part handles ONLY for bindable/addressable
 * parts plus the explicit root handle"). A part is addressable when it can change
 * a read: a bound behavior makes it presentation-addressable, real baseline
 * coverage makes it condition/coverage-bearing. A collar that covers nothing and
 * does nothing is real topology the model has no operation for, so it stays out
 * of the block rather than eating tokens — the resolver still accepts it, because
 * a part that EXISTS is not a hallucination.
 */
function addressablePartIds(blueprint: GarmentBlueprint): string[] {
  const root = blueprint.rootNodeId;
  const rest = blueprint.nodes
    .filter(
      (node) =>
        node.id !== root &&
        (node.baselineCoverage.length > 0 || garmentBehaviorBindingFor(blueprint, node.id) !== undefined),
    )
    .map((node) => node.id);
  return [root, ...rest].slice(0, GARMENT_HANDLE_MAX_PARTS);
}

/** Where an instance is, in words — the prompt's grounding for a `move`. */
function whereText(instance: GarmentInstanceState, labelFor: (actorId: string) => string): string {
  switch (instance.locus.kind) {
    case "worn":
      return `worn by ${labelFor(instance.locus.actorId)}`;
    case "held":
      return `held by ${labelFor(instance.locus.actorId)}`;
    case "wardrobe":
      return `put away (${labelFor(instance.locus.ownerId)})`;
    case "scene":
      return instance.locus.anchor ? `left here, ${instance.locus.anchor}` : "left here";
    case "gone":
      return "gone";
  }
}

/**
 * Build the in-scope handle table for one exchange. PURE and deterministic: the
 * same store, actors and place always produce the same handles.
 *
 * Only actors that are actually MODELLED are listed. Minting a garment onto an
 * unmodelled actor would flip them to modelled and make the store their whole
 * wardrobe truth — which, for a player still wearing their persona's default
 * preset, would silently strip everything the preset supplied. An unmodelled
 * actor therefore contributes no handles and takes no `introduce`.
 */
export function buildGarmentHandleTable(input: {
  store: ChatGarmentStore;
  /** Candidate actors, in handle-minting priority order (characters, then the player). */
  actors: readonly GarmentHandleActorInput[];
  /** The scene the fiction is in — garments left HERE are in scope; elsewhere they are not. */
  placeName?: string;
  limit?: number;
}): GarmentHandleTable {
  const limit = input.limit ?? GARMENT_HANDLE_MAX_GARMENTS;
  const modelled = input.actors.filter((actor) =>
    input.store.instances.some((instance) => garmentLocusActorId(instance.locus) === actor.actorId),
  );
  const actorSlugs = new Set<string>();
  const actors: GarmentHandleActor[] = modelled.map((actor) => ({
    handle: claim(actorSlugs, slugToken(actor.slug ?? actor.label) || "actor"),
    actorId: actor.actorId,
    label: actor.label,
  }));
  const slugByActorId = new Map(actors.map((actor) => [actor.actorId, actor.handle]));
  const labelByActorId = new Map(actors.map((actor) => [actor.actorId, actor.label]));
  const labelFor = (actorId: string): string => labelByActorId.get(actorId) ?? actorId;

  // Worn before held before scene — the trim order the plan asks for, applied by
  // COLLECTING in that order and capping the tail.
  const ofActors = (kind: "worn" | "held"): GarmentInstanceState[] =>
    actors.flatMap((actor) =>
      input.store.instances.filter(
        (instance) => instance.locus.kind === kind && garmentLocusActorId(instance.locus) === actor.actorId,
      ),
    );
  const ordered = [...ofActors("worn"), ...ofActors("held"), ...garmentsAtScenePlace(input.store, input.placeName)];
  const kept = ordered.slice(0, limit);

  const handles = new Set<string>();
  const entries = kept.map((instance): GarmentHandleEntry => {
    const actorId = garmentLocusActorId(instance.locus);
    const prefix = (actorId ? slugByActorId.get(actorId) : undefined) ?? "scene";
    const blueprint = garmentBlueprintFor(input.store, instance);
    const handle = claim(handles, `${prefix}.${garmentSlug(instance.name)}`);
    return {
      handle,
      garmentId: instance.id,
      name: instance.name,
      where: whereText(instance, labelFor),
      locusKind: instance.locus.kind,
      partHandles: addressablePartIds(blueprint),
      partIds: blueprint.nodes.map((node) => node.id),
    };
  });

  return { entries, actors, trimmed: ordered.length > kept.length };
}

/** Entry lookup by the exact handle the model returned (never fuzzy — OQ7). */
export function garmentHandleEntry(
  table: GarmentHandleTable,
  handle: string,
): GarmentHandleEntry | undefined {
  const wanted = handle.trim();
  return table.entries.find((entry) => entry.handle === wanted);
}

/** Actor lookup by handle (`introduce.wearer`, `move.wearer`). */
export function garmentHandleActor(table: GarmentHandleTable, handle: string): GarmentHandleActor | undefined {
  const wanted = handle.trim();
  return table.actors.find((actor) => actor.handle === wanted);
}
