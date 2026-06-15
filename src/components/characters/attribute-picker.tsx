"use client";

import { Fragment, useMemo, useState } from "react";
import {
  attributeGroups,
  FEATURE_GROUPS,
  INTIMATE_REGION_GROUPS,
  realizeBody,
  type AttributeDefinition,
  type AttributeValue,
} from "@/contracts";
import { cx } from "@/components/ui/cx";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { AiTag, Tag } from "@/components/ui/tag";
import {
  asList,
  attributeValueMap,
  defaultValueFor,
  isAiSourced,
  removeAttribute,
  setAttribute,
  sliderBounds,
} from "./attribute-helpers";

export interface AttributePickerProps {
  values: readonly AttributeValue[];
  onChange: (values: AttributeValue[]) => void;
  /** Per-character body-config — which intimate region groups are present. */
  intimateRegions?: readonly string[];
  /** When provided, the body-config toggle UI is shown and intimate groups unlock. */
  onChangeIntimateRegions?: (regions: string[]) => void;
  /** Per-character additive feature config; undefined means species defaults. */
  bodyFeatures?: readonly string[];
  /** When provided, body feature toggle UI is shown. */
  onChangeBodyFeatures?: (features: string[]) => void;
  speciesId?: string;
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
 * attribute group from @/contracts, controls keyed off valueType, sparse by
 * design — unset attributes live behind each group's "add" select. Attributes
 * are filtered through the realized body (species/realize.ts): intimate groups
 * appear only when the body-config switches their region on, and the explicit
 * anatomy nests under its anatomical area (Chest / Pelvis) rather than at the top.
 */
export function AttributePicker({
  values,
  onChange,
  intimateRegions = [],
  onChangeIntimateRegions,
  bodyFeatures,
  onChangeBodyFeatures,
  speciesId,
  bodyPlanId,
}: AttributePickerProps) {
  const byId = useMemo(() => attributeValueMap(values), [values]);
  const body = useMemo(
    () => realizeBody({ speciesId, bodyPlanId, intimateRegions, bodyFeatures }),
    [speciesId, bodyPlanId, intimateRegions, bodyFeatures],
  );
  const effectiveBodyFeatures = bodyFeatures ?? [...body.bodyFeatures];

  const onSet = (id: string, value: AttributeValue["value"]) =>
    onChange(setAttribute(values, id as AttributeValue["id"], value));
  const onRemove = (id: string) => onChange(removeAttribute(values, id));

  // Applicable (present-on-this-body) definitions for a category, by id.
  const definitionsFor = (category: string): AttributeDefinition[] => {
    const group = attributeGroups.find((g) => g.category === category);
    return group ? group.definitions.filter((d) => body.isAttributeApplicable(d)) : [];
  };
  const nestedGroupsFor = (categories: readonly string[]): NestedGroup[] =>
    categories
      .map((category) => ({ category, definitions: definitionsFor(category) }))
      .filter((g) => g.definitions.length > 0);

  return (
    <div className="flex flex-col gap-3">
      {onChangeIntimateRegions ? (
        <BodyConfigSection intimateRegions={intimateRegions} onChange={onChangeIntimateRegions} />
      ) : null}
      {onChangeBodyFeatures ? (
        <BodyFeaturesSection bodyFeatures={effectiveBodyFeatures} onChange={onChangeBodyFeatures} />
      ) : null}
      {attributeGroups.map((group) => {
        if (NESTED_CATEGORIES.has(group.category)) return null; // rendered nested below
        const definitions = group.definitions.filter((d) => body.isAttributeApplicable(d));
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
            />
            {/* The Pelvis area sits next to its anatomical neighbour, Hips. */}
            {group.category === "hips" ? (
              <PelvisArea
                members={nestedGroupsFor(PELVIS_CATEGORIES)}
                anusPresent={body.isLocationPresent("anus")}
                byId={byId}
                onSet={onSet}
                onRemove={onRemove}
              />
            ) : null}
          </Fragment>
        );
      })}
    </div>
  );
}

function BodyFeaturesSection({
  bodyFeatures,
  onChange,
}: {
  bodyFeatures: readonly string[];
  onChange: (features: string[]) => void;
}) {
  const [open, setOpen] = useState(bodyFeatures.length > 0);
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
        onClick={() => setOpen((o) => !o)}
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
                    "cursor-pointer rounded-full border px-2.5 py-0.5 text-[11px] capitalize transition-colors",
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
}: {
  intimateRegions: readonly string[];
  onChange: (regions: string[]) => void;
}) {
  const [open, setOpen] = useState(intimateRegions.length > 0);
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
        onClick={() => setOpen((o) => !o)}
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
                    "cursor-pointer rounded-full border px-2.5 py-0.5 text-[11px] capitalize transition-colors",
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
}

/** A category rendered nested inside an anatomical area (e.g. breasts → chest). */
interface NestedGroup {
  category: string;
  definitions: readonly AttributeDefinition[];
}

const setCountOf = (definitions: readonly AttributeDefinition[], byId: Map<string, AttributeValue>): number =>
  definitions.filter((d) => byId.has(d.id)).length;

/** Header label "N set" / "—" for a collapsible body section. */
function SectionCount({ count, open }: { count: number; open: boolean }) {
  return (
    <span className="text-xs text-paper-500">
      {count > 0 ? `${count} set` : "—"}
      <span className={cx("ml-2 inline-block transition-transform", open && "rotate-90")}>›</span>
    </span>
  );
}

/**
 * The attribute controls for one category — rows for set attributes plus the
 * "add attribute" select — with no card chrome of its own, so it can head a
 * top-level section *or* sit nested inside an anatomical area.
 */
function CategoryFields({ category, definitions, byId, onSet, onRemove }: GroupProps) {
  const setDefs = definitions.filter((d) => byId.has(d.id));
  const unsetDefs = definitions.filter((d) => !byId.has(d.id));
  if (setDefs.length === 0 && unsetDefs.length === 0) {
    return <p className="text-xs text-paper-500">No attributes in this group.</p>;
  }
  return (
    <>
      {setDefs.map((def) => {
        const current = byId.get(def.id);
        if (!current) return null;
        return (
          <AttributeRow
            key={def.id}
            def={def}
            value={current}
            onSet={(v) => onSet(def.id, v)}
            onRemove={() => onRemove(def.id)}
          />
        );
      })}
      {unsetDefs.length > 0 ? (
        <Select
          value=""
          aria-label={`Add ${category} attribute`}
          onChange={(e) => {
            const def = unsetDefs.find((d) => d.id === e.target.value);
            if (def) onSet(def.id, defaultValueFor(def));
          }}
          className="h-8 max-w-60 text-xs text-paper-400"
        >
          <option value="">+ Add attribute…</option>
          {unsetDefs.map((def) => (
            <option key={def.id} value={def.id}>
              {def.label}
            </option>
          ))}
        </Select>
      ) : null}
    </>
  );
}

/** A nested anatomical sub-group (e.g. Breasts under Chest) — indented, no card. */
function NestedCategory({ category, definitions, byId, onSet, onRemove }: GroupProps) {
  return (
    <div className="flex flex-col gap-3 border-l border-ink-600 pl-3">
      <p className="text-xs font-semibold text-paper-300 capitalize">{category}</p>
      <CategoryFields
        category={category}
        definitions={definitions}
        byId={byId}
        onSet={onSet}
        onRemove={onRemove}
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
}: GroupProps & { nested?: readonly NestedGroup[] }) {
  const nestedSet = nested.reduce((n, g) => n + setCountOf(g.definitions, byId), 0);
  const totalSet = setCountOf(definitions, byId) + nestedSet;
  const [open, setOpen] = useState(totalSet > 0);

  return (
    <section className="rounded-card border border-ink-600 bg-ink-800">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full cursor-pointer items-center justify-between px-4 py-2.5 text-left"
      >
        <span className="text-sm font-medium text-paper-100 capitalize">{category}</span>
        <SectionCount count={totalSet} open={open} />
      </button>
      {open ? (
        <div className="flex flex-col gap-3 border-t border-ink-600 px-4 py-3">
          <CategoryFields
            category={category}
            definitions={definitions}
            byId={byId}
            onSet={onSet}
            onRemove={onRemove}
          />
          {nested.map((g) => (
            <NestedCategory
              key={g.category}
              category={g.category}
              definitions={g.definitions}
              byId={byId}
              onSet={onSet}
              onRemove={onRemove}
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
}: {
  members: readonly NestedGroup[];
  anusPresent: boolean;
  byId: Map<string, AttributeValue>;
  onSet: (id: string, value: AttributeValue["value"]) => void;
  onRemove: (id: string) => void;
}) {
  const totalSet = members.reduce((n, g) => n + setCountOf(g.definitions, byId), 0);
  const [open, setOpen] = useState(totalSet > 0);

  return (
    <section className="rounded-card border border-ink-600 bg-ink-800">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
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
  onSet,
  onRemove,
}: {
  def: AttributeDefinition;
  value: AttributeValue;
  onSet: (v: AttributeValue["value"]) => void;
  onRemove: () => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium text-paper-300" title={def.description}>
          {def.label}
        </span>
        {isAiSourced(value) ? <AiTag /> : null}
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Clear ${def.label}`}
          className="ml-auto cursor-pointer text-xs text-paper-500 hover:text-danger-300"
        >
          clear
        </button>
      </div>
      <AttributeControl def={def} value={value} onSet={onSet} />
    </div>
  );
}

function AttributeControl({
  def,
  value,
  onSet,
}: {
  def: AttributeDefinition;
  value: AttributeValue;
  onSet: (v: AttributeValue["value"]) => void;
}) {
  switch (def.valueType) {
    case "enum":
      return (
        <Select
          value={typeof value.value === "string" ? value.value : ""}
          onChange={(e) => onSet(e.target.value)}
          aria-label={def.label}
          className="h-8 max-w-72 text-xs"
        >
          {(def.allowedValues ?? []).map((option) => (
            <option key={option} value={option}>
              {option.replaceAll("_", " ")}
            </option>
          ))}
        </Select>
      );
    case "enum_list": {
      const selected = asList(value.value);
      return (
        <div className="flex flex-wrap gap-1.5">
          {(def.allowedValues ?? []).map((option) => {
            const active = selected.includes(option);
            return (
              <button
                key={option}
                type="button"
                aria-pressed={active}
                onClick={() => {
                  const next = active ? selected.filter((s) => s !== option) : [...selected, option];
                  if (next.length > 0) onSet(next); // enum_list values must stay non-empty
                }}
                className={cx(
                  "cursor-pointer rounded-full border px-2 py-0.5 text-[11px] transition-colors",
                  active
                    ? "border-accent-500/60 bg-accent-500/10 text-accent-300"
                    : "border-ink-500 text-paper-400 hover:text-paper-200",
                )}
              >
                {option.replaceAll("_", " ")}
              </button>
            );
          })}
        </div>
      );
    }
    case "number": {
      const bounds = sliderBounds(def);
      const current = typeof value.value === "number" ? value.value : (bounds.min + bounds.max) / 2;
      return (
        <Slider
          value={current}
          min={bounds.min}
          max={bounds.max}
          step={bounds.step}
          unit={def.unit}
          onChange={onSet}
          className="max-w-96"
        />
      );
    }
    case "text":
      return (
        <Input
          value={typeof value.value === "string" ? value.value : ""}
          onChange={(e) => onSet(e.target.value)}
          aria-label={def.label}
          placeholder={def.description}
          className="h-8 max-w-96 text-xs"
        />
      );
    case "flag":
      return (
        <label className="flex w-fit cursor-pointer items-center gap-2 text-xs text-paper-300">
          <input
            type="checkbox"
            checked={value.value === true}
            onChange={(e) => onSet(e.target.checked)}
            className="size-4 accent-accent-500"
          />
          <Tag tone={value.value === true ? "accent" : "default"}>{value.value === true ? "yes" : "no"}</Tag>
        </label>
      );
  }
}
