import { z } from "zod";
import {
  attributeRegistry,
  BUST_SCALE_TO_BREAST_SIZE,
  DEFAULT_SPECIES_ID,
  diag,
  isFeatureAttributeCategory,
  isIntimateAttributeCategory,
  materializeRegistryDefaults,
  seedBodyConfigFromAttributes,
  type AttributeDefinition,
  type AttributeValue,
  type DiagnosticSink,
  type RealizedBody,
} from "@/contracts";
import { fnv1a32 } from "@/lib/hash";
import { generateChecked } from "@/server/ai";
import { FORGE_LEG_OPTIONS, type CharacterForgeContext, type CharacterSectionPatch } from "./types";
import {
  heritageForForgeContext,
  realizedBodyForForgeContext,
  speciesForgeDescriptor,
  speciesForForgeContext,
} from "./context";
import { demoCharacterAttributeSection } from "./demo";

export interface RawAttributeEntry {
  id: string;
  value: string | string[] | number | boolean;
}

/** Model-emitted plausible subset for an unset [CORE] enum attribute. */
export interface RawAttributeRange {
  id: string;
  plausible: string[];
}

export interface AttributeSection {
  attributes: RawAttributeEntry[];
  ranges: RawAttributeRange[];
}

export function characterAttributeDefinitions(context?: CharacterForgeContext): readonly AttributeDefinition[] {
  const realizedBody = context ? realizedBodyForForgeContext(context) : undefined;
  // Anatomy-specific attributes stay out of the forge vocabulary: the body-config
  // that realizes them is seeded from the answer itself (gender's
  // activatesGroups), so the model cannot be shown a body it has yet to decide.
  // The one exception is the render-visual intimate size (breasts.size): the
  // model may state the size a concept gives rather than have the fill invent
  // one, and the realized body drops the value when the region ends up off
  // (conformAttributesToBody). Additive feature groups enter only when the
  // prompt/draft resolves a feature-bearing species.
  return attributeRegistry.definitions.filter(
    (d) =>
      (d.appliesToEntityKinds ?? ["character"]).includes("character") &&
      (!isIntimateAttributeCategory(d.category) || d.renderVisual === true) &&
      (!isFeatureAttributeCategory(d.category) || (realizedBody?.isAttributeApplicable(d) ?? false)),
  );
}

/**
 * Built dynamically from the registry so the model only ever sees validated
 * vocabulary: ids are an enum of registered attribute ids. Values are still
 * grounded post-hoc with registry.parseValue (docs/authoring/README.md
 * §Guardrails).
 */
export function buildAttributeSectionSchema(context?: CharacterForgeContext): z.ZodType<AttributeSection> {
  const ids = characterAttributeDefinitions(context).map((d) => d.id as string);
  // The registry is never empty in practice; the string fallback keeps an
  // empty registry from producing an invalid z.enum([]).
  const idSchema = ids.length > 0 ? z.enum(ids as [string, ...string[]]) : z.string().min(1);
  return z.object({
    attributes: z
      .array(
        z.object({
          id: idSchema,
          value: z.union([z.string(), z.array(z.string()), z.number(), z.boolean()]),
        }),
      )
      .default([]),
    ranges: z
      .array(
        z.object({
          id: idSchema,
          plausible: z
            .array(z.string())
            .describe("Plausible subset of the attribute's allowed values, conditioned on the identity anchors."),
        }),
      )
      .default([])
      .describe("For [CORE]/[RENDER] enum attributes you could not pin to a definite value: a plausible subset of allowed values."),
  });
}

function normalizeEnumToken(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

/**
 * Ground raw model output against the registry: invalid or unknown values are
 * dropped with a diagnostic, never saved. Survivors carry source "creation".
 * When a `realizedBody` is supplied, a definite enum value outside the resolved
 * species' narrowed set is also dropped (e.g. "rounded" ears on an elf) — the
 * gap is then refilled from the narrowed vocabulary by the species/core-visual
 * default passes, so the species invariant holds even if the model disobeys.
 */
export function groundAttributeValues(
  entries: readonly RawAttributeEntry[],
  sink?: DiagnosticSink,
  code = "forge.character.attributes",
  realizedBody?: RealizedBody,
): AttributeValue[] {
  const grounded: AttributeValue[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.id)) {
      sink?.push(diag("info", `${code}.duplicate_id`, `dropped duplicate attribute "${entry.id}"`));
      continue;
    }
    let parsed = attributeRegistry.parseValue(entry.id, entry.value);
    if (!parsed.ok && typeof entry.value === "string") {
      // Salvage common model slips: "Dark Brown" → "dark_brown".
      parsed = attributeRegistry.parseValue(entry.id, normalizeEnumToken(entry.value));
    }
    if (!parsed.ok && Array.isArray(entry.value)) {
      parsed = attributeRegistry.parseValue(entry.id, entry.value.map(normalizeEnumToken));
    }
    if (!parsed.ok) {
      sink?.push(
        diag("warn", `${code}.invalid_value`, `dropped attribute "${entry.id}": ${parsed.issues.join("; ")}`, {
          context: { id: entry.id, value: entry.value },
        }),
      );
      continue;
    }
    const def = attributeRegistry.byId(entry.id);
    if (realizedBody && def?.valueType === "enum" && typeof parsed.value === "string") {
      const allowed = realizedBody.allowedValuesFor(def);
      if (allowed && !allowed.includes(parsed.value)) {
        sink?.push(
          diag("warn", `${code}.species_disallowed_value`, `dropped "${entry.id}=${parsed.value}": not allowed for the resolved species`, {
            context: { id: entry.id, value: parsed.value },
          }),
        );
        continue;
      }
    }
    seen.add(entry.id);
    // parseValue success implies a registered id, which satisfies the pattern.
    grounded.push({ id: entry.id as AttributeValue["id"], value: parsed.value, source: "creation" });
  }
  return grounded;
}

/**
 * Ground model-emitted plausible ranges against the registry: a range on an
 * unknown id or a non-enum attribute drops whole, out-of-vocabulary members
 * drop individually (both `forge.character.attributes.invalid_range_member`),
 * and a range emptied by grounding drops entirely — fillVisualDefaults
 * then treats that attribute as unconstrained. Survivors map id → subset of
 * the attribute's allowedValues.
 */
export function groundAttributeRanges(
  ranges: readonly RawAttributeRange[],
  sink?: DiagnosticSink,
  code = "forge.character.attributes",
): Map<string, string[]> {
  const grounded = new Map<string, string[]>();
  for (const range of ranges) {
    if (grounded.has(range.id)) {
      sink?.push(diag("info", `${code}.duplicate_id`, `dropped duplicate range for "${range.id}"`));
      continue;
    }
    const def = attributeRegistry.byId(range.id);
    if (!def || def.valueType !== "enum" || !def.allowedValues || def.allowedValues.length === 0) {
      sink?.push(
        diag("warn", `${code}.invalid_range_member`, `dropped range for "${range.id}": not a registered enum attribute`, {
          context: { id: range.id, plausible: range.plausible },
        }),
      );
      continue;
    }
    const members: string[] = [];
    for (const raw of range.plausible) {
      const member = normalizeEnumToken(raw);
      if (!def.allowedValues.includes(member)) {
        sink?.push(
          diag("warn", `${code}.invalid_range_member`, `dropped out-of-vocabulary range member "${raw}" on "${range.id}"`, {
            context: { id: range.id, member: raw },
          }),
        );
        continue;
      }
      if (!members.includes(member)) members.push(member);
    }
    // A range emptied by grounding drops entirely — better unconstrained than
    // constrained to nothing (the member drops above already told the dev).
    if (members.length === 0) continue;
    grounded.set(range.id, members);
  }
  return grounded;
}

const ATTRIBUTES_SYSTEM = [
  "You translate a character concept into a fixed attribute vocabulary. Use only the listed attribute ids and allowed values.",
  "First infer the identity anchors (marked [ANCHOR]) — heritage, apparent age, gender — from any cue the text offers, and emit the ones it supports as attributes.",
  "Where the text states or strongly implies a value for any attribute, emit it as a definite attribute value.",
  "For each [CORE] or [RENDER] enum attribute you cannot pin to a definite value, emit a ranges entry instead: a plausible subset of its allowed values, conditioned on the identity anchors you inferred.",
  "Guardrails: identity anchors may constrain physical attributes only — coloring, features, build. Heritage must never feed personality, voice, behavior, or role suggestions. Ranges are soft priors that explicit text always overrides — when the text pins a value, emit the definite value and no range for that attribute. When the identity signal is weak, emit wide ranges or none.",
  "Attributes describe THIS PERSON'S body, not the setting's mood: never map scene or life-circumstance adjectives (a weathered town, a hard year, a gloomy harbor) onto skin, hair, or build unless the text says it of the body itself.",
  'Worked example — text overrides the prior: "a Latina engineer with dyed silver hair" gives identity.heritage = "Latina" and hair.color = "gray" as definite values (the dye job in the text beats the heritage prior — no hair.color range), while eyes.color, unstated, gets a range like ["brown", "dark_brown", "hazel"].',
  "For everything else, omit any attribute the concept gives no basis for — sparse is correct.",
].join("\n");

export function describeConstraint(def: AttributeDefinition, allowedValues?: readonly string[]): string {
  const allowed = allowedValues ?? def.allowedValues ?? [];
  // Choices carry their narrator gloss when authored — the same authored string the
  // read-side prompts render — so the forge picks the member that MEANS what it wants.
  const choice = (v: string): string => (def.narratorGuidance?.[v] ? `${v} (${def.narratorGuidance[v]})` : v);
  switch (def.valueType) {
    case "enum":
      return `one of: ${allowed.map(choice).join(" | ")}`;
    case "enum_list":
      return `list from: ${allowed.map(choice).join(" | ")}`;
    case "number": {
      const range = def.min !== undefined || def.max !== undefined ? ` ${def.min ?? ""}-${def.max ?? ""}` : "";
      return `number${range}${def.unit ? ` ${def.unit}` : ""}`;
    }
    case "text":
      return "short free text";
    case "flag":
      return "true or false";
  }
}

function attributesPrompt(context: CharacterForgeContext): string {
  const realizedBody = realizedBodyForForgeContext(context);
  let hasSpeciesTrait = false;
  const definitions = characterAttributeDefinitions(context);
  const vocabulary = definitions
    .map((def) => {
      const allowed = realizedBody.allowedValuesFor(def);
      const required = realizedBody.isAttributeRequired(def);
      if (required) hasSpeciesTrait = true;
      const speciesDefault = realizedBody.defaultValueFor(def);
      const defaultHint =
        required && typeof speciesDefault === "string" ? ` (species default: ${speciesDefault})` : "";
      const tags = `${def.coreVisual ? " [CORE]" : ""}${def.renderVisual ? " [RENDER]" : ""}${def.identityAnchor ? " [ANCHOR]" : ""}${required ? " [SPECIES]" : ""}`;
      return `- ${def.id}${tags} (${describeConstraint(def, allowed)})${defaultHint}: ${def.description}`;
    })
    .join("\n");
  const lines = [
    "Character concept:",
    context.prompt,
  ];
  const species = speciesForForgeContext(context);
  if (species && species.id !== DEFAULT_SPECIES_ID) {
    const { label, look } = speciesForgeDescriptor(species, heritageForForgeContext(context));
    lines.push(
      "",
      `Resolved structural species: ${label}.${look} Include its visible feature morphology when the vocabulary lists it; choose attribute values consistent with this generic look unless the concept says otherwise.`,
    );
  }
  if (hasSpeciesTrait) {
    lines.push(
      "",
      "Attributes marked [SPECIES] are inherent to the resolved species — emit a value within the (narrowed) allowed set shown; if unsure, the species default is used.",
    );
  }
  const bio = context.draft?.profile.bio;
  if (bio) lines.push("", "Drafted bio:", bio);
  lines.push(
    "",
    "Attribute vocabulary:",
    vocabulary,
    "",
    "Infer the [ANCHOR] attributes first. Emit definite values where the concept supports them; for each [CORE] or [RENDER] enum attribute left without a definite value, emit a ranges entry with the plausible subset of its allowed values given the anchors. Fill the others only where the concept supports them; omit the rest.",
  );
  // The admitted anatomy-gated ids, named plainly: the contract says
  // breasts.size; any model-specific wording belongs to an adapter.
  const anatomyIds = definitions.filter((def) => isIntimateAttributeCategory(def.category)).map((def) => def.id);
  if (anatomyIds.length > 0) {
    lines.push(
      "",
      `Attributes of configurable anatomy (${anatomyIds.join(", ")}) apply only to a body that carries that anatomy: emit a definite value where the concept states one, a range where the anchors suggest one, and omit it for a body without the anatomy.`,
    );
  }
  return lines.join("\n");
}

export async function forgeAttributesSection(context: CharacterForgeContext): Promise<CharacterSectionPatch> {
  const { value } = await generateChecked({
    ...FORGE_LEG_OPTIONS,
    schema: buildAttributeSectionSchema(context),
    system: ATTRIBUTES_SYSTEM,
    prompt: attributesPrompt(context),
    code: "forge.character.attributes",
    sink: context.sink,
    fallback: context.useFallbacks === false ? undefined : demoCharacterAttributeSection,
  });
  const section = value ?? { attributes: [], ranges: [] };
  const realizedBody = realizedBodyForForgeContext(context);
  const grounded = groundAttributeValues(section.attributes, context.sink, undefined, realizedBody);
  const ranges = groundAttributeRanges(section.ranges, context.sink);
  // Species-required defaults first (e.g. elf ears.shape = "pointed") so the
  // core-visual pass treats them as already present, then the core-visual fill.
  const seeded = fillSpeciesRequiredDefaults(grounded, realizedBody, context.sink);
  // The fills run against the body the draft WILL carry: its body-config is
  // seeded from the values so far (gender's activatesGroups — a SEED, overridable
  // in the editor), so an anatomy-gated visual fills for the right owner (a body
  // with breasts gets breasts.size, one without gets chest.size; never both).
  // Each pass first conforms the values to that body — a size the body does not
  // apply is translated to its successor or dropped BEFORE the fill can seed
  // the competing owner beside it — so the draft never stores both sizes.
  const bodyFor = (values: readonly AttributeValue[]) =>
    realizedBodyForForgeContext(context, seedBodyConfigFromAttributes(values).intimateRegions);
  const conformAndFill = (values: readonly AttributeValue[]) => {
    const body = bodyFor(values);
    const conformed = conformAttributesToBody(values, body, context.sink);
    return { body, values: fillVisualDefaults(conformed, context.prompt, context.sink, ranges, body) };
  };
  const first = conformAndFill(seeded);
  // gender is itself a core visual: when the model omitted it, the fill above
  // invented one and thereby moved the seeded body-config. Realize once more
  // against the final config, conform to it, and fill whatever that body still
  // lacks (a no-op when the config didn't move — present ids are never refilled).
  const { body: forgedBody, values: filled } = conformAndFill(first.values);
  // Persisted-baseline facts (materializeDefault) ground here too, so a forged
  // draft shows them in the editor rather than acquiring them silently on save.
  // Fill-only — anything the model inferred (a prompt that mentioned her feet)
  // wins; the fixed default is the point for these, unlike the concept-varied
  // core-visual fills above.
  const attributes = materializeRegistryDefaults(filled, {
    isApplicable: (def) => forgedBody.isAttributeApplicable(def),
    allowedValuesFor: (def) => forgedBody.allowedValuesFor(def),
    ruleDefaultFor: (def) => forgedBody.defaultValueFor(def),
  });
  // The stored body-config is the same seed the fills realized against. Intimate
  // attribute values beyond the render-consistency fill stay empty; the human
  // authors them.
  const { intimateRegions } = seedBodyConfigFromAttributes(attributes);
  return { profile: { attributes, intimateRegions } };
}

/**
 * Seed species-required attribute defaults the model left unset. Unlike
 * fillVisualDefaults this is NOT limited to visual-flagged attributes: a
 * species `required` rule with a `defaultValue` (elf `ears.shape` = "pointed")
 * guarantees the trait is present on every member of that species. A value the
 * model already emitted for the id wins — present ids are never overwritten;
 * the species default only fills the gap. The default is validated against the
 * registry so a bad data edit surfaces as a diagnostic, not a stored bad value.
 */
export function fillSpeciesRequiredDefaults(
  values: readonly AttributeValue[],
  realizedBody: RealizedBody | undefined,
  sink?: DiagnosticSink,
): AttributeValue[] {
  const filled = [...values];
  if (!realizedBody) return filled;
  const present = new Set(values.map((v) => v.id));
  const added: string[] = [];
  for (const def of attributeRegistry.definitions) {
    if (present.has(def.id) || !realizedBody.isAttributeApplicable(def)) continue;
    if (!realizedBody.isAttributeRequired(def)) continue;
    const raw = realizedBody.defaultValueFor(def);
    if (raw === undefined) continue;
    const parsed = attributeRegistry.parseValue(def.id, raw);
    if (!parsed.ok) {
      sink?.push(
        diag("warn", "forge.character.attributes.species_default_invalid", `species default for "${def.id}" rejected: ${parsed.issues.join("; ")}`, {
          context: { id: def.id, value: raw },
        }),
      );
      continue;
    }
    filled.push({ id: def.id as AttributeValue["id"], value: parsed.value, source: "creation" });
    added.push(`${def.id}=${String(parsed.value)}`);
  }
  if (added.length > 0) {
    sink?.push(
      diag("info", "forge.character.attributes.species_defaults", `seeded species-required defaults: ${added.join(", ")}`),
    );
  }
  return filled;
}

/**
 * Tier-3 fill (docs/authoring/character-forge.md §The three-tier fill): every
 * registry attribute flagged coreVisual OR renderVisual (the render-consistency tier: silhouette
 * + face structure a scene render would
 * otherwise re-invent per image) that the model left unset gets a default
 * picked from its surviving plausible range when one exists — falling through
 * to the full allowedValues when none does — seeded by (concept, attribute
 * id). Seeded rather than random on purpose — different concepts get varied
 * defaults (an LLM asked to "pick randomly" converges on brown/brown), while
 * the same input still forges the same draft (demo-mode determinism,
 * docs/resilience.md §6). A definite value always beats a range for the same
 * id — present ids are never filled. Enum-only: a default we can't pick from
 * a closed list isn't a default worth inventing.
 *
 * With a realized body the candidate set is every registry attribute that body
 * says applies — so an anatomy-gated flagged attribute (breasts.size on a body
 * with breasts; chest.size on one without) fills for exactly the owner the
 * body realizes, and a superseded one is never seeded. Without a body it is the
 * everyday forge vocabulary minus intimate anatomy: no body means no region to
 * gate a breast size on, so none is ever invented.
 */
export function fillVisualDefaults(
  values: readonly AttributeValue[],
  seedText: string,
  sink?: DiagnosticSink,
  ranges?: ReadonlyMap<string, readonly string[]>,
  realizedBody?: RealizedBody,
): AttributeValue[] {
  const present = new Set(values.map((v) => v.id));
  const filled = [...values];
  const added: string[] = [];
  const unconstrained: string[] = [];
  const candidates = realizedBody
    ? attributeRegistry.definitions.filter((def) => realizedBody.isAttributeApplicable(def))
    : characterAttributeDefinitions().filter((def) => !isIntimateAttributeCategory(def.category));
  for (const def of candidates) {
    if ((!def.coreVisual && !def.renderVisual) || present.has(def.id)) continue;
    if (def.valueType !== "enum" || !def.allowedValues || def.allowedValues.length === 0) continue;
    // Pick within the resolved species' narrowed set when one applies, so a
    // core-visual default (e.g. orc build.height) can't fall outside the
    // species' band. Falls back to the definition's own values.
    const baseAllowed = realizedBody?.allowedValuesFor(def) ?? def.allowedValues;
    if (baseAllowed.length === 0) continue;
    // A model range is a soft prior over the definition; intersect it with the
    // species band so an off-species range member can't be picked.
    const rawRange = ranges?.get(def.id);
    const range = rawRange ? rawRange.filter((v) => baseAllowed.includes(v)) : undefined;
    const constrained = range !== undefined && range.length > 0;
    let pool: readonly string[] = constrained ? range : baseAllowed;
    if (!constrained) {
      unconstrained.push(def.id);
      // No signal at all: pick from the (species-narrowed) vocabulary minus
      // members the registry marks as never-auto-default (e.g. minor apparent
      // ages). A human or the model can still set those explicitly; we just
      // never seed one. Fall back to the full pool if exclusion would empty it.
      const excl = def.autoDefaultExcludes;
      if (excl && excl.length > 0) {
        const filtered = baseAllowed.filter((v) => !excl.includes(v));
        if (filtered.length > 0) pool = filtered;
      }
    }
    const pick = pool[fnv1a32(`${seedText}::${def.id}`) % pool.length];
    if (!pick) continue;
    filled.push({ id: def.id, value: pick, source: "creation" });
    added.push(`${def.id}=${pick}`);
  }
  if (added.length > 0) {
    sink?.push(
      diag("info", "forge.character.attributes.visual_defaults", `filled visual defaults: ${added.join(", ")}`),
    );
  }
  if (unconstrained.length > 0) {
    sink?.push(
      diag(
        "info",
        "forge.character.attributes.unconstrained_default",
        `no plausible range for ${unconstrained.join(", ")}: picked from the full vocabulary`,
        { context: { ids: unconstrained } },
      ),
    );
  }
  return filled;
}

/**
 * Conform grounded values to the body the draft will carry: a value whose
 * definition that body does not apply is never stored (the fills are fill-only
 * and would otherwise leave it beside the owner they seed). Scoped to what the
 * realized body says CANNOT apply — a model-emitted value and a fill are
 * indistinguishable here (both carry source "creation"), so nothing the body
 * applies is ever second-guessed. The one translation is the anatomy-split
 * size pair: a `chest.size` the breasts region supersedes becomes
 * `breasts.size` through the contract's bust-scale table when it is the only
 * size given, so the one size signal survives as its successor instead of
 * yielding to a hash pick (`forge.character.attributes.size_translated`);
 * with `breasts.size` already present it drops (breasts.size wins), as does a
 * structural chest build with no breast-size reading. Every other inapplicable
 * value drops with `forge.character.attributes.inapplicable_for_body`.
 */
export function conformAttributesToBody(
  values: readonly AttributeValue[],
  body: RealizedBody,
  sink?: DiagnosticSink,
): AttributeValue[] {
  const present = new Set(values.map((v) => v.id));
  const kept: AttributeValue[] = [];
  const dropped: string[] = [];
  for (const value of values) {
    const def = attributeRegistry.byId(value.id);
    // An unregistered id is not ours to judge — never drop what we don't understand.
    if (!def || body.isAttributeApplicable(def)) {
      kept.push(value);
      continue;
    }
    if (value.id === "chest.size" && !present.has("breasts.size") && typeof value.value === "string") {
      const successor = attributeRegistry.byId("breasts.size");
      const translated = BUST_SCALE_TO_BREAST_SIZE[value.value];
      if (successor && translated !== undefined && (body.allowedValuesFor(successor)?.includes(translated) ?? false)) {
        present.add("breasts.size");
        kept.push({ ...value, id: "breasts.size", value: translated });
        sink?.push(
          diag(
            "info",
            "forge.character.attributes.size_translated",
            `translated chest.size=${value.value} to breasts.size=${translated}: the body carries the breasts region`,
          ),
        );
        continue;
      }
    }
    dropped.push(`${value.id}=${String(value.value)}`);
  }
  if (dropped.length > 0) {
    sink?.push(
      diag("info", "forge.character.attributes.inapplicable_for_body", `dropped ${dropped.join(", ")}: not applicable to the realized body`, {
        context: { ids: dropped },
      }),
    );
  }
  return kept;
}
