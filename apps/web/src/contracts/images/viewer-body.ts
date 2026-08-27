import type { RegionExposure } from "../items/visibility";

/**
 * The **viewer's own body** in a POV scene image.
 *
 * Scene images are shot through the player's eyes, and until now the player was
 * *absolutely* absent — a useful lie, since the fiction constantly puts their hands on
 * someone and the image couldn't show it. This is the closed vocabulary of what may enter
 * frame as theirs.
 *
 * **A registry, not free text** (CLAUDE.md: registries are the extension point), because
 * the phrasing is the whole feature. Two failure modes bound every line here:
 *
 * 1. **Third-person men.** Naming a body part without binding it to the camera makes the
 *    model paint a whole second person into the room. What prevents that is NOT a negative
 *    — "no man in frame" anchors on *man*, exactly as the literal "no camera" once anchored
 *    on cameras (the scar recorded on `SCENE_POV_RULE`). It is **possessive binding** ("the
 *    viewer's own") plus **frame geometry**: a limb cropped by the frame edge and strongly
 *    foreshortened cannot be composed as a standing subject. The person-count assertion in
 *    `sceneFramingRule` does the rest.
 * 2. **Anatomy through clothing.** `requiresBare` is the gate, and it is deliberately
 *    *coverage*, not judgment — see `resolveViewerParts`.
 *
 * PURE. Tuning a phrase is a data edit here; adding a part is one entry.
 */

export const viewerBodyPartIds = ["hands", "forearms", "lap_thighs", "legs_feet", "torso", "genitals"] as const;
export type ViewerBodyPartId = (typeof viewerBodyPartIds)[number];

export interface ViewerBodyPart {
  id: ViewerBodyPartId;
  /**
   * The frame-geometry phrase — what makes this a POV limb rather than a subject. Always
   * possessive-bound and always cropped/foreshortened; never a bare noun.
   */
  framing: string;
  /** Intimate ⇒ rides only an uncensored route, exactly like `sceneRevealAppearance`. */
  intimate: boolean;
  /**
   * The `RegionExposure` key that must read bare/sheer for this part to be renderable at
   * all; `null` ⇒ ungated. Only anatomy is gated — a **clothed** torso or lap in frame is a
   * perfectly good POV element, so those are ungated and simply render whatever they have on.
   */
  requiresBare: keyof RegionExposure | null;
  /**
   * The persona attributes that describe THIS part (slice 4) — so a shot with only the
   * viewer's hands in frame doesn't state their leg hair. Registry ids; unknown ones are
   * ignored downstream. `skin.tone` is added for any part (see `VIEWER_SKIN_ATTRIBUTE_IDS`)
   * — it is the one fact that must not drift between scenes, since arms that change colour
   * shot to shot read as a different person.
   */
  attributeIds: readonly string[];
}

/**
 * Stated whenever the viewer has ANY body in frame: the facts that make the limbs read as
 * one consistent person rather than a stock hand. Deliberately tiny — this rides the
 * prompt budget alongside everything else.
 */
export const VIEWER_SKIN_ATTRIBUTE_IDS = ["skin.tone", "build.frame"] as const;

export const viewerBodyParts: readonly ViewerBodyPart[] = [
  {
    id: "hands",
    framing: "the viewer's own hands entering frame from the lower edge, close to the lens and strongly foreshortened",
    intimate: false,
    requiresBare: null,
    attributeIds: ["hands.size", "hands.texture", "hands.nails"],
  },
  {
    id: "forearms",
    framing: "the viewer's own forearms entering frame from the lower edge, foreshortened, cropped where the frame cuts them",
    intimate: false,
    requiresBare: null,
    attributeIds: ["arms.build", "arms.hair"],
  },
  {
    id: "lap_thighs",
    framing: "the viewer's own thighs across the bottom of the frame, seen from above as they look down at their own lap",
    intimate: false,
    requiresBare: null,
    attributeIds: ["legs.build", "legs.hair"],
  },
  {
    id: "legs_feet",
    framing: "the viewer's own legs receding away from the lens toward the lower frame edge, feet at the far end",
    intimate: false,
    requiresBare: null,
    attributeIds: ["legs.build", "legs.hair", "legs.length", "feet.size"],
  },
  {
    id: "torso",
    framing: "the viewer's own chest and stomach along the bottom of the frame, foreshortened as they look down over themselves",
    intimate: false,
    requiresBare: null,
    attributeIds: ["build.musculature", "chest.hair", "skin.markings"],
  },
  {
    id: "genitals",
    framing: "the viewer's own genitals in the immediate foreground, close to the lens and cropped by the lower frame edge",
    intimate: true,
    requiresBare: "pelvis",
    attributeIds: [],
  },
];

export function viewerBodyPartById(id: string): ViewerBodyPart | undefined {
  return viewerBodyParts.find((p) => p.id === id);
}

export interface ResolveViewerPartsArgs {
  /** The proposed part ids (the composer's pick). Unknown ids drop. */
  proposed: readonly string[];
  /** The PLAYER's coverage, computed from their worn items (persona-library slice 8). */
  exposure?: RegionExposure;
  /** Does the render route permit intimate detail? (Uncensored reference edit: yes; the bare-prompt fallback: no.) */
  allowIntimate?: boolean;
}

/**
 * **The gate: the composer proposes, coverage disposes.**
 *
 * The ask was for the composer to withhold anatomy when the player is dressed. This puts
 * the mechanism in code instead, for a reason worth keeping: the composer runs with
 * `allowIntimate: false` whatever model its seam picks — which is *precisely* why the
 * character's intimate anatomy has always been injected at render assembly rather than
 * through it, and stays true however bold the composer model gets (owner ruling
 * 2026-08-10: exposure gating is code's job regardless of the model choice). `exposedRegions(playerWorn).pelvis === "covered"` is a boolean. Wearing pants
 * makes the part **structurally unavailable**: it never enters the plan, so there is no
 * prompt text to leak and nothing to talk the model out of.
 *
 * Three filters, in order — unknown id, then route, then coverage:
 *
 * - an id not in the registry drops (the composer invented it);
 * - an intimate part drops unless the route allows it;
 * - a `requiresBare` part drops unless that region reads `bare` or `sheer`. **Missing
 *   coverage counts as covered** — the same default-shut rule the chat intimate gate uses
 *   (`chatSceneIsIntimate`): a scene that has established nothing earns nothing.
 *
 * Order is preserved and duplicates collapse, so the caller's phrasing stays stable.
 */
export function resolveViewerParts(args: ResolveViewerPartsArgs): ViewerBodyPart[] {
  const seen = new Set<string>();
  const out: ViewerBodyPart[] = [];
  for (const id of withDerivedIntimateParts(args.proposed)) {
    const part = viewerBodyPartById(id.trim());
    if (!part || seen.has(part.id)) continue;
    if (part.intimate && args.allowIntimate !== true) continue;
    if (part.requiresBare !== null) {
      const region = args.exposure?.[part.requiresBare];
      if (region !== "bare" && region !== "sheer") continue;
    }
    seen.add(part.id);
    out.push(part);
  }
  return out;
}

/**
 * Parts whose presence means the shot is **already looking down the viewer's own body** —
 * the only framing in which their genitals are plausibly in view at all.
 */
const LOOKING_DOWN_PART_IDS: readonly string[] = ["lap_thighs", "torso"];

/**
 * Derive the intimate parts the composer is structurally unable to ask for (slice 4).
 *
 * The composer has no intimate vocabulary — it runs `allowIntimate: false` whatever
 * model its seam picks — so `genitals` can never be *proposed*. It has to be
 * **earned**, deterministically, the way `sceneRevealAppearance` is:
 *
 * - the shot must already be looking down the viewer's body (`lap_thighs` or `torso` in
 *   frame). Hands in frame is a hand on someone's cheek, not a view of your own crotch;
 * - and then the ordinary gate still applies — `resolveViewerParts` drops it unless the
 *   pelvis reads bare/sheer AND the route is uncensored.
 *
 * So three independent conditions must all hold, and the two that matter (coverage, route)
 * are code, not judgment. **This rule is a guess worth revisiting** — it is the one piece of
 * the feature with no owner ruling behind it (recorded as an open question in the plan).
 */
function withDerivedIntimateParts(proposed: readonly string[]): readonly string[] {
  const lookingDown = proposed.some((id) => LOOKING_DOWN_PART_IDS.includes(id.trim()));
  if (!lookingDown || proposed.some((id) => id.trim() === "genitals")) return proposed;
  return [...proposed, "genitals"];
}
