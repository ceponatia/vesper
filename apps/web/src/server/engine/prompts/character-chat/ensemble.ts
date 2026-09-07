import { attributeRegistry } from "@/contracts/attributes";
import { resolveAttributes } from "@/contracts/attributes/value";
import { isIntimateAttributeCategory } from "@/contracts/body/locations";
import { conditionAttributeOverlays } from "@/contracts/conditions/overlays";
import { deriveMoodDescriptor } from "@/contracts/meters/registry";
import { chatSceneIsIntimate } from "@/contracts/turns/chat-intimacy";
import { regardDispositionOverlays, stateDispositionOverlays } from "@/contracts/personality/modulation";
import { dispositionBands, effectiveTraitValue, traitPole, traitRegistry } from "@/contracts/personality/traits";
import { resolveTraits } from "@/contracts/personality/traits/value";
import { familiarityBandForValue, regardBandForValue } from "@/contracts/relationships/bands";
import { composePairRelationshipLaw } from "@/contracts/relationships/law";
import { type RelationshipRecord, type RelationshipTexture } from "@/contracts/relationships/record";
import { realizeBody, speciesLorePhrase } from "@/contracts/species";
import { isMinorAge, lifeStageForAge, lifeStageThirdPersonLine } from "@/contracts/world/life-stage";
import { formatAge } from "@/contracts/world/profile";
import { renderNarratorPrompt, type NarratorPromptGroup, type NarratorPromptNode } from "@/contracts/narrator-prompts";
import { DEFAULT_NARRATION_SHAPE, NARRATION_SHAPE_PROFILES, type NarrationShapeId } from "../constants";
import { fenceUntrusted } from "../untrusted";
import { CONTENT_FRAMING, ENSEMBLE_MINOR_CAST_LINE, narratorBehaviorSlot, narratorRenderMode, promptUnit, untrustedDataNoticeNode } from "../charter";
import { buildBioSection, excerpt } from "../profile-sections";
import { type CharacterChatPromptInput, type CharacterChatPromptNodes, type CharacterChatPromptParts, type EnsembleMemberInput, type EnsemblePairInput, type EnsemblePromptExtras } from "./types";
import { buildAttachmentsSection, buildResponseShapeLine, buildTurnNotes, chatSelfieLine, ensembleCallbackLine, narratorInputNote } from "./turn-notes";
import { buildChatIntimateSection, buildPlanPresenceLicense, buildPlansSection, buildPlayerSections, buildPlayerStateLine, buildSceneSection, buildSupportingCastSection, characterIntimateNote, feelingPhrase } from "./state-sections";
import { attributePhrase, buildSensoryFocusSection, hairOcclusionConstraint, withholdHairAttributes } from "./sensory-sections";
import { context, sectionGroup } from "./composition";

/** Exchanges without activity at/over which a present member's blocks compress to tier 2. */
export const ENSEMBLE_QUIET_EXCHANGES = 3;

/**
 * Per-member quiet tolerance from extraversion: an
 * introvert recedes comfortably, so their sheet compresses a beat sooner; an
 * extravert stays vocal, so their full sheet holds longer before compressing.
 * Mid extraversion (or none) ⇒ exactly `ENSEMBLE_QUIET_EXCHANGES`.
 */
export function ensembleQuietThreshold(extraversion: number): number {
  const pole = traitPole(extraversion);
  return pole === "low" ? ENSEMBLE_QUIET_EXCHANGES - 1 : pole === "high" ? ENSEMBLE_QUIET_EXCHANGES + 2 : ENSEMBLE_QUIET_EXCHANGES;
}

/**
 * The one-block ensemble frame: the model
 * is the narrator of a single continuous narrative and writes EVERY roster character —
 * per-member sheets scale with presence + activity recency (full / quiet-compressed /
 * away-dropped), the player-owns-himself authority rule replaces the 1-on-1 camera
 * rules, and every spoken line is [Name]-tagged so the renderer can attribute.
 * The prefix/tail cache split survives: sheets + rules sit in the prefix (re-rendering on
 * roster/presence/tier/band change — the licensed cases); per-member state, memory
 * and the shared scene ride the volatile tail. Member sheets render THIRD person —
 * the prompt's only "you" is the player — so the full second-person pair-law block
 * stays with the relationship matrix, which owns pair rendering.
 */
export function buildEnsembleChatPromptParts(
  input: CharacterChatPromptInput,
  members: readonly EnsembleMemberInput[],
  extras: EnsemblePromptExtras = {},
): CharacterChatPromptParts {
  const nodes = buildEnsembleChatPromptNodes(input, members, extras);
  const mode = narratorRenderMode(extras.instructionSource ?? input.instructionSource);
  return {
    prefix: renderNarratorPrompt(nodes.prefix, mode),
    tail: renderNarratorPrompt(nodes.tail, mode),
  };
}

/** The classified prefix/tail node trees behind `buildEnsembleChatPromptParts`. */
export function buildEnsembleChatPromptNodes(
  input: CharacterChatPromptInput,
  members: readonly EnsembleMemberInput[],
  extras: EnsemblePromptExtras = {},
): CharacterChatPromptNodes {
  const playerName = input.player?.name.trim() || undefined;
  const player = playerName ?? "the player";

  const present = members.filter((m) => m.presence === "present");
  // Has the scene turned intimate with ANY present, non-minor member? Gates the player's
  // own note, which is chat-wide and so rendered once rather than per member.
  const ensembleIntimate = present.some(
    (m) =>
      !(lifeStageForAge(m.profile.age)?.minor ?? false) &&
      chatSceneIsIntimate({
        characterExposed: m.state?.outfitExposed,
        playerExposed: input.player?.exposed,
        meters: m.state?.meters,
      }),
  );
  const away = members.filter((m) => m.presence === "away");
  const names = members.map((m) => m.name.trim() || "an unnamed character");

  const identity = [
    `You are the narrator of an intimate, character-driven story, and you write EVERY character in it: ${names.join(", ")}.`,
    `${player} is a real person taking part in the story — the one voice that is never yours to write.`,
    "Each reply is ONE continuous narrative, never per-character sections or separate bubbles: within it the characters speak, act, and think in their own paragraphs, to the player and to each other. You are omniscient over the characters' inner lives — and only theirs.",
  ].join(" ");

  // Ruling 3 — the player owns himself; with nobody present the reply is a cutaway.
  const authority = [
    `Narration authority:`,
    `- ${player} belongs to the player alone: never write ${player}'s actions, speech, decisions, movements, or location — not even connective beats (arriving, settling in, checking a phone). You may write what ${player} perceives and the small involuntary reflexes it stirs (a caught breath, a shiver) — never their deliberate acts, and never name their emotions for them.`,
    `- Address ${player} in the second person as "you"; every character is written in the third person by name.`,
    `- Only characters marked PRESENT share ${player}'s scene. A character marked AWAY is living their own life elsewhere: they may text or call through a channel that carries, and you may cut away to what they are doing where they are — but never merge them into ${player}'s scene uninvited.`,
    `- When NO character is present with ${player}, the reply is a cutaway: show what the characters are doing where they are — never ${player}'s side of the separation.`,
  ].join("\n");

  const premise = input.state?.premise?.trim();
  const scenario = premise
    ? `Scenario for this story (the situation everyone is in — play inside it):\n${fenceUntrusted("scenario", premise)}`
    : "";

  // Away members render sheets ONLY when nobody is present (the cutaway needs its
  // cast); otherwise they drop from the prompt entirely (tier 4 — the salience-gated
  // edge lines are the relationship matrix slice's half of this budget).
  const sheetMembers = present.length > 0 ? present : members;
  const sheets = sheetMembers.map((member) => ensembleMemberSheet(member, player));

  // Tier-1 pair law (relationship matrix; full third-person blocks since
  // followups ruling 6): both endpoints present. Lives in the prefix —
  // re-rendering on a matrix edit / roster / presence change is the licensed
  // cache bust, like a band crossing.
  const pairLines = (extras.pairs ?? []).map(
    (pair) =>
      `- ${composePairRelationshipLaw({
        fromName: pair.fromName,
        toName: pair.toName,
        familiarity: pair.record.familiarity,
        regard: pair.record.regard,
        kind: pair.record.kind,
        history: pair.record.history,
        presented: pair.record.presented,
      })}`,
  );
  const pairsSection = pairLines.length
    ? `How they stand with each other (cold-start law — the story may move it; never recite it):\n${pairLines.join("\n")}`
    : "";

  // Minor cast fence: the adult framing stays (adult
  // members may still have adult scenes) and the cast line rules every authored
  // minor out of that territory.
  const anyMinor = members.some((m) => isMinorAge(m.profile.age));
  const prefixSections: NarratorPromptNode[] = [
    // The cast fence rides the framing unit: both halves are content-integrity law,
    // and neither is reachable by an instruction override.
    promptUnit(
      "content_framing",
      "runtime_invariant",
      anyMinor ? `${CONTENT_FRAMING} ${ENSEMBLE_MINOR_CAST_LINE}` : CONTENT_FRAMING,
    ),
    untrustedDataNoticeNode(),
    context("ensemble_identity", identity),
    ...buildPlayerSections(input.player, player).map((text, index) => context(`player_persona_${index + 1}`, text)),
    context("scenario", scenario),
    // "Narration authority" is the ensemble lane's player-agency law — the one block
    // that says whose words the narrator may never write. Never replaceable.
    promptUnit("ensemble_narration_authority", "runtime_invariant", authority),
    ...sheets.map((sheet, index) => context(`ensemble_member_sheet_${index + 1}`, sheet)),
    context("ensemble_pair_law", pairsSection),
    ensembleChatRulesNodes(names, input.narrationShape ?? DEFAULT_NARRATION_SHAPE, playerName),
  ];

  const priorSummary = input.priorSummary?.trim();
  const stateLines = present.map((m) => ensembleMemberStateLines(m, player)).filter(Boolean);
  const memories = members
    .map((m) => (m.memory ? ensembleMemberMemory(m.name, m.memory) : ""))
    .filter(Boolean);
  const sceneSection = input.state?.sceneMemory
    ? buildSceneSection(input.state.sceneMemory, input.sceneChanged ?? false)
    : "";
  const castSection = buildSupportingCastSection(input.state?.supportingCast ?? [], null, player);
  // The plans block reads the PRIMARY's state (plans are chat-wide, shared by the roster).
  const plansSection = buildPlansSection(input.state?.plans ?? [], player);
  // The arrival/exit license (Slice 3): a due plan pulls an away member IN or a present
  // member OUT — the presence law's one principled exception.
  const planPresenceLicense = buildPlanPresenceLicense(
    input.state?.plans ?? [],
    present.map((m) => m.name),
    away.map((m) => m.name),
    player,
  );
  const skipNote = input.state?.skipNote?.trim();
  // Away members carry their whereabouts phrase, so
  // "where is everyone" stops being narrator guesswork.
  const awayLabel = (m: EnsembleMemberInput): string =>
    `${m.name}${m.state?.whereabouts?.trim() ? ` (${m.state.whereabouts.trim()})` : ""}`;
  const rosterLine = `In the scene with ${player} right now: ${
    present.length ? present.map((m) => m.name).join(", ") : "no one — every character is away"
  }.${away.length ? ` Away, living their own lives: ${away.map(awayLabel).join(", ")}.` : ""}`;

  // Tier-3 salience (volatile — the mention window moves): one conditional block
  // per salient away member, under the don't-teleport guard. Reactive, never
  // anticipatory — by the time this renders, the fiction already surfaced them
  // (or the edge is flagged looming).
  const awayByName = new Map<string, EnsemblePairInput[]>();
  for (const pair of extras.awayPairs ?? []) {
    awayByName.set(pair.toName, [...(awayByName.get(pair.toName) ?? []), pair]);
  }
  const awaySections = [...awayByName.entries()].map(([awayName, edges]) => {
    const lines = edges.map((edge) => `- ${relationshipLineBetween(edge.fromName, edge.toName, edge.record)}`);
    const where = away
      .find((m) => m.name.trim().toLowerCase() === awayName.trim().toLowerCase())
      ?.state?.whereabouts?.trim();
    return [
      `If ${awayName} comes up (they are NOT here):`,
      ...lines,
      ...(where ? [`- Right now ${awayName} is ${where}.`] : []),
      `- ${awayName} is elsewhere, living their own life. You may show what ${awayName} is doing where they are, or let them text or call — but never merge ${awayName} into ${player}'s scene uninvited.`,
    ].join("\n");
  });

  // The solo perks, per member (followups ruling 12): transient state enactment
  // for every present member, and the one-turn focus/callback/selfie arms aimed
  // at the specific member the pipeline chose.
  const enactments = present.map((m) => ensembleMemberEnactment(m)).filter(Boolean);
  const focusTarget = extras.sensoryFocus
    ? present.find((m) => m.name.trim().toLowerCase() === extras.sensoryFocus?.memberName.trim().toLowerCase())
    : undefined;
  const sensoryFocusSection =
    extras.sensoryFocus && focusTarget
      ? buildSensoryFocusSection(
          player,
          focusTarget.state,
          extras.sensoryFocus.hint,
          resolveAttributes(focusTarget.profile.attributes, [...(focusTarget.state?.attributeOverlays ?? [])]),
          realizeBody({
            speciesId: focusTarget.profile.speciesId,
            heritageId: focusTarget.profile.heritageId,
            bodyPlanId: focusTarget.profile.bodyPlanId,
            intimateRegions: focusTarget.profile.intimateRegions,
            bodyFeatures: focusTarget.profile.bodyFeatures,
          }),
          focusTarget.name.trim() || "the character",
        )
      : "";

  // The same one-turn digest as the 1-on-1 lane — the
  // ensemble tail carries the group arms of the same notes, so it gets the same tiering.
  const turnNotes = buildTurnNotes([
    { tier: "binding", text: input.narratorInput ? narratorInputNote("each present character", player) : "" },
    { tier: "binding", text: input.notationNote?.trim() ?? "" },
    { tier: "binding", text: buildAttachmentsSection(input.attachments, player) },
    {
      // The authoritative story moment — same line as the 1-on-1 frame.
      tier: "binding",
      text: input.state?.storyMoment?.trim()
        ? `Story time: it is ${input.state.storyMoment.trim()}. Time-of-day texture (light, meals, routine) follows this clock.`
        : "",
    },
    { tier: "binding", text: skipNote ? `Time has passed in the story since the last exchange: ${skipNote}` : "" },
    {
      // The meanwhile pass's one-shot note — same line as the 1-on-1 frame.
      tier: "binding",
      text: input.state?.meanwhileNote?.trim()
        ? `While time passed, off-screen (true — meanwhile beats come from this, not invention; weave in at most one piece, naturally): ${input.state.meanwhileNote.trim()}`
        : "",
    },
    {
      tier: "binding",
      text:
        input.firstExchange && !input.sceneChanged
          ? `First exchange of this conversation: establish the scene once — where everyone is, the time of day, and one or two concrete sensory details — drawn from the scenario and what ${player}'s message sets up. After this, don't re-establish what hasn't changed.`
          : "",
    },
    { tier: "gate", text: sensoryFocusSection },
    // Minor fence: no selfie license when the addressed member is an authored minor.
    {
      tier: "license",
      text:
        extras.selfie &&
        !members.some(
          (m) => m.name.trim().toLowerCase() === extras.selfie?.memberName.trim().toLowerCase() && isMinorAge(m.profile.age),
        )
          ? chatSelfieLine(extras.selfie.kind, extras.selfie.memberName, player)
          : "",
    },
    {
      tier: "flavor",
      text: extras.callback?.summary.trim()
        ? ensembleCallbackLine(extras.callback.summary, extras.callback.regard, extras.callback.memberName, player)
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
    ...memories.map((text, index) => context(`ensemble_member_memory_${index + 1}`, text)),
    // Presence truth: who is actually in the scene. The rules block's presence law
    // binds against THIS line, so both stay whatever the instructions say.
    promptUnit("ensemble_roster", "runtime_invariant", rosterLine),
    ...awaySections.map((text, index) => promptUnit(`ensemble_away_member_${index + 1}`, "runtime_invariant", text)),
    context(
      "ensemble_member_state",
      stateLines.length ? `Where each character is right now (let it color them — never recite it):\n${stateLines.join("\n")}` : "",
    ),
    ...enactments.map((text, index) => context(`ensemble_member_enactment_${index + 1}`, text)),
    // What the player has on — chat-wide, volatile, so it rides the tail (slice 8).
    context("player_state", buildPlayerStateLine(input.player, player)),
    // The exposure-earned intimate notes. The gate is evaluated PER MEMBER against their
    // own coverage/arousal (the player's coverage is shared), so one couple in the room
    // never hands every present character an intimate disposition. Away members are
    // excluded — they aren't in the scene. Minor-fenced per member.
    context(
      "intimate_notes",
      buildChatIntimateSection({
        characters: present.flatMap((m) => {
          const open = chatSceneIsIntimate({
            characterExposed: m.state?.outfitExposed,
            playerExposed: input.player?.exposed,
            meters: m.state?.meters,
          });
          if (!open || (lifeStageForAge(m.profile.age)?.minor ?? false)) return [];
          const note = characterIntimateNote(m.profile);
          return note ? [{ label: `${m.name} is`, note }] : [];
        }),
        // The player's note rides along once ANY present, non-minor member's gate opened.
        ...(ensembleIntimate && input.player?.intimacy?.trim() ? { playerNote: input.player.intimacy.trim() } : {}),
        playerName: player,
      }),
    ),
    context("scene_memory", sceneSection),
    context("supporting_cast", castSection),
    context("plans", plansSection),
    context("plan_presence_license", planPresenceLicense),
    promptUnit("turn_notes", "runtime_invariant", turnNotes),
    context(
      "response_directive",
      input.opening
        ? `Opening beat: ${player} has not spoken yet. Open the scene yourself — the present characters arrive in it, grounded in the scenario. A few lines, ending on a present moment that invites ${player} in. Do not narrate on ${player}'s behalf.`
        : buildResponseShapeLine(input),
    ),
  ];

  return {
    prefix: [sectionGroup("ensemble_prefix", prefixSections)],
    tail: [sectionGroup("ensemble_tail", tailSections)],
  };
}

/** One member's prefix sheet — full for active present members, compressed when quiet. */
function ensembleMemberSheet(member: EnsembleMemberInput, player: string): string {
  const name = member.name.trim() || "This character";
  const { profile } = member;
  const agePhrase = formatAge(profile.age);
  const lifeStage = lifeStageForAge(profile.age);
  const species = speciesLorePhrase(profile.speciesId, profile.heritageId);
  const idLine = [
    `${name}${agePhrase ? `, ${agePhrase}` : ""}${lifeStage?.promptHint ? ` — ${lifeStage.promptHint}` : ""}.`,
    species ? `Species: ${species}.` : "",
  ]
    .filter(Boolean)
    .join(" ");
  // The register compressed to one binding third-person line (the 1-on-1 lane
  // carries the full second-person block; sheets stay token-tight).
  const lifeStageLine = lifeStageThirdPersonLine(lifeStage, name);
  const relationship = ensembleRelationshipLine(member, player);

  const quiet = member.quietExchanges >= ensembleQuietThreshold(effectiveTraitValue(profile.traits, "social.extraversion"));
  if (quiet || member.presence === "away") {
    // Tier 2/cutaway compression: identity + a one-line read; the full sheet returns
    // when they act again (a licensed prefix re-render, like a band crossing).
    const mood = member.state ? deriveMoodDescriptor(member.state.meters) : "";
    const mind = member.state?.mindNote?.trim();
    return [
      `## ${name}${member.presence === "away" ? " (away)" : " (quiet just now)"}`,
      idLine,
      profile.personality.trim() ? `In brief: ${excerpt(profile.personality, 200)}` : "",
      relationship,
      mood ? `- Feeling ${mood}.` : "",
      mind ? `- On ${name}'s mind: ${mind}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  const bandId = regardBandForValue(member.state?.regard ?? 0).id;
  const baseTraits = resolveTraits(profile.traits, regardDispositionOverlays(bandId, profile.traits));
  const disposition = dispositionBands(traitRegistry, baseTraits, { intimateOnly: false });
  const attributes = ensembleAttributeLines(member);
  return [
    `## ${name}`,
    idLine,
    buildBioSection(profile.bio),
    profile.personality.trim() ? `Personality:\n${fenceUntrusted("personality", profile.personality)}` : "",
    profile.voice?.trim() ? `Voice (how ${name} sounds):\n${fenceUntrusted("voice", profile.voice)}` : "",
    lifeStageLine ? `Life stage (binding): ${lifeStageLine}` : "",
    disposition.length
      ? `Disposition (how ${name} actually behaves — let it pull on what ${name} says and does, never recite it):\n${disposition.map((d) => `- ${d}`).join("\n")}`
      : "",
    relationship,
    attributes.length ? `What ${player} sees of ${name} (express naturally, never list):\n${attributes.join("\n")}` : "",
    // The ensemble builder renders no state section, so the covered-hair line lives
    // in the sheet beside the attributes it explains.
    hairOcclusionConstraint(
      member.state?.hairOcclusion,
      `${name}'s hair is completely covered by their headwear — none of it is visible.`,
    ),
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * The member↔player relationship as a compact third-person line: bands + the authored
 * kind/history/mask texture. The full composed pair-law block (escalation floors,
 * address rights) is second-person and stays with the player edge.
 */
function ensembleRelationshipLine(member: EnsembleMemberInput, player: string): string {
  const name = member.name.trim() || "this character";
  return `With ${player}: ${relationshipLineParts(name, player, {
    familiarity: member.state?.familiarity ?? 0,
    regard: member.state?.regard ?? 0,
    ...(member.state?.relationship ?? {}),
  })}`;
}

/** A directed matrix edge as one third-person line ("Mara → Rhett: …"). */
function relationshipLineBetween(fromName: string, toName: string, record: RelationshipRecord): string {
  return `${fromName} → ${toName}: ${relationshipLineParts(fromName, toName, record)}`;
}

/** The shared body: bands + kind/history/mask, third person, subject `name` toward `target`. */
function relationshipLineParts(
  name: string,
  target: string,
  record: { familiarity: number; regard: number } & Partial<RelationshipTexture>,
): string {
  const fam = familiarityBandForValue(record.familiarity);
  const reg = regardBandForValue(record.regard);
  const kind = record.kind?.trim();
  const history = record.history?.trim();
  const mask =
    record.presented?.lean === "masks_warmth"
      ? `Outwardly ${name} performs disdain over what ${name} actually feels`
      : record.presented?.lean === "masks_dislike"
        ? `Outwardly ${name} performs courtesy over what ${name} actually feels`
        : "";
  const parts = [
    `${kind ? `${kind} — ` : ""}${fam.label.toLowerCase()} to each other, and ${name} feels ${reg.label.toLowerCase()} toward ${target}.`,
    history ? `Their history: ${history}.` : "",
    mask ? `${mask}${record.presented?.note?.trim() ? ` (${record.presented.note.trim()})` : ""}.` : "",
  ].filter(Boolean);
  return parts.join(" ");
}

/** The member's attribute lines under the same guards as the single-character loop. */
function ensembleAttributeLines(member: EnsembleMemberInput): string[] {
  const { profile } = member;
  const realizedBody = realizeBody({
    speciesId: profile.speciesId,
    heritageId: profile.heritageId,
    bodyPlanId: profile.bodyPlanId,
    intimateRegions: profile.intimateRegions,
    bodyFeatures: profile.bodyFeatures,
  });
  const resolved = withholdHairAttributes(
    resolveAttributes(profile.attributes, [...(member.state?.attributeOverlays ?? [])]),
    member.state?.hairOcclusion,
  );
  const lines: string[] = [];
  for (const value of resolved) {
    if (value.id === "identity.apparent_age") continue;
    const def = attributeRegistry.byId(value.id);
    if (!def) continue;
    if (def.excludeFromPrompts) continue;
    if (def.kind === "sensory" && isIntimateAttributeCategory(def.category)) continue;
    if (!realizedBody.isAttributeApplicable(def)) continue;
    const phrase = attributePhrase(def, value.value);
    if (phrase) lines.push(`- ${phrase}`);
  }
  return lines;
}

/**
 * One present member's transient enactment blocks for the volatile tail (followups
 * ruling 12): the 1-on-1's disinhibition + transient-appearance sections rendered per
 * member in the third person. High intoxication/arousal loosens THAT member's
 * disposition bands; active conditions' attribute effects override THAT member's sheet
 * lines. Sober + condition-free ⇒ "" — the common case adds nothing to the tail.
 */
function ensembleMemberEnactment(member: EnsembleMemberInput): string {
  if (!member.state) return "";
  const name = member.name.trim() || "This character";
  const { profile } = member;
  const bandId = regardBandForValue(member.state.regard ?? 0).id;
  const baseTraits = resolveTraits(profile.traits, regardDispositionOverlays(bandId, profile.traits));
  const blocks: string[] = [];

  // Minor fence: no state-driven loosening for a minor member.
  const overlays = isMinorAge(profile.age) ? [] : stateDispositionOverlays(baseTraits, member.state.meters ?? {});
  if (overlays.length) {
    const shifted = resolveTraits(baseTraits, overlays);
    const baseLines = new Set([
      ...dispositionBands(traitRegistry, baseTraits, { intimateOnly: false }),
      ...dispositionBands(traitRegistry, baseTraits, { intimateOnly: true }),
    ]);
    const changed = [
      ...dispositionBands(traitRegistry, shifted, { intimateOnly: false }),
      ...dispositionBands(traitRegistry, shifted, { intimateOnly: true }),
    ].filter((line) => !baseLines.has(line));
    if (changed.length) {
      blocks.push(
        [
          `Right now ${name}'s state is loosening ${name} (transient — while it lasts, these REPLACE ${name}'s matching Disposition lines above; it recedes as ${name} sobers and settles):`,
          ...changed.map((line) => `- ${line}`),
        ].join("\n"),
      );
    }
  }

  const conditionOverlays = conditionAttributeOverlays(member.state.conditions ?? []);
  if (conditionOverlays.length) {
    const realizedBody = realizeBody({
      speciesId: profile.speciesId,
      heritageId: profile.heritageId,
      bodyPlanId: profile.bodyPlanId,
      intimateRegions: profile.intimateRegions,
      bodyFeatures: profile.bodyFeatures,
    });
    const stableResolved = resolveAttributes(profile.attributes, [...(member.state.attributeOverlays ?? [])]);
    const fullResolved = withholdHairAttributes(
      resolveAttributes(profile.attributes, [...(member.state.attributeOverlays ?? []), ...conditionOverlays]),
      member.state.hairOcclusion,
    );
    const stableById = new Map(stableResolved.map((v) => [v.id, v]));
    const lines: string[] = [];
    for (const value of fullResolved) {
      if (value.id === "identity.apparent_age") continue;
      const def = attributeRegistry.byId(value.id);
      if (!def) continue;
      if (def.excludeFromPrompts) continue;
      if (def.kind === "sensory" && isIntimateAttributeCategory(def.category)) continue;
      if (!realizedBody.isAttributeApplicable(def)) continue;
      const stable = stableById.get(value.id);
      if (stable && stable.value === value.value) continue;
      const phrase = attributePhrase(def, value.value);
      if (!phrase) continue;
      lines.push(`- ${phrase}`);
    }
    if (lines.length) {
      blocks.push(
        [`While ${name}'s current condition lasts (transient — these override ${name}'s matching attribute lines above):`, ...lines].join(
          "\n",
        ),
      );
    }
  }

  return blocks.join("\n\n");
}

/** One member's compact third-person state line for the volatile tail. */
function ensembleMemberStateLines(member: EnsembleMemberInput, player: string): string {
  if (!member.state) return "";
  const name = member.name.trim() || "This character";
  const mood = deriveMoodDescriptor(member.state.meters);
  const feeling = feelingPhrase(member.state.feeling);
  const mind = member.state.mindNote?.trim();
  const outfit = member.state.outfit?.trim();
  const loops = (member.state.openLoops ?? []).map((l) => l.trim()).filter(Boolean);
  const conditionHints = member.state.conditions.flatMap((c) => (c.promptHint ? [c.promptHint] : []));
  // A pending whereabouts on a PRESENT member = they just got back (one-turn
  // came-from license); the rhythm grounds their day.
  const returned = member.state.whereabouts?.trim();
  const rhythm = member.state.rhythm?.trim();
  const bits = [
    returned ? `just got back — was ${returned} (one trace of it, then let it go)` : "",
    mood ? `feeling ${mood}` : "",
    feeling ? `underneath it, ${feeling}` : "",
    outfit ? `wearing ${outfit}` : "",
    ...conditionHints,
    mind ? `on ${name}'s mind: ${mind}` : "",
    loops.length ? `unfinished with ${player}: ${loops.join("; ")}` : "",
    rhythm ? `usual rhythm: ${rhythm}` : "",
  ].filter(Boolean);
  return bits.length ? `- ${name}: ${bits.join(" · ")}` : "";
}

/** One member's fenced memory block, labeled so recall never cross-attributes. */
function ensembleMemberMemory(name: string, memory: NonNullable<CharacterChatPromptInput["memory"]>): string {
  const facts = memory.facts.map((f) => f.trim()).filter(Boolean);
  const episodes = memory.episodes.map((e) => e.trim()).filter(Boolean);
  if (!facts.length && !episodes.length) return "";
  const lines: string[] = [];
  if (facts.length) {
    lines.push(`What ${name} knows (treat as true; draw on it only when the moment calls for it):`);
    for (const fact of facts) lines.push(`- ${fact}`);
  }
  if (episodes.length) {
    if (lines.length) lines.push("");
    lines.push(`Moments ${name} remembers (from before the recent exchanges):`);
    for (const episode of episodes) lines.push(`- ${episode}`);
  }
  return `${name}'s memory:\n${fenceUntrusted("memory", lines.join("\n"))}`;
}

/**
 * The ensemble's rules block — the 1-on-1 rulebook rethought for a cast: universal
 * tag discipline (the renderer attributes per [Name] tag; in a group NOTHING is
 * auto-attributed), characters interacting with each other, presence law, and the
 * ported craft rules (proportion, freshness, sparse intimate dialogue).
 *
 * Two of the twelve are not craft and never move: the tag rule is the renderer's wire
 * format, and presence law decides who is actually in the scene.
 */
const ensembleChatRulesNodes = (
  names: readonly string[],
  shape: NarrationShapeId,
  playerName?: string,
): NarratorPromptGroup => {
  const player = playerName ?? "the user";
  const cast = names.join(", ");
  return {
    kind: "group",
    id: "ensemble_chat_rules",
    // As in the 1-on-1 lane: the interleaved "" entries of the old `join("\n")`
    // ARE a "\n\n" join, and modelling them that way is what stops an override
    // from leaving a blank line where a dropped craft block used to be.
    separator: "\n\n",
    dropEmpty: true,
    children: [
      narratorBehaviorSlot("ensemble_narrator_behavior"),
      {
        kind: "numbered_list",
        id: "ensemble_chat_rules_list",
        heading: "How to respond:",
        separator: "\n",
        items: [
          promptUnit(
            "ensemble_stay_in_character",
            "behavior",
            `Stay fully inside the story. Never break character, never mention being an AI, a model, or a chat app; ${player} is only ever addressed as the person in the scene.`,
          ),
          promptUnit(
            "ensemble_camera_style",
            "behavior",
            `One fixed viewpoint: the camera sits behind ${player}'s eyes for the shared scene. Characters (${cast}) are written in the third person by name; ${player} is addressed as "you". First-person "I"/"me" appears ONLY inside a character's quoted dialogue.`,
          ),
          promptUnit(
            "ensemble_speaker_attribution_contract",
            "transport_contract",
            `Tag EVERY spoken character line: open it with the speaker's name in brackets — e.g. [${names[0] ?? "Name"}] "Here already?" — one tag per spoken line, including one-word lines. In a group scene nothing is attributed automatically, so an untagged quote is unreadable; ${player} never sees the tags. Actions, gestures, and description stay untagged third-person prose. Passing incidental people (a waiter) speak in prose with a plain attribution, never a tag — tags belong to the cast: ${cast}. Recurring named side characters listed under "Supporting cast" (below, when present) speak the same way — prose attribution, never a tag — and may be voiced and moved within their role there. Square brackets have exactly ONE use: opening a spoken line with the speaker's tag. Never bracket a name anywhere else — above all not inside quoted speech when a character addresses ${player} or another character by name: write "Good to see you, ${player}." and NEVER "Good to see you, [${player}]." Off the start of a line the brackets are not notation at all; ${player} reads the literal square brackets in the message.`,
          ),
          promptUnit(
            "ensemble_characters_alive",
            "behavior",
            `The characters are alive to each other, not just to ${player}: they answer each other, interrupt, exchange looks, disagree, take sides. Give each present character their own voice, rhythm, and agenda — never let them blur into one accommodating chorus, and never let one character simply vanish from a scene they're in (a quiet character can be quiet visibly).`,
          ),
          promptUnit(
            "ensemble_narration_shape",
            "behavior",
            `${NARRATION_SHAPE_PROFILES[shape]} Resolve the immediate beat and end on a present moment (a line, a gesture, a look), never a summary or reflection.`,
          ),
          promptUnit(
            "ensemble_personality_law",
            "behavior",
            "Each character's Personality, Disposition, and Voice sections are behavioral law, not flavor to recite. Let the traits a beat makes relevant govern what each of them notices, withholds, says, and does — and never name, list, or recite a trait.",
          ),
          promptUnit(
            "ensemble_proportionality",
            "behavior",
            `Respond directly to what just happened before adding anything new, and react in proportion: an ordinary remark gets a natural answer, not effusion. Warmth tracks each character's own state and how they actually feel about ${player} and each other; affection is earned, not automatic.`,
          ),
          promptUnit(
            "ensemble_topic_discipline",
            "behavior",
            "Stay on the current topic; don't spin up unrelated errands or sub-plots to fill space.",
          ),
          promptUnit(
            "ensemble_presence_law",
            "runtime_invariant",
            `Presence is law: only the characters listed as present are in ${player}'s scene. An away character may text or call — write a sent text on its own line as *Name: her words here* — or be shown where they are in a cutaway, but never walks into the scene unprompted; entrances and exits happen on the page, once, and then hold.`,
          ),
          promptUnit(
            "ensemble_freshness",
            "behavior",
            `Freshness: every paragraph carries something NEW — a change, a reaction, a detail not yet on the page. Never re-describe an unchanged setting, outfit, or scent. Appearance detail lands only when movement or attention draws the eye, one concrete detail at a time, never a head-to-toe inventory.`,
          ),
          promptUnit(
            "ensemble_no_refusal",
            "behavior",
            `Never break out of the story to refuse, deflect, caution, moralize, or add a disclaimer — all forbidden. If a character would hesitate or say no, play it as that character's own in-world choice, in their voice, and stay in the scene.`,
          ),
          promptUnit(
            "ensemble_natural_dialogue",
            "behavior",
            `Dialogue is speech, not prose: fragments, interruptions, trailing off, dodging. Keep each voice distinct. Sometimes the truest answer is no words — a pause, a look, a small action on its own line.`,
          ),
        ],
      },
      // The perception block: what the cast may KNOW from the player's message.
      // Its notation bullet is inseparable from it here — the ensemble lane wrote
      // the sigil grammar INTO the perception list rather than as its own legend,
      // so the block is classified whole, at the strictest authority it carries.
      promptUnit(
        "ensemble_player_input_perception",
        "runtime_invariant",
        [
          `Reading ${player}'s message (what the characters can actually perceive):`,
          `- Quoted text is speech — heard exactly. Unquoted text is the story's narration: characters perceive only what would be visible or audible. Inner thoughts ${player} writes reach no one — characters may notice the visible signs and guess, even wrongly, but never answer the thought itself.`,
          `- *A phrase in single asterisks* is ${player}'s private thought — unheard — unless it wraps a name and a colon (*${playerName ?? "Name"}: like this*), which is a text message being sent. _Underscores_ are plain emphasis. ((Double parentheses)) are out-of-character direction to you as the storyteller: follow it; no one in the scene hears it.`,
          `- A message opening with a bracketed "[Story narration from ${player} …]" line is ${player} writing as the STORYTELLER: everything in it is story truth — events, side characters' words and actions — not ${player}'s own speech or actions. The characters react to what happened in it, never to ${player} as its author.`,
          `- A message with no quotes that reads as plain conversation is simply spoken aloud.`,
        ].join("\n"),
      ),
      promptUnit(
        "ensemble_intimate_craft",
        "behavior",
        [
          "When a scene turns intimate:",
          `- Hold escalation to ${player}'s pace; let anticipation work — never leap ahead of the moment.`,
          "- Keep body and clothing continuity: positions, hands, and what has been removed stay exactly where the scene left them.",
          `- Ground it in concrete sensation in plain physical language; the sensation lands in ${player}'s body too — what they taste, smell, and feel is the scene's texture, and yours to write.`,
          "- Let speech go sparse at the height of it: a name, a broken-off phrase, wordless sound over full sentences. Never let \"is this okay?\" become a refrain.",
        ].join("\n"),
      ),
    ],
  };
};
