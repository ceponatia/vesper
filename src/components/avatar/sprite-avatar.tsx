"use client";

import { useState } from "react";
import type { AvatarCue, AvatarManifest, ReactionLabel } from "@/contracts";
import { useReducedMotion } from "@/components/hooks/use-reduced-motion";
import { EntityImage } from "@/components/ui/entity-image";
import { cx } from "@/components/ui/cx";

/**
 * The renderer-neutral seam (avatar-3d.spec §6 / notes): every avatar renderer consumes
 * the same props — a validated cue, the per-character asset manifest, a base fallback
 * frame, and a keyed one-shot `beat`. `SpriteAvatar` is the layered-sprite implementation;
 * a future `RiveAvatar` / `ThreeVrmAvatar` swaps in behind this contract without touching
 * the cue pipeline, prompts, or saves. (A dedicated XState `AvatarDirector` is MVP work —
 * the PoC folds the small hysteresis/beat orchestration into the component below.)
 */
export interface AvatarRendererProps {
  cue: AvatarCue;
  manifest: AvatarManifest;
  /** Canonical avatar id, used when the manifest has no frame for the cue (e.g. neutral). */
  fallbackImageId?: string | null;
  name: string;
  /** A one-shot reaction beat: bump `key` to (re)play `reaction`. `none` ⇒ no beat. */
  beat: { key: number; reaction: ReactionLabel };
  className?: string;
}

/** Transform-beat → CSS class. `blush` is a color overlay (handled separately), not here. */
const BEAT_CLASS: Record<Exclude<ReactionLabel, "none" | "blush">, string> = {
  nod: "avatar-beat-nod",
  shake: "avatar-beat-shake",
  laugh: "avatar-beat-laugh",
  gasp: "avatar-beat-gasp",
  flinch: "avatar-beat-flinch",
  sigh: "avatar-beat-sigh",
  perk: "avatar-beat-perk",
};

/** Resolve the still that renders for this cue: expression frame → base → fallback. */
function resolveFrame(cue: AvatarCue, manifest: AvatarManifest, fallbackImageId?: string | null): string | null {
  return manifest.expressions[cue.character.emotion] ?? manifest.baseImageId ?? fallbackImageId ?? null;
}

/**
 * Crossfade between expression frames: the settled frame sits underneath, a changed frame
 * fades in on top and is promoted to the base when the fade completes. Under reduced
 * motion the swap is instant. State is adjusted during render (the codebase's EntityImage
 * pattern) so a new frame never waits a tick.
 */
function FrameStack({ imageId, name, reduced }: { imageId: string | null; name: string; reduced: boolean }) {
  const [shown, setShown] = useState<string | null>(imageId);
  const [incoming, setIncoming] = useState<string | null>(null);
  const [target, setTarget] = useState<string | null>(imageId);
  if (target !== imageId) {
    setTarget(imageId);
    if (reduced || imageId === null || imageId === shown) {
      setShown(imageId);
      setIncoming(null);
    } else {
      setIncoming(imageId);
    }
  }

  return (
    <div className="relative h-full w-full">
      <EntityImage imageId={shown} name={name} className="absolute inset-0 h-full w-full object-cover" />
      {incoming && incoming !== shown ? (
        <div
          key={incoming}
          className="avatar-fade-in absolute inset-0"
          onAnimationEnd={() => {
            setShown(incoming);
            setIncoming(null);
          }}
        >
          <EntityImage imageId={incoming} name={name} className="h-full w-full object-cover" />
        </div>
      ) : null}
    </div>
  );
}

export function SpriteAvatar({ cue, manifest, fallbackImageId, name, beat, className }: AvatarRendererProps) {
  const reduced = useReducedMotion();
  const frameId = resolveFrame(cue, manifest, fallbackImageId);

  // One-shot beat: adopt the latest keyed beat (skip under reduced motion), clear when its
  // animation ends. Adjusting state during render keeps it off the effect path.
  const [beatKey, setBeatKey] = useState(beat.key);
  const [playing, setPlaying] = useState<ReactionLabel | null>(null);
  if (beatKey !== beat.key) {
    setBeatKey(beat.key);
    setPlaying(reduced || beat.reaction === "none" ? null : beat.reaction);
  }

  const transformBeat = playing && playing !== "blush" && playing !== "none" ? BEAT_CLASS[playing] : undefined;

  return (
    // `relative h-full w-full` makes the renderer fill (and self-size to) the box it's given
    // and own the positioning context for the blush overlay below — never depend on the caller
    // for a height. (A caller-passed `absolute inset-0` used to lose the cascade to this
    // `relative`, collapsing the whole h-full subtree to zero height — a black box.)
    <div className={cx("relative h-full w-full overflow-hidden", className)}>
      <div className="avatar-drift h-full w-full">
        <div className="avatar-breathe h-full w-full">
          <div
            className={cx("h-full w-full transform-gpu", transformBeat)}
            onAnimationEnd={transformBeat ? () => setPlaying(null) : undefined}
          >
            <FrameStack imageId={frameId} name={name} reduced={reduced} />
          </div>
        </div>
      </div>
      {playing === "blush" ? (
        <div
          className="avatar-blush pointer-events-none absolute inset-0"
          style={{
            background: "radial-gradient(55% 38% at 50% 44%, rgba(244,114,182,0.55), transparent 72%)",
            mixBlendMode: "soft-light",
          }}
          onAnimationEnd={() => setPlaying(null)}
        />
      ) : null}
    </div>
  );
}
