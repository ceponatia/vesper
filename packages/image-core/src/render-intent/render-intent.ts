import { referenceCapacity, type ImageModel } from "../models/image-models";
import {
  isImageControlReferenceRole,
  type ImageBindingArity,
  type ImageReferenceRole,
} from "../capabilities/image-model-capabilities";
import type { ImageLoraRenderBinding } from "../loras/image-loras";
import type { ImageReferencePolicy, ImageRenderControls } from "../models/image-model-profiles";

/**
 * The normalized render request every image lane speaks
 * (image-model-capabilities.spec.md §"Normalized render intent").
 *
 * Before this existed, each lane called the provider its own way: the portrait
 * lane sent a prompt, the variant lane a prompt and one buffer, the scene lane a
 * prompt and up to three buffers whose meaning was their POSITION. A reference
 * was the first, second or third image and nothing more, so nothing downstream
 * could tell the character's face from the room it stands in — which is why
 * capacity trimming could drop the identity anchor and keep the location.
 *
 * An intent says what the render WANTS in terms no model knows about: the
 * prompt, the shape, the optional controls, and references that carry a ROLE.
 * The profile and model translate that into provider fields.
 *
 * This module is the serializable half — vocabulary and pure rules only. The
 * buffer-bearing request and the orchestration live in
 * `server/images/render-intent.ts`, because bytes never cross into `contracts`.
 */

/**
 * One reference a lane wants to send, minus its bytes.
 *
 * `role` is the point of the whole type. `required` and `priority` feed
 * {@link planIntentReferences}, which sorts required references ahead of
 * optional ones and profile role order ahead of numeric priority. Selection only
 * ORDERS a required reference; the refusal half of the flag lives one layer up,
 * in `planImageRender` — see the field.
 *
 * `sourceImageId` and `name` are provenance, not payload: they let a diagnostic
 * say which stored asset was dropped rather than "reference 3".
 *
 * `subject` is the one field here that IS payload, and the split from `name` is
 * deliberate rather than redundant. Both hold a person's name; only `subject`
 * crosses into the provider, woven into this reference's numbered binding by the
 * compose strategy. Keeping the sent one separate means a diagnostic label can
 * stay as loose as a diagnostic label should be — a place, an id fragment, an
 * operator's shorthand — without any of it silently becoming prompt text.
 */
export interface ImageRenderReferenceSpec {
  role: ImageReferenceRole;
  /**
   * Fail the render rather than send it without this reference.
   *
   * Two layers honour it, and both are needed. Selection sorts required
   * references ahead of optional ones, so the slots go to them first; and
   * `planImageRender` refuses the whole plan
   * (`image_profile.required_reference_dropped`) when one is dropped anyway —
   * for capacity, for a per-role cap, for a role the policy never allowed, or
   * for a dedicated input's own ceiling. Sorting alone would have made this
   * field a preference with a promise's name.
   *
   * Distinct from the policy's `requiredRoles`, which is a demand about ROLES
   * and is answered with a set: a lane sending two required identity references
   * is asking for both FACES, and "an identity reference survived" cannot tell
   * that apart from one of them being trimmed. This flag is per reference, so
   * the second one going missing refuses instead of rendering a two-character
   * scene with one character in it.
   */
  required?: boolean;
  /** Tie-break within a role band; higher wins. Unset sorts after any set value. */
  priority?: number;
  /** The `images.id` these bytes came from, when they came from a stored asset. */
  sourceImageId?: string;
  /** A human label for DIAGNOSTICS — a character or place name, never sent. */
  name?: string;
  /**
   * A short subject label — a character's name — that the compose strategy weaves
   * into this reference's numbered binding, and which therefore IS SENT to the
   * provider as prompt text.
   *
   * It exists because two references of the SAME role stop being distinguishable
   * the moment there are two of them: "the identity reference" said twice names
   * neither person, and a two-character render whose prompt cannot say which face
   * belongs to which image is a swap waiting to happen. Set only where that
   * ambiguity is real (identity today); left unset, the compiled text is
   * byte-identical to what it was before this field existed.
   */
  subject?: string;
}

/**
 * The shape a lane wants back, as a width/height ratio.
 *
 * An object rather than a bare number because this is where the quality tier and
 * explicit resolution join it in slice 4. They are deliberately absent now: a
 * `quality: "fast" | "balanced" | "quality"` field would be a claim about the
 * render that nothing in the payload honors until quality profiles and the
 * control transports exist.
 */
export interface ImageRenderTarget {
  aspectRatio: number;
}

/**
 * What a lane asks for, independent of which model will answer.
 *
 * The task is deliberately NOT here: an intent is always accompanied by the
 * profile it resolved to, and that profile names its own task. Carrying both
 * would let them disagree.
 */
export interface ImageRenderIntentCore {
  /** The lane's prompt, BEFORE the profile's prompt strategy compiles it. */
  prompt: string;
  target: ImageRenderTarget;
  /**
   * Per-render control overrides, merged over the profile's stored defaults. No
   * lane sends any today, which is what keeps the migration payload-neutral.
   */
  controls?: ImageRenderControls;
  /**
   * A curated LoRA that has already been resolved against the library
   * (`resolveImageLoraForRender`): the locator to send, the scale to send it at,
   * and the prompt additions that come with it.
   *
   * Set ONLY by server code that performed that resolution — the image lab, which
   * resolves before it plans so a refusal settles onto its row pre-spend, and
   * `renderImageIntent`, which resolves for every caller that did not. A lane
   * never sets it; a lane asks for a LoRA the same way a profile does, through
   * `controls.lora`, which is a REQUEST (`{ id, scale? }`) rather than a decision.
   *
   * The distinction is the whole safety property: a locator on an intent has been
   * judged compatible with this model, this version and this task, while a
   * selection has not, and the control mapper deliberately refuses to send the
   * second.
   */
  resolvedLora?: ImageLoraRenderBinding;
}

/**
 * Reference roles a profile requires that this intent does not supply.
 *
 * Empty means the intent satisfies the policy — including the common case of a
 * policy that requires nothing, which is what the seeded scene profiles carry
 * (their `generate` rung legitimately runs with no references at all).
 *
 * Checked BEFORE any provider work, because a variant profile that requires an
 * identity reference and receives none cannot produce a variant of anybody: it
 * would render a stranger and bill for it.
 */
export function missingRequiredReferenceRoles(
  policy: ImageReferencePolicy,
  references: readonly ImageRenderReferenceSpec[],
): ImageReferenceRole[] {
  const present = new Set(references.map((reference) => reference.role));
  return policy.requiredRoles.filter((role) => !present.has(role));
}

/**
 * Why a reference the lane offered will not be sent.
 *
 * Three genuinely different operator answers, which is why this is not one
 * "dropped" bucket: `role_not_allowed` means the profile is configured for a
 * different job, `role_cap` means the profile itself asked for fewer of this
 * role, and `model_capacity` means the model has no slot left. Only the last is
 * about scarcity, and only the last changes if you pick a bigger model.
 */
export type ImageReferenceDropReason = "role_not_allowed" | "role_cap" | "model_capacity";

export interface DroppedImageReference<T extends ImageRenderReferenceSpec> {
  reference: T;
  reason: ImageReferenceDropReason;
}

/**
 * How a structural control image reaches the provider.
 *
 * `dedicated_input` is a version that declares its own field for the role — the
 * ControlNet-style shape `additionalImageInputs` records. Such an image does NOT
 * compete for the primary reference field's slots, which is the whole reason the
 * distinction is drawn here rather than left to the transport.
 *
 * `numbered_reference` is the other real answer, and today's only live one: the
 * model takes control maps as ordinary numbered images in its primary reference
 * array, with the prompt saying which slot is the skeleton. Qwen Image Edit 2511
 * works exactly this way — the Stage 0 probes confirmed it honours pose and
 * depth sent that way (docs/developer-notes/qwen-advanced-image-subsystem.plan.md)
 * — so a control on that path is scarce like any other reference and is ordered
 * with them.
 */
export type ControlReferenceTransport =
  | { kind: "dedicated_input"; field: string; arity: ImageBindingArity; maxItems: number }
  | { kind: "numbered_reference" };

/**
 * How this model takes a control image of this role.
 *
 * A version's `additionalImageInputs` is the only source: the probe records what
 * the schema declares, and nothing here guesses a field name. No seeded model
 * declares one today, so every control currently resolves to
 * `numbered_reference` — the same array Stage 0 proved 2511 obeys.
 *
 * The FIRST matching entry wins when a version declares several for one role.
 * That is a probe-side ambiguity rather than a render-time choice, and picking
 * deterministically beats refusing a render over a duplicate the operator can
 * see in the capability record.
 */
export function controlReferenceTransport(model: ImageModel, role: ImageReferenceRole): ControlReferenceTransport {
  if (!isImageControlReferenceRole(role)) return { kind: "numbered_reference" };
  const declared = model.advancedCapabilities.additionalImageInputs.find((input) => input.roleHint === role);
  if (!declared) return { kind: "numbered_reference" };
  // A binding that names the PRIMARY reference field is not a dedicated input at
  // all — it is the numbered array, described twice. Treating it as dedicated
  // would have the transport overwrite the whole reference list with the control
  // image, so the honest reading of "pose goes in `image`" is the one the probe
  // meant: it rides the numbered references.
  if (declared.binding.field === model.referenceField) return { kind: "numbered_reference" };
  // A `single` field holds one image whatever `maxItems` says; an `array` field
  // holds what it declared, and an array that declared no limit is unbounded as
  // far as anything here can tell — the profile's own `maxPerRole` is then the
  // only cap, which is the right place for a judgment call the schema did not make.
  const declaredMax = declared.binding.arity === "single" ? 1 : (declared.binding.maxItems ?? Number.POSITIVE_INFINITY);
  return { kind: "dedicated_input", field: declared.binding.field, arity: declared.binding.arity, maxItems: declaredMax };
}

/** Images bound to one dedicated provider input, in send order. */
export interface DedicatedControlInput<T extends ImageRenderReferenceSpec> {
  field: string;
  arity: ImageBindingArity;
  references: T[];
}

/**
 * Dedicated image inputs this version REQUIRES that the render has nothing to
 * put in, as `{ field, roleHint }` pairs.
 *
 * `imageUriBindingSchema.required` is not optional for exactly this reason: it
 * records whether the model refuses to run without the image. A render missing
 * one is a provider rejection that has already cost a round trip, so it is
 * refused here instead — the same argument as
 * {@link missingRequiredReferenceRoles}, one layer down, about the version's
 * demand rather than the profile's.
 *
 * A binding that resolves to `numbered_reference` is skipped: its image is not
 * going to a field of its own, so a field of its own cannot be empty. That
 * covers the primary-reference-field alias and every content role.
 *
 * Empty on every model Vesper runs today, since none declares an
 * `additionalImageInputs` entry at all.
 */
export function missingRequiredControlInputs<T extends ImageRenderReferenceSpec>(
  model: ImageModel,
  dedicated: readonly DedicatedControlInput<T>[],
): { field: string; roleHint: ImageReferenceRole }[] {
  const filled = new Set(dedicated.filter((input) => input.references.length > 0).map((input) => input.field));
  return model.advancedCapabilities.additionalImageInputs
    .filter((input) => input.binding.required && !filled.has(input.binding.field))
    .filter((input) => controlReferenceTransport(model, input.roleHint).kind === "dedicated_input")
    .map((input) => ({ field: input.binding.field, roleHint: input.roleHint }));
}

/** Every reference decision a render makes before a byte leaves the process. */
export interface PlannedImageReferences<T extends ImageRenderReferenceSpec> {
  /** The primary reference field's images, in SEND order. */
  primary: T[];
  /** Control images that have their own provider field, grouped by that field. */
  dedicated: DedicatedControlInput<T>[];
  /** Everything not sent, in CALLER order, each with the reason it was left out. */
  dropped: DroppedImageReference<T>[];
  /**
   * Whether any sent reference occupies a different SLOT than the caller's own
   * order would have given it.
   *
   * Load-bearing, not a statistic. A lane that numbers its references in the
   * prompt — `buildSceneRenderPrompt` writes "Image 2: the location" — builds
   * that text from its OWN order, before this function runs. If the slot numbers
   * move, the text and the payload disagree and the model is told the room is the
   * person.
   *
   * It is slot equality, not sort-order inversion, because REMOVAL renumbers just
   * as surely as reordering: drop or dedicate the second of three references and
   * the third arrives as image two while the prompt still calls it image three.
   * Trimming from the TAIL renumbers nothing and does not trigger it, which is
   * why the common capacity trim stays quiet.
   */
  renumbered: boolean;
}

/**
 * Choose which references this render sends, in what order, and on which fields
 * (image-model-capabilities.spec.md §"Reference policy").
 *
 * This is slice 3's priority selection and slice 9's control-role binding in one
 * function, because they are one decision: whether a control map competes for a
 * scarce primary slot depends on whether this version gave it a field of its
 * own, and answering that after selection would mean selecting against a
 * capacity that was wrong.
 *
 * The order of operations, and why each step is where it is:
 *
 * 1. **Bind control roles first.** A control with a dedicated input leaves the
 *    primary contest entirely, so capacity is computed over what actually
 *    competes.
 * 2. **Drop roles the policy does not allow.** An EMPTY `allowedRoles` is "no
 *    allowlist declared", never "nothing allowed" — the four seeded `generate`
 *    profiles carry `[]` and legitimately send nothing, and reading emptiness as
 *    a ban would refuse every reference the day a lane started sending one. A
 *    role the policy REQUIRES is implicitly allowed, so a policy that lists a
 *    required role only under `requiredRoles` cannot make itself unsatisfiable.
 * 3. **Sort.** Required before optional; within that, `roleOrder` position, then
 *    numeric priority descending, then the caller's own order. Roles absent from
 *    `roleOrder` sort after every role in it — an unranked role is not
 *    implicitly first. BOTH contests sort, by the one comparator: a dedicated
 *    field with a ceiling is scarce exactly as the primary array is, and a group
 *    that skipped step 1's contest did not thereby earn different rules.
 * 4. **Apply per-role caps, then capacity.** In that order, because a cap is a
 *    profile's own decision and capacity is the model's: reporting `role_cap`
 *    for an image the profile itself would not have sent is the more useful
 *    answer, and it does not change if the operator picks a bigger model.
 *
 * The empty-policy case must be a NO-OP, and that is what keeps this change from
 * rewriting live renders: with no allowlist, no `roleOrder`, no priorities and
 * no caps, every comparison ties and the caller's order survives to the
 * capacity slice — byte-for-byte what the positional trim did before.
 */
export function planIntentReferences<T extends ImageRenderReferenceSpec>(
  model: ImageModel,
  policy: ImageReferencePolicy,
  references: readonly T[],
): PlannedImageReferences<T> {
  const allowed = new Set<ImageReferenceRole>([...policy.allowedRoles, ...policy.requiredRoles]);
  const caps = policy.maxPerRole ?? {};
  // Every reference keeps its caller index for as long as it is being decided
  // about: the sort's last tie-break needs it, and so does the caller-order
  // guarantee on `dropped`.
  const competing: RankedReference<T>[] = [];
  const bound: BoundControlReference<T>[] = [];
  const drops: (DroppedImageReference<T> & { index: number })[] = [];

  references.forEach((reference, index) => {
    if (allowed.size > 0 && !allowed.has(reference.role)) {
      drops.push({ reference, reason: "role_not_allowed", index });
      return;
    }
    const transport = controlReferenceTransport(model, reference.role);
    if (transport.kind === "dedicated_input") {
      bound.push({ reference, index, field: transport.field, arity: transport.arity, maxItems: transport.maxItems });
      return;
    }
    competing.push({ reference, index });
  });

  const capacity = referenceCapacity(model).max;
  const perRole = new Map<ImageReferenceRole, number>();
  const primary: RankedReference<T>[] = [];

  // Sorted on a COPY: the caller's array is not ours to reorder, and `competing`
  // is derived from it by reference.
  for (const entry of [...competing].sort((left, right) => compareReferences(left, right, policy.roleOrder))) {
    const cap = caps[entry.reference.role];
    const used = perRole.get(entry.reference.role) ?? 0;
    if (cap !== undefined && used >= cap) {
      drops.push({ ...entry, reason: "role_cap" });
      continue;
    }
    if (primary.length >= capacity) {
      drops.push({ ...entry, reason: "model_capacity" });
      continue;
    }
    perRole.set(entry.reference.role, used + 1);
    primary.push(entry);
  }

  // Sorted by the SAME comparator as the primary contest, on a copy like it: a
  // dedicated field with a ceiling is scarce exactly as the primary array is, so
  // the rules deciding which references survive scarcity cannot differ between
  // the two just because this group left the primary contest early.
  const dedicated = groupDedicated(
    [...bound].sort((left, right) => compareReferences(left, right, policy.roleOrder)),
    caps,
    drops,
  );

  // Dropped in CALLER order so a diagnostic reads in the order the lane thinks
  // about its references, not the order the comparator happened to visit them.
  // Sorted ONCE, after every source of drops has contributed — the dedicated
  // grouping is the last of them.
  drops.sort((left, right) => left.index - right.index);

  return {
    primary: primary.map((entry) => entry.reference),
    dedicated,
    dropped: drops.map(({ reference, reason }) => ({ reference, reason })),
    // Slot equality: the reference the caller put at index N is the one arriving
    // as image N+1. Any mismatch — a reorder, or a removal from ahead of a kept
    // reference — means the lane's own numbering no longer describes the payload.
    renumbered: primary.some((entry, position) => entry.index !== position),
  };
}

/** One reference plus the caller position that breaks its ties. */
interface RankedReference<T extends ImageRenderReferenceSpec> {
  reference: T;
  index: number;
}

interface BoundControlReference<T extends ImageRenderReferenceSpec> extends RankedReference<T> {
  field: string;
  arity: ImageBindingArity;
  /** The field's own ceiling, from its declared arity and `maxItems`. */
  maxItems: number;
}

/**
 * Sort one pair of competing references: required, then profile role order, then
 * caller priority, then the order the caller supplied them in.
 */
function compareReferences<T extends ImageRenderReferenceSpec>(
  left: RankedReference<T>,
  right: RankedReference<T>,
  ranked: readonly ImageReferenceRole[],
): number {
  const requiredDelta = Number(right.reference.required ?? false) - Number(left.reference.required ?? false);
  if (requiredDelta !== 0) return requiredDelta;

  const rankDelta = roleRank(left.reference.role, ranked) - roleRank(right.reference.role, ranked);
  if (rankDelta !== 0) return rankDelta;

  // Descending: a higher number is a stronger claim on a slot. An unset priority
  // is not zero — it sorts after every set value, so adding a priority to one
  // reference never silently demotes the ones that never carried one. Both unset
  // is a tie, which is why this is a three-way comparison rather than an
  // arithmetic difference (`-Infinity` minus itself is NaN, and a NaN comparator
  // silently corrupts the sort).
  const priorityDelta = comparePriority(left.reference.priority, right.reference.priority);
  if (priorityDelta !== 0) return priorityDelta;

  return left.index - right.index;
}

/** Higher priority first; an unset priority sorts after every set one; both unset ties. */
function comparePriority(left: number | undefined, right: number | undefined): number {
  if (left === right) return 0;
  if (left === undefined) return 1;
  if (right === undefined) return -1;
  return right - left;
}

/** A role's position in the profile's order; unranked roles sort after every ranked one. */
function roleRank(role: ImageReferenceRole, ranked: readonly ImageReferenceRole[]): number {
  const index = ranked.indexOf(role);
  return index === -1 ? ranked.length : index;
}

/**
 * Group dedicated-input controls by their provider field, enforcing the field's
 * own arity and the profile's per-role cap.
 *
 * Takes its entries ALREADY SORTED by {@link compareReferences} — the parameter
 * name is the precondition — because this function fills a field first-come and
 * drops the overflow. "The first one wins" is only the right rule if the order
 * that reached it already ranked them: on a `single` field an optional control
 * supplied ahead of a required one of the same role would otherwise take the
 * only slot, sending the image the caller marked expendable and losing the one
 * it could not do without. A capped field must prefer what cannot be lost, which
 * is the same judgment the primary contest makes about capacity.
 *
 * A `single` field takes ONE image: a second is dropped as `role_cap` rather
 * than overwriting the first or being sent as an array the schema does not
 * declare. That is the same answer `buildRegistryModelInput` gives the primary
 * reference field, and giving a different one here would make "how many images
 * fit" depend on which field they landed on.
 *
 * `role_cap` covers both ceilings — the profile's `maxPerRole` and the field's
 * own declared limit — because they are the same answer to an operator: fewer
 * of this role will be sent than were offered, and a bigger model does not
 * change it. Only primary-array scarcity is `model_capacity`.
 */
function groupDedicated<T extends ImageRenderReferenceSpec>(
  ordered: readonly BoundControlReference<T>[],
  caps: Partial<Record<ImageReferenceRole, number>>,
  drops: (DroppedImageReference<T> & { index: number })[],
): DedicatedControlInput<T>[] {
  const groups = new Map<string, DedicatedControlInput<T>>();
  const perRole = new Map<ImageReferenceRole, number>();

  for (const entry of ordered) {
    const cap = caps[entry.reference.role];
    const used = perRole.get(entry.reference.role) ?? 0;
    const group = groups.get(entry.field) ?? { field: entry.field, arity: entry.arity, references: [] };
    if (group.references.length >= entry.maxItems || (cap !== undefined && used >= cap)) {
      drops.push({ reference: entry.reference, reason: "role_cap", index: entry.index });
      continue;
    }
    perRole.set(entry.reference.role, used + 1);
    group.references.push(entry.reference);
    groups.set(entry.field, group);
  }

  return [...groups.values()];
}
