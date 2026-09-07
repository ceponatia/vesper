import { HAIR_LOCATION_ID } from "@/contracts/affordances";
import { attributeRegistry, promptValueWithNoneElided, type AttributeDefinition } from "@/contracts/attributes";
import { type AttributeValue } from "@/contracts/attributes/value";
import { isIntimateAttributeCategory } from "@/contracts/body/locations";
import { type HairOcclusion } from "@/contracts/items/hair-occlusion";
import { meterStateCue } from "@/contracts/meters/registry";
import { expandBodyTarget, type RealizedBody } from "@/contracts/species";
import { type ChatSensoryAllowance, type SensoryFocusHint } from "../../chat-intent";
import { type CharacterChatPromptInput } from "./types";

/**
 * The affordance cue block's heading. Declared once because TWO places name it:
 * the block itself, and the sensory-allowance line's carve-out (owner ruling
 * 2026-07-28) — a heading that drifted between them would leave the allowance
 * line exempting a block the prompt no longer calls that. Exported (with the
 * carve-out below) for the trial harness, whose splice checks must
 * subtract exactly what the cue arm adds.
 */
export const AFFORDANCE_CUE_BLOCK_HEADING = "Physical detail worth noticing this turn";

/**
 * The visual-state block headings, declared HERE beside the affordance one
 * rather than imported from `chat-visual-state-cues.ts`: the prompt builder is
 * the thing that writes them, and importing upward from `prompts/` into the
 * engine root would close an import cycle. The renderer re-exports these.
 */
export const VISUAL_STATE_CONSTRAINT_BLOCK_HEADING = "True right now — do not contradict";

export const VISUAL_STATE_CUE_BLOCK_HEADING = "Visible detail worth noticing this turn";

/**
 * The sensory-allowance carve-out sentence (owner ruling 2026-07-28: "cues
 * win"). Appended to the `none` allowance line only when the prompt actually
 * carries cue lines, so the two instructions never contradict. A pure function
 * of the character name; exported so the trial harness can reproduce the
 * cue-arm/control-arm delta without hardcoding this wording.
 */
export function chatAffordanceCueCarveOut(name: string): string {
  return ` The "${AFFORDANCE_CUE_BLOCK_HEADING}" block above is exempt: those are effects happening now, not a description of how ${name} looks — its own one-detail limit still applies.`;
}

/**
 * The same carve-out for the visual-state cue block. Separate sentence and
 * separate constant rather than a shared one:
 * the two blocks are independently flagged, and a run with only one of them on
 * must not name a block its prompt does not carry. Exported for the
 * trial harness, whose splice checks subtract exactly what the cue arm adds.
 */
export function chatVisualStateCueCarveOut(name: string): string {
  return ` The "${VISUAL_STATE_CUE_BLOCK_HEADING}" block above is exempt on the same terms: it offers what just changed or came into view about ${name}, not a description of how ${name} looks — its own one-detail limit still applies.`;
}

const humanize = (value: string): string => value.replaceAll("_", " ").trim();

/**
 * The resolved attributes the narrator may be handed, after the wardrobe's hair-occlusion
 * band (`state.hairOcclusion`, docs/contracts/items/README.md §Hair occlusion; absent ⇒
 * `none`). At `full` every attribute the registry anchors at the `hair` body location is
 * withheld — colour, length, texture, density, condition, arrangement, styling — because
 * hair nobody can see is not material the narrator may describe. `partial` and `none`
 * pass the list through untouched: some hair is still visible, so its attributes are
 * still true of what the player sees.
 *
 * The withheld set is the registry's own anchoring (`bodyLocationId`), keyed on the same
 * `HAIR_LOCATION_ID` the affordance perception view hides at `full` — one definition of
 * "the hair" for both consumers, so a hair attribute that lives under another category
 * still follows the location, and an attribute that merely mentions hair in its phrase
 * does not. Never a phrase or id-prefix match.
 *
 * This runs on the list BEFORE any block is built from it — the Attributes lines, their
 * phrasing guidance, the transient condition overrides, the sensory-focus join — so
 * nothing downstream has to cancel a line that should never have rendered. The prefix
 * re-rendering when the band crosses into or out of `full` is the intended cache cost.
 */
export function withholdHairAttributes(values: readonly AttributeValue[], band: HairOcclusion | undefined): readonly AttributeValue[] {
  if (band !== "full") return values;
  return values.filter((value) => attributeRegistry.byId(value.id)?.bodyLocationId !== HAIR_LOCATION_ID);
}

/**
 * The binding line that accompanies the withheld hair at `full`, "" otherwise. Withholding
 * alone would read as an unauthored gap the model is free to fill; this names the gap as
 * a covered head and says the missing fields are not licence to invent. `opening` is the
 * lane's own sentence naming the character (second person for the 1-on-1 prompt, third
 * for an ensemble sheet); the withholding clause is shared so the two can never drift.
 */
export function hairOcclusionConstraint(band: HairOcclusion | undefined, opening: string): string {
  if (band !== "full") return "";
  return `Covered hair (binding): ${opening} Hair colour, length, texture, and style are withheld on purpose; that is not licence to invent them — while the headwear stays on, describe it, never the hair beneath it.`;
}

/**
 * One resolved attribute → a `label: value` phrase, or null for empty/false. When the
 * definition authors a `narratorGuidance` gloss for the resolved enum member, it renders
 * as an inline parenthetical — `foot scent: cheesy (dense fermented funk…)` — so the
 * narrator knows what the value means *in this game* instead of guessing from a bare
 * token. No gloss ⇒ byte-identical to before.
 */
export function attributePhrase(
  def: Pick<AttributeDefinition, "label" | "unit" | "narratorGuidance" | "renderNoneInPrompts">,
  value: AttributeValue["value"],
): string | null {
  // "none" is elided unless the definition opts in (contracts/attributes/value.ts) —
  // "nose piercings: none" plants the very noun the narrator then riffs on.
  const rendered = promptValueWithNoneElided(def, value);
  if (rendered === null) return null;
  const glossed = (raw: string): string => {
    const text = humanize(raw);
    const gloss = def.narratorGuidance?.[raw];
    return gloss ? `${text} (${gloss})` : text;
  };
  const label = def.label.toLowerCase();
  if (typeof rendered === "boolean") return rendered ? label : null;
  if (typeof rendered === "number") return `${label}: ${rendered}${def.unit ? ` ${def.unit}` : ""}`;
  if (Array.isArray(rendered)) {
    const joined = rendered.map((v) => glossed(String(v))).join(", ");
    return joined ? `${label}: ${joined}` : null;
  }
  const text = rendered.trim() ? glossed(rendered) : "";
  return text ? `${label}: ${text}` : null;
}

interface SensoryCue {
  /** The attribute id, so the flat Attributes loop can skip what we've claimed. */
  id: string;
  /** The rendered `label: value` phrase (reused from `attributePhrase`). */
  phrase: string;
}

/**
 * Proximity-gated, non-intimate sensory attributes — surfaced as *opportunistic*
 * "use only when the beat earns it" cues instead of
 * flat attribute lines, because scent reads as embodiment when close and as a checklist
 * when listed unconditionally. The filter (kind sensory, not `voice`, not intimate)
 * resolves to `presentation.scent_baseline` today; a future non-voice/non-intimate
 * sensory attribute (a skin-warmth/texture sense) would qualify automatically.
 *
 * - **Voice is excluded** (`category === "voice"`): pitch/timbre/cadence are audible at
 *   any conversational distance, so they are NOT closeness-gated — they stay in the
 *   normal Attributes block.
 * - **Intimate scent/taste is excluded** (`isIntimateAttributeCategory`): chat carries
 *   no exposure/intimacy signal to earn it, so it surfaces nowhere here.
 *
 * Same applicability + exclusion guards as the main attribute loop, so a stale or
 * prompt-excluded attribute never leaks.
 */
export function sensoryCues(resolved: readonly AttributeValue[], realizedBody: RealizedBody): SensoryCue[] {
  const cues: SensoryCue[] = [];
  for (const value of resolved) {
    const def = attributeRegistry.byId(value.id);
    if (!def || def.kind !== "sensory") continue;
    if (def.category === "voice") continue; // audible at distance — not a closeness cue
    if (isIntimateAttributeCategory(def.category)) continue; // no exposure signal in chat earns it
    if (def.excludeFromPrompts) continue;
    if (!realizedBody.isAttributeApplicable(def)) continue;
    const phrase = attributePhrase(def, value.value);
    if (!phrase) continue;
    cues.push({ id: value.id, phrase });
  }
  return cues;
}

/**
 * The "Sensory cues" section: the character's proximity-gated senses as an
 * opportunistic hook, never a checklist. The
 * per-cue lines are `label: value` for the model's reference; the framing forbids
 * reciting them and ties any use to closeness/relevance. "" when there are no cues, so
 * the prompt stays byte-identical for an unscented character.
 */
export function buildSensorySection(cues: SensoryCue[], name: string): string {
  if (!cues.length) return "";
  return [
    "Sensory cues (use only when the beat earns them — never list them):",
    ...cues.map((c) => `- ${name}'s ${c.phrase}`),
    // Pre-2026-07-10 wording (the when-it's-earned teaching moved to the
    // per-turn Sensory-allowance line; rollback: restore this bullet):
    // "- Work a sensory detail into action only when proximity, touch, intimacy, a first impression, or " +
    //   "the player's input makes it noticeable, and write it as it arrives in the player's senses — the " +
    //   "scent that reaches them as you lean in, not a fact recited about yourself. One grounded hook woven " +
    //   "into what you do is enough — never recite a label: value, and never force sensory detail into " +
    //   "ordinary distant conversation.",
    "- These are reference values, used only when the current-turn Sensory allowance grants a cue — then " +
      "written as it arrives in the player's senses (the scent that reaches them as you lean in), never " +
      "recited as a label: value about yourself.",
  ].join("\n");
}

/**
 * The binding per-turn sensory-allowance line —
 * the single authority rules 10–11 defer to. Worded as a ceiling, not an instruction: a grant is
 * permission for at most one cue, never a demand that one appears. `focused_description` returns
 * "" because the Sensory-focus block below carries that turn's (richer) grant.
 *
 * ## The cue carve-out (owner ruling 2026-07-28: current-effect cues are exempt
 * from the sensory-allowance appearance restriction — a current effect is new
 * information, not static appearance)
 *
 * The `none` grant and the affordance cue block were contradicting each other:
 * the trial dress-rehearsal measured ~79% of cue-bearing exchanges carrying
 * "Sensory allowance this turn: none" alongside a cue line inviting the narrator
 * to weave the detail in. The no-appearance instruction exists to stop an
 * UNCHANGED look being re-described; every affordance cue is a current effect
 * with a live cause by construction, so it was never the thing that instruction
 * meant to suppress.
 *
 * This is PROMPT-PROJECTION policy, not ranking policy. The allowance is not an
 * input to selection anywhere in `contracts/affordances` — cues are chosen
 * exactly as before, and only the framing around them changes. And the carve-out
 * renders ONLY when a cue line is actually present, so with the flag off (or on
 * a quiet exchange) the line is byte-identical to today's.
 */
export function chatSensoryAllowanceLine(
  allowance: ChatSensoryAllowance,
  name: string,
  player: string,
  /** True when this turn's prompt actually carries affordance cue lines. */
  hasCurrentEffectCues = false,
  /** True when this turn's prompt actually carries visual-state cue lines. */
  hasVisualStateCues = false,
): string {
  switch (allowance) {
    case "none":
      return `Sensory allowance this turn: none — no scent, warmth, texture, or taste detail of ${name}, and no appearance description beyond what ${name}'s own movement this turn makes newly visible.${
        hasCurrentEffectCues ? chatAffordanceCueCarveOut(name) : ""
      }${hasVisualStateCues ? chatVisualStateCueCarveOut(name) : ""}`;
    case "visual_accent":
      return `Sensory allowance this turn: one visual accent — ${player}'s eye is on ${name}. You may give one concrete visual detail drawn from ${name}'s Attributes and outfit, woven into the beat and seen from ${player}'s eye. Sight only — no scent, touch, or taste detail.`;
    case "close_range_hook":
      return `Sensory allowance this turn: one close-range hook — the beat brings ${player} close. One sensory cue (scent, warmth, texture, the sound of ${name}'s voice) may land, woven into action as it reaches ${player}'s senses. One at most; never listed.`;
    case "focused_description":
      return "";
  }
}

/** Per-sense verb for the Sensory-focus heading. */
const SENSE_FOCUS_VERB: Record<SensoryFocusHint["sense"], string> = {
  smell: "breathing in",
  taste: "tasting",
  touch: "touching",
  study: "taking in",
};

/** How many of the target region's own attribute values the focus block may carry. */
const FOCUS_REGION_LINE_CAP = 6;

/**
 * Sense-relevance rank for one of the target region's attributes (lower renders first;
 * null drops it — a scent value is not studied, a taste value is not felt). The sense
 * the beat brings to bear leads; supporting texture and shape follow, because what sits
 * under lips or fingers is felt even when the beat is a taste.
 */
function focusSenseRank(sense: SensoryFocusHint["sense"], def: AttributeDefinition): number | null {
  const scent = def.id.endsWith(".scent") || def.id.endsWith(".smell");
  const taste = def.id.endsWith(".taste");
  const texture = def.id.endsWith(".texture");
  switch (sense) {
    case "smell":
      if (scent) return 0;
      if (taste) return null;
      return def.kind === "sensory" ? 1 : 2;
    case "taste":
      if (taste) return 0;
      if (scent) return 1; // this close, scent carries into taste
      if (texture) return 2;
      return def.kind === "sensory" ? 2 : 3;
    case "touch":
      if (texture) return 0;
      if (scent || taste) return null;
      return def.kind === "sensory" ? 1 : 2; // shape and size under the hand are felt
    case "study":
      if (scent || taste) return null;
      return 1;
  }
}

/** The per-sense "what the player directly experiences" clause for the focus header. */
function focusExperienceClause(sense: SensoryFocusHint["sense"], player: string): string {
  switch (sense) {
    case "smell":
      return `the scent itself — its character and strength, how it deepens as ${player} breathes in — and the warmth of skin this close`;
    case "taste":
      return `taste and texture together — skin under the tongue, its warmth, the scent that carries into taste this close`;
    case "touch":
      return `texture, temperature, the give and firmness under ${player}'s hand`;
    case "study":
      return `what ${player} actually sees this close — detail, texture, the way light and small movements play over it`;
  }
}

/**
 * The one-turn "Sensory focus" block (scope guard):
 * when the player's beat brings a sense to bear on a specific body region / garment
 * (`detectSensoryFocus`), assemble the character's AUTHORED sensory values for it — the
 * TARGET REGION's own attributes first (`expandBodyTarget` over the hint's `region`,
 * sense-ranked: a taste beat on a foot surfaces `feet.smell`, not just the perfume line),
 * then the generic grounding (baseline scent + hygiene for smell/taste, outfit + grooming +
 * close hygiene for touch/study, active conditions always). Intimate-region attributes ride
 * the same join, gated by the hint's `intimate` flag and the realized body. The directive
 * OPENS the reply with the sensation itself and holds each value's CHARACTER fixed: unfold
 * it into prose (with its `narratorGuidance` gloss inline when authored), let state deepen
 * it, never trade it for a milder or generic sensation. "" when nothing authored grounds it
 * (the builder then degrades the allowance line instead of leaving the turn grantless).
 * Volatile tail.
 */
export function buildSensoryFocusSection(
  player: string,
  state: CharacterChatPromptInput["state"] | undefined,
  hint: SensoryFocusHint,
  resolved: readonly AttributeValue[],
  realizedBody: RealizedBody,
  name: string,
): string {
  const meters = state?.meters ?? {};
  const byId = (id: string): AttributeValue | undefined => resolved.find((v) => v.id === id);
  const lines: string[] = [];
  const hygieneCue = meters.hygiene !== undefined ? meterStateCue("hygiene", meters.hygiene) : null;

  // The target region's own authored values (the core join): every attribute bound to the
  // region's body-location subtree, realized-body filtered, sense-ranked, capped. Intimate
  // categories surface ONLY when the beat targeted intimate anatomy (the hint's flag).
  const expansion = hint.region
    ? expandBodyTarget(hint.region, (def) => realizedBody.isAttributeApplicable(def))
    : undefined;
  // Whether an authored scent/taste value for the TARGET REGION rendered — when it did,
  // that value is the current truth of the region and the generic lines below must layer
  // over it (perfume as an overlay, hygiene as a deepener), never compete with it. The old
  // unconditional `Right now: clean skin, nothing strong` default sat directly under
  // `foot scent: cheesy` and the model obediently reconciled toward clean.
  let regionSenseAuthored = false;
  if (expansion) {
    const ranked = expansion.definitions
      .filter((def) => !def.excludeFromPrompts)
      .filter((def) => hint.intimate || !isIntimateAttributeCategory(def.category))
      .map((def) => ({ def, rank: focusSenseRank(hint.sense, def) }))
      .filter((entry): entry is { def: AttributeDefinition; rank: number } => entry.rank !== null)
      .sort((a, b) => a.rank - b.rank);
    for (const { def } of ranked) {
      if (lines.length >= FOCUS_REGION_LINE_CAP) break;
      const value = byId(def.id);
      if (!value) continue;
      const phrase = attributePhrase(def, value.value);
      if (!phrase) continue;
      lines.push(`- ${name}'s ${phrase}`);
      if (/\.(scent|smell|taste)$/.test(def.id)) regionSenseAuthored = true;
    }
  }

  if (hint.sense === "smell" || hint.sense === "taste") {
    const scent = byId("presentation.scent_baseline");
    if (scent && typeof scent.value === "string" && scent.value.trim()) {
      lines.push(
        `- ${name}'s usual perfume/skin scent: ${humanize(String(scent.value))}` +
          (regionSenseAuthored ? " — an overlay riding above the scent named above, never replacing it" : ""),
      );
    }
    if (hygieneCue) {
      lines.push(
        `- Right now: ${hygieneCue.hint}` +
          (regionSenseAuthored
            ? " — this DEEPENS the authored scent above: stronger and staler, never a different character."
            : ""),
      );
    } else if (!regionSenseAuthored) {
      // Nothing authored for the region and hygiene is unremarkable: give the model a
      // grounded default rather than a vacuum it would fill by invention.
      lines.push("- Right now: clean skin, nothing strong");
    }
    // With an authored region scent and unremarkable hygiene, say nothing more: the
    // authored value IS the current scent (mutable state, not a "when dirty" hypothetical).
  }

  if (hint.sense === "touch" || hint.sense === "study") {
    const outfit = state?.outfit?.trim();
    if (outfit) lines.push(`- Wearing: ${outfit}${state?.outfitExposed ? " — and more exposed than usual" : ""}`);
    const grooming = byId("presentation.grooming");
    if (grooming && typeof grooming.value === "string" && grooming.value.trim()) {
      lines.push(`- Grooming: ${humanize(String(grooming.value))}`);
    }
    if (hygieneCue) lines.push(`- Close detail: ${hygieneCue.hint}`);
  }

  for (const condition of state?.conditions ?? []) {
    if (condition.promptHint) lines.push(`- ${condition.promptHint}`);
  }

  if (!lines.length) return "";
  return [
    `Sensory focus candidate — ${player} ${SENSE_FOCUS_VERB[hint.sense]} ${name}'s ${hint.target}. ` +
      `Use this block only if the CURRENT player narration explicitly performs that action now. ` +
      `Negated, hypothetical, remembered, spoken, third-party, or storyteller wording performs no player action; ignore this block if the written beat does not prove it. ` +
      `Never add contact or movement beyond what the player wrote. If verified, OPEN your reply with the experience itself: two to four sentences of what ${player} directly perceives — ` +
      `${focusExperienceClause(hint.sense, player)} — written as sensation landing in ${player}'s senses, before ${name} reacts or the scene moves on. ` +
      `Ground it in the values below — they are the truth of what ${player} perceives, and each names the CHARACTER of a sensation. ` +
      `Unfold each into rich, specific, felt prose that stays inside what it names — never trade it for a milder, cleaner, or more generic sensation (a scent authored pungent lands pungent, not fresh, not faintly salty). ` +
      `Don't parrot a bare value word as the whole description; elaborate it. ${name}'s current state can deepen or sharpen what is authored (a long day, heat, exertion) — it never washes it away:`,
    ...lines,
  ].join("\n");
}
