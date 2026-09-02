import {
  imageModelProfileSchema,
  imageModelSchema,
  type ImageProfileTask,
  type ImagePromptStrategy,
  type ResolvedImageProfile,
} from "@vesper/image-core";

/**
 * One resolved image profile for a lane test, pinned to exactly the
 * (slug, task, key) triple a prompt binding row is resolved by — so a test
 * chooses whether its lane compiles (a seeded slug) or answers `unbound` (a
 * `test-only/…` slug) by the slug alone.
 *
 * The model can both generate and edit and takes up to three array references
 * on `image`, which is what lets reference planning actually move or drop a
 * reference. The operation and strategy follow the task unless overridden:
 * a portrait is text-to-image, every other character task is an instruction
 * edit. The reference policy is the one field a caller varies.
 */
export function resolvedImageProfileFixture(over: {
  readonly slug: string;
  readonly task: ImageProfileTask;
  readonly key: string;
  readonly operation?: "generate" | "edit";
  readonly promptStrategy?: ImagePromptStrategy;
  readonly referencePolicy?: unknown;
}): ResolvedImageProfile {
  const operation = over.operation ?? (over.task === "portrait" ? "generate" : "edit");
  const model = imageModelSchema.parse({
    id: `mdl-${over.slug.replaceAll("/", "-")}`,
    slug: over.slug,
    label: `Fixture ${over.slug}`,
    canGenerate: true,
    canEdit: true,
    referenceField: "image",
    referenceArity: "array",
    maxReferences: 3,
    supportedAspects: ["3:4"],
  });
  const profile = imageModelProfileSchema.parse({
    id: `prf-${over.key}`,
    imageModelId: model.id,
    key: over.key,
    label: over.key,
    task: over.task,
    operation,
    promptStrategy: over.promptStrategy ?? (operation === "generate" ? "text_to_image_description" : "instruction_edit"),
    ...(over.referencePolicy === undefined ? {} : { referencePolicy: over.referencePolicy }),
  });
  return { model, profile };
}
