"use client";

import { Fragment, useMemo, useState } from "react";
import {
  attributeGroups,
  FEATURE_GROUPS,
  INTIMATE_REGION_GROUPS,
  isPersonalityAttributeCategory,
  realizeBody,
  type AttributeDefinition,
  type AttributeValue,
  type RealizedBody,
} from "@/contracts";
import { cx } from "@/components/ui/cx";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { AiTag, Tag } from "@/components/ui/tag";
import {
  allowedOptionsFor,
  asList,
  attributeValueMap,
  isAiSourced,
  isOutOfRuleValue,
  removeAttribute,
  seedValueFor,
  setAttribute,
  sliderBounds,
} from "./attribute-helpers";

export interface AttributePickerProps {
  values: readonly AttributeValue[];
  onChange: (values: AttributeValue[]) => void;
  /**
   * Which slice of the attribute vocabulary to render: `"body"` (physical
   * attributes plus the body-config/features overrides) or `"personality"`
   * (voice / presentation / movement). Defaults to `"body"`.
   */
  scope?: "body" | "personality";
  /** Per-character body-config — which intimate region groups are present. */
  intimateRegions?: readonly string[];
  /** When provided, the body-config toggle UI is shown and intimate groups unlock. */
  onChangeIntimateRegions?: (regions: string[]) => void;
  /** Per-character additive feature config; undefined means species defaults. */
  bodyFeatures?: readonly string[];
  /** When provided, body feature toggle UI is shown. */
  onChangeBodyFeatures?: (features: string[]) => void;
  speciesId?: string;
  heritageId?: string;
  bodyPlanId?: string;
}

/**
 * Explicit intimate attribute categories that render *nested inside* an
 * anatomical area rather than as their own top-level section, so they read as
 * part of the body region they belong to instead of floating loose at the top:
 *
 *  - `breasts` nests inside the everyday **Chest** section.
 *  - `vulva` / `penis` / `testicles` nest inside a synthetic **Pelvis** area
 *    (there is no everyday `pelvis` attribute group to host them).
 *
 * The **anus** is universal anatomy with no descriptive attributes, surfaced in
 * the Pelvis area as a present-region note (it is not a body-config toggle).
 */
const NESTED_UNDER_CHEST = ["breasts"] as const;
const PELVIS_CATEGORIES = ["vulva", "penis", "testicles"] as const;
const NESTED_CATEGORIES = new Set<string>([...NESTED_UNDER_CHEST, ...PELVIS_CATEGORIES]);

/**
 * Registry-driven attribute editor (docs/authoring.md): one section per
 * attribute group from @/contracts, controls keyed off valueType. Sections are
 * a **single-open accordion** — everything starts collapsed, expanding one
 * collapses the rest — and an open section shows EVERY applicable attribute as
 * a row (face-jewelry plan §accordion): set values are editable, unset ones
 * render blank controls that materialize on first interaction, so storage
 * stays sparse without an "add attribute" select. Attributes are filtered
 * through the realized body (species/realize.ts): intimate groups appear only
 * when the body-config switches their region on, and the explicit anatomy
 * nests under its anatomical area (Chest / Pelvis) rather than at the top.
 */
export function AttributePicker({
  values,
  onChange,
  scope = "body",
  intimateRegions = [],
  onChangeIntimateRegions,
  bodyFeatures,
  onChangeBodyFeatures,
  speciesId,
  heritageId,
  bodyPlanId,
}: AttributePickerProps) {
  const byId = useMemo(() => attributeValueMap(values), [values]);
  const body = useMemo(
    () => realizeBody({ speciesId, heritageId, bodyPlanId, intimateRegions, bodyFeatures }),
    [speciesId, heritageId, bodyPlanId, intimateRegions, bodyFeatures],
  );
  const effectiveBodyFeatures = bodyFeatures ?? [...body.bodyFeatures];

  // Single-open accordion: at most one section id expanded; opening another
  // collapses the current one, clicking the open header collapses it.
  const [openSection, setOpenSection] = useState<string | null>(null);
  const sectionToggle = (id: string) => () => setOpenSection((current) => (current === id ? null : id));

  // `identity.natal_sex` is a scaffold surfaced only for an androgynous / nonbinary
  // presentation, where the gender label doesn't already imply sex at birth; for a
  // plain female / male gender it's redundant, so it's hidden (docs/contracts/attributes.md
  // §Natal sex, deferred.plan.md). A definition is shown when the realized body says it's
  // applicable AND it clears this conditional gate.
  const genderValue = byId.get("identity.gender")?.value;
  const natalSexRelevant = typeof genderValue === "string" && /^(androgynous|nonbinary)_born_/.test(genderValue);
  const isVisible = (def: AttributeDefinition): boolean =>
    body.isAttributeApplicable(def) && (def.id !== "identity.natal_sex" || natalSexRelevant);

  const onSet = (id: string, value: AttributeValue["value"]) =>
    onChange(setAttribute(values, id as AttributeValue["id"], value));
  const onRemove = (id: string) => onChange(removeAttribute(values, id));
  // The realized `body` is threaded down so each control can resolve, per THIS
  // character, the species/heritage rule note (`attributeRuleFor`), the narrowed
  // option set (`allowedValuesFor` — hard-restricts enums to species-allowed values),
  // and the seeded rule default (`defaultValueFor`). realizeBody already composed
  // species + heritage (heritage overrides win).

  // Applicable (present-on-this-body) definitions for a category, by id.
  const definitionsFor = (category: string): AttributeDefinition[] => {
    const group = attributeGroups.find((g) => g.category === category);
    return group ? group.definitions.filter((d) => isVisible(d)) : [];
  };
  const nestedGroupsFor = (categories: readonly string[]): NestedGroup[] =>
    categories
      .map((category) => ({ category, definitions: definitionsFor(category) }))
      .filter((g) => g.definitions.length > 0);

  return (
    <div className="flex flex-col gap-3">
      {attributeGroups.map((group) => {
        // Each tab owns a disjoint slice of the vocabulary (PERSONALITY_ATTRIBUTE_CATEGORIES).
        if (isPersonalityAttributeCategory(group.category) !== (scope === "personality")) return null;
        if (NESTED_CATEGORIES.has(group.category)) return null; // rendered nested below
        const definitions = group.definitions.filter((d) => isVisible(d));
        const nested = group.category === "chest" ? nestedGroupsFor(NESTED_UNDER_CHEST) : [];
        if (definitions.length === 0 && nested.length === 0) return null; // gated off
        return (
          <Fragment key={group.category}>
            <AttributeGroupSection
              category={group.category}
              definitions={definitions}
              nested={nested}
              byId={byId}
              onSet={onSet}
              onRemove={onRemove}
              body={body}
              open={openSection === group.category}
              onToggle={sectionToggle(group.category)}
            />
            {/* The Pelvis area sits next to its anatomical neighbour, Hips. */}
            {group.category === "hips" ? (
              <PelvisArea
                members={nestedGroupsFor(PELVIS_CATEGORIES)}
                anusPresent={body.isLocationPresent("anus")}
                byId={byId}
                onSet={onSet}
                onRemove={onRemove}
                body={body}
                open={openSection === "pelvis-area"}
                onToggle={sectionToggle("pelvis-area")}
              />
            ) : null}
          </Fragment>
        );
      })}
      {/* Overrides sit at the bottom of the body form: they reshape what anatomy
          exists rather than describe it, so they're kept out of the normal flow. */}
      {scope === "body" && onChangeIntimateRegions ? (
        <BodyConfigSection
          intimateRegions={intimateRegions}
          onChange={onChangeIntimateRegions}
          open={openSection === "body-config"}
          onToggle={sectionToggle("body-config")}
        />
      ) : null}
      {scope === "body" && onChangeBodyFeatures ? (
        <BodyFeaturesSection
          bodyFeatures={effectiveBodyFeatures}
          onChange={onChangeBodyFeatures}
          open={openSection === "body-features"}
          onToggle={sectionToggle("body-features")}
        />
      ) : null}
    </div>
  );
}

function BodyFeaturesSection({
  bodyFeatures,
  onChange,
  open,
  onToggle,
}: {
  bodyFeatures: readonly string[];
  onChange: (features: string[]) => void;
  open: boolean;
  onToggle: () => void;
}) {
  const present = new Set(bodyFeatures);
  const toggle = (group: string) => {
    const next = new Set(present);
    if (next.has(group)) next.delete(group);
    else next.add(group);
    onChange([...next]);
  };

  return (
    <section className="rounded-card border border-ink-600 bg-ink-800">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full cursor-pointer items-center justify-between px-4 py-2.5 text-left"
      >
        <span className="text-sm font-medium text-paper-100">Body features</span>
        <span className="text-xs text-paper-500">
          {present.size > 0 ? `${present.size} feature${present.size === 1 ? "" : "s"}` : "—"}
          <span className={cx("ml-2 inline-block transition-transform", open && "rotate-90")}>›</span>
        </span>
      </button>
      {open ? (
        <div className="flex flex-col gap-2 border-t border-ink-600 px-4 py-3">
          <p className="text-xs text-paper-500">
            Visible non-human morphology. Species can seed this, but each character can override it.
          </p>
          <div className="flex flex-wrap gap-1.5">
            {FEATURE_GROUPS.map((group) => {
              const active = present.has(group);
              return (
                <button
                  key={group}
                  type="button"
                  aria-pressed={active}
                  onClick={() => toggle(group)}
                  className={cx(
                    "touch-target inline-flex cursor-pointer items-center justify-center rounded-full border px-2.5 py-0.5 text-[11px] capitalize transition-colors",
                    active
                      ? "border-accent-500/60 bg-accent-500/10 text-accent-300"
                      : "border-ink-500 text-paper-400 hover:text-paper-200",
                  )}
                >
                  {group}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </section>
  );
}

/**
 * Body-config editor: which intimate region groups this character has. Defaulted
 * from gender at forge time (Decision 1), fully overridable here. Toggling a
 * region off also clears any attribute values it gated (handled by realize at
 * read time; stored values for an absent region are simply ignored).
 */
function BodyConfigSection({
  intimateRegions,
  onChange,
  open,
  onToggle,
}: {
  intimateRegions: readonly string[];
  onChange: (regions: string[]) => void;
  open: boolean;
  onToggle: () => void;
}) {
  const present = new Set(intimateRegions);
  const toggle = (group: string) => {
    const next = new Set(present);
    if (next.has(group)) next.delete(group);
    else next.add(group);
    onChange([...next]);
  };

  return (
    <section className="rounded-card border border-ink-600 bg-ink-800">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full cursor-pointer items-center justify-between px-4 py-2.5 text-left"
      >
        <span className="text-sm font-medium text-paper-100">Body configuration</span>
        <span className="text-xs text-paper-500">
          {present.size > 0 ? `${present.size} region${present.size === 1 ? "" : "s"}` : "—"}
          <span className={cx("ml-2 inline-block transition-transform", open && "rotate-90")}>›</span>
        </span>
      </button>
      {open ? (
        <div className="flex flex-col gap-2 border-t border-ink-600 px-4 py-3">
          <p className="text-xs text-paper-500">
            Which intimate anatomy this character has. Unlocks the matching attribute groups below.
          </p>
          <div className="flex flex-wrap gap-1.5">
            {INTIMATE_REGION_GROUPS.map((group) => {
              const active = present.has(group);
              return (
                <button
                  key={group}
                  type="button"
                  aria-pressed={active}
                  onClick={() => toggle(group)}
                  className={cx(
                    "touch-target inline-flex cursor-pointer items-center justify-center rounded-full border px-2.5 py-0.5 text-[11px] capitalize transition-colors",
                    active
                      ? "border-accent-500/60 bg-accent-500/10 text-accent-300"
                      : "border-ink-500 text-paper-400 hover:text-paper-200",
                  )}
                >
                  {group}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </section>
  );
}

interface GroupProps {
  category: string;
  definitions: readonly AttributeDefinition[];
  byId: Map<string, AttributeValue>;
  onSet: (id: string, value: AttributeValue["value"]) => void;
  onRemove: (id: string) => void;
  /** Realized body for THIS character — source of rule note, narrowed options, defaults. */
  body: RealizedBody;
}

/** A category rendered nested inside an anatomical area (e.g. breasts → chest). */
interface NestedGroup {
  category: string;
  definitions: readonly AttributeDefinition[];
}

const setCountOf = (definitions: readonly AttributeDefinition[], byId: Map<string, AttributeValue>): number =>
  definitions.filter((d) => byId.has(d.id)).length;

/** Set values of a section as short human words, in registry order. */
function setValueWords(definitions: readonly AttributeDefinition[], byId: Map<string, AttributeValue>): string[] {
  const words: string[] = [];
  for (const def of definitions) {
    const held = byId.get(def.id);
    if (held === undefined) continue;
    const v = held.value;
    if (typeof v === "string") words.push(v.replace(/_/g, " "));
    else if (typeof v === "number") words.push(def.unit ? `${v} ${def.unit}` : String(v));
    else if (typeof v === "boolean") words.push(v ? def.label.toLowerCase() : `no ${def.label.toLowerCase()}`);
    else if (v.length > 0) words.push(v.map((x) => x.replace(/_/g, " ")).join(" · "));
  }
  return words;
}

/** Preview length past which the header falls back to "N set". */
const SECTION_PREVIEW_MAX = 64;

/**
 * Collapsed-header summary (ux-improvements slice 7): the section's set values
 * as a scannable phrase — "auburn, shoulder-length, wavy" — falling back to
 * "N set" when it gets long, with a distinct italic "empty" when nothing is
 * authored. What makes a fully-authored section distinguishable at a glance
 * (and Forge-the-rest / From-portrait output reviewable without expanding).
 */
function SectionCount({ count, open, preview }: { count: number; open: boolean; preview?: string }) {
  const label =
    count === 0 ? undefined : preview && preview.length <= SECTION_PREVIEW_MAX ? preview : `${count} set`;
  return (
    <span className="flex min-w-0 items-center text-xs text-paper-500">
      {label !== undefined ? (
        <span className="max-w-44 truncate sm:max-w-80" title={preview}>
          {label}
        </span>
      ) : (
        <span className="text-paper-600 italic">empty</span>
      )}
      <span className={cx("ml-2 inline-block shrink-0 transition-transform", open && "rotate-90")}>›</span>
    </span>
  );
}

/**
 * The attribute controls for one category — EVERY applicable definition as a
 * row, in registry order (face-jewelry plan §accordion). Set attributes edit
 * in place; unset ones render blank controls that write a value on first
 * interaction, so the stored list stays sparse without an "add" select. No
 * card chrome of its own, so it can head a top-level section *or* sit nested
 * inside an anatomical area.
 */
function CategoryFields({ definitions, byId, onSet, onRemove, body }: GroupProps) {
  if (definitions.length === 0) {
    return <p className="text-xs text-paper-500">No attributes in this group.</p>;
  }
  return (
    <>
      {definitions.map((def) => (
        <AttributeRow
          key={def.id}
          def={def}
          value={byId.get(def.id)}
          note={body.attributeRuleFor(def.id)?.notes}
          allowed={allowedOptionsFor(def, body)}
          seed={seedValueFor(def, body)}
          onSet={(v) => onSet(def.id, v)}
          onRemove={() => onRemove(def.id)}
        />
      ))}
    </>
  );
}

/** A nested anatomical sub-group (e.g. Breasts under Chest) — indented, no card. */
function NestedCategory({ category, definitions, byId, onSet, onRemove, body }: GroupProps) {
  return (
    <div className="flex flex-col gap-3 border-l border-ink-600 pl-3">
      <p className="text-xs font-semibold text-paper-300 capitalize">{category}</p>
      <CategoryFields
        category={category}
        definitions={definitions}
        byId={byId}
        onSet={onSet}
        onRemove={onRemove}
        body={body}
      />
    </div>
  );
}

function AttributeGroupSection({
  category,
  definitions,
  nested = [],
  byId,
  onSet,
  onRemove,
  body,
  open,
  onToggle,
}: GroupProps & { nested?: readonly NestedGroup[]; open: boolean; onToggle: () => void }) {
  const nestedSet = nested.reduce((n, g) => n + setCountOf(g.definitions, byId), 0);
  const totalSet = setCountOf(definitions, byId) + nestedSet;
  const preview = [
    ...setValueWords(definitions, byId),
    ...nested.flatMap((g) => setValueWords(g.definitions, byId)),
  ].join(", ");

  return (
    <section className="rounded-card border border-ink-600 bg-ink-800">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full cursor-pointer items-center justify-between gap-3 px-4 py-2.5 text-left"
      >
        <span className="shrink-0 text-sm font-medium text-paper-100 capitalize">{category}</span>
        <SectionCount count={totalSet} open={open} preview={preview} />
      </button>
      {open ? (
        <div className="flex flex-col gap-3 border-t border-ink-600 px-4 py-3">
          <CategoryFields
            category={category}
            definitions={definitions}
            byId={byId}
            onSet={onSet}
            onRemove={onRemove}
            body={body}
          />
          {nested.map((g) => (
            <NestedCategory
              key={g.category}
              category={g.category}
              definitions={g.definitions}
              byId={byId}
              onSet={onSet}
              onRemove={onRemove}
              body={body}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}

/**
 * The Pelvis area — a synthetic anatomical section grouping the genital
 * attribute categories (vulva / penis / testicles, each present only when the
 * body-config switches it on) plus the universal anus, which has no descriptive
 * attributes and so shows as a present-region note. Mirrors a top-level section
 * but hosts no attributes of its own.
 */
function PelvisArea({
  members,
  anusPresent,
  byId,
  onSet,
  onRemove,
  body,
  open,
  onToggle,
}: {
  members: readonly NestedGroup[];
  anusPresent: boolean;
  byId: Map<string, AttributeValue>;
  onSet: (id: string, value: AttributeValue["value"]) => void;
  onRemove: (id: string) => void;
  body: RealizedBody;
  open: boolean;
  onToggle: () => void;
}) {
  const totalSet = members.reduce((n, g) => n + setCountOf(g.definitions, byId), 0);

  return (
    <section className="rounded-card border border-ink-600 bg-ink-800">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full cursor-pointer items-center justify-between px-4 py-2.5 text-left"
      >
        <span className="text-sm font-medium text-paper-100">Pelvis</span>
        <SectionCount count={totalSet} open={open} />
      </button>
      {open ? (
        <div className="flex flex-col gap-3 border-t border-ink-600 px-4 py-3">
          {members.length === 0 ? (
            <p className="text-xs text-paper-500">
              No genital anatomy configured — switch a region on in Body configuration above.
            </p>
          ) : (
            members.map((g) => (
              <NestedCategory
                key={g.category}
                category={g.category}
                definitions={g.definitions}
                byId={byId}
                onSet={onSet}
                onRemove={onRemove}
                body={body}
              />
            ))
          )}
          {anusPresent ? (
            <p className="text-xs text-paper-500">
              <span className="font-semibold text-paper-300">Anus</span> — present (universal anatomy; no detail to
              author).
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function AttributeRow({
  def,
  value,
  note,
  allowed,
  seed,
  onSet,
  onRemove,
}: {
  def: AttributeDefinition;
  /** Stored value; undefined renders the blank (unset) control. */
  value: AttributeValue | undefined;
  /** Species/heritage rule note for this attribute, shown as helper text. */
  note?: string;
  /** Species-narrowed option set for enum/enum_list controls (hard-restricted). */
  allowed: readonly string[];
  /** Rule/registry default — the blank slider's resting position. */
  seed: AttributeValue["value"];
  onSet: (v: AttributeValue["value"]) => void;
  onRemove: () => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <span
          className={cx("text-xs font-medium", value ? "text-paper-300" : "text-paper-500")}
          title={def.description}
        >
          {def.label}
        </span>
        {value && isAiSourced(value) ? <AiTag /> : null}
        {value ? (
          <button
            type="button"
            onClick={onRemove}
            aria-label={`Clear ${def.label}`}
            className="ml-auto cursor-pointer text-xs text-paper-500 hover:text-danger-300"
          >
            clear
          </button>
        ) : null}
      </div>
      <AttributeControl def={def} value={value} allowed={allowed} seed={seed} onSet={onSet} onRemove={onRemove} />
      {note ? <p className="text-xs italic text-paper-500">{note}</p> : null}
    </div>
  );
}

function AttributeControl({
  def,
  value,
  allowed,
  seed,
  onSet,
  onRemove,
}: {
  def: AttributeDefinition;
  /** Stored value; undefined renders the blank state (nothing written yet). */
  value: AttributeValue | undefined;
  /** Hard-restricted option set (species-narrowed); see allowedOptionsFor. */
  allowed: readonly string[];
  /** Default the blank slider rests at before the first drag sets a value. */
  seed: AttributeValue["value"];
  onSet: (v: AttributeValue["value"]) => void;
  onRemove: () => void;
}) {
  switch (def.valueType) {
    case "enum": {
      const current = value && typeof value.value === "string" ? value.value : "";
      // A stored value outside the species-narrowed set (e.g. after a species change)
      // is surfaced as a flagged option — visible and fixable, never silently rewritten.
      const outOfRule = isOutOfRuleValue(allowed, current);
      return (
        <Select
          value={current}
          // Picking "—" on a set attribute clears it back to unset.
          onChange={(e) => (e.target.value === "" ? onRemove() : onSet(e.target.value))}
          aria-label={def.label}
          className={cx("h-8 max-w-72 text-xs", !value && "text-paper-500")}
        >
          <option value="">—</option>
          {outOfRule ? <option value={current}>{`⚠ ${current.replaceAll("_", " ")} (not allowed)`}</option> : null}
          {allowed.map((option) => (
            <option key={option} value={option} title={def.narratorGuidance?.[option]}>
              {option.replaceAll("_", " ")}
            </option>
          ))}
        </Select>
      );
    }
    case "enum_list": {
      const selected = value ? asList(value.value) : [];
      // Out-of-rule selected values lead, flagged, so they can be deselected.
      const extraneous = selected.filter((s) => !allowed.includes(s));
      return (
        <div className="flex flex-wrap gap-1.5">
          {[...extraneous, ...allowed].map((option) => {
            const active = selected.includes(option);
            const outOfRule = !allowed.includes(option);
            return (
              <button
                key={option}
                type="button"
                aria-pressed={active}
                title={outOfRule ? "Not allowed for this species" : def.narratorGuidance?.[option]}
                onClick={() => {
                  const next = active ? selected.filter((s) => s !== option) : [...selected, option];
                  // Deselecting the last chip clears the attribute back to unset.
                  if (next.length > 0) onSet(next);
                  else onRemove();
                }}
                className={cx(
                  "touch-target inline-flex cursor-pointer items-center justify-center rounded-full border px-2 py-0.5 text-[11px] transition-colors",
                  outOfRule
                    ? "border-danger-400/60 bg-danger-500/10 text-danger-300"
                    : active
                      ? "border-accent-500/60 bg-accent-500/10 text-accent-300"
                      : "border-ink-500 text-paper-400 hover:text-paper-200",
                )}
              >
                {`${outOfRule ? "⚠ " : ""}${option.replaceAll("_", " ")}`}
              </button>
            );
          })}
        </div>
      );
    }
    case "number": {
      const bounds = sliderBounds(def);
      const fallback = typeof seed === "number" ? seed : (bounds.min + bounds.max) / 2;
      const current = value && typeof value.value === "number" ? value.value : fallback;
      // Unset: the slider rests dimmed at the seed position; the first drag
      // writes a value (there is no "blank" a slider can render).
      return (
        <Slider
          value={current}
          min={bounds.min}
          max={bounds.max}
          step={bounds.step}
          unit={def.unit}
          onChange={onSet}
          className={cx("max-w-96", !value && "opacity-50")}
        />
      );
    }
    case "text":
      return (
        <Input
          value={value && typeof value.value === "string" ? value.value : ""}
          // Emptying the field clears the attribute back to unset.
          onChange={(e) => (e.target.value === "" ? onRemove() : onSet(e.target.value))}
          aria-label={def.label}
          placeholder={def.description}
          className="h-8 max-w-96 text-xs"
        />
      );
    case "flag":
      return (
        <label className="touch-target flex w-fit cursor-pointer items-center gap-2 text-xs text-paper-300">
          <input
            type="checkbox"
            checked={value?.value === true}
            onChange={(e) => onSet(e.target.checked)}
            className="size-4 accent-accent-500"
          />
          <Tag tone={value?.value === true ? "accent" : "default"}>
            {value ? (value.value === true ? "yes" : "no") : "—"}
          </Tag>
        </label>
      );
  }
}
