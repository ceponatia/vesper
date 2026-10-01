"use client";

import { useId, useState } from "react";
import {
  bodyReferenceSlots,
  bodyReferenceTags,
  defaultBodyReferenceTag,
  type BodyReferenceSet,
  type BodyReferenceSlot,
  type BodyReferenceSummary,
  type BodyReferenceTag,
} from "@/contracts";
import { referenceViewsApi } from "@/lib/client/api";
import { ActionMenu } from "@/components/ui/action-menu";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EntityImage } from "@/components/ui/entity-image";
import { Tag } from "@/components/ui/tag";
import { useToast } from "@/components/ui/toast";
import { PortraitCropUploadDialog } from "./avatar-upload-dialog";
import {
  BODY_REFERENCE_CHANGE_EFFECT,
  BODY_REFERENCE_REAL_PERSON_NOTE,
  BODY_REFERENCE_UNCLOTHED_REFUSED,
  BODY_REFERENCE_UNCLOTHED_UNAVAILABLE,
  bodyReferenceSlotLabel,
  bodyReferenceTagCopy,
} from "./body-reference-copy";

/**
 * The reference views' BODY IMAGES (#671): up to two full-body images, each
 * tagged Clothed or Unclothed, that every view is built with so the sheet
 * follows the character's real body while the face still comes from the
 * accepted portrait (`docs/images/pipelines/reference-views.md` §Body reference
 * images).
 *
 * It sits at the top of the Reference views panel because it is an INPUT to
 * them: one card per slot, an empty slot offering an upload and a filled one
 * its tag, Replace and Remove. Uploads run through the shared 3:4 crop dialog
 * with the character's written body attributes and the real-person note
 * beside the image. Every change is free and synchronous and marks the views
 * out of date; nothing rebuilds until the owner builds them, so the panel's
 * own build action is the next step.
 *
 * Every write names the image the owner saw, so a write that crossed another
 * tab's is refused and the panel refetches rather than acting on a picture
 * nobody looked at.
 */

export interface BodyReferencesSectionProps {
  characterId: string;
  name: string;
  body: BodyReferenceSet;
  /** Called after any write — the panel refetches the set and the views together. */
  onChanged: () => void;
}

interface UploadTarget {
  readonly slot: BodyReferenceSlot;
  /** The image the slot showed when the dialog opened; null for an empty slot. */
  readonly expectedImageId: string | null;
  readonly tag: BodyReferenceTag;
}

export function BodyReferencesSection({ characterId, name, body, onChanged }: BodyReferencesSectionProps) {
  const toast = useToast();
  const headingId = useId();
  const [busySlot, setBusySlot] = useState<BodyReferenceSlot | null>(null);
  const [upload, setUpload] = useState<UploadTarget | null>(null);
  const [removing, setRemoving] = useState<BodyReferenceSummary | null>(null);
  const bySlot = new Map(body.images.map((image) => [image.slot, image]));

  /** The tag a new image in this slot starts with, never one the adult gate refuses. */
  const startingTag = (slot: BodyReferenceSlot, current: BodyReferenceSummary | undefined): BodyReferenceTag => {
    const preferred = current?.tag ?? defaultBodyReferenceTag(slot);
    return preferred === "unclothed" && !body.unclothedAllowed ? "clothed" : preferred;
  };

  const openUpload = (slot: BodyReferenceSlot) => {
    const current = bySlot.get(slot);
    setUpload({ slot, expectedImageId: current?.imageId ?? null, tag: startingTag(slot, current) });
  };

  const changed = (title: string) => {
    toast.push({ title, description: BODY_REFERENCE_CHANGE_EFFECT });
    onChanged();
  };

  const submitUpload = async (dataUrl: string): Promise<{ ok: true } | { ok: false; message: string }> => {
    const target = upload;
    if (target === null) return { ok: false, message: "Choose a body image slot again." };
    setBusySlot(target.slot);
    const result = await referenceViewsApi.bodyReferences.upload(characterId, target.slot, {
      dataUrl,
      tag: target.tag,
      expectedImageId: target.expectedImageId,
    });
    setBusySlot(null);
    if (!result.ok) {
      onChanged();
      return { ok: false, message: result.error.message };
    }
    changed(target.expectedImageId === null ? "Body image added" : "Body image replaced");
    return { ok: true };
  };

  const retag = async (image: BodyReferenceSummary, tag: BodyReferenceTag) => {
    if (tag === image.tag) return;
    setBusySlot(image.slot);
    const result = await referenceViewsApi.bodyReferences.retag(characterId, image.slot, { tag, expectedImageId: image.imageId });
    setBusySlot(null);
    if (!result.ok) {
      toast.push({ title: "Could not change that tag", description: result.error.message, tone: "error" });
      onChanged();
      return;
    }
    changed(`${bodyReferenceSlotLabel(image.slot)} is now ${bodyReferenceTagCopy[tag].label}`);
  };

  const remove = async () => {
    const image = removing;
    if (image === null) return;
    setBusySlot(image.slot);
    const result = await referenceViewsApi.bodyReferences.remove(characterId, image.slot, image.imageId);
    setBusySlot(null);
    setRemoving(null);
    if (!result.ok) {
      toast.push({ title: "Could not remove that body image", description: result.error.message, tone: "error" });
      onChanged();
      return;
    }
    changed("Body image removed");
  };

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <div className="flex min-w-0 max-w-2xl flex-col gap-1">
        <h4 id={headingId} className="text-sm font-medium text-paper-200">
          Body images
        </h4>
        <p className="text-sm text-paper-400">
          Optional. Give up to two full-body images and every view is built with them, so the views follow this
          character&apos;s real body. The face still comes from the accepted portrait.
        </p>
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {bodyReferenceSlots.map((slot) => {
          const image = bySlot.get(slot);
          const label = bodyReferenceSlotLabel(slot);
          const busy = busySlot === slot;
          return (
            <div key={slot} className="flex min-w-0 gap-3 rounded-card border border-ink-600 bg-ink-800 p-3">
              <div className="flex aspect-[3/4] w-24 shrink-0 items-center justify-center overflow-hidden rounded-card border border-ink-700 bg-ink-900">
                {image ? (
                  <EntityImage imageId={image.imageId} name={label} alt={`${label} of ${name}`} className="h-full w-full" />
                ) : (
                  <span className="px-2 text-center text-xs text-paper-500">No image</span>
                )}
              </div>
              <div className="flex min-w-0 flex-1 flex-col gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-paper-100">{label}</span>
                  {image?.withheld ? (
                    <Tag tone="danger" title={BODY_REFERENCE_UNCLOTHED_REFUSED}>
                      not used
                    </Tag>
                  ) : null}
                  {image ? (
                    <ActionMenu
                      label="More"
                      ariaLabel={`${label} actions`}
                      items={[
                        { label: "Replace image", onSelect: () => openUpload(slot), disabled: busySlot !== null },
                        { label: "Remove", onSelect: () => setRemoving(image), danger: true, disabled: busySlot !== null },
                      ]}
                    />
                  ) : null}
                </div>
                {image ? (
                  <>
                    <BodyReferenceTagChoice
                      legend={`What ${label.toLowerCase()} shows`}
                      value={image.tag}
                      unclothedAllowed={body.unclothedAllowed}
                      disabled={busy || busySlot !== null}
                      onChange={(tag) => void retag(image, tag)}
                    />
                    {image.withheld ? <p className="text-xs leading-relaxed text-danger-300">{BODY_REFERENCE_UNCLOTHED_REFUSED}</p> : null}
                  </>
                ) : (
                  <div className="mt-auto">
                    <Button size="sm" busy={busy} disabled={busySlot !== null} onClick={() => openUpload(slot)}>
                      Add body image
                    </Button>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {upload ? (
        <PortraitCropUploadDialog
          open
          onClose={() => setUpload(null)}
          name={bodyReferenceSlotLabel(upload.slot)}
          title={upload.expectedImageId === null ? `Add ${bodyReferenceSlotLabel(upload.slot).toLowerCase()}` : `Replace ${bodyReferenceSlotLabel(upload.slot).toLowerCase()}`}
          description="Fit the whole body, from the top of the head to the feet, inside the 3:4 frame. The face is taken from the accepted portrait, never from this image."
          confirmLabel="Use this body image"
          onUpload={submitUpload}
          aside={
            <>
              <BodyReferenceTagChoice
                legend="This image shows the body"
                value={upload.tag}
                unclothedAllowed={body.unclothedAllowed}
                disabled={busySlot !== null}
                onChange={(tag) => setUpload({ ...upload, tag })}
              />
              <BodyAttributeSummary body={body} />
              <p className="text-xs leading-relaxed text-paper-400">{BODY_REFERENCE_REAL_PERSON_NOTE}</p>
            </>
          }
        />
      ) : null}

      <ConfirmDialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        onConfirm={() => void remove()}
        title={removing === null ? "Remove body image" : `Remove ${bodyReferenceSlotLabel(removing.slot).toLowerCase()}?`}
        confirmLabel="Remove"
        busy={removing !== null && busySlot === removing.slot}
      >
        <p>{BODY_REFERENCE_CHANGE_EFFECT}</p>
      </ConfirmDialog>
    </section>
  );
}

/**
 * The Clothed / Unclothed choice — native radios, so arrow keys and screen
 * readers get the radio-group behaviour for free. Unclothed is unavailable on
 * a character the adult gate refuses, and says why.
 */
function BodyReferenceTagChoice({
  legend,
  value,
  unclothedAllowed,
  disabled,
  onChange,
}: {
  legend: string;
  value: BodyReferenceTag;
  unclothedAllowed: boolean;
  disabled: boolean;
  onChange: (tag: BodyReferenceTag) => void;
}) {
  const group = useId();
  return (
    <fieldset className="flex flex-col gap-1.5" disabled={disabled}>
      <legend className="mb-1 text-xs text-paper-400">{legend}</legend>
      {bodyReferenceTags.map((tag) => {
        const refused = tag === "unclothed" && !unclothedAllowed;
        const copy = bodyReferenceTagCopy[tag];
        return (
          <label
            key={tag}
            className="touch-target flex cursor-pointer items-start gap-2 rounded-md border border-ink-600 bg-ink-900/60 px-3 py-2 text-sm has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60"
          >
            <input
              type="radio"
              name={group}
              value={tag}
              checked={value === tag}
              disabled={refused}
              onChange={() => onChange(tag)}
              className="mt-0.5 accent-accent-500"
            />
            <span className="min-w-0">
              <span className="font-medium text-paper-100">{copy.label}</span>
              <span className="block text-xs text-paper-400">{refused ? BODY_REFERENCE_UNCLOTHED_UNAVAILABLE : copy.hint}</span>
            </span>
          </label>
        );
      })}
    </fieldset>
  );
}

/**
 * The character's written body, beside the image, so the owner can make the
 * two agree: the text is always sent too, and a body image never replaces it.
 */
function BodyAttributeSummary({ body }: { body: BodyReferenceSet }) {
  return (
    <div className="flex flex-col gap-2 rounded-card border border-ink-600 bg-ink-900/40 p-3">
      <p className="text-xs tracking-wide text-paper-500 uppercase">This character&apos;s body, as written</p>
      {body.attributes.length === 0 ? (
        <p className="text-sm text-paper-400">No body attributes are set yet.</p>
      ) : (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
          {body.attributes.map((attribute) => (
            <div key={attribute.id} className="contents">
              <dt className="text-paper-400">{attribute.label}</dt>
              <dd className="break-words text-paper-200">{attribute.value}</dd>
            </div>
          ))}
        </dl>
      )}
      <p className="text-xs leading-relaxed text-paper-400">
        Make the image and these attributes agree. Both are sent to every view, and the image never replaces the text.
      </p>
    </div>
  );
}
