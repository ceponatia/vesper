"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { attributeRegistry, type Diagnostic } from "@/contracts";
import { mergeFillDraft } from "@/lib/character-fill";
import { mergeRedraftScope, type CharacterSheetScope } from "@/lib/character-scopes";
import {
  characterDraftSchema,
  charactersApi,
  type CharacterDraft,
  type PortraitReview,
} from "@/lib/client/api";
import { resolveChatModelId } from "@/lib/narrative-models";
import { decideDraftSeed } from "@/components/hooks/draft-seed";
import { useAsyncData } from "@/components/hooks/use-async";
import { PublishToggle } from "@/components/library/publish-toggle";
import { PageContainer } from "@/components/shell/app-shell";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { ErrorState } from "@/components/ui/error-state";
import { SaveBar } from "@/components/ui/save-bar";
import { Skeleton, SkeletonText } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { CharacterEditor } from "./character-editor";

/** Render an attribute value for the portrait review rows. */
function formatPortraitValue(value: string | readonly string[] | number | boolean): string {
  return Array.isArray(value) ? value.join(", ") : String(value);
}

export function CharacterEditPage({ characterId }: { characterId: string }) {
  const router = useRouter();
  const toast = useToast();
  const detail = useAsyncData(() => charactersApi.get(characterId), [characterId]);

  const [draft, setDraft] = useState<CharacterDraft | null>(null);
  // The chat tab's narrator pick lives here (not in the chat component) so it outlives
  // that tab unmounting on a tab switch; persisted out-of-band to `characters.chatModel`
  // (not the editor draft), so it's saved on pick rather than via the SaveBar.
  const [chatModel, setChatModel] = useState<string>(() => resolveChatModelId(null));
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [forging, setForging] = useState(false);
  const [redrafting, setRedrafting] = useState<CharacterSheetScope | null>(null);
  const [derivingPortrait, setDerivingPortrait] = useState(false);
  // The portrait review dialog (followups ruling 2): what the vision pass read —
  // disagreements offered as current → proposed, auto-fills listed for testing
  // visibility. Opens after every read that saw anything.
  const [portraitReview, setPortraitReview] = useState<PortraitReview | null>(null);
  const [acceptedIds, setAcceptedIds] = useState<ReadonlySet<string>>(new Set());
  const [forgeDiagnostics, setForgeDiagnostics] = useState<readonly Diagnostic[]>([]);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  /** Bumped on every edit so a completing save can't clear newer dirtiness. */
  const editGenRef = useRef(0);
  /** Bumped on every chat-model pick so a superseded pick is skipped, plus the serializing chain. */
  const chatModelGenRef = useRef(0);
  const chatModelChainRef = useRef<Promise<void>>(Promise.resolve());

  // Seed the editable draft from the loaded character during render (the
  // React "adjust state while rendering" pattern). Each character is seeded
  // exactly once, so refetches — silent avatar polling, the reload after a
  // save — can never clobber in-progress edits.
  const [seededId, setSeededId] = useState<string | null>(null);
  const seedAction = decideDraftSeed({ entityId: characterId, seededId, loadedId: detail.data?.id ?? null });
  if (seedAction === "seed" && detail.data) {
    setSeededId(characterId);
    setDirty(false);
    setDraft(
      characterDraftSchema.parse({
        name: detail.data.name,
        tags: detail.data.tags,
        profile: detail.data.profile,
      }),
    );
    setChatModel(resolveChatModelId(detail.data.chatModel));
  } else if (seedAction === "clear") {
    setSeededId(null);
    setDraft(null);
    setDirty(false);
    setChatModel(resolveChatModelId(null));
  }

  const save = async (): Promise<boolean> => {
    if (!draft) return false;
    const gen = editGenRef.current;
    setSaving(true);
    const result = await charactersApi.update(characterId, {
      name: draft.name,
      tags: draft.tags,
      profile: draft.profile,
    });
    setSaving(false);
    if (result.ok) {
      // Edits made while the save was in flight stay marked unsaved.
      if (editGenRef.current === gen) setDirty(false);
      toast.push({ title: "Character saved", tone: "success" });
      detail.reload({ silent: true });
      return true;
    }
    toast.push({ title: "Save failed", description: result.error.message, tone: "error" });
    return false;
  };

  /**
   * In-sheet Forge (character-sheet-forge.plan.md): complete every empty part
   * of the sheet from what the player entered; never overwrites it. Typed
   * content is committed BEFORE the LLM runs (save-first, abort on failure),
   * and the generated additions land as an unsaved draft — the save bar is the
   * review/undo step.
   */
  const forgeFill = async () => {
    if (!draft || forging || redrafting || saving) return;
    if (dirty && !(await save())) return;
    setForging(true);
    const result = await charactersApi.forge({ mode: "fill", draft });
    setForging(false);
    if (!result.ok) {
      toast.push({ title: "Forge failed", description: result.error.message, tone: "error" });
      return;
    }
    const { draft: filled, diagnostics } = result.data;
    setForgeDiagnostics(diagnostics);
    // Fill-merge over the CURRENT draft so edits made while the request was in
    // flight also beat the generated content.
    editGenRef.current += 1;
    setDraft((current) => (current ? mergeFillDraft(current, filled) : filled));
    setDirty(true);
    toast.push({ title: "Sheet forged", description: "Review the additions, then save.", tone: "success" });
  };

  /**
   * Per-tab Re-draft (character-sheet-forge.plan.md): rewrite ONE tab from the
   * whole sheet, narrator-formatted. Same save-first discipline as the Forge;
   * the scope merge keeps player-set attribute/trait values and reports any
   * conflicts as diagnostics instead of applying them.
   */
  const redraft = async (scope: CharacterSheetScope) => {
    if (!draft || forging || redrafting || saving) return;
    if (dirty && !(await save())) return;
    setRedrafting(scope);
    const result = await charactersApi.forge({ mode: "redraft", scope, draft });
    setRedrafting(null);
    if (!result.ok) {
      toast.push({ title: "Re-draft failed", description: result.error.message, tone: "error" });
      return;
    }
    const { draft: redrafted, diagnostics } = result.data;
    setForgeDiagnostics(diagnostics);
    editGenRef.current += 1;
    setDraft((current) => (current ? mergeRedraftScope(current, redrafted, scope) : redrafted));
    setDirty(true);
    toast.push({ title: "Tab re-drafted", description: "Review the rewrite, then save.", tone: "success" });
  };

  /**
   * Portrait → attributes (character-sheet-forge.plan.md slice 3): a vision
   * pass over the canonical avatar fills unset appearance attributes;
   * disagreements with existing values surface as diagnostics, never applied.
   */
  const derivePortrait = async () => {
    if (!draft || forging || redrafting || derivingPortrait || saving) return;
    if (dirty && !(await save())) return;
    setDerivingPortrait(true);
    const result = await charactersApi.attributesFromPortrait(characterId, draft);
    setDerivingPortrait(false);
    if (!result.ok) {
      toast.push({ title: "Portrait read failed", description: result.error.message, tone: "error" });
      return;
    }
    const { draft: derived, diagnostics, portrait } = result.data;
    setForgeDiagnostics(diagnostics);
    editGenRef.current += 1;
    // Same fill-merge as the Forge: additions only, current draft wins.
    setDraft((current) => (current ? mergeFillDraft(current, derived) : derived));
    setDirty(true);
    if (portrait.conflicts.length || portrait.filled.length) {
      // Conflicts pre-checked: the button's purpose is "accept what the picture shows".
      setAcceptedIds(new Set(portrait.conflicts.map((c) => c.id)));
      setPortraitReview(portrait);
    } else {
      toast.push({ title: "Portrait read", description: "Nothing new was visible — the sheet already matches.", tone: "success" });
    }
  };

  /** Apply the checked portrait values over the sheet's (source stays AI-owned). */
  const applyPortraitReview = () => {
    const review = portraitReview;
    setPortraitReview(null);
    if (!review) return;
    const accepted = review.conflicts.filter((c) => acceptedIds.has(c.id));
    if (accepted.length === 0) return;
    const byId = new Map(accepted.map((c) => [c.id, c.proposed]));
    editGenRef.current += 1;
    setDraft((current) =>
      current
        ? {
            ...current,
            profile: {
              ...current.profile,
              attributes: current.profile.attributes.map((a) =>
                byId.has(a.id) ? { ...a, value: byId.get(a.id) as typeof a.value, source: "creation" as const } : a,
              ),
            },
          }
        : current,
    );
    setDirty(true);
    toast.push({
      title: `Applied ${accepted.length} portrait value${accepted.length === 1 ? "" : "s"}`,
      description: "Review the sheet, then save.",
      tone: "success",
    });
  };

  /**
   * Persist the chat-tab narrator pick immediately (save-on-update), out-of-band
   * from the SaveBar. PATCHes are serialized through a promise chain so rapid
   * picks can't overlap and land out of order server-side (the unguarded version
   * could persist a stale pick, codebase-review A10); a pick superseded before
   * its turn is skipped entirely.
   */
  const saveChatModel = (modelId: string) => {
    setChatModel(modelId);
    const gen = ++chatModelGenRef.current;
    chatModelChainRef.current = chatModelChainRef.current.then(async () => {
      if (gen !== chatModelGenRef.current) return; // a newer pick superseded this one
      const result = await charactersApi.update(characterId, { chatModel: modelId });
      if (gen !== chatModelGenRef.current) return;
      if (!result.ok) {
        toast.push({ title: "Couldn't save the chat model", description: result.error.message, tone: "error" });
      }
    });
  };

  const remove = async () => {
    setDeleting(true);
    const result = await charactersApi.remove(characterId);
    setDeleting(false);
    if (result.ok) {
      toast.push({ title: "Character deleted" });
      router.push("/characters");
    } else {
      toast.push({ title: "Delete failed", description: result.error.message, tone: "error" });
      setConfirmDelete(false);
    }
  };

  if (detail.loading && !draft) {
    return (
      <PageContainer>
        <Skeleton className="mb-6 h-8 w-64" />
        <SkeletonText lines={6} />
      </PageContainer>
    );
  }

  if (detail.error && !draft) {
    return (
      <PageContainer>
        <ErrorState error={detail.error} onRetry={() => detail.reload()} />
      </PageContainer>
    );
  }

  if (!draft) return null;

  return (
    <PageContainer>
      <div className="mb-6 flex items-center justify-between gap-4">
        <h1 className="prose-display text-2xl">{draft.name || "Untitled character"}</h1>
        <div className="flex items-center gap-3">
          <Button
            onClick={() => void forgeFill()}
            busy={forging}
            disabled={saving || redrafting !== null}
            title="Complete every empty part of the sheet from what you've entered — never changes what you wrote. Saves your edits first."
          >
            ✦ Forge the rest
          </Button>
          {detail.data ? <PublishToggle kind="character" id={characterId} visibility={detail.data.visibility} /> : null}
        </div>
      </div>
      <CharacterEditor
        draft={draft}
        onChange={(next) => {
          editGenRef.current += 1;
          setDraft(next);
          setDirty(true);
        }}
        characterId={characterId}
        avatarImageId={detail.data?.avatarImageId ?? null}
        onAvatarChanged={() => detail.reload({ silent: true })}
        chatModel={chatModel}
        onChatModelChange={(modelId) => void saveChatModel(modelId)}
        onRedraft={(scope) => void redraft(scope)}
        redrafting={redrafting}
        onPortraitAttributes={() => void derivePortrait()}
        derivingPortrait={derivingPortrait}
        diagnostics={forgeDiagnostics}
      />
      <SaveBar
        dirty={dirty}
        saving={saving}
        onSave={save}
        secondary={
          <Button variant="danger" size="sm" onClick={() => setConfirmDelete(true)}>
            Delete
          </Button>
        }
      />
      <Dialog
        open={portraitReview !== null}
        onClose={() => setPortraitReview(null)}
        title="Review portrait changes"
        footer={
          <>
            <Button onClick={() => setPortraitReview(null)}>Keep sheet values</Button>
            <Button variant="primary" onClick={applyPortraitReview} disabled={acceptedIds.size === 0 && (portraitReview?.conflicts.length ?? 0) > 0}>
              {portraitReview?.conflicts.length ? `Apply checked (${acceptedIds.size})` : "Done"}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4 text-sm">
          {portraitReview?.conflicts.length ? (
            <div className="flex flex-col gap-2">
              <p className="text-paper-300">The portrait disagrees with the sheet — check what the picture should win:</p>
              {portraitReview.conflicts.map((conflict) => {
                const label = attributeRegistry.byId(conflict.id as never)?.label ?? conflict.id;
                return (
                  <label key={conflict.id} className="flex items-start gap-2 rounded-md border border-ink-600 bg-ink-850 px-2.5 py-2">
                    <input
                      type="checkbox"
                      checked={acceptedIds.has(conflict.id)}
                      onChange={(e) =>
                        setAcceptedIds((prev) => {
                          const next = new Set(prev);
                          if (e.target.checked) next.add(conflict.id);
                          else next.delete(conflict.id);
                          return next;
                        })
                      }
                      className="mt-0.5"
                    />
                    <span className="min-w-0">
                      <span className="text-paper-200">{label}:</span>{" "}
                      <span className="text-paper-500 line-through">{formatPortraitValue(conflict.current)}</span>
                      {" → "}
                      <span className="text-accent-300">{formatPortraitValue(conflict.proposed)}</span>
                    </span>
                  </label>
                );
              })}
            </div>
          ) : null}
          {portraitReview?.filled.length ? (
            <div className="flex flex-col gap-1">
              <p className="text-paper-300">Filled in from the portrait (was empty):</p>
              <ul className="flex flex-col gap-0.5 text-xs text-paper-400">
                {portraitReview.filled.map((entry) => (
                  <li key={entry.id}>
                    {attributeRegistry.byId(entry.id as never)?.label ?? entry.id}: {formatPortraitValue(entry.value)}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </Dialog>
      <Dialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title="Delete this character?"
        footer={
          <>
            <Button onClick={() => setConfirmDelete(false)}>Cancel</Button>
            <Button variant="danger" busy={deleting} onClick={remove}>
              Delete
            </Button>
          </>
        }
      >
        This removes {draft.name || "the character"} from your library. Sessions keep their own snapshots.
      </Dialog>
    </PageContainer>
  );
}
