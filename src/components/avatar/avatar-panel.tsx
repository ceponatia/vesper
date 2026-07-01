"use client";

import { useEffect, useRef } from "react";
import {
  type AtmosphereLabel,
  type AvatarCue,
  deriveReactionBeat,
  EMPTY_AVATAR_MANIFEST,
  type ReactionLabel,
} from "@/contracts";
import { charactersApi } from "@/lib/client/api";
import { useAsyncData } from "@/components/hooks/use-async";
import { MoodChip } from "@/components/ui/mood-chip";
import { cx } from "@/components/ui/cx";
import { SpriteAvatar } from "./sprite-avatar";

/**
 * A source-agnostic one-shot beat input (avatar-3d.plan.md §"In-session beat"): the panel
 * derives the `ReactionLabel` from this, so each surface builds its own (character-chat from
 * the chat pulse trace at magnitude 1; in-session play from the real merge reaction beat with
 * its evaluated magnitude). `valence: null` ⇒ no beat.
 */
export interface AvatarBeatInput {
  valence: "like" | "dislike" | null;
  /** Evaluated reaction magnitude — drives the strong-tier beat (laugh/flinch vs nod/sigh). */
  magnitude: number;
  concept?: string | null;
}

export interface AvatarPanelProps {
  characterId: string;
  name: string;
  /** Canonical avatar — the base/fallback frame while the manifest loads or lacks a frame. */
  avatarImageId: string | null;
  /** Baseline cue (reaction always `none` here — the beat rides `beat`/`beatTick`). */
  cue: AvatarCue;
  /** The latest one-shot beat input; null ⇒ no beat. Fires only when `beatTick` changes. */
  beat: AvatarBeatInput | null;
  /**
   * Increments once per fresh reaction edge (chat reply / new session turn). `0` ⇒ no beat;
   * a change keys a single replay. Polls don't bump it, so beats never replay on a refresh —
   * the spec's hysteresis without a timer.
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

/** A novel emotion's frame is lazy-generated server-side; refetch the manifest after ~this long. */
const LAZY_GEN_POLL_MS = 5_000;

/**
 * The standing companion panel (avatar-3d.plan.md): a portrait-sized avatar that emotes live
 * as the conversation/session progresses. It fetches the asset manifest once, **lazy-gens** a
 * missing expression frame on demand (then refetches), and pulses a one-shot beat off the
 * latest reaction. Degrades gracefully: no manifest / no frames ⇒ the base portrait with
 * procedural life only.
 */
export function AvatarPanel({ characterId, name, avatarImageId, cue, beat, beatTick, className }: AvatarPanelProps) {
  const manifest = useAsyncData(() => charactersApi.avatarManifest(characterId), [characterId]);
  const resolved = manifest.data ?? EMPTY_AVATAR_MANIFEST;
  const reload = manifest.reload;

  // Lazy-gen: when the current sustained emotion has no frame (and isn't `neutral`, which
  // falls back to the base portrait), request it once, then refetch the manifest so it swaps
  // in when ready. The ref guard is mutated inside the effect (never render) and the
  // setState-bearing reload runs only after the await — strict-react-hooks safe.
  const currentEmotion = cue.character.emotion;
  // Wait for the real manifest before deciding a frame is missing — until it loads, `resolved`
  // is the EMPTY manifest (every frame reads absent), which would fire a redundant POST on
  // every mount even when the frame already exists.
  const loaded = manifest.data !== null;
  const hasFrame = currentEmotion in resolved.expressions;
  const requestedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!loaded || currentEmotion === "neutral" || hasFrame) return;
    const key = `${characterId}:${currentEmotion}`;
    if (requestedRef.current.has(key)) return;
    requestedRef.current.add(key);
    let active = true;
    void (async () => {
      const res = await charactersApi.requestExpression(characterId, currentEmotion);
      if (!active) return;
      if (!res.ok) {
        requestedRef.current.delete(key); // allow a later retry (e.g. a 429)
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, LAZY_GEN_POLL_MS));
      if (active) reload({ silent: true });
    })();
    return () => {
      active = false;
    };
  }, [characterId, currentEmotion, hasFrame, loaded, reload]);

  const beatReaction: ReactionLabel =
    beatTick > 0 && beat?.valence
      ? deriveReactionBeat(
          { valence: beat.valence, magnitude: beat.magnitude, band: "", hint: "" },
          beat.concept ?? undefined,
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
