import type { ImageReferenceRole } from "@vesper/image-core";
import { IMAGE_GENERATOR_MAX_PRIMARY, type ImageGeneratorDedicatedRole } from "@/contracts/images/image-generator";
import { imageUrl } from "@/lib/client/api";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { Tag } from "@/components/ui/tag";
import { imageGeneratorRoleLabel } from "../image-generator-copy";
import { OwnedImagePicker } from "../owned-image-picker";
import type { Dispatch, SetStateAction } from "react";
import type { GeneratorModelView } from "./model";

/**
 * The purposes the form offers: the CONTENT roles only. The structural roles
 * are deliberately absent — a structural image belongs in a dedicated slot or
 * an ordinary numbered position, and letting an admin file one as a "pose
 * purpose" would look like routing while changing nothing. A stored purpose
 * outside this set (possible via the API) is dropped from a duplicate's seed
 * rather than silently remapped.
 */
export const PURPOSE_ROLES = [
  "identity",
  "location",
  "style",
  "object",
  "outfit",
  "product",
  "before",
  "after_example",
] as const satisfies readonly ImageReferenceRole[];
export type PurposeRole = (typeof PURPOSE_ROLES)[number];

export function toPurposeOption(purpose: ImageReferenceRole | undefined): PurposeRole | "" {
  return PURPOSE_ROLES.find((role) => role === purpose) ?? "";
}

export interface PrimaryRow {
  key: number;
  imageId: string | null;
  purpose: PurposeRole | "";
}

export function GeneratorReferences({
  modelCanEdit,
  capacity,
  modelCapacity,
  primaryRows,
  setPrimaryRows,
  nextRowKey,
  setNextRowKey,
  dedicatedSlots,
  dedicated,
  setDedicated,
  openPicker,
  setOpenPicker,
  overCapacity,
  missingRequiredDedicated,
}: {
  modelCanEdit: boolean;
  capacity: number | null;
  modelCapacity: number | null;
  primaryRows: PrimaryRow[];
  setPrimaryRows: Dispatch<SetStateAction<PrimaryRow[]>>;
  nextRowKey: number;
  setNextRowKey: Dispatch<SetStateAction<number>>;
  dedicatedSlots: GeneratorModelView["dedicatedSlots"];
  dedicated: Partial<Record<ImageGeneratorDedicatedRole, string>>;
  setDedicated: Dispatch<SetStateAction<Partial<Record<ImageGeneratorDedicatedRole, string>>>>;
  openPicker: string | null;
  setOpenPicker: Dispatch<SetStateAction<string | null>>;
  overCapacity: boolean;
  missingRequiredDedicated: GeneratorModelView["dedicatedSlots"];
}) {
  const addRow = () => {
    setPrimaryRows((rows) => [...rows, { key: nextRowKey, imageId: null, purpose: "" }]);
    setNextRowKey((key) => key + 1);
    setOpenPicker(`primary:${String(nextRowKey)}`);
  };
  const removeRow = (key: number) => {
    setPrimaryRows((rows) => rows.filter((row) => row.key !== key));
  };
  const moveRow = (index: number, delta: -1 | 1) => {
    setPrimaryRows((rows) => {
      const target = index + delta;
      if (target < 0 || target >= rows.length) return rows;
      const next = [...rows];
      const [moved] = next.splice(index, 1);
      if (moved === undefined) return rows;
      next.splice(target, 0, moved);
      return next;
    });
  };
  const setRowImage = (key: number, imageId: string | null) => {
    setPrimaryRows((rows) => rows.map((row) => (row.key === key ? { ...row, imageId } : row)));
    if (imageId !== null) setOpenPicker(null);
  };
  const setRowPurpose = (key: number, purpose: PurposeRole | "") => {
    setPrimaryRows((rows) => rows.map((row) => (row.key === key ? { ...row, purpose } : row)));
  };
  const setDedicatedImage = (role: ImageGeneratorDedicatedRole, imageId: string | null) => {
    setDedicated((current) => {
      const next = { ...current };
      if (imageId === null) delete next[role];
      else next[role] = imageId;
      return next;
    });
    if (imageId !== null) setOpenPicker(null);
  };

  /** One image slot's thumbnail — or an honest "nothing yet". */
  const slotThumb = (imageId: string | null, alt: string) =>
    imageId !== null ? (
      // eslint-disable-next-line @next/next/no-img-element -- local asset route at thumbnail size; next/image adds nothing here
      <img
        src={imageUrl(imageId)}
        alt={alt}
        className="h-14 w-14 rounded-card border border-ink-600 bg-ink-950 object-cover"
      />
    ) : (
      <span className="text-xs text-paper-600">no image chosen</span>
    );

  return (
    <>
        {modelCanEdit && capacity !== null && capacity > 0 ? (
          <div className="flex flex-col gap-2">
            <h3 className="text-xs font-medium tracking-wide text-paper-400 uppercase">Primary references</h3>
            <p className="text-xs text-paper-500">
              {`Ordered images sent through the model’s numbered reference input — up to ${String(capacity)} here `}
              {`(the model takes ${String(modelCapacity ?? 0)}; the app caps freeform runs at ${String(IMAGE_GENERATOR_MAX_PRIMARY)}). `}
              {"The optional purpose is recorded on the run for provenance only: every primary reference is sent "}
              {"under the neutral reference role, and a purpose changes nothing about the request."}
            </p>
            {primaryRows.map((row, index) => (
              <div key={row.key} className="flex flex-col gap-2 rounded-card border border-ink-700 bg-ink-950/40 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[11px] tracking-wide text-paper-500 uppercase">
                    Image {index + 1}
                  </span>
                  {slotThumb(row.imageId, `Reference ${String(index + 1)}`)}
                  <Select
                    value={row.purpose}
                    onChange={(e) => setRowPurpose(row.key, e.target.value as PurposeRole | "")}
                    className="w-52"
                    aria-label={`Recorded purpose for reference ${String(index + 1)}`}
                  >
                    <option value="">— No recorded purpose —</option>
                    {PURPOSE_ROLES.map((role) => (
                      <option key={role} value={role}>
                        {imageGeneratorRoleLabel(role)}
                      </option>
                    ))}
                  </Select>
                  <div className="ml-auto flex items-center gap-1">
                    <Button size="sm" variant="quiet" disabled={index === 0} onClick={() => moveRow(index, -1)}>
                      Up
                    </Button>
                    <Button
                      size="sm"
                      variant="quiet"
                      disabled={index === primaryRows.length - 1}
                      onClick={() => moveRow(index, 1)}
                    >
                      Down
                    </Button>
                    <Button
                      size="sm"
                      variant="quiet"
                      onClick={() =>
                        setOpenPicker(openPicker === `primary:${String(row.key)}` ? null : `primary:${String(row.key)}`)
                      }
                    >
                      {row.imageId === null ? "Choose image" : "Change image"}
                    </Button>
                    <Button size="sm" variant="quiet" onClick={() => removeRow(row.key)}>
                      Remove
                    </Button>
                  </div>
                </div>
                {openPicker === `primary:${String(row.key)}` ? (
                  <OwnedImagePicker
                    label={`Reference ${String(index + 1)} image`}
                    hint="Any of your ready images. Clicking the chosen tile again clears it."
                    value={row.imageId}
                    onChange={(imageId) => setRowImage(row.key, imageId)}
                  />
                ) : null}
              </div>
            ))}
            {primaryRows.length < capacity ? (
              <div>
                <Button size="sm" onClick={addRow}>
                  Add reference
                </Button>
              </div>
            ) : null}
            {overCapacity ? (
              <p className="text-xs text-danger-300" role="alert">
                {`${String(primaryRows.length)} references exceed this model’s capacity of ${String(capacity)}. `}
                {"Nothing is trimmed for you — remove rows until the request fits."}
              </p>
            ) : null}
          </div>
        ) : null}

        {dedicatedSlots.length > 0 ? (
          <div className="flex flex-col gap-2">
            <h3 className="text-xs font-medium tracking-wide text-paper-400 uppercase">Dedicated structural inputs</h3>
            <p className="text-xs text-paper-500">
              {"Inputs the probed version declares its own fields for — they do not spend primary-reference "}
              {"capacity, and the provider field behind each slot is a probe fact, never typed here."}
            </p>
            {dedicatedSlots.map((slot) => {
              const imageId = dedicated[slot.role] ?? null;
              const pickerKey = `dedicated:${slot.role}`;
              return (
                <div key={slot.role} className="flex flex-col gap-2 rounded-card border border-ink-700 bg-ink-950/40 p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[11px] tracking-wide text-paper-500 uppercase">
                      {imageGeneratorRoleLabel(slot.role)}
                    </span>
                    {slot.binding.required ? <Tag tone="accent">required</Tag> : <Tag>optional</Tag>}
                    <code className="text-[10px] text-paper-600">{slot.binding.field}</code>
                    {slotThumb(imageId, `${imageGeneratorRoleLabel(slot.role)} input`)}
                    <div className="ml-auto flex items-center gap-1">
                      <Button
                        size="sm"
                        variant="quiet"
                        onClick={() => setOpenPicker(openPicker === pickerKey ? null : pickerKey)}
                      >
                        {imageId === null ? "Choose image" : "Change image"}
                      </Button>
                      {imageId !== null ? (
                        <Button size="sm" variant="quiet" onClick={() => setDedicatedImage(slot.role, null)}>
                          Clear
                        </Button>
                      ) : null}
                    </div>
                  </div>
                  {openPicker === pickerKey ? (
                    <OwnedImagePicker
                      label={`${imageGeneratorRoleLabel(slot.role)} image`}
                      hint="Any of your ready images — a lab fixture is usually the honest choice for a structural map."
                      value={imageId}
                      onChange={(picked) => setDedicatedImage(slot.role, picked)}
                    />
                  ) : null}
                </div>
              );
            })}
            {missingRequiredDedicated.length > 0 ? (
              <p className="text-xs text-danger-300" role="alert">
                {`The model requires ${missingRequiredDedicated
                  .map((slot) => imageGeneratorRoleLabel(slot.role))
                  .join(", ")} — the run is held until each required slot has an image.`}
              </p>
            ) : null}
          </div>
        ) : null}

    </>
  );
}
