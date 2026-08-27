"use client";

import {
  imageEditKinds,
  imageIdentityPreservationRatings,
  type ImageEditKind,
  type ImageIdentityPreservation,
} from "@vesper/image-core";
import {
  imageReferenceTransports,
  type adminImageModelsApi,
  type ImageModel,
  type ImageModelProfile,
  type ImageModelSurface,
  type ImageReferenceTransport,
} from "@/lib/client/api";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Tag } from "@/components/ui/tag";
import { MODEL_SURFACES } from "./image-admin-shared";
import { ImageModelProfilesSection } from "./image-model-profiles-section";
import { ImageModelVersionPanel } from "./image-model-version-panel";

/**
 * One registry model's card: identity and probed facts, the owner-set controls,
 * the two REVIEWED ratings and the operator warning, the version corner, and
 * the nested profiles.
 *
 * The reviewed controls are presented as what they are — judgments from looking
 * at output, which no probe writes and no re-probe overwrites. `editKind` keeps
 * an instruction editor apart from noise repainting; `identityPreservation`
 * gates the identity-critical tasks, so setting it to `weak` here takes this
 * model's variant/scene/chat-look profiles out of service at once.
 */

export type ImageModelPatchBody = Parameters<typeof adminImageModelsApi.update>[1];

export function ModelRow({
  model,
  profiles,
  busy,
  onPatch,
  onDelete,
  onChanged,
}: {
  model: ImageModel;
  /** This model's profiles, grouped out of the page's one registry fetch. */
  profiles: ImageModelProfile[];
  busy: boolean;
  onPatch: (body: ImageModelPatchBody) => void;
  onDelete: () => void;
  /** Silent registry refetch (profile CRUD, version activation). */
  onChanged: () => void;
}) {
  const enabled: Record<ImageModelSurface, boolean> = {
    portrait: model.forPortrait,
    variant: model.forVariant,
    scene: model.forScene,
  };
  const capable: Record<ImageModelSurface, boolean> = {
    portrait: model.canGenerate,
    variant: model.canEdit,
    scene: model.canEdit,
  };

  return (
    <div className="rounded-card border border-ink-600 bg-ink-850 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-medium text-paper-200">{model.label}</h3>
            {model.builtin ? <Tag>built-in</Tag> : null}
            {model.canGenerate ? <Tag tone="ok">can generate</Tag> : null}
            {model.canEdit ? <Tag tone="ok">can edit</Tag> : null}
          </div>
          <p className="mt-0.5 font-mono text-[11px] break-all text-paper-500">{model.slug}</p>
          <p className="mt-1 text-[11px] text-paper-600">
            references: <code>{model.referenceField}</code> ({model.referenceArity}, max {model.maxReferences}) ·
            shape: {model.aspectMode} · {model.supportedAspects.length} option
            {model.supportedAspects.length === 1 ? "" : "s"}
            {model.outputFormat ? ` · ${model.outputFormat}` : ""}
            {model.referenceTransport === "data_url" ? " · inlined references" : ""}
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button
            size="sm"
            variant="quiet"
            busy={busy}
            onClick={() => onPatch({ reprobe: true })}
            title="Re-read this model's API and refresh what it can do — never the reviewed ratings"
          >
            Re-probe
          </Button>
          <Button size="sm" variant="quiet" onClick={onDelete}>
            Remove
          </Button>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-4">
        {MODEL_SURFACES.map((surface) => (
          <label
            key={surface.key}
            className={`flex items-center gap-2 text-sm ${capable[surface.key] ? "text-paper-300" : "text-paper-600"}`}
            // A ticked box on a model that lacks the capability is honoured as
            // storage but never listed — say so rather than letting it look broken.
            title={
              capable[surface.key]
                ? surface.hint
                : surface.key === "portrait"
                  ? "This model needs a reference image, so it can't make a portrait from nothing"
                  : "This model has no reference input, so it can't edit an existing image"
            }
          >
            <input
              type="checkbox"
              checked={enabled[surface.key]}
              disabled={!capable[surface.key] || busy}
              onChange={() =>
                onPatch({
                  ...(surface.key === "portrait" ? { forPortrait: !model.forPortrait } : {}),
                  ...(surface.key === "variant" ? { forVariant: !model.forVariant } : {}),
                  ...(surface.key === "scene" ? { forScene: !model.forScene } : {}),
                })
              }
              className="accent-accent-500"
            />
            {surface.label}
          </label>
        ))}
        <label
          className="ml-auto flex items-center gap-2 text-[11px] text-paper-500"
          // Not probeable: only running the model tells you whether its wrapper
          // can resolve an uploaded file URL. Wan 2.7 cannot — it reads the
          // extension off whatever it is handed and rejects the upload URL.
          title="How reference images are sent. Upload is right for nearly every model; inline when the model rejects uploaded file URLs."
        >
          references sent as
          <Select
            value={model.referenceTransport}
            disabled={busy || !model.canEdit}
            onChange={(e) => onPatch({ referenceTransport: e.target.value as ImageReferenceTransport })}
            className="h-7 w-36 text-xs"
          >
            {imageReferenceTransports.map((transport) => (
              <option key={transport} value={transport}>
                {transport === "file" ? "upload" : "inline data URI"}
              </option>
            ))}
          </Select>
        </label>
        <label className="flex items-center gap-2 text-[11px] text-paper-500">
          max references
          <Input
            type="number"
            min={0}
            max={64}
            defaultValue={model.maxReferences}
            disabled={busy || !model.canEdit}
            onBlur={(e) => {
              const next = Number(e.target.value);
              if (Number.isFinite(next) && next !== model.maxReferences) onPatch({ maxReferences: next });
            }}
            className="h-7 w-16 text-xs"
          />
        </label>
      </div>

      {/* The owner's own columns: the display label, the two reviewed judgments,
          and the operator caveat. Saved on blur / on change like the reference
          cap — no separate save button on a card of independent facts. */}
      <div className="mt-3 grid gap-3 border-t border-ink-600/60 pt-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Label" hint="Shown in every picker.">
          {(id) => (
            <Input
              id={id}
              defaultValue={model.label}
              maxLength={120}
              disabled={busy}
              onBlur={(e) => {
                const next = e.target.value.trim();
                if (next && next !== model.label) onPatch({ label: next });
              }}
            />
          )}
        </Field>
        <Field label="Edit kind" hint="Reviewed judgment: what its editing actually does. A probe never sets this.">
          {(id) => (
            <Select
              id={id}
              value={model.editKind}
              disabled={busy}
              onChange={(e) => onPatch({ editKind: e.target.value as ImageEditKind })}
            >
              {imageEditKinds.map((kind) => (
                <option key={kind} value={kind}>
                  {kind}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field
          label="Identity preservation"
          hint="Reviewed judgment: does a face survive a render? “weak” takes this model out of variant/scene/chat-look work."
        >
          {(id) => (
            <Select
              id={id}
              value={model.identityPreservation}
              disabled={busy}
              onChange={(e) => onPatch({ identityPreservation: e.target.value as ImageIdentityPreservation })}
            >
              {imageIdentityPreservationRatings.map((rating) => (
                <option key={rating} value={rating}>
                  {rating}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Operator warning" hint="Shown in pickers before use. Clear the box to retract it.">
          {(id) => (
            <Input
              id={id}
              defaultValue={model.operatorWarning ?? ""}
              maxLength={500}
              disabled={busy}
              placeholder="none"
              onBlur={(e) => {
                const next = e.target.value.trim();
                if (next !== (model.operatorWarning ?? "")) onPatch({ operatorWarning: next === "" ? null : next });
              }}
            />
          )}
        </Field>
      </div>

      <ImageModelVersionPanel model={model} profiles={profiles} onChanged={onChanged} />
      <ImageModelProfilesSection model={model} profiles={profiles} onChanged={onChanged} />
    </div>
  );
}
