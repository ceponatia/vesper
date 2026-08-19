import { and, eq } from "drizzle-orm";
import {
  activeImagePromptBinding,
  buildImageWorldDigest,
  compileImagePromptProgram,
  imageNegativePack,
  imagePositivePack,
  imagePromptBudgetFromBinding,
  IMAGE_PROMPT_PROGRAM_META_KEY,
  IMAGE_WORLD_STATE_META_KEY,
  type ImageModel,
  type ImageWorldDigest,
  type ImageWorldDigestResult,
} from "@vesper/image-core";
import { diag, type DiagnosticSink } from "@/contracts/diagnostics";
import {
  entityReadToken,
  itemImageOperation,
  itemSourceRevision,
  locationImageOperation,
  locationSourceRevision,
  projectItemDigest,
  projectLocationDigest,
  type ItemProjectionInput,
  type LocationProjectionInput,
} from "@/contracts/images/entity-digest";
import { parseOrNull } from "@/lib/parse";
import { itemDefinitionSchema } from "@/contracts/items/item";
import { ambientSchema } from "@/contracts/world/location";
import { db, items, locations } from "../db";

/**
 * The item and location image lanes, compiled through the prompt-program
 * pipeline (model-aware-image-prompts.plan.md §"Item and location module").
 *
 * This is the first production lane on the new system, and it is the right first
 * one for two reasons. It runs on `qwen/qwen-image-2512`, the endpoint whose
 * dialect is implemented and which has a real `negative_prompt` field, so both
 * halves of the architecture have somewhere to go. And it carries no identity
 * risk: nobody's face is at stake in a photograph of a compass, so a dialect
 * still awaiting its first pinned trial cannot cost a character their likeness.
 *
 * What it replaces is `prompts-entity.ts`, which formatted a paragraph per entity
 * kind and appended "no people, no text, no watermark" to it. Both of those
 * survive here, but as different KINDS of thing: the shot decisions became a
 * projected operation contract, and the three exclusions became guarded negative
 * blocks that the linter can drop when a world fact contradicts them.
 *
 * ## What reaches the provider today
 *
 * The positive prompt, always. The negative field only once the model version is
 * probed: the render kernel maps a normalized control through the version's own
 * declared bindings and drops it as `no_binding` otherwise, and inventing a
 * `negative_prompt` key on an unprobed row is exactly the guessing the capability
 * layer exists to prevent. So the compile always runs, the exclusions are always
 * recorded in provenance, and the moment a probe declares the field they start
 * travelling with no code change.
 */

/** What one entity render needs from this module. */
export interface EntityPromptProgramInput {
  readonly entityKind: "item" | "location";
  readonly entityId: string;
  readonly ownerId: string;
  readonly model: ImageModel;
  readonly sink?: DiagnosticSink;
}

export interface EntityPromptProgram {
  /** The entity's display name — the pipeline's monogram fallback still wants it. */
  readonly name: string;
  readonly prompt: string;
  /** The compiled exclusions, or null when this version exposes no field for them. */
  readonly negativePrompt: string | null;
  /** `meta.promptProgram` and `meta.worldState`, ready to merge onto the image row. */
  readonly meta: Record<string, unknown>;
}

/** Why an entity render could not be compiled — a message the pipeline shows on the failed row. */
export interface EntityPromptProgramRefusal {
  readonly refusal: string;
}

export type EntityPromptProgramResult = EntityPromptProgram | EntityPromptProgramRefusal | null;

/** Whether a result is a refusal rather than a compiled program. */
export function isEntityPromptRefusal(result: EntityPromptProgramResult): result is EntityPromptProgramRefusal {
  return result !== null && "refusal" in result;
}

const PATH = "images.entity_prompt";

/**
 * Read the entity, project it, compile the program.
 *
 * Returns null when the row does not exist (the caller already treats that as a
 * failed precondition), and a refusal when the row exists but no prompt program
 * can be built for the resolved model. Refusing rather than falling back to a
 * generic paragraph is the plan's ruling: a lane whose profile has been pointed
 * at an endpoint with no registered dialect has a configuration problem, and
 * quietly rendering something reasonable would hide it behind acceptable-looking
 * images.
 *
 * One row, one read. A single `select` is already a consistent projection, so
 * the read token is minted straight from that row's revision — no transaction is
 * needed to make this atomic, and adding one would imply a multi-owner read that
 * this lane does not perform.
 */
export async function buildEntityPromptProgram(input: EntityPromptProgramInput): Promise<EntityPromptProgramResult> {
  const loaded =
    input.entityKind === "item"
      ? await loadItem(input.entityId, input.ownerId, input.sink)
      : await loadLocation(input.entityId, input.ownerId, input.sink);
  if (loaded === null) return null;

  const binding = activeImagePromptBinding({ modelSlug: input.model.slug, task: input.entityKind });
  if (binding === null) {
    input.sink?.push(
      diag("warn", "image_prompt_program.binding_missing", "no prompt program is bound to this model for this task", {
        path: PATH,
        context: { slug: input.model.slug, task: input.entityKind },
      }),
    );
    return { refusal: `no image prompt pack is bound to ${input.model.slug} for ${input.entityKind} renders` };
  }
  const positivePack = imagePositivePack(binding.positivePackVersionId);
  const negativePack = imageNegativePack(binding.negativePackVersionId);
  if (positivePack === null || negativePack === null) {
    input.sink?.push(
      diag("warn", "image_prompt_program.pack_missing", "a bound prompt pack version is not registered", {
        path: PATH,
        context: { binding: binding.id, positive: binding.positivePackVersionId, negative: binding.negativePackVersionId },
      }),
    );
    return { refusal: `prompt pack versions bound by ${binding.id} are not registered` };
  }

  const compiled = compileImagePromptProgram({
    digest: loaded.digest,
    binding,
    positivePack,
    negativePack,
    references: [],
    budget: imagePromptBudgetFromBinding(input.model.advancedCapabilities.prompt),
    // The probed negative binding is the only honest source for whether this
    // version has a field at all. An empty `advancedCapabilities` means nobody
    // has looked, which is not the same as "yes".
    negativeFieldAvailable: input.model.advancedCapabilities.controls.negativePrompt !== undefined,
    // An entity render never has identity anchors to lose, and a library row with
    // a blank description is an ordinary state rather than a broken one.
    refuseOnMissingRequired: false,
    ...(input.sink === undefined ? {} : { sink: input.sink }),
  });
  if (!compiled.ok) {
    input.sink?.push(
      diag("warn", compiled.refusal.code, compiled.refusal.message, { path: PATH, context: compiled.refusal.context }),
    );
    return { refusal: compiled.refusal.message };
  }

  return {
    name: loaded.name,
    prompt: compiled.compiled.positiveText,
    negativePrompt: compiled.compiled.negativeText,
    meta: {
      [IMAGE_PROMPT_PROGRAM_META_KEY]: compiled.compiled.promptProgramProvenance,
      [IMAGE_WORLD_STATE_META_KEY]: compiled.compiled.worldStateProvenance,
    },
  };
}

interface LoadedEntity {
  readonly name: string;
  readonly digest: ImageWorldDigest;
}

/**
 * Report the digest builder's own findings and hand back the digest.
 *
 * These are projection bugs rather than data problems — a duplicate fact key, an
 * unregistered concept — so they are worth a diagnostic even though the digest is
 * still returned without the offending member. A silent drop here would look
 * exactly like a field the projection never had.
 */
function reportedDigest(built: ImageWorldDigestResult, sink: DiagnosticSink | undefined): ImageWorldDigest {
  for (const issue of built.issues) {
    sink?.push(
      diag("warn", issue.code, "an entity projection produced a fact the world digest could not carry", {
        path: PATH,
        context: { detail: issue.detail },
      }),
    );
  }
  return built.digest;
}

async function loadItem(entityId: string, ownerId: string, sink?: DiagnosticSink): Promise<LoadedEntity | null> {
  const [row] = await db()
    .select({
      name: items.name,
      description: items.description,
      kind: items.kind,
      definition: items.definition,
      updatedAt: items.updatedAt,
    })
    .from(items)
    .where(and(eq(items.id, entityId), eq(items.ownerId, ownerId)))
    .limit(1);
  if (!row) return null;
  // The definition blob is a trust boundary like any other: it is years old, was
  // written by several authoring versions, and a malformed one must cost this
  // render its optional detail rather than the whole image.
  const definition = parseOrNull(itemDefinitionSchema, row.definition);
  const projection: ItemProjectionInput = {
    id: entityId,
    name: row.name,
    kind: row.kind,
    description: row.description,
    appearance: definition?.sensory.appearance ?? null,
    colorShade: definition?.color?.shade ?? null,
    subtype: definition?.subtype ?? null,
    opacity: definition?.opacity ?? null,
    revision: row.updatedAt.toISOString(),
  };
  const revisions = [itemSourceRevision(projection)];
  const built = buildImageWorldDigest({
    read: { kind: "transactional_projection", token: entityReadToken(revisions) },
    items: [projectItemDigest(projection)],
    operation: itemImageOperation(),
    sourceRevisions: revisions,
  });
  return { name: row.name, digest: reportedDigest(built, sink) };
}

async function loadLocation(entityId: string, ownerId: string, sink?: DiagnosticSink): Promise<LoadedEntity | null> {
  const [row] = await db()
    .select({
      name: locations.name,
      description: locations.description,
      scale: locations.scale,
      ambient: locations.ambient,
      updatedAt: locations.updatedAt,
    })
    .from(locations)
    .where(and(eq(locations.id, entityId), eq(locations.ownerId, ownerId)))
    .limit(1);
  if (!row) return null;
  const ambient = parseOrNull(ambientSchema, row.ambient);
  const projection: LocationProjectionInput = {
    id: entityId,
    name: row.name,
    scale: row.scale,
    description: row.description,
    light: ambient?.light ?? null,
    revision: row.updatedAt.toISOString(),
  };
  const revisions = [locationSourceRevision(projection)];
  const built = buildImageWorldDigest({
    read: { kind: "transactional_projection", token: entityReadToken(revisions) },
    location: projectLocationDigest(projection),
    operation: locationImageOperation(projection.scale),
    sourceRevisions: revisions,
  });
  return { name: row.name, digest: reportedDigest(built, sink) };
}
