import { diag, type DiagnosticSink } from "@/contracts/diagnostics";
import type { RegionExposure } from "@/contracts/items/visibility";
import {
  DEFAULT_SCENE_CAMERA,
  GLANCE_WORDS,
  sceneCameraHeightById,
  sceneShotDistanceById,
  sceneSubjectOrientationById,
  type SceneCameraHeightId,
  type SceneCameraSpec,
  type SceneShotDistanceId,
  type SceneSubjectOrientationId,
} from "@/contracts/images/scene-camera";
import { cameraFromCommittedFacts, type CommittedSceneFacts } from "@/contracts/images/scene-committed";
import { sceneStagingById, stagingEvidenceFromContacts, type SceneStaging } from "@/contracts/images/scene-staging";
import type { ScenePosture } from "@/contracts/affordances/scene/vocabulary";
import { viewerBodyPartById, type ViewerBodyPartId } from "@/contracts/images/viewer-body";
import type { SceneCaptureMode } from "@vesper/image-core";
import {
  sceneEvidenceCorpus,
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
  /**
   * How the body is HELD — the composer's `pose` field, scrubbed.
   *
   * Kept apart from {@link SceneCharacterSpec.activity} because the composer
   * produces two fields and the two lower to two concepts: a body-language claim
   * and an activity claim. Joining them before the lowering is what left the
   * acting half of every scene with no concept of its own.
   */
  pose?: string;
  /** What they are DOING — the composer's `activity` field (an `others` action), scrubbed. */
  activity?: string;
  /** {@link SceneCharacterSpec.pose} and {@link SceneCharacterSpec.activity} as one phrase. */
  action: string;
  /** Deterministic occlusion-filtered outfit phrase, forced from wardrobe state. */
  outfitSummary: string;
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
   * Where the camera stands. REQUIRED, and defaulted
   * rather than optional: an absent camera is the state the whole plan exists to end, so
   * every plan states one and `DEFAULT_SCENE_CAMERA` is what "nothing moved it" looks like.
   * The render layer emits no shot line for the default, keeping today's prompts unchanged.
   */
  camera: SceneCameraSpec;
  /**
   * Who is holding the camera.
   *
   * **Absence is FIRST PERSON in this lane, never third.** The render option
   * behind it is only ever `selfie` or unset, and unset has meant the player's
   * own eyes since long before the prompt-program cutover — so the field is
   * required rather than optional, and `scene-ir` carries no shared default that
   * a `?? default` could quietly flip to an observing camera.
   */
  captureMode: SceneCaptureMode;
  /** The staged intimate configuration — present only once every gate (evidence, exposure) has passed. */
  staging?: SceneStaging;
  /**
   * The viewer's own parts in frame — registry-validated, but NOT yet gated on coverage or
   * the route. That last filter runs per rung in the scene lowering (`scene-lowering.ts`),
   * because `allowIntimate` differs per provider rung (the uncensored edit allows intimate
   * detail; the text-to-image fallback does not).
   */
  viewerBody: ViewerBodyPartId[];
  /**
   * The PLAYER's coverage, computed from their worn items — the other half of that gate.
   * Absent ⇒ treated as covered, so anatomy stays shut (the default-shut rule).
   */
  playerExposure?: RegionExposure;
}

export function emptySceneRenderPlan(): SceneRenderPlan {
  return {
    focal: null,
    others: [],
    setting: "",
    lighting: "soft natural light",
    mood: "calm",
    camera: { ...DEFAULT_SCENE_CAMERA },
    captureMode: "first_person_disembodied",
    viewerBody: [],
  };
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
 * (owner report): "flushed"/"blushing" comes
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
 * bright", "breath shallow") are the physiology we actually wanted.
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
 * wardrobe state (docs/images/pipelines/scene-images.md §Step 1 — the scene
 * composer): a focal name not in the room
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

  // One corpus for every verbatim-quote gate in this function — the narrator's replies AND
  // the player's own messages, normalized once (`sceneEvidenceCorpus` states why both).
  const corpus = normalizeEvidence(sceneEvidenceCorpus(context).join("\n"));
  const viewerBody = resolveViewerBody(spec, context, corpus, sink);
  // Committed facts for the RESOLVED focal pair — after the focal clamp, because a fact
  // about someone the composer wrongly picked is not a fact about this shot.
  const focalFacts = focalEntry ? context.committedScene?.get(normalizeName(focalEntry.name)) : undefined;
  const camera = resolveSceneCamera(spec.camera, focalFacts, focalEntry, corpus, sink);
  const staging = resolveSceneStaging(spec.staging, context, focalEntry, focalFacts, corpus, sink);
  // A surviving staging OWNS the shot: the geometry is entailed by the act it stages, so its
  // camera replaces the composer's rather than merging with it, and the viewer parts it puts
  // in frame join the plan's. The union happens HERE, after `resolveViewerBody` has run its
  // registry and evidence gates, precisely so those gates cannot drop them — a staging's
  // parts are registry data with their own evidence already spent, not a composer proposal.
  // They are still not through: `resolveViewerParts` re-gates every one per prompt on the
  // player's coverage and the route, exactly as a composer-proposed part is.
  const resolvedCamera = staging ? { ...staging.camera } : camera;
  const resolvedViewerBody = staging
    ? [...viewerBody, ...staging.viewerParts.filter((part) => !viewerBody.includes(part))]
    : viewerBody;
  // The scrub only rewrites (rather than drops) player references when the viewer actually
  // has a body in frame — otherwise "her hand on the viewer's arm" would ask for an arm the
  // shot doesn't contain.
  const embodied = Boolean(context.embodiedViewer) && resolvedViewerBody.length > 0;
  const focal = focalEntry ? characterSpec(focalEntry, spec.pose, spec.activity, embodied) : null;
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
    // A featured bystander gets ONE field from the composer, and it answers "what
    // are they doing in frame" — so it lowers as an activity. Both halves compile
    // into the same prompt segment, so nothing about the sentence changes; what
    // would change is the provenance, if a single action were filed as a posture
    // the composer never claimed.
    others.push(characterSpec(entry, "", other.action, embodied));
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
    others.push(characterSpec(entry, "", "", embodied));
    sink?.push(
      diag("info", "images.scene_composer.present_character_added", "composer omitted a present character — added from the roster", {
        context: { added: entry.name, roster: roster.map((c) => c.name) },
      }),
    );
  }

  return {
    focal,
    others,
    camera: resolvedCamera,
    // Absent means the player's own eyes, not an observing camera: only a selfie
    // route ever states a mode, and every other chat scene has been first-person
    // since before the plan carried the field.
    captureMode: context.captureMode ?? "first_person_disembodied",
    ...(staging ? { staging } : {}),
    viewerBody: resolvedViewerBody,
    ...(context.playerExposure ? { playerExposure: context.playerExposure } : {}),
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
  /** The normalized evidence corpus — narration AND the player's own messages (scene-composition slice 1). */
  corpus: string,
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
  return groundViewerBody(kept, spec.viewerBodyEvidence, corpus, sink);
}

/** A quote shorter than this (normalized) proves nothing — "his hand" matches half of any transcript. */
const VIEWER_EVIDENCE_MIN_CHARS = 12;

/** Keep only the parts whose evidence quote is a verbatim (normalized) substring of the corpus. */
function groundViewerBody(
  parts: readonly ViewerBodyPartId[],
  evidence: ReadonlyArray<{ part: string; quote: string }>,
  transcript: string,
  sink?: DiagnosticSink,
): ViewerBodyPartId[] {
  if (parts.length === 0) return [];
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

// ---------------------------------------------------------------------------
// Camera and staging
// ---------------------------------------------------------------------------

/**
 * Postures that put the focal body BELOW a standing viewer.
 *
 * Spelled out rather than "anything but standing" for the reason
 * `contracts/images/scene-committed.ts` spells its copy out: a sixth posture joining the
 * vocabulary should force a decision here instead of silently inheriting one.
 */
const LOWERED_POSTURES: readonly ScenePosture[] = ["sitting", "kneeling", "crouching", "lying"];

/**
 * The same four postures as the composer writes them — the roster's `posture` is free text
 * ("curled in an armchair", "kneeling by the hearth"), not a vocabulary member.
 */
const LOWERED_POSTURE_TEXT = /\b(kneel\w*|crouch\w*|sitting|sits|seated|lying|lies)\b/i;

/**
 * The posture waiver for a looking-DOWN camera: she is kneeling and the viewer is not, so the
 * downward angle is entailed by the pose the composer already wrote and demanding a separate
 * quote for it would be asking the fiction to state geometry twice.
 *
 * `low` gets no equivalent: a camera looking UP at a standing subject is a claim about the
 * VIEWER's body being low, which nothing in the focal's posture can establish.
 *
 * A committed viewer posture closes the waiver outright — with both postures known,
 * `cameraFromCommittedFacts` has already ruled on the height and its answer is a fact rather
 * than an inference.
 */
function postureImpliesHighCamera(
  facts: CommittedSceneFacts | undefined,
  focalEntry: ScenePresentCharacter | null,
): boolean {
  if (facts?.viewerPosture !== undefined) return false;
  const committed = facts?.focalPosture;
  if (committed !== undefined) return LOWERED_POSTURES.includes(committed);
  return LOWERED_POSTURE_TEXT.test(focalEntry?.posture ?? "");
}

/**
 * The composer's camera proposal, resolved to registry ids — committed facts first, then id
 * lookup, then the evidence gate, then the posture waiver.
 *
 * Every degradation lands on `DEFAULT_SCENE_CAMERA`, and the render layer emits nothing at
 * all for that shot: a camera problem must never fail a render, and a scene with no grounding
 * evidence must render exactly as it does today.
 */
function resolveSceneCamera(
  proposal: SceneSpec["camera"],
  facts: CommittedSceneFacts | undefined,
  focalEntry: ScenePresentCharacter | null,
  corpus: string,
  sink?: DiagnosticSink,
): SceneCameraSpec {
  const quote = normalizeEvidence(proposal.evidence);
  const grounded = quote.length >= VIEWER_EVIDENCE_MIN_CHARS && corpus.includes(quote);
  const proposed = {
    orientation: proposal.orientation.trim(),
    distance: proposal.distance.trim(),
    height: proposal.height.trim(),
  };

  const state = facts ? cameraFromCommittedFacts(facts) : {};
  // The one upgrade a proposal may make to committed state (owner ruling 2026-08-10): state
  // knows which way she is TURNED and says nothing about whether she looked back, so a
  // grounded glance quote refines a committed `away` rather than contradicting it.
  const glanceUpgrade =
    state.orientation === "away" && proposed.orientation === "away_glance_back" && grounded && GLANCE_WORDS.test(quote);

  const invalid: Record<string, string> = {};
  const replaced: Record<string, string> = {};
  const ungrounded: string[] = [];

  let orientation: SceneSubjectOrientationId = DEFAULT_SCENE_CAMERA.orientation;
  let orientationFromState = false;
  if (state.orientation !== undefined && !glanceUpgrade) {
    orientation = state.orientation;
    orientationFromState = true;
    if (proposed.orientation && proposed.orientation !== orientation) replaced.orientation = proposed.orientation;
  } else {
    const entry = sceneSubjectOrientationById(proposed.orientation);
    if (entry) orientation = entry.id;
    // An empty string is the composer declining to answer, not an off-registry id — the same
    // silence `focal_clamped` passes over.
    else if (proposed.orientation) invalid.orientation = proposed.orientation;
  }

  let distance: SceneShotDistanceId = DEFAULT_SCENE_CAMERA.distance;
  if (state.distance !== undefined) {
    distance = state.distance;
    if (proposed.distance && proposed.distance !== distance) replaced.distance = proposed.distance;
  } else {
    const entry = sceneShotDistanceById(proposed.distance);
    if (entry) distance = entry.id;
    else if (proposed.distance) invalid.distance = proposed.distance;
  }

  let height: SceneCameraHeightId = DEFAULT_SCENE_CAMERA.height;
  let heightFromState = false;
  if (state.height !== undefined) {
    height = state.height;
    heightFromState = true;
    if (proposed.height && proposed.height !== height) replaced.height = proposed.height;
  } else {
    const entry = sceneCameraHeightById(proposed.height);
    if (entry) height = entry.id;
    else if (proposed.height) invalid.height = proposed.height;
  }

  // The evidence gate runs ONLY on fields the composer still owns: a field replaced from
  // committed state carries provenance, which is a stronger claim than any prose quote.
  if (!orientationFromState && sceneSubjectOrientationById(orientation)?.evidenceRequired) {
    if (!grounded) {
      ungrounded.push(`orientation:${orientation}`);
      orientation = DEFAULT_SCENE_CAMERA.orientation;
    } else if (orientation === "away_glance_back" && !GLANCE_WORDS.test(quote)) {
      // Two-step: the quote grounds the behind-position, so THAT stands. Only the glance —
      // the second, separate physical claim — is refused.
      orientation = "away";
      sink?.push(
        diag("info", "images.scene_composer.glance_ungrounded", "glance-back quote carries no glance language — degraded to a full back-to-camera shot", {
          context: { quote: proposal.evidence.slice(0, 160) },
        }),
      );
    }
  }
  if (!heightFromState && sceneCameraHeightById(height)?.evidenceRequired) {
    const waived = height === "high" && postureImpliesHighCamera(facts, focalEntry);
    if (!grounded && !waived) {
      ungrounded.push(`height:${height}`);
      height = DEFAULT_SCENE_CAMERA.height;
    }
  }

  if (Object.keys(replaced).length > 0) {
    sink?.push(
      diag("info", "images.scene_render.camera_from_state", "committed scene facts replaced the composer's camera proposal", {
        context: { replaced, camera: { orientation, distance, height } },
      }),
    );
  }
  if (Object.keys(invalid).length > 0) {
    sink?.push(
      diag("warn", "images.scene_composer.camera_invalid", "composer proposed camera ids outside the registry — degraded to the default shot", {
        context: { invalid },
      }),
    );
  }
  if (ungrounded.length > 0) {
    sink?.push(
      diag("info", "images.scene_composer.camera_ungrounded", "camera facts without a verbatim quote from the transcript — degraded to the default (anti-eagerness gate)", {
        context: { ungrounded, quote: proposal.evidence.slice(0, 160) },
      }),
    );
  }
  return { orientation, distance, height };
}

/**
 * The composer's staging proposal, run through every gate that is code's job: the lane, the
 * registry, the cast, the evidence, and the subject's own coverage.
 *
 * Route gating is deliberately NOT here — an `intimate` staging is filtered per-prompt where
 * `allowIntimate` is known, exactly as the subject's intimate reveal is (`intimateReveal` on
 * the compiled program), because the ladder's rungs disagree about it. Everything below is a
 * property of the SCENE and therefore settled once.
 */
function resolveSceneStaging(
  proposal: SceneSpec["staging"],
  context: SceneComposerContext,
  focalEntry: ScenePresentCharacter | null,
  facts: CommittedSceneFacts | undefined,
  corpus: string,
  sink?: DiagnosticSink,
): SceneStaging | undefined {
  const id = proposal.id.trim();
  if (!id) return undefined;
  if (!context.embodiedViewer) {
    sink?.push(
      diag("warn", "images.scene_composer.staging_unrequested", "composer proposed a staging in a lane with no viewer body — dropped", {
        context: { proposed: id },
      }),
    );
    return undefined;
  }
  const entry = sceneStagingById(id);
  if (!entry) {
    sink?.push(
      diag("warn", "images.scene_composer.staging_invalid", "composer proposed a staging id outside the registry — dropped", {
        context: { proposed: id },
      }),
    );
    return undefined;
  }
  // The cast gate (owner ruling 2026-08-14): every entry is a two-body geometry between the
  // subject and the viewer, so a second person standing in the room makes the sentence a lie
  // about who is where — the same self-contradiction the person-count assertion prevents.
  const castFits = entry.cast === "solo" ? context.present.length === 1 : context.present.length > 0;
  if (!castFits || !focalEntry) {
    sink?.push(
      diag("info", "images.scene_composer.staging_cast_blocked", "staging cannot honestly describe this cast — dropped", {
        context: { staging: entry.id, cast: entry.cast, present: context.present.length },
      }),
    );
    return undefined;
  }
  // A provenance-carrying fact beats a prose quote: a
  // staging earns its shot from narration, and committed state outranks narration — so a
  // committed facing or posture-derived height that contradicts the geometry the entry
  // stages refuses the whole entry rather than letting its camera overwrite the fact.
  // Distance is deliberately exempt: `cameraFromCommittedFacts` maps body distance to a
  // FRAMING heuristic, while an entry's distance is its own framing choice — a spooning
  // couple is `touching`, and the entry still frames it `close` or `medium` as it likes.
  const state = facts ? cameraFromCommittedFacts(facts) : {};
  const contradicted = [
    state.orientation !== undefined && state.orientation !== entry.camera.orientation ? "orientation" : "",
    state.height !== undefined && state.height !== entry.camera.height ? "height" : "",
  ].filter(Boolean);
  if (contradicted.length > 0) {
    sink?.push(
      diag("info", "images.scene_composer.staging_contradicted", "staging geometry contradicts committed scene facts — dropped (state beats prose)", {
        context: { staging: entry.id, contradicted, state },
      }),
    );
    return undefined;
  }
  const quote = normalizeEvidence(proposal.evidence);
  const quoted = quote.length >= VIEWER_EVIDENCE_MIN_CHARS && corpus.includes(quote);
  // A committed contact on the focal pair is provenance rather than prose, so it stands in
  // for the quote where the table knows the geometry is unambiguous.
  if (!quoted && !stagingEvidenceFromContacts(facts?.contacts ?? [], entry.id)) {
    sink?.push(
      diag("info", "images.scene_composer.staging_ungrounded", "staging without a verbatim quote or a matching committed contact — dropped", {
        context: { staging: entry.id, quote: proposal.evidence.slice(0, 160) },
      }),
    );
    return undefined;
  }
  // Default-shut: an absent exposure reads as covered, so a staging whose template describes
  // bare skin can never fire on a subject whose coverage nobody computed.
  const exposure = focalEntry.exposure;
  const covered = entry.requiresBare.filter((region) => {
    const level = exposure?.[region];
    return level !== "bare" && level !== "sheer";
  });
  if (covered.length > 0) {
    sink?.push(
      diag("info", "images.scene_composer.staging_blocked", "staging needs bare regions the subject's coverage does not report — dropped", {
        context: { staging: entry.id, covered },
      }),
    );
    return undefined;
  }
  return entry;
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

/**
 * The three scrubs, run over ONE field.
 *
 * The player scrub covers the composer's text and the posture/activity fallback
 * alike (session state can carry player-referencing activity phrases too); the
 * blush scrub strips skin-colour words out of whatever survived; and the limb
 * binder then possessively binds any bare "a hand"/"one foot" to this character
 * so the image model cannot compose it as the viewer's foreground limb.
 *
 * Per field rather than over the joined phrase, now that pose and activity lower
 * to two concepts. `bindLimbsToOwner` is the load-bearing one: it is the fourth
 * part of the measured phantom-limb composite, and a half that reached a prompt
 * unbound would reopen a recorded failure.
 */
function scrubActionField(text: string, owner: string, embodied: boolean): string {
  const trimmed = text.trim().replace(/\.+$/, "");
  if (trimmed.length === 0) return "";
  return bindLimbsToOwner(scrubBlush(scrubPlayerFromAction(trimmed, { embodied })), owner);
}

function characterSpec(
  entry: ScenePresentCharacter,
  pose: string,
  activity: string,
  embodied = false,
): SceneCharacterSpec {
  // The roster fallback fires only when the composer wrote NEITHER field, which
  // is what "the composer said nothing about this person" means — a pose with an
  // empty activity is an answer, and backfilling state over it would state a
  // stale activity beside a fresh pose.
  const composed = pose.trim().length > 0 || activity.trim().length > 0;
  const scrubbedPose = scrubActionField(composed ? pose : (entry.posture ?? ""), entry.name, embodied);
  const scrubbedActivity = scrubActionField(composed ? activity : (entry.activity ?? ""), entry.name, embodied);
  return {
    name: entry.name,
    ...(entry.species ? { species: entry.species } : {}),
    pose: scrubbedPose,
    activity: scrubbedActivity,
    // The two halves as one phrase, for the readers that want the resolver's
    // whole answer about a person at once. Trailing periods were stripped per
    // field before the join — "…teasing smile.; Leading…" reads as two stitched
    // sentences rather than one phrase.
    action: [scrubbedPose, scrubbedActivity].filter(Boolean).join("; "),
    // Forced from occlusion-filtered state regardless of anything the model said; a free-text
    // override (character chat — no equippable wardrobe) wins when present.
    outfitSummary: entry.outfitDescription ?? wardrobeOutfitSummary(entry.wornVisible),
  };
}
