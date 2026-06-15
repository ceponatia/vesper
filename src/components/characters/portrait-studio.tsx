"use client";

import { useEffect, useRef, useState } from "react";
import {
  avatarImageModels,
  charactersApi,
  portraitVariantKinds,
  type ImageRecord,
  type AvatarImageModel,
  type PortraitVariantKind,
} from "@/lib/client/api";
import { useAsyncData } from "@/components/hooks/use-async";
import { AvatarUploadDialog } from "./avatar-upload-dialog";
import { Button } from "@/components/ui/button";
import { EntityImage } from "@/components/ui/entity-image";
import { ErrorState } from "@/components/ui/error-state";
import { Field } from "@/components/ui/field";
import { ImageLightbox } from "@/components/ui/image-lightbox";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tag } from "@/components/ui/tag";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";

export interface PortraitStudioProps {
  characterId: string;
  name: string;
  avatarImageId: string | null;
  /** Called when the avatar may have changed (generate/promote) — parent refetches. */
  onAvatarChanged: () => void;
}

const POLL_MS = 2500;

const avatarModelLabels: Record<AvatarImageModel, string> = {
  flux: "Flux",
  qwen: "Qwen (uncensored)",
};

function generationError(image: ImageRecord): string | null {
  const error = image.meta?.error?.trim();
  return error ? error : null;
}

function portraitKindLabel(image: ImageRecord): string {
  if (image.kind === "avatar") return "avatar";
  return image.meta?.variantKind?.trim() || image.kind.replaceAll("_", " ");
}

/**
 * Avatar + Venice variant studio (docs/images.md): generate the canonical
 * avatar from attributes, accumulate kind+instruction variants, promote any
 * variant to canonical. Pending rows poll until ready/failed.
 */
export function PortraitStudio({ characterId, name, avatarImageId, onAvatarChanged }: PortraitStudioProps) {
  const portraits = useAsyncData(() => charactersApi.portraits(characterId), [characterId]);
  const toast = useToast();
  const [kind, setKind] = useState<PortraitVariantKind>("pose");
  const [avatarModel, setAvatarModel] = useState<AvatarImageModel>("flux");
  const [instruction, setInstruction] = useState("");
  const [generatingAvatar, setGeneratingAvatar] = useState(false);
  const [submittingVariant, setSubmittingVariant] = useState(false);
  const [busyImageId, setBusyImageId] = useState<string | null>(null);
  const [enlarged, setEnlarged] = useState<{ id: string; caption: string | null } | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);

  // Once the avatar id changes (a generate finished or a variant was
  // promoted), stop treating the avatar job as pending. Adjusted during
  // render — the "previous render" pattern — rather than setState in an effect.
  const [prevAvatarImageId, setPrevAvatarImageId] = useState(avatarImageId);
  if (avatarImageId !== prevAvatarImageId) {
    setPrevAvatarImageId(avatarImageId);
    if (avatarImageId) setGeneratingAvatar(false);
  }

  const hasPending = (portraits.data ?? []).some((img) => img.status === "pending") || generatingAvatar;

  // Latest-ref pattern, written in an effect (never during render): the poll
  // below always calls the current callbacks without re-subscribing on every
  // parent render (onAvatarChanged is typically an inline arrow).
  const reloadRef = useRef(portraits.reload);
  const onAvatarChangedRef = useRef(onAvatarChanged);
  // Newest avatar-row id when a generation started — lets the effect below tell a
  // FAILED regen (a new avatar row that never became canonical) from an old one.
  const genBaselineRef = useRef<string | null>(null);
  useEffect(() => {
    reloadRef.current = portraits.reload;
    onAvatarChangedRef.current = onAvatarChanged;
  });

  // Poll while anything is generating; also nudge the parent so a finished
  // avatar job shows up without a manual refresh.
  useEffect(() => {
    if (!hasPending) return;
    const timer = setInterval(() => {
      reloadRef.current({ silent: true });
      onAvatarChangedRef.current();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [hasPending]);

  // A failed regeneration never changes avatarImageId, so the success-path clear
  // (the previous-render block above) never fires. Detect the new failed avatar
  // row and release the spinner so the button doesn't stay stuck on "Working…".
  useEffect(() => {
    if (!generatingAvatar) return;
    const newestAvatar = (portraits.data ?? []).find((img) => img.kind === "avatar");
    if (newestAvatar && newestAvatar.id !== genBaselineRef.current && newestAvatar.status === "failed") {
      setGeneratingAvatar(false);
      const error = generationError(newestAvatar);
      toast.push({
        title: "Avatar generation failed",
        description: error ?? "The image provider returned an error. Try again.",
        tone: "error",
      });
    }
  }, [portraits.data, generatingAvatar, toast]);

  const generateAvatar = async () => {
    genBaselineRef.current = (portraits.data ?? []).find((img) => img.kind === "avatar")?.id ?? null;
    setGeneratingAvatar(true);
    const result = await charactersApi.generateAvatar(characterId, { model: avatarModel });
    if (result.ok) {
      toast.push({ title: "Avatar queued", description: "Built from this character's attributes." });
    } else {
      toast.push({ title: "Avatar generation failed", description: result.error.message, tone: "error" });
      setGeneratingAvatar(false);
    }
    portraits.reload({ silent: true });
  };

  const submitVariant = async () => {
    if (!instruction.trim()) return;
    setSubmittingVariant(true);
    const result = await charactersApi.createPortrait(characterId, { kind, instruction: instruction.trim() });
    setSubmittingVariant(false);
    if (result.ok) {
      setInstruction("");
      portraits.reload({ silent: true });
    } else {
      toast.push({ title: "Variant failed to queue", description: result.error.message, tone: "error" });
    }
  };

  const promote = async (imageId: string) => {
    setBusyImageId(imageId);
    const result = await charactersApi.promotePortrait(characterId, imageId);
    setBusyImageId(null);
    if (result.ok) {
      toast.push({ title: "Promoted to avatar", tone: "success" });
      onAvatarChanged();
    } else {
      toast.push({ title: "Promote failed", description: result.error.message, tone: "error" });
    }
  };

  const removeVariant = async (imageId: string) => {
    setBusyImageId(imageId);
    const result = await charactersApi.deletePortrait(characterId, imageId);
    setBusyImageId(null);
    if (!result.ok) {
      toast.push({ title: "Delete failed", description: result.error.message, tone: "error" });
    }
    portraits.reload({ silent: true });
  };

  // Keep failed rows visible: image failures are diagnostics the user can act on,
  // not transient noise that should disappear after polling.
  const variants = (portraits.data ?? []).filter((img) => img.id !== avatarImageId);
  const canonical = avatarImageId ? (portraits.data ?? []).find((img) => img.id === avatarImageId) : undefined;
  // The prompt that produced the canonical avatar — null when there's no avatar
  // yet or it's a user-uploaded image (uploads carry no generation prompt).
  const canonicalPrompt =
    canonical && canonical.status === "ready" && canonical.meta?.source !== "upload" && canonical.prompt.trim()
      ? canonical.prompt
      : null;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start gap-5">
        <button
          type="button"
          onClick={() => avatarImageId && setEnlarged({ id: avatarImageId, caption: null })}
          disabled={!avatarImageId}
          aria-label={avatarImageId ? "Enlarge avatar" : undefined}
          className="cursor-pointer rounded-card disabled:cursor-default"
        >
          <EntityImage
            imageId={avatarImageId}
            name={name}
            className="aspect-[3/4] w-44 rounded-card border border-ink-600 text-3xl"
          />
        </button>
        <div className="flex max-w-sm flex-col gap-2">
          <h3 className="text-xs font-medium tracking-wide text-paper-400 uppercase">Canonical avatar</h3>
          <p className="text-sm text-paper-400">
            Generated from this character&apos;s attributes — the registry phrasing is the prompt.
          </p>
          <Field label="Model" className="w-44">
            {(id) => (
              <Select id={id} value={avatarModel} onChange={(e) => setAvatarModel(e.target.value as AvatarImageModel)}>
                {avatarImageModels.map((m) => (
                  <option key={m} value={m}>
                    {avatarModelLabels[m]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" onClick={generateAvatar} busy={generatingAvatar}>
              {avatarImageId ? "Regenerate avatar" : "Generate avatar"}
            </Button>
            <Button variant="ghost" onClick={() => setUploadOpen(true)}>
              Upload image
            </Button>
          </div>
          {generatingAvatar ? <p className="text-xs text-paper-500">Working — this can take a minute…</p> : null}
        </div>
      </div>

      {canonicalPrompt ? (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <h3 className="text-xs font-medium tracking-wide text-paper-400 uppercase">Avatar prompt</h3>
            {canonical?.meta?.model ? <Tag>{canonical.meta.model}</Tag> : null}
          </div>
          <p className="rounded-card border border-ink-600 bg-ink-950/40 px-3 py-2 text-sm whitespace-pre-wrap text-paper-300">
            {canonicalPrompt}
          </p>
        </div>
      ) : null}

      <div className="flex flex-col gap-3">
        <h3 className="text-xs font-medium tracking-wide text-paper-400 uppercase">New variant</h3>
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Kind" className="w-36">
            {(id) => (
              <Select id={id} value={kind} onChange={(e) => setKind(e.target.value as PortraitVariantKind)}>
                {portraitVariantKinds.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Instruction" className="min-w-64 flex-1">
            {(id) => (
              <Textarea
                id={id}
                rows={2}
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
                placeholder="leaning on the harbor rail at dusk, wind in her hair"
              />
            )}
          </Field>
          <Button
            variant="primary"
            onClick={submitVariant}
            busy={submittingVariant}
            disabled={!avatarImageId || !instruction.trim()}
            title={avatarImageId ? undefined : "Generate an avatar first — variants edit the canonical portrait"}
          >
            Create variant
          </Button>
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <h3 className="text-xs font-medium tracking-wide text-paper-400 uppercase">Portrait history</h3>
        {portraits.loading ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="aspect-[3/4]" />
            ))}
          </div>
        ) : portraits.error ? (
          <ErrorState error={portraits.error} onRetry={() => portraits.reload()} />
        ) : variants.length === 0 ? (
          <p className="text-sm text-paper-500">No alternate portraits yet.</p>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {variants.map((img) => {
              const error = generationError(img);
              const label = portraitKindLabel(img);
              return (
                <figure key={img.id} className="group relative overflow-hidden rounded-card border border-ink-600">
                  {img.status === "pending" ? (
                    <Skeleton className="aspect-[3/4] rounded-none" />
                  ) : img.status === "failed" ? (
                    <div className="flex aspect-[3/4] w-full flex-col justify-center gap-2 bg-ink-950/60 px-3 py-4">
                      <Tag tone="danger" className="self-start">
                        failed
                      </Tag>
                      <p className="text-xs font-medium text-paper-200">{label} generation failed</p>
                      <p className="max-h-24 overflow-y-auto text-xs break-words text-paper-400" title={error ?? undefined}>
                        {error ?? "The image provider returned an error."}
                      </p>
                      {img.meta?.model ? <p className="text-[11px] break-words text-paper-500">{img.meta.model}</p> : null}
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setEnlarged({ id: img.id, caption: img.prompt || img.kind })}
                      aria-label="Enlarge portrait"
                      className="block w-full cursor-pointer"
                    >
                      <EntityImage imageId={img.id} name={name} className="aspect-[3/4] w-full" />
                    </button>
                  )}
                  <figcaption className="absolute inset-x-0 bottom-0 flex items-center gap-1.5 bg-ink-950/80 px-2 py-1.5 text-[11px] text-paper-300">
                    {img.status === "pending" ? (
                      <Tag>generating…</Tag>
                    ) : img.status === "failed" ? (
                      <span className="truncate" title={error ?? undefined}>
                        {error ?? "Generation failed"}
                      </span>
                    ) : (
                      <span className="truncate" title={img.prompt}>
                        {img.prompt || img.kind}
                      </span>
                    )}
                    <span className="ml-auto flex gap-1 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
                      {img.status === "ready" ? (
                        <Button size="sm" busy={busyImageId === img.id} onClick={() => promote(img.id)}>
                          Promote
                        </Button>
                      ) : null}
                      <Button
                        size="sm"
                        variant="danger"
                        busy={busyImageId === img.id}
                        onClick={() => removeVariant(img.id)}
                      >
                        ✕
                      </Button>
                    </span>
                  </figcaption>
                </figure>
              );
            })}
          </div>
        )}
      </div>

      <AvatarUploadDialog
        open={uploadOpen}
        onClose={() => setUploadOpen(false)}
        characterId={characterId}
        name={name}
        onUploaded={() => {
          setGeneratingAvatar(false);
          toast.push({ title: "Avatar updated", description: "Set from your uploaded image.", tone: "success" });
          onAvatarChanged();
          portraits.reload({ silent: true });
        }}
      />

      <ImageLightbox
        imageId={enlarged?.id ?? null}
        alt={name}
        caption={enlarged?.caption}
        onClose={() => setEnlarged(null)}
      />
    </div>
  );
}
