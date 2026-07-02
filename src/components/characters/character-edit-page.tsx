"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import {
  characterDraftSchema,
  charactersApi,
  type CharacterDraft,
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

  const save = async () => {
    if (!draft) return;
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
    } else {
      toast.push({ title: "Save failed", description: result.error.message, tone: "error" });
    }
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
        {detail.data ? <PublishToggle kind="character" id={characterId} visibility={detail.data.visibility} /> : null}
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
