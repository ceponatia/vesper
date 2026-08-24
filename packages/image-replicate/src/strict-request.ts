import {
  type ImageModel,
  type ImageProviderInputDescriptor,
  imageAspectInputField,
} from "@vesper/image-core";

/**
 * The strict arm of a registry render (`ImageRenderPolicy` in
 * `@vesper/image-core`): the two pre-spend questions a bench caller wants
 * answered before a prediction is created, both of them Replicate-schema
 * questions and therefore this package's to answer.
 *
 * 1. **Did everything the caller explicitly selected actually fit?** The
 *    inline byte budget and the model's own reference capacity both trim from
 *    the tail. Production wants that trim; a bench does not, because a run that
 *    sent four of five selected images is a different experiment wearing the
 *    same run id.
 * 2. **Does the assembled payload satisfy the version's declared schema?** The
 *    probe already recorded required/default/type/enum/range per field. Holding
 *    the finished payload against those facts turns a certain provider
 *    rejection into a refusal that costs nothing.
 *
 * Both live HERE rather than in the application for the reason the whole
 * package exists: Replicate field names, the payload's shape, and the byte
 * budget are provider facts, and an application-side approximation of them is
 * a second copy that drifts. The application asks for the policy; it never
 * restates the rules.
 */

/** One explicitly selected reference the transport could not carry. */
export interface UnsentReferenceReport {
  /** Position in the caller's own reference list, zero-based. */
  index: number;
  /** The caller's role label for it — never bytes, never a URI. */
  role: string;
  reason: "model_capacity" | "inline_byte_budget";
}

/** One way the assembled payload contradicts the version's probed schema. */
export interface ProviderInputViolation {
  field: string;
  reason: "required_missing" | "type" | "enum" | "range" | "unsupported_shape";
  detail: string;
}

/**
 * The references the transport is about to drop, as a report.
 *
 * `selected` is the caller's list and `sending` is the prefix that survived
 * both trims, so the report is the tail difference — which is exactly what
 * both trims produce (`fitReferences` and `withinDataUrlBudget` are prefix
 * selections, never gap-filling ones).
 */
export function unsentReferenceReports(
  selected: readonly { role?: string }[],
  fitted: number,
  sending: number,
): UnsentReferenceReport[] {
  const reports: UnsentReferenceReport[] = [];
  for (let index = sending; index < selected.length; index += 1) {
    reports.push({
      index,
      role: selected[index]?.role ?? "reference",
      // Anything past the capacity fit was refused by the model's own arity;
      // anything between the fit and the send lost to the inline byte budget.
      reason: index >= fitted ? "model_capacity" : "inline_byte_budget",
    });
  }
  return reports;
}

/** The operator-facing sentence for a set of unsent references. */
export function unsentReferenceMessage(slug: string, reports: readonly UnsentReferenceReport[]): string {
  const parts = reports.map((report) => `${report.role} (#${String(report.index + 1)}, ${report.reason})`);
  return `${slug} cannot carry every selected reference: ${parts.join(", ")}`;
}

/**
 * The provider fields the render path itself writes, and therefore the ones a
 * `uri`/`array`/`unknown` descriptor is allowed to appear under.
 *
 * A URI-shaped field is only safe when a typed transport put it there — the
 * primary reference binding, a dedicated structural input, the aspect key, or a
 * reviewed `extraInput` pin. Any OTHER route to such a field is the raw
 * advanced bag, and the bag may not hand a provider an arbitrary address: the
 * owner-scoped image picker is the only path to an image, and a shape Vesper
 * cannot read is a shape Vesper must not send.
 */
function typedOwnerFields(model: ImageModel, controlFields: readonly string[]): Set<string> {
  const owners = new Set<string>(["prompt", "version", "disable_safety_checker", "output_format"]);
  owners.add(model.referenceField);
  owners.add(imageAspectInputField(model));
  const probedPrompt = model.advancedCapabilities.prompt?.field;
  if (probedPrompt) owners.add(probedPrompt);
  for (const field of controlFields) owners.add(field);
  for (const field of Object.keys(model.extraInput)) owners.add(field);
  return owners;
}

/** Whether a value is a URI-shaped payload entry: one address, or a list of them. */
function looksLikeUriValue(value: unknown): boolean {
  if (typeof value === "string") return true;
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

/**
 * Every way the assembled payload contradicts what the version declared.
 *
 * Descriptor-driven, so a model whose record predates provider-input
 * descriptors reports nothing and behaves exactly as it did — the strict arm
 * strengthens a probed record, it does not invent facts about an unprobed one.
 *
 * `default`-carrying required fields are deliberately NOT demanded: a provider
 * default is the provider's answer, and making the caller restate it would turn
 * "leave it unset" into "copy whatever another lane used".
 */
export function providerInputViolations(
  model: ImageModel,
  input: Record<string, unknown>,
  controlFields: readonly string[] = [],
): ProviderInputViolation[] {
  const descriptors = model.advancedCapabilities.providerInputs;
  if (descriptors.length === 0) return [];
  const owners = typedOwnerFields(model, controlFields);
  const violations: ProviderInputViolation[] = [];

  for (const descriptor of descriptors) {
    const present = Object.hasOwn(input, descriptor.field) && input[descriptor.field] !== undefined;
    if (!present) {
      if (descriptor.required && descriptor.default === undefined) {
        violations.push({
          field: descriptor.field,
          reason: "required_missing",
          detail: `${descriptor.field} is required by this version and declares no default`,
        });
      }
      continue;
    }
    const violation = valueViolation(descriptor, input[descriptor.field], owners.has(descriptor.field));
    if (violation) violations.push(violation);
  }
  return violations;
}

/** The violation one present value commits against its descriptor, or null. */
function valueViolation(
  descriptor: ImageProviderInputDescriptor,
  value: unknown,
  ownedByTypedTransport: boolean,
): ProviderInputViolation | null {
  const fail = (reason: ProviderInputViolation["reason"], detail: string): ProviderInputViolation => ({
    field: descriptor.field,
    reason,
    detail,
  });
  const range = (numeric: number): ProviderInputViolation | null => {
    if (descriptor.minimum !== undefined && numeric < descriptor.minimum) {
      return fail("range", `${descriptor.field} must be at least ${String(descriptor.minimum)}`);
    }
    if (descriptor.maximum !== undefined && numeric > descriptor.maximum) {
      return fail("range", `${descriptor.field} must be at most ${String(descriptor.maximum)}`);
    }
    return null;
  };

  switch (descriptor.type) {
    case "boolean":
      return typeof value === "boolean" ? null : fail("type", `${descriptor.field} expects a boolean`);
    case "integer":
      if (typeof value !== "number" || !Number.isInteger(value)) {
        return fail("type", `${descriptor.field} expects an integer`);
      }
      return range(value);
    case "number":
      if (typeof value !== "number") return fail("type", `${descriptor.field} expects a number`);
      return range(value);
    case "string":
      return typeof value === "string" ? null : fail("type", `${descriptor.field} expects a string`);
    case "enum": {
      // A mixed provider enum keeps only its string members in the descriptor
      // (`descriptiveEnumValues`), so a non-string value here is unprovable
      // rather than wrong — the strict arm refuses what it can PROVE.
      if (typeof value !== "string") return null;
      if (descriptor.enumValues === undefined || descriptor.enumValues.length === 0) return null;
      return descriptor.enumValues.includes(value)
        ? null
        : fail("enum", `${descriptor.field} must be one of: ${descriptor.enumValues.join(", ")}`);
    }
    case "uri":
      if (!ownedByTypedTransport) {
        return fail(
          "unsupported_shape",
          `${descriptor.field} takes an image address, which only the image picker may supply`,
        );
      }
      return looksLikeUriValue(value) ? null : fail("type", `${descriptor.field} expects an image address`);
    case "array":
      if (!ownedByTypedTransport) {
        return fail("unsupported_shape", `${descriptor.field} takes a list, which Vesper cannot send as a raw value`);
      }
      return Array.isArray(value) ? null : fail("type", `${descriptor.field} expects a list`);
    case "unknown":
      return ownedByTypedTransport
        ? null
        : fail("unsupported_shape", `${descriptor.field} has a shape this version's schema did not describe`);
  }
}

/** The operator-facing sentence for a set of payload violations. */
export function providerInputViolationMessage(slug: string, violations: readonly ProviderInputViolation[]): string {
  return `${slug} would reject this request: ${violations.map((violation) => violation.detail).join("; ")}`;
}
