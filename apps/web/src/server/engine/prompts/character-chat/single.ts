import { attributeRegistry } from "@/contracts/attributes";
import { resolveAttributes } from "@/contracts/attributes/value";
import { isIntimateAttributeCategory } from "@/contracts/body/locations";
import { chatSceneIsIntimate } from "@/contracts/turns/chat-intimacy";
import { regardDispositionOverlays } from "@/contracts/personality/modulation";
import { dispositionBands, effectiveTraitValue, traitRegistry } from "@/contracts/personality/traits";
import { resolveTraits } from "@/contracts/personality/traits/value";
import { regardBandForValue } from "@/contracts/relationships/bands";
import { realizeBody, speciesLorePhrase } from "@/contracts/species";
import { lifeStageForAge } from "@/contracts/world/life-stage";
import { formatAge } from "@/contracts/world/profile";
import { chatPhysicalGuidanceBlock } from "../../chat-physical-guidance-render";
import { renderNarratorPrompt, type NarratorPromptGroup, type NarratorPromptNode } from "@/contracts/narrator-prompts";
import { DEFAULT_NARRATION_SHAPE, NARRATION_SHAPE_PROFILES, type NarrationShapeId } from "../constants";
import { fenceUntrusted } from "../untrusted";
import { attributionTagNode, cameraViewpointNode, contentFramingNode, intimateCraftNode, lifeStageNode, messageNotationNode, narratorBehaviorSlot, narratorCameraNode, narratorRenderMode, naturalDialogueNode, noRefusalNode, physicalStateLawNode, promptUnit, proportionalityNode, readingPlayerMessageNode, shapingNode, topicDisciplineNode, untrustedDataNoticeNode } from "../charter";
import { buildBioSection, buildMicroExemplarsSection, buildPreferencesSection, buildVoiceAnchorsSection } from "../profile-sections";
import { type CharacterChatPromptInput, type CharacterChatPromptNodes, type CharacterChatPromptParts } from "./types";
import { buildAttachmentsSection, buildResponseShapeLine, buildTurnNotes, chatCallbackLine, chatSelfieLine, narratorInputNote } from "./turn-notes";
import { buildChatIntimateSection, buildDisinhibitionSection, buildDrivesSection, buildMemorySection, buildPlansSection, buildPlayerSections, buildPlayerStateLine, buildRelationshipSection, buildSceneSection, buildSlipCorrectionLine, buildSocialFramingSection, buildStateSection, buildSupportingCastSection, buildTransientAppearanceSection, buildVoiceReanchorLine, buildVoiceRingSection, characterIntimateNote } from "./state-sections";
import { attributePhrase, buildSensoryFocusSection, buildSensorySection, chatSensoryAllowanceLine, hairOcclusionConstraint, sensoryCues, withholdHairAttributes } from "./sensory-sections";
import { context, sectionGroup } from "./composition";

/**
 * The chat rulebook. Beyond the character-embodiment rules it carries two perception
 * models, one per direction:
 * - **"Reading the player's message"** (the input
 *   side): quoted text is heard, unquoted narration is seen only where visible,
 *   interiority reaches no one (no mind-reading), a no-quotes message degrades
 *   gracefully to speech, with a worked example (these narrator models respond better
 *   to one concrete example than to three abstract rules).
 * - **The narrator-camera rules** (the output side): untagged
 *   prose is also the story's camera behind the player's eyes. Rule 4 licenses the
 *   player's involuntary perception + light reflex (never their voluntary actions,
 *   speech, decisions, or named emotions — an owner ruling), and (owner ruling
 *   2026-07-10) forbids advancing the player's story on the narrator's turn — even
 *   mundane connective beats. Rule 16 is the separation arm: when the character and
 *   player are apart, the reply follows the CHARACTER's side only, reaching the player
 *   solely through comms. Rule 12 is the attention/motion-gated visual channel (sight
 *   carries at any distance; one detail, never an inventory).
 * - **The "Message notation" legend** (the
 *   optional sigil grammar): teaches quotes = speech, `*…*` = thought (or a text when
 *   `Name:`-shaped), `_…_` = italics only, `((…))` = OOC to the storyteller, and the
 *   house reversal of the RP "asterisks = actions" habit (unquoted prose is the action
 *   channel here). It also defines the narrator's texted-reply output grammar
 *   (`*Name: …*`, which the parser round-trips from history). Static text — byte-identical
 *   across turns; the per-turn *derived* facts (who is texting whom, co-presence) ride a
 *   volatile tail note (`chatNotationNote`), never the stable prefix.
 *
 * Emitted as CLASSIFIED NODES rather than a joined
 * string: the numbers are generated from position, and a rule's craft sentences are
 * separable from the agency/perception law riding in the same rule. The numbers in
 * the notes above describe today's PRODUCTION order and are not addressable — under
 * an instruction override the survivors renumber themselves.
 */
const chatRulesNodes = (
  name: string,
  shape: NarrationShapeId,
  playerName?: string,
  minor = false,
  opts: { dominance?: number } = {},
): NarratorPromptGroup => {
  const player = playerName ?? "the user";
  return {
    kind: "group",
    id: "chat_rules",
    // Today's `[…, "", block, "", block].join("\n")` is exactly this join: an
    // interleaved "" between two entries joined by "\n" IS a "\n\n" join. Modelled
    // that way rather than as literal empties so an override that drops a craft
    // block leaves no stranded blank line behind it.
    separator: "\n\n",
    dropEmpty: true,
    children: [
      // The owner's handwritten instructions land ABOVE the rulebook, so the
      // surviving numbered rules read as the constraints that still bind it.
      // Renders "" in production, and the join above then drops it entirely.
      narratorBehaviorSlot(),
      {
        kind: "numbered_list",
        id: "chat_rules_list",
        heading: "How to respond:",
        separator: "\n",
        // Numbers are GENERATED from position — never authored into the text —
        // so an override that drops craft rules renumbers 1…n contiguously
        // instead of leaving gaps. Nothing may cite a rule by its number.
        items: [
          promptUnit(
            "stay_in_character",
            "behavior",
            `Stay fully in character as ${name}. Never break character, never mention being an AI, a model, or a chat app, never address the user as anyone but the person ${name} is talking to.`,
          ),
          // Camera & agency (legacy rules 2 and 4) + the mechanical [Name] tag contract (rule 3),
          // with their provenance, live in charter.ts (shared with the successor narrator lane).
          cameraViewpointNode({ characterName: name, playerName }),
          attributionTagNode({ characterName: name, player }),
          narratorCameraNode({ characterName: name, player }),
          promptUnit(
            "narration_shape",
            "behavior",
            `${NARRATION_SHAPE_PROFILES[shape]} Resolve the immediate beat and end on a present moment (a line, a gesture, a look), never a summary or reflection.`,
          ),
          // Pre-2026-07-10 wording (the per-reply trait quota; the queued
          // enactment measurement run validates the softened form. Rollback: restore these):
          // "6. Your Personality, Voice, and Disposition above are behavioral law, not flavor to recite. The Disposition sliders decide how you actually act: whether you open up or deflect, lead or defer, push back or go along, warm quickly or stay guarded, hold steady or flare. Let the two or three strongest pulls visibly shape THIS reply — your word choice, rhythm, what you choose to do, and how much you give — and never name, list, or recite a trait.",
          // "7. Speak and act your age: let your age and life-stage shape your diction, references, patience, and energy — sound like someone of your years.",
          promptUnit(
            "personality_law",
            "behavior",
            "Your Personality, Voice, and Disposition above are behavioral law, not flavor to recite. The Disposition sliders decide how you actually act: whether you open up or deflect, lead or defer, push back or go along, warm quickly or stay guarded, hold steady or flare. Let the traits THIS beat makes relevant govern what you notice, withhold, say, and do — the strongest pulls should be felt in your word choice, rhythm, and how much you give — but a trait is something you possess, not something you perform: never demonstrate a set number of traits per reply, and never name, list, or recite one.",
          ),
          promptUnit(
            "life_stage_register_use",
            "behavior",
            'Speak and act your age: sound like someone of your years — let your age and life-stage color your diction and references where the beat touches them, without making a show of your age every turn. When a "Life stage" block is present above, its rules are binding and override any conflicting style elsewhere.',
          ),
          // Rule 8 ("Respond directly to what ${name} just heard and saw before adding anything
          // new") retired 2026-07-14: it was a strictly weaker
          // restatement of the "Resolve, then one move" bullet that opens the Shaping block below —
          // the same instruction stated twice, once vaguely. The Shaping bullet keeps the teaching
          // (and adds what "then" may be); rules 9+ shift up one. (Rollback: restore this line as
          // rule 8 and renumber.)
          proportionalityNode(),
          topicDisciplineNode(),
          // Pre-2026-07-10 wording (the "one cue, earned" teaching now lives in
          // the deterministic per-turn Sensory-allowance line; rollback: restore these
          // two rules and the pipeline's chatCueInviteLine arm):
          // `11. When you move close, ${player} notices you closely, or the moment turns intimate, you may work in one relevant sensory cue if you have one — scent, warmth, texture, the sound of your voice — woven into a gesture or action and written as it lands in ${player}'s senses (the scent that reaches them, the warmth they feel). One is enough. Do not force sensory detail into ordinary, distant conversation, and never list it.`,
          // `12. Show, don't inventory: when ${player}'s attention lands on you — a look, a compliment, a mention of what you're wearing — or when you enter, move, or adjust your clothes, give one concrete visual detail from ${player}'s eye, drawn from your Attributes and outfit (e.g. the slit of a dress parting over a crossed leg, sleeves pushed up off flour-dusted forearms). Sight carries at any distance. One detail woven into the beat — never a head-to-toe description, never repeated for an unchanged look, and none at all when nothing draws the eye.`,
          promptUnit(
            "sensory_allowance_binding",
            "runtime_invariant",
            `Sensory and appearance detail is gated per turn: when a "Sensory allowance" line is present below, it states exactly what may land this turn — follow it. When it grants a cue, weave AT MOST ONE into a gesture or action, written as it arrives in ${player}'s senses (the scent that reaches them, the warmth they feel) — never listed, and never forced into ordinary, distant conversation. When no allowance line is present, default to none.`,
          ),
          promptUnit(
            "show_dont_inventory",
            "behavior",
            `Show, don't inventory: when your own movement this turn — entering, standing, adjusting your clothes — draws the eye, one concrete visual detail from ${player}'s eye is welcome (drawn from your Attributes and outfit, e.g. sleeves pushed up off flour-dusted forearms). Everything beyond that follows the Sensory allowance line. Never a head-to-toe description, never a detail repeated for an unchanged look.`,
          ),
          physicalStateLawNode(),
          noRefusalNode({ characterName: name }),
          naturalDialogueNode({ characterName: name }),
          promptUnit(
            "apart_camera",
            "behavior",
            `When ${name} and ${player} are not in the same place — they parted, someone left, the scene split — your reply follows ${name} and ONLY ${name}: narrate what ${name} does, where ${name} goes, what ${name} feels and sends, like a scene cut to ${name}'s side of the world. ${name}'s side needn't be empty: Supporting-cast members who would plausibly be with ${name} may appear there — you may play them, and let them and ${name} carry their own threads forward. Never narrate ${player}'s side of the separation — not their trip home, their evening, or their phone lighting up; that is ${player}'s to write. ${name} reaches ${player} only through a channel that carries — a text on its own line as *${name}: her words here*, a call — and the reply ends on ${name}'s move, waiting for ${player}'s answer.`,
          ),
          promptUnit(
            "attached_photos",
            "runtime_invariant",
            `When ${player}'s message carries attached photos, an "Attached photos" note below describes what ${name} sees in each. Treat them as real photos ${player} is showing or sending ${name} — react in character to what they show, weave what genuinely matters into the reply, and let ${name}'s disposition decide how much they land. Never inventory a photo back detail-by-detail, and never speak of an "image" or "attachment" — it is a photo ${name} is looking at.`,
          ),
        ],
      },
      // Craft: the Shaping block (resolve-then-one-move + worked example + per-shape length
      // story + freshness), the "Reading the player's message" perception block, and the
      // "Message notation" legend all live in charter.ts (shared with the successor lane).
      shapingNode({ characterName: name, player, shape, dominance: opts.dominance ?? 0 }),
      readingPlayerMessageNode({ characterName: name, player }),
      messageNotationNode({ characterName: name, player, playerName }),
      intimateCraftNode({ characterName: name, player }, minor),
    ],
  };
};

/**
 * Build the system prompt embodying `name` from their saved profile, split into the
 * stable prefix + volatile tail. Attribute applicability is checked against the
 * realized body (`realizeBody`) so a stale attribute (e.g. wings left on a character
 * after a species change) never leaks, mirroring images/prompts-*.ts and engine/scene.ts.
 *
 * Rendering is `input.instructionSource`'s call: absent or `production` ⇒ today's
 * prompt to the byte; a `test` source swaps the behavior layer for the owner's body.
 * The prefix/tail SPLIT is untouched either way — an override changes the prefix
 * (a different template is a different cache key), but the prefix stays byte-stable
 * across turns for a fixed source, which is what prefix caching actually needs.
 */
export function buildCharacterChatPromptParts(input: CharacterChatPromptInput): CharacterChatPromptParts {
  const nodes = buildCharacterChatPromptNodes(input);
  const mode = narratorRenderMode(input.instructionSource);
  return {
    prefix: renderNarratorPrompt(nodes.prefix, mode),
    tail: renderNarratorPrompt(nodes.tail, mode),
  };
}

/** The classified prefix/tail node trees behind `buildCharacterChatPromptParts`. */
export function buildCharacterChatPromptNodes(input: CharacterChatPromptInput): CharacterChatPromptNodes {
  const { name, profile } = input;
  const displayName = name.trim() || "this character";

  const realizedBody = realizeBody({
    speciesId: profile.speciesId,
    heritageId: profile.heritageId,
    bodyPlanId: profile.bodyPlanId,
    intimateRegions: profile.intimateRegions,
    bodyFeatures: profile.bodyFeatures,
  });

  // Attribute overlays resolve in provenance order:
  // the authored base, then the PERSISTED narrative overlays that evolve over the chat
  // (a recorded haircut/dye) — both stable across turns, so they render in the prefix.
  // The TRANSIENT condition overlays (a "disheveled"/"unwashed" condition shifting
  // grooming/scent/hair while active) resolve separately and surface as a volatile
  // tail block, so a condition coming or going never busts the cached prefix. Both
  // overlay sources are pre-guarded against rewriting inherent attributes (eye
  // colour, species) at their write sites. Fully covered hair is withheld HERE, at
  // the source every attribute block reads from (`withholdHairAttributes`).
  const stableResolved = withholdHairAttributes(
    resolveAttributes(profile.attributes, [...(input.state?.attributeOverlays ?? [])]),
    input.state?.hairOcclusion,
  );
  const agePhrase = formatAge(profile.age); // the character's real age (basic info) — NOT the portrait-studio-only apparent age
  // The life-stage band a bare numeric age maps to: a hint on the identity line,
  // register rules as a binding block, and the minor
  // flag fencing every intimate surface below. Fantasy/blank ages ⇒ undefined ⇒
  // no life-stage material in the prompt at all.
  const lifeStage = lifeStageForAge(profile.age);
  const minor = lifeStage?.minor ?? false;
  const species = speciesLorePhrase(profile.speciesId, profile.heritageId);

  // The chat lane's intimate gate (contracts/turns/chat-intimacy.ts) — the lane's answer
  // to the session's ExposureMask, built from the signals it actually has: either party's
  // coverage-computed bare state, or arousal. Below it, the intimate notes are ZERO tokens
  // rather than text the model is asked to ignore.
  const intimate = chatSceneIsIntimate({
    characterExposed: input.state?.outfitExposed,
    playerExposed: input.player?.exposed,
    meters: input.state?.meters,
  });

  // The authored personality sliders (traits), rendered as behavioural band
  // guidance — the SAME representation the session narrator gets via
  // engine/scene.ts, shared through `dispositionBands`. Without this the chat
  // model never saw the sliders at all, so a guarded/dominant/cold character read
  // identically to a neutral one. Everyday traits surface always; the intimate
  // ones are kept behind an "if the moment turns intimate" framing so they don't
  // colour an ordinary conversation. The prefix renders the STAGE-COLORED bands
  // (soft coloring — a warm relationship reads warmer than the authored
  // resting sliders; re-renders only on a stage change, which is cache-friendly);
  // the transient disinhibition shift (intoxication/arousal loosening
  // inhibition, guardedness, composure at render time) surfaces as a volatile
  // tail block listing just the bands it changed.
  const bandId = regardBandForValue(input.state?.regard ?? 0).id;
  // Bounded personality evolution: the persisted narrative
  // trait overlays fold onto the authored traits FIRST (the evolved resting disposition),
  // then the regard coloring shifts relative to that evolved value — so a character who
  // grew warmer over the arc reads warmer, and the coloring composes on top instead of
  // being overridden by it (condition precedence > narrative).
  const evolvedTraits = resolveTraits(profile.traits, input.state?.traitOverlays ?? []);
  const baseTraits = resolveTraits(evolvedTraits, regardDispositionOverlays(bandId, evolvedTraits));
  const everydayDisposition = dispositionBands(traitRegistry, baseTraits, { intimateOnly: false });
  // Minor fence: a minor's intimate trait bands never
  // reach the prompt, whatever an imported/forged sheet carries.
  const intimateDisposition = minor ? [] : dispositionBands(traitRegistry, baseTraits, { intimateOnly: true });
  const dispositionSection = everydayDisposition.length
    ? [
        "Disposition (your standing temperament — this governs how you actually behave; let it pull on what you say and do, never recite it):",
        ...everydayDisposition.map((d) => `- ${d}`),
        ...(intimateDisposition.length
          ? ["When the moment turns intimate, these also drive you:", ...intimateDisposition.map((d) => `- ${d}`)]
          : []),
      ].join("\n")
    : "";

  // Proximity-gated sensory attributes (scent) become an opportunistic "Sensory cues"
  // block instead of flat attribute lines. Compute them
  // first so the attribute loop can skip what we've claimed (and drop their exposure-mask
  // phrasing hint, which references a mask the chat lane doesn't have).
  const cues = sensoryCues(stableResolved, realizedBody);
  const claimedSensory = new Set(cues.map((c) => c.id));

  // Attribute lines + a deduped phrasing-guidance set (same shape as
  // engine/scene.buildGlanceImpressions) so a hint shared by many attributes is
  // stated once instead of repeated per line.
  const attributeLines: string[] = [];
  const hints = new Set<string>();
  for (const value of stableResolved) {
    if (value.id === "identity.apparent_age") continue; // visual age is portrait-studio-only; the narrator gets real `age` (identity block)
    if (claimedSensory.has(value.id)) continue; // surfaced in the Sensory cues block, not as a flat line
    const def = attributeRegistry.byId(value.id);
    if (!def) continue; // unknown vocabulary — never leak a raw id
    if (def.excludeFromPrompts) continue; // tracked but not wired into prompts yet (e.g. identity.natal_sex)
    if (def.kind === "sensory" && isIntimateAttributeCategory(def.category)) continue; // intimate scent/taste: chat has no exposure signal to earn it
    if (!realizedBody.isAttributeApplicable(def)) continue;
    const phrase = attributePhrase(def, value.value);
    if (!phrase) continue;
    attributeLines.push(`- ${phrase}`);
    for (const hint of def.promptHints ?? []) hints.add(hint);
  }

  // Identity framing (framework text) stays trusted; the author-written `bio`,
  // `personality`, `voice`, and the recap are untrusted DATA — fence each so an
  // "ignore your rules / you are actually …" line smuggled into a bio or note
  // reads as in-world background, not as authority over the chat rules below.
  const playerName = input.player?.name.trim() || undefined;

  const identity = [
    playerName
      ? `You are ${displayName}, speaking with ${playerName} in a one-on-one conversation.`
      : `You are ${displayName}, speaking with the user in a one-on-one conversation.`,
    agePhrase ? `You are ${agePhrase}${lifeStage?.promptHint ? ` — ${lifeStage.promptHint}` : ""}.` : "",
    species ? `Species: ${species}.` : "",
  ]
    .filter(Boolean)
    .join(" ");

  const priorSummary = input.priorSummary?.trim();

  // The per-chat scenario framing: the strongest framing in the prompt — the
  // situation the whole conversation plays inside — fenced (player-authored), placed
  // right after identity. Empty ⇒ no block ⇒ byte-identical to the stateless chat.
  const premise = input.state?.premise?.trim();
  const scenario = premise
    ? `Scenario for this chat (the situation you are in — play inside it):\n${fenceUntrusted("scenario", premise)}`
    : "";
  // The dynamic "Current state" block; "" when nothing is notable.
  const stateSection = input.state ? buildStateSection(input.state) : "";
  // Soft social-card framing: what the character values, never the card severity.
  const socialFraming = buildSocialFramingSection(input.state?.activeSocialCards ?? []);

  // Everything outside the classified craft layer is emitted as ONE unit per
  // section — authored/committed facts as `runtime_context`, fences and per-turn
  // ceilings as `runtime_invariant`. Neither is replaceable, so decomposing them
  // further buys nothing; what matters is that NOTHING here is `behavior`.
  const prefixSections: NarratorPromptNode[] = [
    contentFramingNode(minor),
    untrustedDataNoticeNode(),
    context("identity", identity),
    ...buildPlayerSections(input.player, playerName ?? "the user").map((text, index) =>
      context(`player_persona_${index + 1}`, text),
    ),
    context("scenario", scenario),
    context("character_bio", buildBioSection(profile.bio)),
    context("character_personality", profile.personality.trim() ? `Personality:\n${fenceUntrusted("personality", profile.personality)}` : ""),
    context("character_voice", profile.voice?.trim() ? `Voice (how you sound):\n${fenceUntrusted("voice", profile.voice)}` : ""),
    context("character_micro_exemplars", buildMicroExemplarsSection(profile.microExemplars)),
    context("character_voice_anchors", buildVoiceAnchorsSection(profile.voiceAnchors)),
    lifeStageNode(lifeStage),
    context("character_disposition", dispositionSection),
    context("relationship_law", buildRelationshipSection(input.state, displayName, playerName, profile.traits, minor)),
    context("social_framing", socialFraming),
    context("character_preferences", buildPreferencesSection(profile.preferences, playerName ?? "the user", minor)),
    context(
      "character_attributes",
      attributeLines.length
        ? `Attributes (who you are, and what ${playerName ?? "the user"} sees of you — express and show these naturally, never list them):\n${attributeLines.join("\n")}`
        : "",
    ),
    // Beside the Attributes it explains, in the prefix: the block above is already
    // keyed on the hair-occlusion band, so this line changes the prefix only when
    // that block already has.
    context(
      "hair_occlusion_constraint",
      hairOcclusionConstraint(
        input.state?.hairOcclusion,
        `${displayName}, your hair is completely covered by your headwear — none of it is visible to ${playerName ?? "the user"}.`,
      ),
    ),
    context("phrasing_guidance", hints.size ? `Phrasing guidance:\n${[...hints].map((h) => `- ${h}`).join("\n")}` : ""),
    context("sensory_cues", buildSensorySection(cues, displayName)),
    chatRulesNodes(displayName, input.narrationShape ?? DEFAULT_NARRATION_SHAPE, playerName, minor, {
      // Slice 5: the forward-move rule owns the character's dominance posture.
      dominance: effectiveTraitValue(baseTraits, "social.dominance"),
    }),
  ];

  const skipNote = input.state?.skipNote?.trim();
  // The accumulating scene block (chat scene memory), volatile because it accretes.
  const sceneSection = input.state?.sceneMemory
    ? buildSceneSection(input.state.sceneMemory, input.sceneChanged ?? false)
    : "";
  // The accumulating supporting-cast block — volatile, like Scene.
  const castSection = buildSupportingCastSection(
    input.state?.supportingCast ?? [],
    displayName,
    playerName ?? "the player",
  );
  // The compact plans block — the commitments near this turn.
  const plansSection = buildPlansSection(input.state?.plans ?? [], playerName ?? "the player");
  // The one-turn sense-targeted focus block (scope guard) — earned by the player's beat.
  const sensoryFocus = input.sensoryFocus
    ? buildSensoryFocusSection(
        input.player?.name.trim() || "the player",
        input.state,
        input.sensoryFocus,
        stableResolved,
        realizedBody,
        displayName,
      )
    : "";
  // The one-turn directives: gathered into ONE ordered
  // "Right now" block by tier — binding truths, then the ceilings that bound the reply, then
  // what the beat merely permits, then the optional grace note — instead of a dozen unranked
  // paragraphs appended in the order their features happened to ship.
  const turnNotes = buildTurnNotes([
    // — binding: what is true this turn, and how to read the message at all.
    { tier: "binding", text: input.narratorInput ? narratorInputNote(displayName, playerName ?? "the player") : "" },
    {
      // Physical consistency: what this body's
      // committed state forbids, and which of the player's physical premises must not
      // be adopted. Directly after the narrator-mode note because both are about HOW
      // to read the message; before the notation note because a fence outranks a
      // markup gloss. Flag-off ⇒ "" ⇒ the block is absent to the byte.
      tier: "binding",
      text: chatPhysicalGuidanceBlock(input.physicalGuidance),
    },
    { tier: "binding", text: input.notationNote?.trim() ?? "" },
    { tier: "binding", text: buildAttachmentsSection(input.attachments, playerName ?? "the player") },
    {
      // The authoritative story moment: the narrator reads the
      // same clock the player's clock card shows — light, meals, and routine follow it.
      tier: "binding",
      text: input.state?.storyMoment?.trim()
        ? `Story time: it is ${input.state.storyMoment.trim()}. Time-of-day texture (light, meals, routine) follows this clock.`
        : "",
    },
    { tier: "binding", text: skipNote ? `Time has passed in the story since your last exchange: ${skipNote}` : "" },
    {
      // The meanwhile pass's one-shot note: what actually happened
      // off-screen — the meanwhile license draws from THIS, never free invention.
      tier: "binding",
      text: input.state?.meanwhileNote?.trim()
        ? `While you were apart, off-screen (true — your ONE meanwhile beat comes from this, not invention; weave in at most one piece, naturally): ${input.state.meanwhileNote.trim()}`
        : "",
    },
    {
      // The one-turn return license: a pending whereabouts on a
      // present character means they JUST got back — carry one trace of it, then let it go.
      tier: "binding",
      text: input.state?.whereabouts?.trim()
        ? `You just got back — you were ${input.state.whereabouts.trim()}. You may carry ONE trace of it into the scene (texture, mood, a mention), then let it go.`
        : "",
    },
    {
      // The first-exchange scene directive (Fly screenshot, 2026-07-10): on a brand-new chat the
      // Scene block is empty and `sceneChanged` can't fire (nothing to change FROM), so no rule
      // directed scene establishment — the model got the brand-new-scene length license and spent
      // it all on dialogue. One volatile line fills that gap; sceneChanged's own directive wins
      // when a first-message movement minted a place.
      tier: "binding",
      text:
        input.firstExchange && !input.sceneChanged
          ? `First exchange of this conversation: establish the scene once — where you are, the time of day, and one or two concrete sensory details (sight plus one other sense), drawn from the scenario and what ${playerName ?? "the player"}'s message sets up. Let narration carry this opening (a paragraph or two around the dialogue, not talk alone); after this, don't re-establish what hasn't changed.`
          : "",
    },
    // — gate: the ceilings and corrections that bound the reply.
    { tier: "gate", text: sensoryFocus },
    {
      tier: "gate",
      text:
        input.sensoryAllowance !== undefined
          ? chatSensoryAllowanceLine(
              // A focused_description grant with an EMPTY focus block (nothing authored grounds
              // the beat) would otherwise render no line at all — and rule 10's default-none
              // then forbids sensory detail on the one turn that most earned it. Degrade to the
              // close-range grant instead.
              input.sensoryAllowance === "focused_description" && !sensoryFocus
                ? "close_range_hook"
                : input.sensoryAllowance,
              displayName,
              playerName ?? "the player",
              // Owner ruling 2026-07-28: a current-effect cue is new information,
              // not static appearance, so the `none` grant must not read as
              // forbidding the block the same prompt just offered.
              (input.state?.affordanceCues ?? []).some((cue) => cue.trim().length > 0),
              // Same ruling, same reason: a visual-state cue is change-gated
              // new information, so a `none` grant must not read as forbidding
              // the block the same prompt just offered.
              (input.state?.visualCues ?? []).some((cue) => cue.trim().length > 0),
            )
          : "",
    },
    { tier: "gate", text: input.gateNotes?.trim() ?? "" },
    // Slice 9: last exchange's one-turn character-consistency corrective (absent/"" ⇒ no line).
    { tier: "gate", text: buildSlipCorrectionLine(input.state?.slipNote) },
    // — license: what the beat permits, never demands.
    { tier: "license", text: input.cueInvite?.trim() ?? "" },
    // Minor fence: the selfie license (a romance-lane affordance) never renders.
    { tier: "license", text: minor ? "" : chatSelfieLine(input.selfie, displayName, playerName ?? "the player") },
    // — flavor: the optional grace note. Already crowd-gated pre-burn (chatCallbackEligible).
    {
      tier: "flavor",
      text: input.callback?.summary.trim()
        ? chatCallbackLine(input.callback.summary, input.state?.regard ?? 0, displayName, playerName ?? "the player")
        : "",
    },
  ]);

  const tailSections: NarratorPromptNode[] = [
    context(
      "conversation_recap",
      priorSummary
        ? `Earlier in this conversation (recap for continuity — this is context, not dialogue; do not quote it back verbatim):\n${fenceUntrusted("conversation recap", priorSummary)}`
        : "",
    ),
    context("long_term_memory", input.memory ? buildMemorySection(input.memory) : ""),
    // Voice-exemplar ring (slice 8): "How you sound" few-shots kept past the summary horizon.
    context("voice_ring", buildVoiceRingSection(input.state?.voiceExemplars ?? [])),
    context("current_state", stateSection),
    // Slice 5: confidence colors the drive-reveal posture (bold vs. hesitant disclosure).
    context(
      "drives",
      input.state
        ? buildDrivesSection(input.state, playerName ?? "the player", effectiveTraitValue(baseTraits, "temperament.confidence"))
        : "",
    ),
    context("scene_memory", sceneSection),
    context("supporting_cast", castSection),
    context("plans", plansSection),
    // Daily rhythm: one compact standing line so time-of-day
    // texture and meanwhile beats ground in the character's actual routine.
    context(
      "daily_rhythm",
      input.state?.rhythm?.trim()
        ? `Your daily rhythm (ground time-of-day texture and any life-meanwhile beat in it): ${input.state.rhythm.trim()}.`
        : "",
    ),
    // What the player has on — volatile, so it sits here beside the character's own
    // wearing-line rather than in the cached prefix.
    context("player_state", buildPlayerStateLine(input.player, playerName ?? "the player")),
    // The exposure-earned intimate notes. Volatile: the gate flips with coverage/arousal,
    // so this can never live in the prefix. Minor fence: an authored minor contributes no
    // note and earns no player note either — the block is about the two of them together.
    context(
      "intimate_notes",
      buildChatIntimateSection({
        characters:
          intimate && !minor && characterIntimateNote(profile) ? [{ label: "you are", note: characterIntimateNote(profile) }] : [],
        ...(intimate && !minor && input.player?.intimacy?.trim() ? { playerNote: input.player.intimacy.trim() } : {}),
        playerName: playerName ?? "the player",
      }),
    ),
    // State-derived overrides of the prefix's own blocks — data, not directives, so they
    // stay above the "Right now" digest with the rest of the standing state.
    // Minor fence: no state-driven loosening block for a minor character.
    context(
      "disinhibition_shift",
      minor ? "" : buildDisinhibitionSection(baseTraits, input.state?.meters ?? {}, everydayDisposition, intimateDisposition),
    ),
    context("transient_appearance", buildTransientAppearanceSection(input, stableResolved, realizedBody)),
    // The "Right now" digest states outright that it OVERRIDES the standing rules for
    // this turn — a per-turn ceiling, not craft, so no override may drop it.
    promptUnit("turn_notes", "runtime_invariant", turnNotes),
    // Slice 7: the one-line voice re-anchor rides beside the mood pin, near generation.
    context("voice_reanchor", buildVoiceReanchorLine(profile.voiceAnchors)),
    context(
      "response_directive",
      input.opening
        ? `Opening beat: ${playerName ?? "the player"} has not spoken yet. Begin the conversation yourself — open the scene in character, grounded in the scenario and your current state above. A line or two, ending on a present moment that invites them in. Do not narrate on their behalf.`
        : buildResponseShapeLine(input),
    ),
  ];

  return {
    prefix: [sectionGroup("chat_prefix", prefixSections)],
    tail: [sectionGroup("chat_tail", tailSections)],
  };
}

/**
 * The full system prompt — the prefix and tail joined. Callers that don't care about the
 * cache split keep using this; the split is observable via
 * `buildCharacterChatPromptParts` (and snapshot-tested for prefix stability).
 */
export function buildCharacterChatSystemPrompt(input: CharacterChatPromptInput): string {
  const { prefix, tail } = buildCharacterChatPromptParts(input);
  return [prefix, tail].filter(Boolean).join("\n\n");
}
