"use client";

import { useMemo, useState } from "react";
import {
  attributeGroups,
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
  speciesId?: string;
  bodyPlanId?: string;
}

/**
 * Registry-driven attribute editor (docs/authoring.md): one section per
 * attribute group from @/contracts, controls keyed off valueType, sparse by
 * design — unset attributes live behind each group's "add" select. Attributes
 * are filtered through the realized body (species/realize.ts): intimate groups
 * appear only when the body-config switches their region on.
 */
export function AttributePicker({
  values,
  onChange,
  intimateRegions = [],
  onChangeIntimateRegions,
  speciesId,
  bodyPlanId,
}: AttributePickerProps) {
  const byId = useMemo(() => attributeValueMap(values), [values]);
  const body = useMemo(
    () => realizeBody({ speciesId, bodyPlanId, intimateRegions }),
    [speciesId, bodyPlanId, intimateRegions],
  );

  return (
    <div className="flex flex-col gap-3">
      {onChangeIntimateRegions ? (
        <BodyConfigSection intimateRegions={intimateRegions} onChange={onChangeIntimateRegions} />
      ) : null}
      {attributeGroups.map((group) => {
        const definitions = group.definitions.filter((d) => body.isAttributeApplicable(d));
        if (definitions.length === 0) return null; // gated off (e.g. an intimate region not present)
        return (
          <AttributeGroupSection
            key={group.category}
            category={group.category}
            definitions={definitions}
            byId={byId}
            onSet={(id, value) => onChange(setAttribute(values, id as AttributeValue["id"], value))}
            onRemove={(id) => onChange(removeAttribute(values, id))}
          />
        );
      })}
    </div>
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

function AttributeGroupSection({ category, definitions, byId, onSet, onRemove }: GroupProps) {
  const setDefs = definitions.filter((d) => byId.has(d.id));
  const unsetDefs = definitions.filter((d) => !byId.has(d.id));
  const [open, setOpen] = useState(setDefs.length > 0);

  return (
    <section className="rounded-card border border-ink-600 bg-ink-800">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full cursor-pointer items-center justify-between px-4 py-2.5 text-left"
      >
        <span className="text-sm font-medium text-paper-100 capitalize">{category}</span>
        <span className="text-xs text-paper-500">
          {setDefs.length > 0 ? `${setDefs.length} set` : "—"}
          <span className={cx("ml-2 inline-block transition-transform", open && "rotate-90")}>›</span>
        </span>
      </button>
      {open ? (
        <div className="flex flex-col gap-3 border-t border-ink-600 px-4 py-3">
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
          {setDefs.length === 0 && unsetDefs.length === 0 ? (
            <p className="text-xs text-paper-500">No attributes in this group.</p>
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
