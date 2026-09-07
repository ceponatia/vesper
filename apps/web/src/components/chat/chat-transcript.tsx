"use client";

import type { ComponentProps, RefObject, UIEventHandler } from "react";
import type { ApiError, ImageRecord } from "@/lib/client/api";
import { MessageBubble, type ChatLine } from "@/components/characters/chat-message";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/error-state";
import { Skeleton } from "@/components/ui/skeleton";
import { SceneMomentRow } from "./chat-scene-moments";

type BubbleProps = ComponentProps<typeof MessageBubble>;
interface TranscriptProps {
  lines: ChatLine[];
  loading: boolean;
  error: ApiError | null;
  onRetry: () => void;
  ready: boolean;
  hasEarlier: boolean;
  loadingEarlier: boolean;
  loadEarlier: () => Promise<void>;
  scrollRef: RefObject<HTMLDivElement | null>;
  contentRef: RefObject<HTMLDivElement | null>;
  onScroll: UIEventHandler<HTMLDivElement>;
  pinned: boolean;
  jumpToLatest: () => void;
  who: string;
  name: string;
  rosterNames: string[];
  avatarImageId: string | null;
  sending: boolean;
  archived: boolean;
  lastAssistantId: string | null;
  capabilities: Pick<BubbleProps, "canEditHistory" | "canDeleteHistory" | "canRerunFromMessage" | "canRetakeLatest">;
  privacyMode: boolean;
  sceneAnchors: Map<string, ImageRecord[]>;
  onEnlargeAvatar: () => void;
  actions: {
    editLine: NonNullable<BubbleProps["onEdit"]>;
    deleteLine: NonNullable<BubbleProps["onDelete"]>;
    rerun: (id: string) => Promise<void>;
    anotherTake: (id: string) => Promise<void>;
    switchTake: NonNullable<BubbleProps["onSwitchTake"]>;
    openRemember: (content: string) => void;
    markMoment: (id: string) => Promise<void>;
  };
}

/** Transcript presentation consumes the page's shared scene list and privacy flag. */
export function ChatTranscriptView({ lines, loading, error, onRetry, ready, hasEarlier,
  loadingEarlier, loadEarlier, scrollRef, contentRef, onScroll, pinned, jumpToLatest, who, name, rosterNames, avatarImageId,
  sending, archived, lastAssistantId, capabilities, privacyMode, sceneAnchors,
  onEnlargeAvatar, actions }: TranscriptProps) {
  return (
    <div className="relative min-h-0 flex-1">
    <div
      ref={scrollRef}
      onScroll={onScroll}
      className="h-full overflow-y-auto px-4 py-4"
    >
      <div ref={contentRef} className="mx-auto flex max-w-3xl flex-col gap-3">
        {hasEarlier && ready ? (
          <div className="flex justify-center">
            <Button size="sm" variant="quiet" busy={loadingEarlier} onClick={() => void loadEarlier()}>
              Load earlier
            </Button>
          </div>
        ) : null}
        {loading ? (
          <div className="flex flex-col gap-3">
            <Skeleton className="h-10 w-2/3" />
            <Skeleton className="h-10 w-1/2 self-end" />
            <Skeleton className="h-10 w-3/5" />
          </div>
        ) : error ? (
          <ErrorState error={error} onRetry={onRetry} />
        ) : lines.length === 0 ? (
          <p className="m-auto max-w-sm py-10 text-center text-sm text-paper-500">
            Say something to {who} to start the conversation — or let them open the scene with Prompt {who} below.
          </p>
        ) : (
          lines.map((line) => {
            const moments = sceneAnchors.get(line.id);
            return (
              <div key={line.id} className="flex flex-col gap-2">
                <MessageBubble
                  line={line}
                  name={name}
                  knownNames={rosterNames}
                  avatarImageId={avatarImageId}
                  streaming={sending}
                  takeTarget={!archived && line.id === lastAssistantId}
                  canEditHistory={capabilities.canEditHistory}
                  canDeleteHistory={capabilities.canDeleteHistory}
                  canRerunFromMessage={capabilities.canRerunFromMessage}
                  canRetakeLatest={capabilities.canRetakeLatest}
                  onEdit={actions.editLine}
                  onDelete={actions.deleteLine}
                  onRerun={(id) => void actions.rerun(id)}
                  onAnotherTake={(id) => void actions.anotherTake(id)}
                  onSwitchTake={actions.switchTake}
                  onRemember={archived ? undefined : actions.openRemember}
                  onMarkMoment={archived ? undefined : (id) => void actions.markMoment(id)}
                  onEnlargeAvatar={!privacyMode && avatarImageId ? onEnlargeAvatar : undefined}
                  privacyMode={privacyMode}
                />
                {/* Scene moments: hidden under privacy
                    mode, same as the strip — no inline thumbnail, no reachable lightbox. */}
                {!privacyMode && moments ? <SceneMomentRow images={moments} name={name} /> : null}
              </div>
            );
          })
        )}
      </div>
    </div>
    {!pinned && lines.length > 0 ? (
      <button
        type="button"
        onClick={jumpToLatest}
        className="absolute bottom-4 left-1/2 z-10 -translate-x-1/2 cursor-pointer rounded-full border border-ink-500 bg-ink-800 px-4 py-1.5 text-xs text-paper-200 shadow-lift transition-colors hover:border-accent-500 hover:text-paper-50"
      >
        ↓ Jump to latest
      </button>
    ) : null}
    </div>
  );
}
