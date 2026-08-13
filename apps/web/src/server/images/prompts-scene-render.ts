import type { SceneVisualReferenceKind } from "@vesper/image-core";
import { resolveViewerParts, type ViewerBodyPart } from "@/contracts/images/viewer-body";
import { viewerBodyAppearance } from "./prompts-appearance";
import { capitalizeFirst, excerpt } from "./prompts-format";
import { normalizeName, type SceneCharacterSpec, type SceneRenderPlan } from "./prompts-scene-plan";
import { PORTRAIT_IDENTITY_LOCK } from "./prompts-variant";

/** The final scene render instruction, assembled from a resolved plan under a length budget. */

// ---------------------------------------------------------------------------
// Scene render prompt (final image instruction)
// ---------------------------------------------------------------------------

/** The hard POV opening of every scene render prompt (limb-noun-free form, 2026-07-29). */
// The framing must name NO limb, in any polarity. "The player is the camera"
// made image models paint hands gripping a camera; its replacement "no hands or
// held objects in frame" summoned disembodied foreground hands; and the first
// fix attempt — an enumerated possession line, "every hand, arm, leg and foot
// belongs to Mira" — STILL painted a phantom viewer hand (phantom-limb A/B,
// scripts/eval/scene-images/phantom-limb-ab.ts): even a possessively-bound
// enumeration summons what it names. What held up (3/3 clean) is this opening +
// the person-count assertion + an abstract possession clause ("every visible
// body part belongs to Mira") appended by sceneFramingRule — plus the pose
// text's own limbs bound to the character by bindLimbsToOwner.
export const SCENE_POV_RULE =
  "First-person POV through the player's own eyes; the player is never visible in the image.";

/**
 * The shot's framing rule (scene-pov-embodiment.plan.md slice 1) — the disembodied
 * form when the viewer has no body in frame, the **embodied** variant when they do.
 *
 * BOTH forms are built from positives (the "no camera" scar: a negative anchors the
 * model on exactly what it forbids). The disembodied form (2026-07-29, phantom-limb
 * fix) is {@link SCENE_POV_RULE} + the person-count assertion + a total-possession
 * binding — the pose text constantly names the character's hands and feet ("one hand
 * holding a cup", "barefoot"), and without an owner the model composes them as the
 * VIEWER's foreground limbs.
 *
 * The embodied variant's job is to put a limb in frame without the model promoting it into
 * a whole second person. Three things do that work, and none of them is a negative:
 *
 * 1. **Possessive binding** — "the viewer's own", never "a man's". No subject noun for the
 *    player, ever; the registry's phrases carry this.
 * 2. **Frame geometry** — cropped by the frame edge, strongly foreshortened. A limb the
 *    frame cuts through cannot be composed as someone standing there.
 * 3. **A person-count assertion** — the positive form of "no third person", and the
 *    realistic-model analogue of the booru `solo focus` tag. Derived from the featured
 *    list, never hardcoded.
 *
 * The reference-edit route helps too: the base image is the character's portrait, so the
 * composition is already anchored on her and a foreground forearm is a small edit rather
 * than a recomposition.
 */
export function sceneFramingRule(args: {
  /** The viewer's parts in frame, already gated (`resolveViewerParts`). Empty ⇒ the disembodied rule. */
  parts?: readonly ViewerBodyPart[];
  /** Everyone fully in frame — the count assertion's subjects. */
  subjects?: readonly string[];
  /** The viewer's own body facts for those parts (`viewerBodyAppearance`) — keeps them one person. */
  body?: string;
  /** The viewer's exposure-gated intimate anatomy; the caller emits it only on an uncensored route. */
  intimate?: string;
}): string {
  const parts = args.parts ?? [];
  const names = (args.subjects ?? []).map((n) => n.trim()).filter(Boolean);
  if (parts.length === 0) {
    return [SCENE_POV_RULE, countAssertion(names), limbPossession(names)].filter(Boolean).join(" ");
  }
  const body = args.body?.trim();
  const intimate = args.intimate?.trim();
  return [
    "First-person POV through the viewer's own eyes; the viewer's face and head are never in frame.",
    countAssertion(names),
    `Also in frame, in the viewer's immediate foreground: ${joinPhrases(parts.map((p) => p.framing))}.`,
    // The facts ride AFTER the geometry deliberately: the model has to know these limbs are
    // the viewer's and cropped before it is told what they look like, or a described body
    // is just an invitation to paint a whole person wearing it.
    body ? `The viewer's own body: ${body}.` : "",
    intimate ? `${capitalizeFirst(intimate)}.` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

/** "Exactly one person is fully in frame: Mira." — the positive form of "no third person". */
function countAssertion(names: readonly string[]): string {
  if (names.length === 0) return "No other person is in frame.";
  const count = names.length === 1 ? "Exactly one person is" : `Exactly ${numberWord(names.length)} people are`;
  return `${count} fully in frame: ${joinPhrases(names)}. Nobody else appears.`;
}

/**
 * "Every visible body part belongs to Mira." — the total-possession binding for the
 * disembodied shot (2026-07-29). Deliberately ABSTRACT: the first draft enumerated the
 * limbs ("every hand, arm, leg and foot…") and the A/B run painted a phantom viewer
 * hand anyway — a limb noun summons a limb even when possessively bound. Binding
 * specific limbs is the POSE text's job (`bindLimbsToOwner`), where the limb is
 * already in the shot on purpose. "" with no subjects (location-only shot).
 *
 * With a cast, the owners are NAMED rather than left as "one of them". The proven
 * sentence binds possession to a name, and the anonymous form kept the abstraction
 * while dropping the binding — which is the half doing the work. "or" rather than
 * "and", because each part belongs to exactly one of them.
 */
function limbPossession(names: readonly string[]): string {
  if (names.length === 0) return "";
  return `Every visible body part belongs to ${joinPhrases(names, "or")}.`;
}

/** Small-number words; past the cap the digit reads fine and never occurs in practice. */
function numberWord(n: number): string {
  return ["zero", "one", "two", "three", "four", "five"][n] ?? String(n);
}

/** "a, b and c" — an Oxford-less join, since these are prompt phrases and not prose. */
function joinPhrases(items: readonly string[], conjunction: "and" | "or" = "and"): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} ${conjunction} ${items[items.length - 1]}`;
}

/**
 * The selfie framing (chat-selfies.plan.md) — the exact INVERSE of the scene POV
 * rule: the subject's own phone camera, subject aware of the lens and composing
 * the shot. Positive phrasing only (a literal "no camera" would anchor the model
 * on cameras); a mirror shot may legitimately show the phone.
 */
export const SELFIE_FRAMING =
  "A casual phone selfie the subject is taking of herself: framed at arm's length or in a mirror, the subject aware of the camera and composing the shot — direct eye contact with the lens or a deliberate glance away, natural close-quarters phone perspective, candid everyday lighting. No one else in frame.";

export interface SceneRenderOptions {
  /**
   * Shot framing: the default player-POV scene rule, or the selfie inversion
   * (chat-selfies.plan.md — the subject's own camera). Applies on every route.
   */
  framing?: "pov" | "selfie";
  /**
   * Force the viewer's parts, bypassing the plan + gate. Tests and the eval harness only —
   * the render path derives them from `plan.viewerBody` ∩ coverage ∩ this route's
   * `allowIntimate`, which is why the gate lives in the builder and not the caller.
   */
  viewerParts?: readonly ViewerBodyPart[];
  /** Name of the character the reference image identity-locks (single-reference edit); omit for text-to-image. */
  referenceName?: string;
  /** Uncensored route: emit exposed intimate-anatomy detail (Decision 3). Off for the moderated text-to-image fallback. */
  allowIntimate?: boolean;
  /**
   * Multi-reference edit (spec §5): the ordered
   * reference images fed to the provider — the present characters' avatars plus
   * the location image — so the prompt can map each image to who/what it depicts.
   * When set, builds the multi-reference composition prompt (every listed
   * character is identity-locked by an image, not described textually) instead
   * of the single-anchor one.
   */
  multiReferences?: SceneMultiReference[];
}

/** One reference image fed to `/image/multi-edit`, in send order (first = base). */
export interface SceneMultiReference {
  name: string;
  kind: SceneVisualReferenceKind;
}

/**
 * Prompt-length budget for the reference-edit paths. Originally Venice's hard
 * limit (`Prompt exceeds 1500 character limit`); Venice is gone as of
 * 2026-08-05, and the Replicate models we run advertise far roomier caps —
 * Seedream accepts 4000 characters, though it recommends staying under 600.
 *
 * The number is KEPT at Venice's old value deliberately. It is now a
 * self-imposed quality bound rather than a provider constraint: 1500 is well
 * inside every current model's limit, and shorter prompts demonstrably steer
 * these models better than exhaustive ones. Untruncated garment descriptions
 * (followups.phase3.md §1) dominate the length, so a rich outfit or several
 * NPCs blows the budget — buildSceneRenderPrompt shrinks the variable fields to
 * fit (followups.phase3.md §6).
 */
export const EDIT_RENDER_PROMPT_LIMIT = 1500;

/**
 * The viewer's parts for THIS prompt: the plan's registry-clamped proposal, intersected
 * with the player's coverage and **this rung's** `allowIntimate`. It runs per-prompt rather
 * than once at plan time because the ladder's rungs disagree — the uncensored reference edit
 * permits intimate detail, the bare-prompt fallback does not — exactly as
 * `intimateAppearance` already works. `opts.viewerParts` is a test/eval override.
 */
function viewerPartsFor(plan: SceneRenderPlan, opts: SceneRenderOptions): readonly ViewerBodyPart[] {
  if (opts.viewerParts) return opts.viewerParts;
  return resolveViewerParts({
    proposed: plan.viewerBody,
    ...(plan.playerExposure ? { exposure: plan.playerExposure } : {}),
    allowIntimate: opts.allowIntimate === true,
  });
}

/** The whole framing clause for one route: gate the parts, then describe exactly those. */
function framingFor(plan: SceneRenderPlan, opts: SceneRenderOptions, subjects: readonly string[]): string {
  if (opts.framing === "selfie") return SELFIE_FRAMING;
  const parts = viewerPartsFor(plan, opts);
  const intimate = opts.allowIntimate && parts.some((p) => p.intimate) ? (plan.playerIntimateAppearance ?? "") : "";
  return sceneFramingRule({
    parts,
    subjects,
    body: viewerBodyAppearance(plan.playerAttributes ?? [], parts, plan.playerProfile),
    intimate,
  });
}

/**
 * Final render instruction. The single-reference rung anchors on at most ONE
 * character is identity-locked (`referenceName`); every other featured
 * character — including the focal one when the reference fell back to another
 * present NPC — is described textually from state-derived appearance/outfit.
 *
 * On the edit path (`referenceName` set) the prompt is budgeted to
 * EDIT_RENDER_PROMPT_LIMIT: the outfit and setting text are progressively
 * excerpted until it fits, with a hard clamp as a final safety net. Identity
 * lock, POV rule, pose, bare-region phrasing and the clothing-authority clause
 * are never dropped — only the verbose, lower-priority description text shrinks.
 */
export function buildSceneRenderPrompt(plan: SceneRenderPlan, opts: SceneRenderOptions = {}): string {
  const featured = [...(plan.focal ? [plan.focal] : []), ...plan.others];

  if (opts.multiReferences && opts.multiReferences.length > 0) {
    return budgetRenderPrompt((outfitCap, settingCap) => assembleMulti(plan, featured, opts, outfitCap, settingCap));
  }

  const refIndex = opts.referenceName
    ? featured.findIndex((c) => normalizeName(c.name) === normalizeName(opts.referenceName ?? ""))
    : -1;
  const reference = refIndex >= 0 ? featured[refIndex] : undefined;
  const textual = featured.filter((_, index) => index !== refIndex);

  const assemble = (outfitCap: number, settingCap: number): string => {
    const fit = makeFit(outfitCap);
    const pieces: string[] = [];
    if (reference) {
      pieces.push(PORTRAIT_IDENTITY_LOCK);
      // The age anchor is the one place the TEXT overrules the reference (owner
      // ruling 2026-07-29): the edit model over-reads an ambiguous reference's age
      // and drifts older every generation without this. Placed IMMEDIATELY after
      // the lock — adjacent to its "preserve apparent age" clause it reads as
      // qualifying that instruction, which is where the A/B probe measured the
      // ~15–20-year pull; parked later in the prompt it visibly diluted.
      if (reference.ageAnchor) pieces.push(reference.ageAnchor);
    }
    pieces.push(framingFor(plan, opts, featured.map((c) => c.name)));
    if (reference) {
      // Identity anchors reinforce the lock; the reference image stays authoritative
      // (owner constraint: these must never override the reference).
      if (reference.identityAnchors) {
        pieces.push(
          `Same person as the reference image — these features confirm it (the reference is authoritative where they differ): ${reference.identityAnchors}.`,
        );
      }
      if (reference.action) pieces.push(`Pose: ${reference.action}.`);
      // The reference portrait is waist-up — supply the figure it can't show.
      if (reference.lowerBody) pieces.push(`Body (below the portrait's framing): ${reference.lowerBody}.`);
      if (reference.outfitSummary) pieces.push(`Wearing: ${fit(reference.outfitSummary, outfitCap)}.`);
      if (reference.exposure) pieces.push(`${capitalizeFirst(reference.exposure)}.`);
      if (opts.allowIntimate && reference.intimateAppearance) pieces.push(`${capitalizeFirst(reference.intimateAppearance)}.`);
      if (!reference.outfitSummary && !reference.exposure) pieces.push("Keep the same outfit as the reference image.");
    }
    for (const c of textual) {
      const clothing = c.outfitSummary ? `wearing ${fit(c.outfitSummary, outfitCap)}` : c.exposure ? "" : "wearing casual everyday clothing";
      const intimate = opts.allowIntimate ? c.intimateAppearance : "";
      const species = c.species ? excerpt(c.species, 160) : "";
      const detail = [species, c.appearance, clothing, c.exposure, intimate, c.action].filter(Boolean).join("; ");
      const label = !reference && c === plan.focal ? "Subject" : "Also in frame";
      pieces.push(`${label}: ${c.name} — ${detail}.`);
      // The anchor-less (text-to-image) focal has no reference to mis-read, but the
      // same age drift applies to a purely textual render — state the sheet's age.
      if (!reference && c === plan.focal && c.ageAnchor) pieces.push(c.ageAnchor);
    }
    appendSceneTail(pieces, plan, featured, fit, settingCap);
    return pieces.join(" ");
  };

  // Text-to-image is unbudgeted; the reference-edit path shrinks to the char cap.
  if (!opts.referenceName) return assemble(Infinity, Infinity);
  return budgetRenderPrompt(assemble);
}

/** Per-call excerpt helper: `Infinity` cap ⇒ pass text through whole. */
function makeFit(_cap: number): (text: string, cap: number) => string {
  return (text, cap) => (cap === Infinity ? text : excerpt(text, cap));
}

/**
 * Shared tail for every scene render prompt: the clothing-authority clause (so
 * an edit model can't re-paint a shed garment), the empty-room note, and the
 * setting / lighting / mood / quality lines.
 */
function appendSceneTail(
  pieces: string[],
  plan: SceneRenderPlan,
  featured: SceneCharacterSpec[],
  fit: (text: string, cap: number) => string,
  settingCap: number,
): void {
  // Anchor clothing to wardrobe state, not the (often fully-dressed) reference image:
  // without this the edit model re-paints removed garments — a shed top stays on.
  if (featured.some((c) => c.outfitSummary || c.exposure)) {
    pieces.push("Depict only the clothing described; add no garment that is not listed.");
  }
  if (featured.length === 0) pieces.push("No people in frame — a quiet shot of the place itself.");
  if (plan.setting) pieces.push(`Setting: ${fit(plan.setting, settingCap)}.`);
  if (plan.lighting) pieces.push(`Lighting: ${plan.lighting}.`);
  if (plan.mood) pieces.push(`Mood: ${plan.mood}.`);
  pieces.push("High quality, no text, no watermark.");
}

/** Reference-edit prompts are budgeted to 1500 chars — shrink outfit/setting text until it fits. */
function budgetRenderPrompt(assemble: (outfitCap: number, settingCap: number) => string): string {
  const caps: ReadonlyArray<[number, number]> = [
    [Infinity, Infinity],
    [360, 220],
    [240, 160],
    [140, 120],
    [70, 80],
  ];
  let prompt = "";
  for (const [outfitCap, settingCap] of caps) {
    prompt = assemble(outfitCap, settingCap);
    if (prompt.length <= EDIT_RENDER_PROMPT_LIMIT) return prompt;
  }
  return clampToLimit(prompt, EDIT_RENDER_PROMPT_LIMIT);
}

/**
 * Multi-reference composition prompt for the multi-reference edit rung (spec §5):
 * every reference image is enumerated and its subject identity-locked, then each
 * featured character's pose/outfit/exposure is stated. Characters WITHOUT a
 * reference image (e.g. a third character beyond the 3-ref cap) fall back to a
 * textual face/appearance description so they still appear. Budgeted to the
 * prompt budget like the single-edit path.
 */
function assembleMulti(
  plan: SceneRenderPlan,
  featured: SceneCharacterSpec[],
  opts: SceneRenderOptions,
  outfitCap: number,
  settingCap: number,
): string {
  const fit = makeFit(outfitCap);
  const multi = opts.multiReferences ?? [];
  const refCharNames = new Set(multi.filter((m) => m.kind === "character").map((m) => normalizeName(m.name)));

  const pieces: string[] = [PORTRAIT_IDENTITY_LOCK];
  // Age anchors sit adjacent to the lock's "preserve apparent age" clause (the
  // placement the A/B probe validated); name-bound sentences keep several people
  // unambiguous in one block.
  for (const c of featured) if (c.ageAnchor) pieces.push(c.ageAnchor);
  pieces.push(framingFor(plan, opts, featured.map((c) => c.name)));
  pieces.push(`${multi.length} reference images provided — ${describeMultiReferences(multi)}`);
  pieces.push("Compose all referenced people together into one shared scene, each keeping the exact face, hair and build of their reference image.");
  // The cast-integrity clause (qwen-advanced-image-subsystem.spec.md, Stage 6).
  // The count assertion above already says how many people and names them; this
  // says what must not happen to them, which is a different failure. A render
  // handed two faces has three ways to go wrong a viewer notices instantly —
  // one person drawn twice, one person dropped, or both blended into a stranger
  // — and none is prevented by correct per-slot bindings, because each of those
  // is a statement about ONE image while the failure is about the set. Emitted
  // on two or more CHARACTER references: a lone subject cannot be swapped.
  if (refCharNames.size >= 2) {
    pieces.push(
      "Render each person exactly once, matched to their own reference image; never merge, swap, or duplicate them.",
    );
  }

  for (const c of featured) {
    const isRef = refCharNames.has(normalizeName(c.name));
    const parts: string[] = [];
    if (!isRef) {
      if (c.species) parts.push(excerpt(c.species, 160));
      // Budgeted like the outfit text. These per-person fields are the ones that
      // scale with cast size, so leaving them uncapped meant the budgeter's five
      // steps could not shrink a multi-character prompt below the limit and
      // `clampToLimit` cut the TAIL instead — taking the clothing-authority
      // clause this builder is documented never to drop. At the first step the
      // cap is Infinity, so a prompt that already fits is unchanged.
      if (c.appearance) parts.push(fit(c.appearance, outfitCap));
    }
    // Anchored characters get the identity-reinforcement phrase (reference stays authoritative).
    if (isRef && c.identityAnchors) parts.push(`matching the reference: ${fit(c.identityAnchors, outfitCap)}`);
    if (isRef && c.lowerBody) parts.push(`figure: ${fit(c.lowerBody, outfitCap)}`);
    if (c.action) parts.push(c.action);
    if (c.outfitSummary) parts.push(`wearing ${fit(c.outfitSummary, outfitCap)}`);
    else if (!c.exposure && !isRef) parts.push("wearing casual everyday clothing");
    if (c.exposure) parts.push(c.exposure);
    if (opts.allowIntimate && c.intimateAppearance) parts.push(c.intimateAppearance);
    const label = isRef ? c.name : `${c.name} (no reference image — render from this description)`;
    if (parts.length > 0) pieces.push(`${label}: ${parts.join("; ")}.`);
  }

  appendSceneTail(pieces, plan, featured, fit, settingCap);
  return pieces.join(" ");
}

/** "1) Mira and 2) Sayed are the people; 3) the location is the setting." */
function describeMultiReferences(multi: readonly SceneMultiReference[]): string {
  const parts = multi.map((m, i) => {
    const what = m.kind === "location" ? `the location (${m.name || "the setting"}) — the background/setting` : `${m.name || "a character"} — a person to include`;
    return `${i + 1}) ${what}`;
  });
  return parts.join("; ") + ".";
}

/** Last-resort hard cap: trim to a word boundary at or under the limit. */
function clampToLimit(prompt: string, limit: number): string {
  if (prompt.length <= limit) return prompt;
  const cut = prompt.slice(0, limit);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > limit - 60 ? cut.slice(0, lastSpace) : cut).trimEnd();
}
