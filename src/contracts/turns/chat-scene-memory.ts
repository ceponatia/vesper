import { z } from "zod";

/**
 * Chat scene memory (chat-reply-discipline feature — the stateful centerpiece).
 *
 * Chat locations are narrator-imagined (not world entities), so the lane has no
 * structured place to keep them consistent. This is an accumulating, forward-compatible
 * memory of the setting the narration has established: the current place, the time of
 * day, and a bounded set of named places, each with a few durable details ("blue sofa")
 * and connections ("kitchen through the doorway"). It rides ONE jsonb column on
 * `character_chat_state` (`scene_memory`) so field additions are never migrations.
 *
 * It is maintained deterministic-first (a movement detector switches `current` before the
 * prompt builds, `switchScenePlace`) and then reconciled post-turn from the archivist's
 * optional `scene` proposal (`mergeSceneMemory`). Every write is capped + deduped; a bad
 * proposal never fails the turn. The loader parses it through `parseOr` at the trust
 * boundary with `emptyChatSceneMemory()` as the degraded default (docs/resilience.md §1).
 */

/** Cap on remembered places — a chat wanders through a home/city, not a whole map. */
export const SCENE_MEMORY_MAX_PLACES = 12;
/** Cap on durable details per place (a place is a few salient touches, not an inventory). */
export const SCENE_MEMORY_MAX_DETAILS = 8;
/** Cap on connection strings per place ("kitchen through the doorway"). */
export const SCENE_MEMORY_MAX_CONNECTIONS = 6;
/** Length cap on a single detail / connection phrase. */
export const SCENE_DETAIL_MAX_CHARS = 140;
/** Length cap on a place name. */
export const SCENE_PLACE_NAME_MAX_CHARS = 60;
/**
 * Length cap on a place's visual sketch (chat-scene-fidelity.plan.md slice 2): the
 * background sketch agent's 2–4 sentence description of the place, consumed by the
 * scene image's `room` and the narrator's Scene block.
 */
export const SCENE_SKETCH_MAX_CHARS = 600;

const detailString = z.string().trim().min(1).max(SCENE_DETAIL_MAX_CHARS);
const placeNameString = z.string().trim().min(1).max(SCENE_PLACE_NAME_MAX_CHARS);

/** One established place: a name plus its durable details and named connections. */
export const scenePlaceSchema = z.object({
  name: placeNameString,
  details: z
    .array(detailString)
    .catch([])
    .default([])
    .transform((d) => dedupeCap(d, SCENE_MEMORY_MAX_DETAILS)),
  connections: z
    .array(detailString)
    .catch([])
    .default([])
    .transform((c) => dedupeCap(c, SCENE_MEMORY_MAX_CONNECTIONS)),
  /**
   * The background sketch agent's visual description of the place (slice 2b) — generated
   * once when the place is introduced, consumed by the scene image (`room`) and the
   * narrator's Scene block. Absent until the agent runs; an invalid value parses away
   * (the absent-sketch trigger simply re-fires).
   */
  sketch: z.string().trim().min(1).max(SCENE_SKETCH_MAX_CHARS).optional().catch(undefined),
  /**
   * The place's rendered reference image (chat-scene-references.plan.md): a
   * `chat_place` asset minted lazily from the sketch on the first render there,
   * fed to the multi-edit rung as the setting anchor. Absent until minted; a
   * dangling id (deleted asset) just fails the anchor load and re-mints.
   */
  imageId: z.string().trim().min(1).optional().catch(undefined),
});
export type ScenePlace = z.infer<typeof scenePlaceSchema>;

/**
 * The persisted memory blob. Every field is `.catch`/`.default`ed so an older/partial
 * row parses clean (forward-compatible: adding a field is never a migration). The hard
 * place cap rides the schema (last N, oldest-out) as a safety net; the merge enforces it
 * while protecting the current place.
 */
export const chatSceneMemorySchema = z.object({
  current: placeNameString.optional(),
  places: z
    .array(scenePlaceSchema)
    .catch([])
    .default([])
    .transform((p) => p.slice(-SCENE_MEMORY_MAX_PLACES)),
});
export type ChatSceneMemory = z.infer<typeof chatSceneMemorySchema>;

/** The empty memory — the degraded default and the seed value. */
export function emptyChatSceneMemory(): ChatSceneMemory {
  return { places: [] };
}

/** True when the memory carries nothing yet (⇒ the Scene block renders nothing). */
export function isEmptyChatSceneMemory(memory: ChatSceneMemory): boolean {
  return !memory.current && memory.places.length === 0;
}

/**
 * The archivist's optional post-turn `scene` proposal (folded into the archivist output
 * schema): only what the fiction actually established this exchange — a current-place
 * confirmation, a time-of-day hint, and new place details/connections. Lenient — a bad
 * proposal parses to an empty object and merges as a no-op, so it never fails the turn.
 */
export const chatSceneProposalSchema = z
  .object({
    current: placeNameString.optional(),
    places: z
      .array(
        z.object({
          name: placeNameString,
          details: z.array(detailString).catch([]).default([]),
          connections: z.array(detailString).catch([]).default([]),
        }),
      )
      .catch([])
      .default([]),
  })
  .catch({ places: [] })
  .default({ places: [] });
export type ChatSceneProposal = z.infer<typeof chatSceneProposalSchema>;

const normalizeName = (name: string): string => name.trim().toLowerCase();

/**
 * Dedupe (case-insensitive, first-write-wins on casing), drop blanks, then keep the
 * NEWEST `cap` entries (oldest-out). Pure.
 */
function dedupeCap(items: readonly string[], cap: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of items) {
    const item = raw.trim();
    const key = normalizeName(item);
    if (!item || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out.slice(-cap);
}

/** Cap the place list to SCENE_MEMORY_MAX_PLACES, evicting the OLDEST non-current places first. */
function capPlaces(places: readonly ScenePlace[], currentName: string | undefined): ScenePlace[] {
  if (places.length <= SCENE_MEMORY_MAX_PLACES) return [...places];
  const currentKey = currentName ? normalizeName(currentName) : null;
  const overflow = places.length - SCENE_MEMORY_MAX_PLACES;
  const kept: ScenePlace[] = [];
  let dropped = 0;
  for (const place of places) {
    if (dropped < overflow && normalizeName(place.name) !== currentKey) {
      dropped++;
      continue;
    }
    kept.push(place);
  }
  return kept;
}

/** True when two place names refer to the same place (case-insensitive, trimmed). */
export function samePlaceName(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  return normalizeName(a) === normalizeName(b);
}

/**
 * Deterministic movement/arrival (pre-prompt): switch `current` to `placeName`, minting a
 * stub place on first mention so THIS turn's Scene injection is right. No-op when already
 * current or when the name is blank. Pure.
 */
export function switchScenePlace(memory: ChatSceneMemory, placeName: string): ChatSceneMemory {
  const name = placeName.trim().slice(0, SCENE_PLACE_NAME_MAX_CHARS);
  if (!name) return memory;
  if (samePlaceName(memory.current, name)) return memory;
  const key = normalizeName(name);
  const existing = memory.places.find((p) => normalizeName(p.name) === key);
  const places = existing
    ? memory.places
    : capPlaces([...memory.places, { name, details: [], connections: [] }], name);
  const canonical = existing?.name ?? name;
  return { ...memory, current: canonical, places };
}

/**
 * Merge the archivist's post-turn `scene` proposal into the accumulated memory (pure): the
 * current place is updated when proposed, new places minted, and each place's details +
 * connections deduped and capped (oldest-out). The current place is never evicted by the
 * place cap. An empty proposal is a no-op. (Time of day is NOT scene memory — it derives
 * from the story clock, chat-clock-calendar.plan.md.)
 */
export function mergeSceneMemory(memory: ChatSceneMemory, proposal: ChatSceneProposal): ChatSceneMemory {
  let places: ScenePlace[] = memory.places.map((p) => ({
    name: p.name,
    details: [...p.details],
    connections: [...p.connections],
    // Sketch + place image are agent/render-written, never archivist-proposed — carry both.
    ...(p.sketch !== undefined ? { sketch: p.sketch } : {}),
    ...(p.imageId !== undefined ? { imageId: p.imageId } : {}),
  }));

  const upsert = (rawName: string): ScenePlace => {
    const name = rawName.trim().slice(0, SCENE_PLACE_NAME_MAX_CHARS);
    const key = normalizeName(name);
    let place = places.find((p) => normalizeName(p.name) === key);
    if (!place) {
      place = { name, details: [], connections: [] };
      places.push(place);
    }
    return place;
  };

  for (const proposed of proposal.places) {
    const place = upsert(proposed.name);
    place.details = dedupeCap([...place.details, ...proposed.details], SCENE_MEMORY_MAX_DETAILS);
    place.connections = dedupeCap([...place.connections, ...proposed.connections], SCENE_MEMORY_MAX_CONNECTIONS);
  }

  let current = memory.current;
  if (proposal.current) {
    current = upsert(proposal.current).name;
  }
  places = capPlaces(places, current);

  return { current, places };
}

/** The current place record, or null when there is no current place / it has no record yet. */
export function currentScenePlace(memory: ChatSceneMemory): ScenePlace | null {
  if (!memory.current) return null;
  const key = normalizeName(memory.current);
  return memory.places.find((p) => normalizeName(p.name) === key) ?? null;
}

/**
 * The sketch agent's structured output (chat-scene-fidelity.plan.md slice 2b). Lenient:
 * a bad/empty result parses to "" and the handler simply writes nothing (the absent-sketch
 * trigger re-fires on a later exchange).
 */
export const chatSceneSketchSchema = z.object({
  sketch: z
    .string()
    .catch("")
    .default("")
    .transform((s) => s.trim().slice(0, SCENE_SKETCH_MAX_CHARS)),
});
export type ChatSceneSketch = z.infer<typeof chatSceneSketchSchema>;

/** Degraded default: no sketch written. */
export function degradedChatSceneSketch(): ChatSceneSketch {
  return { sketch: "" };
}

/**
 * Write a finished sketch onto its place (pure): set `place.sketch` when the place still
 * exists AND has no sketch yet (first write wins — a racing regeneration never clobbers).
 * Returns the original memory object when nothing changed, so callers can cheap-compare.
 */
export function withPlaceSketch(memory: ChatSceneMemory, placeName: string, sketch: string): ChatSceneMemory {
  const text = sketch.trim().slice(0, SCENE_SKETCH_MAX_CHARS);
  if (!text) return memory;
  const key = normalizeName(placeName);
  const index = memory.places.findIndex((p) => normalizeName(p.name) === key);
  const place = index >= 0 ? memory.places[index] : undefined;
  if (!place || place.sketch) return memory;
  const places = [...memory.places];
  places[index] = { ...place, sketch: text };
  return { ...memory, places };
}

/**
 * Attach a rendered place image to a named place (chat-scene-references.plan.md) —
 * the CAS-write shape `withPlaceSketch` uses: returns the SAME memory reference
 * when the place vanished or already carries an image, so callers can bail on
 * identity. PURE.
 */
export function withPlaceImage(memory: ChatSceneMemory, placeName: string, imageId: string): ChatSceneMemory {
  const id = imageId.trim();
  if (!id) return memory;
  const key = normalizeName(placeName);
  const index = memory.places.findIndex((p) => normalizeName(p.name) === key);
  const place = index >= 0 ? memory.places[index] : undefined;
  if (!place || place.imageId) return memory;
  const places = [...memory.places];
  places[index] = { ...place, imageId: id };
  return { ...memory, places };
}
