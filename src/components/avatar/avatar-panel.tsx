"use client";

import {
  type AtmosphereLabel,
  type AvatarCue,
  type ChatPulseTrace,
  deriveReactionBeat,
  EMPTY_AVATAR_MANIFEST,
  type ReactionLabel,
} from "@/contracts";
import { charactersApi } from "@/lib/client/api";
import { useAsyncData } from "@/components/hooks/use-async";
import { MoodChip } from "@/components/ui/mood-chip";
import { cx } from "@/components/ui/cx";
import { SpriteAvatar } from "./sprite-avatar";

export interface AvatarPanelProps {
  characterId: string;
  name: string;
  /** Canonical avatar — the base/fallback frame while the manifest loads or lacks a frame. */
  avatarImageId: string | null;
  /** Baseline cue from the chat snapshot (reaction always `none` here). */
  cue: AvatarCue;
  /** Last pulse trace — the one-shot beat is derived from its valence/concept. */
  trace: ChatPulseTrace;
  /**
   * Increments once per fresh reply (the chat's reply edge). `0` on mount ⇒ no beat; a
   * change keys a single beat replay. Polls don't bump it, so beats never replay on a
   * status refresh — the spec's hysteresis without a timer.
   */
  beatTick: number;
  className?: string;
}

/** A very subtle scene-tone wash (cue.environment.atmosphere). `calm` ⇒ none. */
const ATMOSPHERE_TINT: Record<AtmosphereLabel, string | null> = {
  calm: null,
  warm: "linear-gradient(180deg, rgba(212,161,96,0.10), transparent 60%)",
  romantic: "linear-gradient(180deg, rgba(244,114,182,0.12), transparent 65%)",
  tense: "linear-gradient(180deg, rgba(80,90,120,0.18), transparent 60%)",
  ominous: "linear-gradient(180deg, rgba(40,40,60,0.30), transparent 55%)",
  melancholy: "linear-gradient(180deg, rgba(90,110,150,0.16), transparent 60%)",
  hopeful: "linear-gradient(180deg, rgba(210,184,133,0.12), transparent 60%)",
};

/**
 * The standing companion panel (avatar-3d.plan.md, slice 2): a portrait-sized avatar that
 * emotes live as the chat progresses, mounted beside the conversation. It derives the
 * one-shot reaction beat from the latest pulse trace (mild beat — the strong laugh/flinch
 * tier needs the real magnitude, which session-play threads later) and fetches the asset
 * manifest once. Degrades gracefully: no manifest / no frames ⇒ the base portrait with
 * procedural life only.
 */
export function AvatarPanel({ characterId, name, avatarImageId, cue, trace, beatTick, className }: AvatarPanelProps) {
  const manifest = useAsyncData(() => charactersApi.avatarManifest(characterId), [characterId]);
  const resolved = manifest.data ?? EMPTY_AVATAR_MANIFEST;

  const beatReaction: ReactionLabel =
    beatTick > 0 && trace.valence
      ? deriveReactionBeat(
          { valence: trace.valence, magnitude: 1, band: "", hint: "" },
          trace.concept ?? undefined,
          cue.character.emotion,
        )
      : "none";

  const tint = ATMOSPHERE_TINT[cue.environment.atmosphere];

  return (
    <div className={cx("flex flex-col gap-2", className)}>
      <div className="relative aspect-[3/4] overflow-hidden rounded-card border border-ink-600 bg-ink-950/40 shadow-lift">
        <SpriteAvatar
          cue={cue}
          manifest={resolved}
          fallbackImageId={avatarImageId}
          name={name}
          beat={{ key: beatTick, reaction: beatReaction }}
          className="absolute inset-0"
        />
        {tint ? (
          <div
            className="pointer-events-none absolute inset-0 transition-[background] duration-1000"
            style={{ background: tint }}
            aria-hidden
          />
        ) : null}
      </div>
      <div className="flex items-center justify-between gap-2 px-0.5">
        <MoodChip emotion={{ label: cue.character.emotion, intensity: cue.character.intensity }} className="text-xs" />
      </div>
    </div>
  );
}
