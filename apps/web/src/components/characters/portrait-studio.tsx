"use client";

import { useEffect, useRef, useState } from "react";
import {
  charactersApi,
  imageProfilesApi,
  portraitVariantKindLabel,
  portraitVariantKinds,
  type CharacterPortraitAcceptance,
  type ImageRecord,
  type PortraitVariantKind,
} from "@/lib/client/api";
import { useAsyncData } from "@/components/hooks/use-async";
import { usePollWhile } from "@/components/hooks/use-poll-while";
import { AvatarUploadDialog } from "./avatar-upload-dialog";
import { IdentityReferencePanel } from "./identity-reference-panel";
import { ReferenceViewsPanel } from "./reference-views-panel";
import { ImageProfileSelect, pickedProfileId } from "./image-profile-select";
import { ActionMenu } from "@/components/ui/action-menu";
import { Button } from "@/components/ui/button";
import { Disclosure } from "@/components/ui/disclosure";
import { EntityImage } from "@/components/ui/entity-image";
import { ErrorState } from "@/components/ui/error-state";
import { Field } from "@/components/ui/field";
import { ImageLightbox } from "@/components/ui/image-lightbox";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tag, type TagTone } from "@/components/ui/tag";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import type { CharacterAuthoringActionDraft } from "./use-character-author-draft";

export interface PortraitStudioProps {
  characterId: string;
  /** Identity of the saved apparent-age plan used by portrait references. */
  referencePlanKey: string;
  name: string;
  /** The portrait CANDIDATE — what this studio shows and edits. */
  avatarImageId: string | null;
  /**
   * Which portrait this character's identity is derived from, and whether the
   * candidate above is it. Owned by the parent, which refetches the character
   * after every acceptance.
   */
  acceptance: CharacterPortraitAcceptance;
  /** Called when the avatar or its acceptance may have changed — parent refetches. */
  onAvatarChanged: () => void;
  /** Await the editor's serialized save and return its exact acknowledgment. */
  prepareGeneration: () => Promise<CharacterAuthoringActionDraft | null>;
  generationDisabled?: boolean;
  pendingProposalCount?: number;
}

const POLL_MS = 2500;

function generationError(image: ImageRecord): string | null {
  const error = image.meta?.error?.trim();
  return error ? error : null;
}

/**
 * The three states the badge has to be able to say out loud. "Not accepted" is
 * the one that matters: it means renders are still using a DIFFERENT portrait,
 * which is invisible from the picture on screen and would otherwise look like a
 * bug in the image lanes.
 */
function portraitAcceptanceChip(acceptance: CharacterPortraitAcceptance): {
  tone: TagTone;
  label: string;
  hint: string;
} {
  if (acceptance.isCurrent) {
    return { tone: "ok", label: "Accepted", hint: "This portrait is the character's identity." };
  }
  if (acceptance.acceptedImageId) {
    return {
      tone: "accent",
      label: "Not accepted",
      hint: "Conversations keep rendering the last accepted portrait until you accept this one.",
    };
  }
  return {
    tone: "default",
    label: "No accepted portrait",
    hint: "Use this portrait to establish the character's appearance in new images.",
  };
}

function portraitKindLabel(image: ImageRecord): string {
  if (image.kind === "avatar") return "avatar";
  const variant = image.meta?.variantKind?.trim();
  return variant ? portraitVariantKindLabel(variant) : image.kind.replaceAll("_", " ");
}

/**
 * Avatar + variant studio (docs/images/pipelines/avatars.md §The job and the
 * studio): generate the canonical avatar from
 * attributes, accumulate kind+instruction variants, promote any variant to
 * canonical. Pending rows poll until ready/failed — and the list GET also
 * reports a live job (`rendering`), because the pending row is reserved INSIDE
 * the job, after the queue 202: without the flag, a reload fired right after
 * kickoff sees nothing in flight, so no tile shows and nothing arms the poll
 * (the frozen-until-tab-reentry bug; same shape as the chat scene lane's fix,
 * QA batch 2026-07-09).
 *
 * TWO profile pickers, reading different tasks of the profile registry. Making
 * an avatar from nothing is
 * the `portrait` task; editing one into a variant is `variant`. The stored
 * `modelId` request field is unchanged and now carries a profile id — legacy
 * stored model ids keep resolving through the server's step-2 fallback.
 */
export function PortraitStudio({
  characterId,
  referencePlanKey,
  name,
  avatarImageId,
  acceptance,
  onAvatarChanged,
  prepareGeneration,
  generationDisabled = false,
  pendingProposalCount = 0,
}: PortraitStudioProps) {
  const portraits = useAsyncData(() => charactersApi.portraits(characterId), [characterId]);
  const toast = useToast();
  const [kind, setKind] = useState<PortraitVariantKind>("pose");
  // Both pickers default to the first profile their task offers, which is the
  // registry's stored sort order — the seeded defaults sort first.
  const portraitProfiles = useAsyncData(() => imageProfilesApi.list("portrait"), []);
  const variantProfiles = useAsyncData(() => imageProfilesApi.list("variant"), []);
  const [avatarProfileId, setAvatarProfileId] = useState<string>("");
  const [variantProfileId, setVariantProfileId] = useState<string>("");
  const [instruction, setInstruction] = useState("");
  const [avatarPhase, setAvatarPhase] = useState<"saving" | "generating" | null>(null);
  const avatarActionRef = useRef(false);
  // POST in flight — the button stays busy for the WHOLE request, releasing only
  // when it settles: an unrelated live job (a running avatar regen) must not
  // re-enable the form mid-request and invite duplicate billable submissions.
  const [submittingVariant, setSubmittingVariant] = useState(false);
  // Queued (202 received) but not yet visible in data — keeps the painting tile
  // up and the poll armed until the refetch shows the job or its row.
  const [variantQueued, setVariantQueued] = useState(false);
  const [busyImageId, setBusyImageId] = useState<string | null>(null);
  const [enlarged, setEnlarged] = useState<{ id: string; prompt: string | null } | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [acceptingPortrait, setAcceptingPortrait] = useState(false);

  // Once the avatar id changes (a generate finished or a variant was
  // promoted), stop treating the avatar job as pending. Adjusted during
  // render — the "previous render" pattern — rather than setState in an effect.
  const [prevAvatarImageId, setPrevAvatarImageId] = useState(avatarImageId);
  if (avatarImageId !== prevAvatarImageId) {
    setPrevAvatarImageId(avatarImageId);
    if (avatarImageId) setAvatarPhase(null);
  }
  useEffect(() => {
    if (avatarImageId) avatarActionRef.current = false;
  }, [avatarImageId]);

  const nsfwTest = kind === "nsfw_test";
  const rows = portraits.data?.portraits ?? [];
  // A portrait job is live server-side — covers the stretch between the queue
  // 202 and the job reserving its pending row, where the list alone says
  // nothing is happening.
  const rendering = portraits.data?.rendering ?? false;
  const hasPendingRow = rows.some((img) => img.status === "pending");
  const generatingAvatar = avatarPhase !== null;
  const hasPending = hasPendingRow || rendering || generatingAvatar || variantQueued;

  // Newest avatar-row id when a generation started — lets the effect below tell a
  // FAILED regen (a new avatar row that never became canonical) from an old one.
  const genBaselineRef = useRef<string | null>(null);

  // Poll while anything is generating; also nudge the parent so a finished
  // avatar job shows up without a manual refresh (the hook latest-refs the tick,
  // so onAvatarChanged being an inline arrow never restarts the interval).
  usePollWhile(
    hasPending,
    () => {
      portraits.reload({ silent: true });
      onAvatarChanged();
    },
    POLL_MS,
  );

  // A failed regeneration never changes avatarImageId, so the success-path clear
  // (the previous-render block above) never fires. Detect the new failed avatar
  // row and release the spinner so the button doesn't stay stuck on "Working…".
  useEffect(() => {
    if (avatarPhase !== "generating") return;
    const newestAvatar = (portraits.data?.portraits ?? []).find((img) => img.kind === "avatar");
    if (newestAvatar && newestAvatar.id !== genBaselineRef.current && newestAvatar.status === "failed") {
      setAvatarPhase(null);
      avatarActionRef.current = false;
      const error = generationError(newestAvatar);
      toast.push({
        title: "Avatar generation failed",
        description: error ?? "The image provider returned an error. Try again.",
        tone: "error",
      });
    }
  }, [portraits.data, avatarPhase, toast]);

  const generateAvatar = async () => {
    if (avatarActionRef.current || generationDisabled || pendingProposalCount > 0) return;
    avatarActionRef.current = true;
    genBaselineRef.current = (portraits.data?.portraits ?? []).find((img) => img.kind === "avatar")?.id ?? null;
    setAvatarPhase("saving");
    const source = await prepareGeneration();
    if (!source) {
      setAvatarPhase(null);
      avatarActionRef.current = false;
      return;
    }
    setAvatarPhase("generating");
    const result = await charactersApi.generateAvatar(characterId, {
      authoringRevision: source.authoringRevision,
      modelId: pickedProfileId(avatarProfileId),
    });
    if (result.ok) {
      toast.push({ title: "Avatar queued", description: "Built from this character's attributes." });
    } else {
      toast.push({ title: "Avatar generation failed", description: result.error.message, tone: "error" });
      setAvatarPhase(null);
      avatarActionRef.current = false;
    }
    portraits.reload({ silent: true });
  };

  // Row count when the variant was queued — clears the queued flag even when a
  // demo-fast job settles before the first refetch (no pending row, `rendering`
  // already false again; only the new READY row betrays that anything happened).
  const variantBaselineRef = useRef(0);

  // Clear the queued flag once the refetched data shows the job (`rendering`),
  // its pending row, or any new row — the data-driven signals own the tile from
  // there. A concurrent job satisfying this early is harmless: whichever signal
  // cleared it is itself keeping the tile up.
  useEffect(() => {
    if (variantQueued && (rendering || hasPendingRow || rows.length > variantBaselineRef.current)) {
      setVariantQueued(false);
    }
  }, [variantQueued, rendering, hasPendingRow, rows.length]);

  const submitVariant = async () => {
    if (!instruction.trim()) return;
    variantBaselineRef.current = rows.length;
    setSubmittingVariant(true);
    const result = await charactersApi.createPortrait(characterId, {
      kind,
      instruction: instruction.trim(),
      modelId: pickedProfileId(variantProfileId),
    });
    setSubmittingVariant(false);
    if (result.ok) {
      setInstruction("");
      setVariantQueued(true);
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

  // Accept the candidate BY ID: the id in the request is the picture the owner
  // is looking at, so a portrait that changed in another tab is refused
  // (`portrait_changed`) rather than accepted by accident.
  const acceptPortrait = async () => {
    if (!avatarImageId) return;
    setAcceptingPortrait(true);
    const result = await charactersApi.acceptPortrait(characterId, avatarImageId);
    setAcceptingPortrait(false);
    if (result.ok) {
      toast.push({ title: "Portrait accepted", description: "New images will use this face.", tone: "success" });
      onAvatarChanged();
      return;
    }
    if (result.error.code === "portrait_changed") {
      toast.push({
        title: "The portrait changed — review the new one and accept again",
        tone: "error",
      });
      onAvatarChanged();
      return;
    }
    toast.push({ title: "Accept failed", description: result.error.message, tone: "error" });
  };

  const clearAcceptance = async () => {
    setAcceptingPortrait(true);
    const result = await charactersApi.clearPortraitAcceptance(characterId);
    setAcceptingPortrait(false);
    if (result.ok) {
      toast.push({ title: "Acceptance cleared", description: "This character has no identity portrait." });
      onAvatarChanged();
    } else {
      toast.push({ title: "Could not clear acceptance", description: result.error.message, tone: "error" });
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
  const variants = rows.filter((img) => img.id !== avatarImageId);
  const canonical = avatarImageId ? rows.find((img) => img.id === avatarImageId) : undefined;
  // Show a placeholder tile from the instant a generation is kicked off (the
  // local flags) through the whole server-side job (`rendering`); once the
  // pending row lands, its own tile takes over seamlessly.
  const showPainting = (generatingAvatar || submittingVariant || variantQueued || rendering) && !hasPendingRow;
  // The prompt that produced the canonical avatar — null when there's no avatar
  // yet or it's a user-uploaded image (uploads carry no generation prompt).
  const canonicalPrompt =
    canonical && canonical.status === "ready" && canonical.meta?.source !== "upload" && canonical.prompt.trim()
      ? canonical.prompt
      : null;
  const acceptanceChip = portraitAcceptanceChip(acceptance);
  const acceptedPortrait = acceptance.acceptedImageId
    ? rows.find((img) => img.id === acceptance.acceptedImageId)
    : undefined;
  const showAcceptedPortrait = !!acceptance.acceptedImageId && acceptance.acceptedImageId !== avatarImageId;
  const hasPortrait = !!avatarImageId || !!acceptance.acceptedImageId;

  return (
    <div className="flex flex-col gap-6">
      <div
        className={showAcceptedPortrait && avatarImageId
          ? "grid items-start gap-5 lg:grid-cols-[minmax(0,1.2fr)_minmax(16rem,0.8fr)]"
          : "grid items-start gap-5 lg:grid-cols-[minmax(0,24rem)_minmax(16rem,1fr)]"}
      >
        {hasPortrait ? (
          <div className={showAcceptedPortrait && avatarImageId ? "grid min-w-0 gap-4 sm:grid-cols-2" : "min-w-0"}>
            {avatarImageId ? (
              <figure className="overflow-hidden rounded-card border border-ink-600 bg-ink-800">
                <button
                  type="button"
                  onClick={() => setEnlarged({ id: avatarImageId, prompt: canonicalPrompt })}
                  aria-label="Enlarge candidate portrait"
                  className="block w-full cursor-pointer"
                >
                  <EntityImage imageId={avatarImageId} name={name} className="aspect-[3/4] w-full text-3xl" />
                </button>
                <figcaption className="flex flex-col gap-3 p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-sm font-medium text-paper-100">
                      {acceptance.isCurrent ? "Your portrait" : "Candidate portrait"}
                    </h3>
                    <Tag tone={acceptanceChip.tone}>{acceptanceChip.label}</Tag>
                  </div>
                  <p className="text-sm text-paper-400">{acceptanceChip.hint}</p>
                  <Button
                    variant="primary"
                    busy={acceptingPortrait}
                    onClick={acceptPortrait}
                    disabled={acceptance.isCurrent}
                    className="w-full"
                  >
                    {acceptance.isCurrent ? "Portrait in use" : "Use this portrait"}
                  </Button>
                </figcaption>
              </figure>
            ) : null}
            {showAcceptedPortrait && acceptance.acceptedImageId ? (
              <figure className="overflow-hidden rounded-card border border-ink-600 bg-ink-800">
                <button
                  type="button"
                  onClick={() => acceptance.acceptedImageId && setEnlarged({
                      id: acceptance.acceptedImageId,
                      prompt: acceptedPortrait?.prompt || null,
                    })}
                  aria-label="Enlarge accepted portrait"
                  className="block w-full cursor-pointer"
                >
                  <EntityImage
                    imageId={acceptance.acceptedImageId}
                    name={name}
                    alt={`Accepted portrait of ${name}`}
                    className="aspect-[3/4] w-full text-3xl"
                  />
                </button>
                <figcaption className="flex flex-col gap-2 p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-sm font-medium text-paper-100">Currently in use</h3>
                    <Tag tone="ok">Accepted</Tag>
                  </div>
                  <p className="text-sm text-paper-400">
                    New images keep this appearance until you use another portrait.
                  </p>
                </figcaption>
              </figure>
            ) : null}
          </div>
        ) : (
          <div className="rounded-card border border-ink-600 bg-ink-800 p-5 sm:p-6">
            <h3 className="prose-display text-2xl text-paper-100">Give {name || "your character"} a face</h3>
            <ol className="mt-4 flex list-decimal flex-col gap-3 pl-5 text-sm text-paper-300">
              <li>Generate a portrait from the character&apos;s appearance, or upload your own.</li>
              <li>Choose <span className="font-medium text-paper-100">Use this portrait</span> when it feels right.</li>
              <li>Review the reference views to keep their appearance consistent.</li>
            </ol>
          </div>
        )}
        <div className="flex min-w-0 flex-col gap-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-base font-medium text-paper-100">
              {hasPortrait ? "Create another portrait" : "Create a portrait"}
            </h3>
            {acceptance.acceptedImageId ? (
              <ActionMenu
                label="Portrait actions"
                items={[{ label: "Clear acceptance", onSelect: () => void clearAcceptance(), busy: acceptingPortrait }]}
              />
            ) : null}
          </div>
          <p className="text-sm text-paper-400">
            Generate from the character&apos;s saved appearance, or choose an image of your own.
          </p>
          <Field label="Image model">
            {(id) => (
              <ImageProfileSelect
                id={id}
                profiles={portraitProfiles.data}
                value={avatarProfileId}
                onChange={setAvatarProfileId}
                emptyHint="No portrait profile is offered."
              />
            )}
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button
              variant={avatarImageId && !acceptance.isCurrent ? "ghost" : "primary"}
              onClick={generateAvatar}
              busy={generatingAvatar}
              disabled={generationDisabled || pendingProposalCount > 0}
              title={pendingProposalCount > 0 ? "Review pending character suggestions before generating a portrait" : undefined}
            >
              {avatarPhase === "saving" ? "Saving…" : avatarImageId ? "Regenerate portrait" : "Generate portrait"}
            </Button>
            <Button variant="ghost" onClick={() => setUploadOpen(true)}>
              Upload image
            </Button>
          </div>
          {pendingProposalCount > 0 ? (
            <p className="text-xs text-warning">Review the {pendingProposalCount} pending character suggestion{pendingProposalCount === 1 ? "" : "s"} above before generating. Only accepted details belong in a portrait.</p>
          ) : avatarPhase === "saving" ? (
            <p className="text-xs text-paper-500">Saving the character before generation…</p>
          ) : avatarPhase === "generating" ? (
            <p className="text-xs text-paper-500">Generating — this can take a minute…</p>
          ) : null}
          {canonicalPrompt || canonical?.meta?.model || canonical?.meta?.source === "upload" ? (
            <Disclosure title="Details" description="Image source and generation prompt">
              <div className="flex flex-col gap-3">
                {canonical?.meta?.model ? (
                  <p className="text-xs break-words text-paper-400">Model: {canonical.meta.model}</p>
                ) : null}
                {canonical?.meta?.source === "upload" ? <p className="text-sm text-paper-400">Uploaded image</p> : null}
                {canonicalPrompt ? (
                  <p className="max-h-64 overflow-y-auto text-sm break-words whitespace-pre-wrap text-paper-300">
                    {canonicalPrompt}
                  </p>
                ) : null}
              </div>
            </Disclosure>
          ) : null}
        </div>
      </div>

      {/* Everything derived FROM the ACCEPTED portrait sits with it, above the
          variant machinery none of it has anything to do with: the face crop
          identity-critical renders receive, then the sheet of views that says
          what the rest of this body looks like. */}
      {acceptance.acceptedImageId ? (
        <IdentityReferencePanel characterId={characterId} name={name} acceptedImageId={acceptance.acceptedImageId} />
      ) : null}

      <ReferenceViewsPanel
        characterId={characterId}
        planKey={referencePlanKey}
        acceptance={acceptance}
        onChanged={onAvatarChanged}
      />

      {avatarImageId ? (
        <Disclosure title="Create a variant" description="Try a different pose, outfit, expression or setting">
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Kind" className="w-full sm:w-36">
              {(id) => (
                <Select id={id} value={kind} onChange={(e) => setKind(e.target.value as PortraitVariantKind)}>
                  {portraitVariantKinds.map((k) => (
                    <option key={k} value={k}>
                      {portraitVariantKindLabel(k)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            {/* Edit-capable profiles only — a variant is a reference edit of the
                canonical portrait, so a text-to-image profile would paint a
                different-looking person (owner ruling 2026-07-29; the variant
                task's eligibility rules enforce it server-side). */}
            <Field label="Model" className="w-full sm:w-56">
              {(id) => (
                <ImageProfileSelect
                  id={id}
                  profiles={variantProfiles.data}
                  value={variantProfileId}
                  onChange={setVariantProfileId}
                  emptyHint="No variant profile is offered."
                />
              )}
            </Field>
            <Field label="Instruction" className="min-w-0 basis-full lg:flex-1">
              {(id) => (
                <Textarea
                  id={id}
                  rows={2}
                  value={instruction}
                  onChange={(e) => setInstruction(e.target.value)}
                  placeholder={
                    nsfwTest ? "lying back across the bed, one knee raised" : "leaning on the harbor rail at dusk, wind in her hair"
                  }
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
          {/* The bench kind pairs the picked profile with the intimate model, so
              say so where the picker is: the profile still decides prompt strategy,
              references and controls, but the render leaves on Qwen Image Edit 2511
              carrying the anatomy LoRA. Clothing is deliberately unmentioned — the
              instruction owns it. */}
          {nsfwTest ? (
            <p className="text-xs text-paper-500">
              Renders the canonical portrait through the NSFW LoRA on Qwen Image Edit 2511, whichever profile is
              picked, and states this character’s intimate attributes in the prompt. Describe the shot — including what
              they are or aren’t wearing — in the instruction.
            </p>
          ) : null}
        </Disclosure>
      ) : null}

      {hasPortrait || portraits.loading || portraits.error || variants.length > 0 || showPainting ? (
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
          ) : variants.length === 0 && !showPainting ? (
            <p className="text-sm text-paper-500">No alternate portraits yet.</p>
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {showPainting ? (
                <figure className="relative overflow-hidden rounded-card border border-ink-600">
                  <Skeleton className="aspect-[3/4] rounded-none" />
                  <figcaption className="absolute inset-x-0 bottom-0 flex items-center gap-1.5 bg-ink-950/80 px-2 py-1.5 text-[11px] text-paper-300">
                    <Tag>generating…</Tag>
                  </figcaption>
                </figure>
              ) : null}
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
                        onClick={() => setEnlarged({ id: img.id, prompt: img.prompt || null })}
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
                      <span className="hover-reveal ml-auto flex gap-1">
                        {img.status === "ready" ? (
                          <Button
                            size="sm"
                            className="touch-target"
                            busy={busyImageId === img.id}
                            onClick={() => promote(img.id)}
                          >
                            Promote
                          </Button>
                        ) : null}
                        <Button
                          size="sm"
                          variant="danger"
                          className="touch-target"
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
      ) : null}

      <AvatarUploadDialog
        open={uploadOpen}
        onClose={() => setUploadOpen(false)}
        characterId={characterId}
        name={name}
        onUploaded={() => {
          setAvatarPhase(null);
          avatarActionRef.current = false;
          toast.push({ title: "Avatar updated", description: "Set from your uploaded image.", tone: "success" });
          onAvatarChanged();
          portraits.reload({ silent: true });
        }}
      />

      <ImageLightbox
        imageId={enlarged?.id ?? null}
        alt={name}
        prompt={enlarged?.prompt}
        onClose={() => setEnlarged(null)}
      />
    </div>
  );
}
