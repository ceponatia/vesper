import type { AttributeValue } from "@/contracts/attributes";
import { diag, type DiagnosticSink } from "@/contracts/diagnostics";
import type { RegionExposure } from "@/contracts/items/visibility";
import { viewerBodyPartById, type ViewerBodyPartId } from "@/contracts/images/viewer-body";
import type { CharacterProfile } from "@/contracts/world/profile";
import {
  formatExposure,
  type SceneComposerContext,
  type ScenePresentCharacter,
  type SceneSpec,
  wardrobeOutfitSummary,
} from "./prompts-scene-composer";

/** The resolved render plan: composer output re-validated against the present roster and wardrobe state. */

// ---------------------------------------------------------------------------
// Resolved render plan (composer output × present roster × wardrobe state)
// ---------------------------------------------------------------------------

export interface SceneCharacterSpec {
  name: string;
  /** Species phrase (label + any authored lore) for non-human casts; "" for human. */
  species?: string;
  /** What they are doing in frame. */
  action: string;
  /** Deterministic occlusion-filtered outfit phrase, forced from wardrobe state. */
  outfitSummary: string;
  /** Compact appearance phrase for textual description. */
  appearance: string;
  /** Identity-anchor phrase for the identity-locked subject — reinforces the reference image. */
  identityAnchors?: string;
  /** Apparent-age anchor sentence — TEXT-authoritative over the reference (owner ruling 2026-07-29). */
  ageAnchor?: string;
  /** SFW lower-body shape line for the identity-locked subject (the waist-up portrait's blind spot). */
  lowerBody?: string;
  /** Explicit bare-region phrase ("topless, bare chest; barefoot"), forced from coverage state; "" when fully covered or untracked. */
  exposure?: string;
  /** Visible intimate-anatomy phrase for exposed regions; emitted only on the uncensored render route. */
  intimateAppearance?: string;
}

export interface SceneRenderPlan {
  /** The focal character, resolved against the present roster; null ⇒ location-only shot. */
  focal: SceneCharacterSpec | null;
  /** Other present characters featured in the shot — never anyone absent. */
  others: SceneCharacterSpec[];
  setting: string;
  lighting: string;
  mood: string;
  /**
   * The viewer's own parts in frame — registry-validated, but NOT yet gated on coverage or
   * the route. That last filter runs per-prompt in `buildSceneRenderPrompt`, because
   * `allowIntimate` differs per provider rung (the uncensored edit allows intimate detail;
   * the text-to-image fallback does not), exactly like `intimateAppearance`.
   */
  viewerBody: ViewerBodyPartId[];
  /**
   * The PLAYER's coverage, computed from their worn items — the other half of that gate.
   * Absent ⇒ treated as covered, so anatomy stays shut (the default-shut rule).
   */
  playerExposure?: RegionExposure;
  /**
   * The persona's resolved attributes (slice 4) — the viewer's own body facts, filtered to
   * the parts in frame at render time by `viewerBodyAppearance`. Without them the viewer's
   * arms change colour between shots and read as a different person reaching in.
   */
  playerAttributes?: ReadonlyArray<AttributeValue>;
  /** The persona's profile — realized-body applicability for those attributes. */
  playerProfile?: CharacterProfile;
  /** The viewer's exposure-gated intimate anatomy; emitted only on an uncensored route. */
  playerIntimateAppearance?: string;
}

export function emptySceneRenderPlan(): SceneRenderPlan {
  return { focal: null, others: [], setting: "", lighting: "soft natural light", mood: "calm", viewerBody: [] };
}

export const normalizeName = (name: string): string => name.trim().toLowerCase();

/**
 * Deterministic backstop for player references in composer pose/activity/action text
 * (owner report 2026-07-10): the composer is instructed to translate player-directed
 * beats into solo equivalents, but a slip hands the render an unpaintable instruction
 * ("walking beside the player, a hand on his arm") that fights the POV rule. Gaze-type
 * references rewrite to the viewer ("head turned toward the player" → "toward the
 * viewer" — exactly right for a POV shot); any clause still naming the player is
 * dropped whole. Pronoun references ("his arm") are deliberately NOT scrubbed — in a
 * multi-character scene a pronoun may be another character; that case belongs to the
 * composer rule, not a regex.
 */
export function scrubPlayerFromAction(action: string, opts: { embodied?: boolean } = {}): string {
  if (!/\bplayer\b/i.test(action)) return action;
  // Gaze/orientation toward the player = toward the camera. Possessives ("at the
  // player's side") are proximity, not gaze — they fall through to the clause drop.
  const rewritten = action.replace(/\b(facing|toward|towards|at)\s+the\s+player\b(?!['’]s)/gi, "$1 the viewer");
  if (opts.embodied) {
    // With the viewer's body in frame (scene-pov-embodiment slice 3), contact is paintable
    // — so a clause naming the player is REWRITTEN to the viewer rather than dropped. The
    // composer is told to say "the viewer" already; this catches the slips, and the render
    // gate still decides whether the part it refers to is actually in frame.
    return rewritten.replace(/\bthe\s+player\b/gi, "the viewer");
  }
  return rewritten
    .split(/[;,]/)
    .map((clause) => clause.trim())
    .filter((clause) => clause.length > 0 && !/\bplayer\b/i.test(clause))
    .join(", ");
}

/**
 * Skin-colour words an image model paints as COSMETICS, not physiology
 * (scene-pov-embodiment.plan.md slice 0, owner report): "flushed"/"blushing" comes
 * back as stage blusher — a clown-makeup face. Deliberately the state-language
 * family only; `skin.undertone: rosy` is an *authored identity attribute* and is
 * never scrubbed (the registry is the author's intent, not the composer's slip).
 */
const BLUSH_WORDS = /\b(blush\w*|flush\w*|rosy|ruddy|reddening|red-faced|pink-cheeked)\b/i;

/**
 * Deterministic backstop for skin-colour words in composer-authored text (pose,
 * activity, mood). `SCENE_COMPOSER_SYSTEM` also rules against them, but the rule
 * alone is not trustworthy — the narrator's own arousal hint says "flushed skin"
 * (contracts/meters/registry.ts), so the composer reads it in the recent narration
 * and hands it straight back. Same shape as {@link scrubPlayerFromAction}: drop the
 * offending clause whole and keep the rest, since the surrounding beats ("eyes
 * bright", "breath shallow") are the physiology we actually wanted. The
 * deterministic sibling is `visualStateNote` (images/character-scene.ts) — keep the
 * two in agreement.
 */
export function scrubBlush(text: string): string {
  if (!BLUSH_WORDS.test(text)) return text;
  return text
    .split(/[;,]/)
    .map((clause) => clause.trim())
    .filter((clause) => clause.length > 0 && !BLUSH_WORDS.test(clause))
    .join(", ");
}

// The trailing lookahead skips possessive idioms ("an arm's length") and compounds ("a hand-carved rail").
const BARE_LIMB = /\b(?:a|an|one)\s+(hand|arm|leg|foot|finger|thumb|palm|wrist|knee|elbow)\b(?!['’-])/gi;
const BOTH_LIMBS = /\bboth\s+(hands|arms|legs|feet|knees|elbows)\b/gi;

/**
 * Possessively bind bare limb references to their owner: "one hand holding a cup" →
 * "Kristin's hand holding a cup" (phantom-limb fix, 2026-07-29). In a first-person
 * POV prompt an unowned limb noun is an invitation to paint it as the VIEWER's
 * foreground hand — the composer is ruled to write "her hand", and this is the
 * deterministic backstop for what slips through (same belt-and-braces as
 * {@link scrubBlush}). Deliberately conservative: only bare-article ("a/an/one")
 * and "both" limb phrases rewrite; already-possessive phrases ("her hand",
 * "the viewer's forearm") and possessive limb idioms ("an arm's length") pass
 * untouched.
 */
export function bindLimbsToOwner(text: string, owner: string): string {
  const name = owner.trim();
  if (!name) return text;
  const possessive = /s$/i.test(name) ? `${name}'` : `${name}'s`;
  return text
    .replace(BARE_LIMB, (_m, limb: string) => `${possessive} ${limb.toLowerCase()}`)
    .replace(BOTH_LIMBS, (_m, limbs: string) => `both of ${possessive} ${limbs.toLowerCase()}`);
}

/**
 * Deterministic focal pick (demo mode / clamp fallback): the present NPC
 * mentioned latest in the newest narration, else the first roster entry,
 * else "" (empty room — location-only shot).
 */
export function heuristicFocalName(
  present: ReadonlyArray<ScenePresentCharacter>,
  recentNarration: ReadonlyArray<string>,
): string {
  if (present.length === 0) return "";
  const newest = (recentNarration.at(-1) ?? "").toLowerCase();
  let best: { name: string; at: number } | null = null;
  for (const c of present) {
    const at = newest.lastIndexOf(c.name.toLowerCase());
    if (at >= 0 && (best === null || at > best.at)) best = { name: c.name, at };
  }
  return best?.name ?? present[0]?.name ?? "";
}

/**
 * Clamp the composer's spec to the present roster and force every outfit from
 * wardrobe state (docs/images/pipelines.md §Scene images): a focal name not in the room
 * is replaced by the heuristic pick (warn diagnostic), absent "others" are
 * dropped (warn diagnostic), and no character the composer invents can ever
 * reach a render prompt. With a non-empty roster the plan always has a focal.
 */
export function resolveScenePlan(
  spec: SceneSpec,
  context: SceneComposerContext,
  sink?: DiagnosticSink,
): SceneRenderPlan {
  const roster = context.present;
  const byName = new Map(roster.map((c) => [normalizeName(c.name), c]));

  let focalEntry = byName.get(normalizeName(spec.focalCharacter)) ?? null;
  if (!focalEntry && roster.length > 0) {
    if (spec.focalCharacter.trim()) {
      sink?.push(
        diag("warn", "images.scene_composer.focal_clamped", "composer picked a focal character not in the room — replaced with a present NPC", {
          context: { picked: spec.focalCharacter, roster: roster.map((c) => c.name) },
        }),
      );
    }
    const fallbackName = heuristicFocalName(roster, context.recentNarration ?? []);
    focalEntry = byName.get(normalizeName(fallbackName)) ?? roster[0] ?? null;
  }

  const viewerBody = resolveViewerBody(spec, context, sink);
  // Trailing periods stripped before the join — "…teasing smile.; Leading…" read as two
  // stitched sentences in the render prompt instead of one pose phrase.
  const focalAction = [spec.pose, spec.activity]
    .map((part) => part.trim().replace(/\.+$/, ""))
    .filter(Boolean)
    .join("; ");
  // The scrub only rewrites (rather than drops) player references when the viewer actually
  // has a body in frame — otherwise "her hand on the viewer's arm" would ask for an arm the
  // shot doesn't contain.
  const embodied = Boolean(context.embodiedViewer) && viewerBody.length > 0;
  const focal = focalEntry ? characterSpec(focalEntry, focalAction, embodied) : null;
  const seen = new Set(focalEntry ? [normalizeName(focalEntry.name)] : []);
  const others: SceneCharacterSpec[] = [];
  for (const other of spec.others) {
    const entry = byName.get(normalizeName(other.name));
    if (!entry) {
      if (other.name.trim()) {
        sink?.push(
          diag("warn", "images.scene_composer.absent_character_dropped", "composer featured a character not in the room — dropped", {
            context: { picked: other.name, roster: roster.map((c) => c.name) },
          }),
        );
      }
      continue;
    }
    if (seen.has(normalizeName(entry.name))) continue;
    seen.add(normalizeName(entry.name));
    others.push(characterSpec(entry, other.action, embodied));
  }

  // MEMBERSHIP IS THE ROSTER'S, NOT THE COMPOSER'S. The caller has already
  // decided who is in the room — the chat lane filters on `presence`, which is
  // the only location-like state chat tracks — so the composer's job is the
  // focal pick and what each person is doing, never who exists. Left to it, a
  // forgotten member produces a prompt that contradicts itself three ways: the
  // render still sends that person's identity reference, still says to compose
  // all referenced people together, and then asserts a person count that
  // excludes them. Backfilled with an empty action, which `characterSpec` fills
  // from their own posture/activity.
  for (const entry of roster) {
    if (seen.has(normalizeName(entry.name))) continue;
    seen.add(normalizeName(entry.name));
    others.push(characterSpec(entry, "", embodied));
    sink?.push(
      diag("info", "images.scene_composer.present_character_added", "composer omitted a present character — added from the roster", {
        context: { added: entry.name, roster: roster.map((c) => c.name) },
      }),
    );
  }

  return {
    focal,
    others,
    viewerBody,
    ...(context.playerExposure ? { playerExposure: context.playerExposure } : {}),
    ...(context.playerAttributes ? { playerAttributes: context.playerAttributes } : {}),
    ...(context.playerProfile ? { playerProfile: context.playerProfile } : {}),
    ...(context.playerIntimateAppearance ? { playerIntimateAppearance: context.playerIntimateAppearance } : {}),
    setting:
      spec.setting.trim() ||
      [context.locationName, context.locationDescription].filter(Boolean).join(" — ").slice(0, 300),
    lighting: spec.lighting,
    // Mood is the composer's other free-text field that reaches the render prompt
    // verbatim ("flushed, intimate") — scrubbed like pose/activity. Lighting is about
    // light, not skin, so it is left alone.
    mood: scrubBlush(spec.mood),
  };
}

/**
 * Clamp the composer's `viewerBody` proposal to the registry — the same
 * the-composer-cannot-invent-things rule as `focal_clamped` / `absent_character_dropped`
 * — then require **narration evidence** for every survivor (2026-07-29): a part stays
 * only when its `viewerBodyEvidence` quote actually appears, verbatim, in the recent
 * narration. This is the anti-eagerness gate — the deterministic alternative to a
 * second "should the player's body appear?" model call, which would carry the same
 * option-bias as the first.
 *
 * Ways to end up with nothing: the lane never asked for embodiment (the session lane —
 * it gets the disembodied rules, so a proposal here means the model ignored them), the
 * id isn't in the registry (both WARN — off-script), or the quote doesn't match the
 * transcript (INFO — the gate doing its designed job on composer eagerness).
 * Coverage and route gating do NOT happen here — they run per-prompt, where `allowIntimate`
 * is known.
 */
function resolveViewerBody(
  spec: Pick<SceneSpec, "viewerBody" | "viewerBodyEvidence">,
  context: SceneComposerContext,
  sink?: DiagnosticSink,
): ViewerBodyPartId[] {
  const proposed = spec.viewerBody;
  if (proposed.length === 0) return [];
  if (!context.embodiedViewer) {
    sink?.push(
      diag("warn", "images.scene_composer.viewer_body_unrequested", "composer proposed viewer body parts in a lane that did not ask for them — dropped", {
        context: { proposed: [...proposed] },
      }),
    );
    return [];
  }
  const kept: ViewerBodyPartId[] = [];
  const dropped: string[] = [];
  for (const id of proposed) {
    const part = viewerBodyPartById(id.trim());
    // The composer has no intimate vocabulary by design (it runs allowIntimate:false), so
    // proposing one is off-script even though the render gate would have caught it too.
    if (!part || part.intimate) dropped.push(id);
    else if (!kept.includes(part.id)) kept.push(part.id);
  }
  if (dropped.length > 0) {
    sink?.push(
      diag("warn", "images.scene_composer.viewer_body_dropped", "composer proposed viewer body parts outside its vocabulary — dropped", {
        context: { dropped, kept },
      }),
    );
  }
  return groundViewerBody(kept, spec.viewerBodyEvidence, context.recentNarration ?? [], sink);
}

/** A quote shorter than this (normalized) proves nothing — "his hand" matches half of any transcript. */
const VIEWER_EVIDENCE_MIN_CHARS = 12;

/** Keep only the parts whose evidence quote is a verbatim (normalized) substring of the recent narration. */
function groundViewerBody(
  parts: readonly ViewerBodyPartId[],
  evidence: ReadonlyArray<{ part: string; quote: string }>,
  recentNarration: readonly string[],
  sink?: DiagnosticSink,
): ViewerBodyPartId[] {
  if (parts.length === 0) return [];
  const transcript = normalizeEvidence(recentNarration.join("\n"));
  const quoteByPart = new Map<string, string>();
  for (const entry of evidence) quoteByPart.set(entry.part.trim().toLowerCase(), entry.quote);
  const grounded: ViewerBodyPartId[] = [];
  const ungrounded: string[] = [];
  for (const id of parts) {
    const quote = normalizeEvidence(quoteByPart.get(id) ?? "");
    if (quote.length >= VIEWER_EVIDENCE_MIN_CHARS && transcript.includes(quote)) grounded.push(id);
    else ungrounded.push(id);
  }
  if (ungrounded.length > 0) {
    sink?.push(
      diag("info", "images.scene_composer.viewer_body_ungrounded", "viewer body parts without a verbatim narration quote — dropped (anti-eagerness gate)", {
        context: { ungrounded, grounded },
      }),
    );
  }
  return grounded;
}

/** Normalization for the evidence substring check: case, whitespace, curly quotes, ellipses. */
function normalizeEvidence(text: string): string {
  return text
    .toLowerCase()
    .replace(/[“”«»]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/…/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function characterSpec(entry: ScenePresentCharacter, action: string, embodied = false): SceneCharacterSpec {
  return {
    name: entry.name,
    ...(entry.species ? { species: entry.species } : {}),
    // The player scrub covers the composer's text AND the posture/activity fallback
    // (session state can carry player-referencing activity phrases too); the blush
    // scrub strips skin-colour words out of whatever survived, and the limb binder
    // then possessively binds any bare "a hand"/"one foot" to this character so the
    // image model can't compose it as the viewer's foreground limb.
    action: bindLimbsToOwner(
      scrubBlush(
        scrubPlayerFromAction(action.trim() || [entry.posture, entry.activity].filter(Boolean).join("; "), { embodied }),
      ),
      entry.name,
    ),
    // Forced from occlusion-filtered state regardless of anything the model said; a free-text
    // override (character chat — no equippable wardrobe) wins when present.
    outfitSummary: entry.outfitDescription ?? wardrobeOutfitSummary(entry.wornVisible),
    appearance: entry.appearance ?? "",
    ...(entry.identityAnchors ? { identityAnchors: entry.identityAnchors } : {}),
    ...(entry.ageAnchor ? { ageAnchor: entry.ageAnchor } : {}),
    ...(entry.lowerBody ? { lowerBody: entry.lowerBody } : {}),
    exposure: formatExposure(entry.exposure, entry.wardrobeTracked),
    intimateAppearance: entry.intimateAppearance ?? "",
  };
}
