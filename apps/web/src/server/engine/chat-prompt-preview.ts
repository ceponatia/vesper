import { and, desc, eq } from "drizzle-orm";
import {
  affordanceSubjectId,
  characterProfileSchema,
  currentScenePlace,
  derivePermissionPolicyRead,
  DiagnosticCollector,
  emptyCharacterProfile,
  garmentActorForCharacter,
  type PhysicalActionOutcome,
} from "@/contracts";
import { parseOr } from "@/lib/parse";
import { resolveNarratorInstructionSource } from "@/server/narrator-prompts";
import { characterChatMessages, db } from "../db";
import { log } from "../log";
import { resolveChatPersona } from "../players";
import { messageAttachmentsMetaSchema } from "./chat-reply-store";
import { renderChatAffordanceCues } from "./chat-affordance-cues";
import { buildChatAffordancePreview, type AffordancePreview } from "./chat-affordance-preview";
import {
  chatContactAcknowledgment,
  chatContactActionOutcome,
  chatContactUnresolvedPremise,
  type ChatContactUnresolvedPremise,
} from "./chat-contact/presentation";
import { chatContactEventRef, CHAT_CONTACT_PLAYER_SUBJECT } from "./chat-contact/identity";
import { chatContactMaterialAtCut } from "./chat-contact/material";
import { planChatContactTurn } from "./chat-contact-adapter";
import type { ChatContactPolicySource } from "./chat-contact/resolution";
import type { ChatContactRosterMember } from "./chat-contact/input-evidence";
import { foldChatPermissionProjection, listChatPermissionEvents } from "./chat-permission-events";
import { buildChatPhysicalGuidance, buildChatPhysicalGuidanceStages } from "./chat-physical-guidance";
import { renderChatPhysicalGuidance } from "./chat-physical-guidance-render";
import { buildChatPhysicalGuidancePreview, type PhysicalGuidancePreview } from "./chat-physical-guidance-preview";
import { loadChatVisualMemory } from "./visual-memory-store";
import { detectSensoryFocus } from "./chat-intent";
import { retrieveChatMemory } from "./chat-memory";
import { resolveSeededOutfit } from "./chat-state/outfit-fold";
import { driftChatState, seedChatScenario, seedChatState } from "./chat-state";
import { loadChatScenario, loadChatState } from "./chat-state/store";
import { resolveChatWardrobe, resolvePlayerWardrobe } from "./chat-wardrobe";
import { buildChatGarmentNarration, chatGarmentNarrationActors } from "./chat-garments";
import { loadChatSummary } from "./chat-summary";
import { buildCharacterChatPromptParts } from "./prompts/character-chat";
import {
  chatAffordanceCuesEnabled,
  chatContactActionsEnabled,
  chatGarmentCuesEnabled,
  chatPhysicalConstraintsEnabled,
  chatRomanticPermissionEnabled,
  chatVisualStateShadowEnabled,
  narrationShapeId,
} from "./prompts/constants";
import {
  degradedVisualStatePreviewPayload,
  safeBuildVisualStateShadow,
  visualStatePreviewPayload,
  type VisualStatePreviewPayload,
} from "@/server/visual-state";
import { chatOwnerId, playerPromptSlice, promptStateSlice } from "./chat-prompt-input";
import { chatVisualStateAffordanceRead, chatVisualStateShadowInput } from "./chat-visual-state-cut";

const describeError = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The dev inspector's "what reaches the narrator" view. */
export interface ChatPromptPreview {
  prefix: string;
  tail: string;
  memory: { facts: string[]; episodes: string[] };
  memoryQueries: string[];
}

/**
 * The stored cut the developer previews read from — state, scenario, persona, and
 * both wardrobes, assembled exactly as a live exchange assembles them and
 * WITHOUT touching state, history, or the exchange lock.
 *
 * Shared by the prompt, affordance, physical-guidance and visual-state previews;
 * separate copies would have more chances to drift from
 * what a real turn does — which is the one thing a debug view must never do.
 */
async function loadChatPreviewCut(input: {
  chatId: string;
  character: { id: string; profile: unknown };
  sink: DiagnosticCollector;
}) {
  const { sink } = input;
  const profile = parseOr(
    characterProfileSchema,
    input.character.profile ?? {},
    emptyCharacterProfile(),
    undefined,
    "characters.profile",
  );
  const stored = await loadChatState(input.chatId, input.character.id, sink);
  const owner = await chatOwnerId(input.chatId);
  const scenario = (await loadChatScenario(input.chatId, sink)) ?? seedChatScenario(profile);
  const state = driftChatState(
    await resolveSeededOutfit(stored ?? seedChatState(profile), owner, profile, sink),
    profile,
    { clockMinutes: scenario.clockMinutes },
  );
  const player = await resolveChatPersona({ ownerId: owner, chatId: input.chatId });
  const wardrobe = await resolveChatWardrobe(
    { ...state, garments: scenario.garments, garmentActorId: garmentActorForCharacter(input.character.id) },
    owner,
    profile,
    sink,
  );
  const playerWardrobe = await resolvePlayerWardrobe(
    scenario.playerState,
    owner,
    player.profile,
    sink,
    scenario.garments,
  );
  return { profile, owner, scenario, state, player, wardrobe, playerWardrobe };
}

/**
 * The read-only developer preview of the staged affordance calculation.
 * Computes on
 * demand from the stored cut and stores NOTHING — in particular it never
 * persists `nextCues`, so looking at a read cannot spend the repeat gate.
 */
export async function previewChatAffordances(input: {
  chatId: string;
  character: { id: string; name: string; profile: unknown };
}): Promise<AffordancePreview> {
  const sink = new DiagnosticCollector();
  const cut = await loadChatPreviewCut({ chatId: input.chatId, character: input.character, sink });
  return buildChatAffordancePreview({
    result: chatVisualStateAffordanceRead({ characterId: input.character.id, cut, sink }),
    possessive: `${input.character.name}'s`,
    cueFlagEnabled: chatAffordanceCuesEnabled(),
  });
}

/**
 * A nonce prompting id for the visual-state inspector's memory read: it matches
 * no exchange's `applied_message_id`, so the two-generation store always hands
 * back the CURRENT `features` generation — what the observer knows now — and,
 * because the preview never writes, the generations themselves never move.
 */
const VISUAL_STATE_PREVIEW_GUARD = "visual_state_preview";

/**
 * The read-only visual-state inspector payload for one legacy chat: the same
 * shadow build the flagged live turn
 * runs — snapshot, composition, suppressions, staircase, both consumer
 * selections, measurements — recomputed on demand from the stored cut.
 *
 * Computes on demand and stores NOTHING: the memory load is read-only, no
 * notice or mention state is spent, and `CHAT_VISUAL_STATE_SHADOW` is reported
 * rather than obeyed — an inspector never changes what it inspects.
 */
export async function previewChatVisualState(input: {
  chatId: string;
  memoryGroupId: string;
  character: { id: string; name: string; profile: unknown };
}): Promise<VisualStatePreviewPayload> {
  const sink = new DiagnosticCollector();
  const characterId = input.character.id;
  const cut = await loadChatPreviewCut({ chatId: input.chatId, character: input.character, sink });
  const memory = await loadChatVisualMemory({
    memoryGroupId: input.memoryGroupId,
    viewpointId: cut.owner,
    subjectId: characterId,
    promptingMessageId: VISUAL_STATE_PREVIEW_GUARD,
    sink,
  });
  const build = safeBuildVisualStateShadow(
    {
      // The shared cut → shadow-input factory (the scene render's digest build
      // uses the same one), so the inspector can never preview an assembly the
      // production render would not take.
      ...chatVisualStateShadowInput({
        characterId,
        memoryGroupId: input.memoryGroupId,
        cutId: VISUAL_STATE_PREVIEW_GUARD,
        cut,
        memory,
        sink,
      }),
      sink,
    },
    sink,
  );
  if (build === null) {
    return degradedVisualStatePreviewPayload({
      lane: "character_chat",
      shadowFlagEnabled: chatVisualStateShadowEnabled(),
      diagnostics: sink.items,
    });
  }
  return visualStatePreviewPayload({
    build,
    shadowFlagEnabled: chatVisualStateShadowEnabled(),
    diagnostics: sink.items,
  });
}

/**
 * The newest player line in this chat, with the register it was authored in.
 *
 * The guidance preview needs a message to premise-check, and "the last thing the
 * player said" is the one that produced the reply a developer is looking at. Narrator
 * mode rides the line's own meta, so the preview reproduces the live authority
 * decision rather than assuming ordinary input.
 *
 * The row's own id comes back with it because the contact preview needs the exchange
 * guard: an ordinary send keys its ledger on `promptMessageId`, which IS this row, so
 * a preview that carries it re-derives the very contact the live turn wrote rather
 * than a look-alike under a different ref.
 */
async function lastPlayerMessage(chatId: string): Promise<{ id: string | null; content: string; narrator: boolean }> {
  const [row] = await db()
    .select({ id: characterChatMessages.id, content: characterChatMessages.content, meta: characterChatMessages.meta })
    .from(characterChatMessages)
    .where(and(eq(characterChatMessages.chatId, chatId), eq(characterChatMessages.role, "user")))
    .orderBy(desc(characterChatMessages.createdAt), desc(characterChatMessages.id))
    .limit(1);
  if (!row) return { id: null, content: "", narrator: false };
  const meta = parseOr(messageAttachmentsMetaSchema, row.meta ?? {}, {}, undefined, "character_chat_messages.meta");
  return { id: row.id, content: row.content, narrator: meta.inputMode === "narrator" };
}

/**
 * Both developer previews run the exact context-aware sensory detector used by a
 * live 1-on-1 cut. The preview loader currently exposes only the primary member;
 * keeping this in one helper at least prevents the guidance inspector and prompt
 * preview from disagreeing about actor, owner, register, or negation.
 */
function previewSensoryFocus(input: {
  character: { id: string; name: string };
  cut: Awaited<ReturnType<typeof loadChatPreviewCut>>;
  message: { content: string; narrator: boolean };
}): ReturnType<typeof detectSensoryFocus> {
  const characters =
    input.cut.state.presence === "present"
      ? [{ id: input.character.id, name: input.character.name, aliases: input.cut.profile.aliases }]
      : [];
  return detectSensoryFocus(input.message.content, {
    characters,
    narratorInput: input.message.narrator,
  });
}

/**
 * This turn's resolved contact, re-derived READ-ONLY for a preview.
 *
 * The live leg does four things: plan, write the ledger, advance the scene
 * projection, and word the outcome. A preview may only do the first and the last, so
 * this runs the same `planChatContactTurn` over the STORED cut and the newest player
 * line, keeps the outcome, and drops the planned scene. Nothing is appended to
 * `chat_contact_events`, and nothing is written back to the scenario: looking at a
 * prompt must never move a body or record a touch.
 *
 * **The one thing it assumes rather than observes.** `contactActionOutcomeStatus`
 * will not say `committed` without an acknowledgment of a durable write, and a
 * preview performs none — so a literal "no write, no acknowledgment" preview would
 * render every contact as silence, which is exactly the blind spot this closes. The
 * acknowledgment is therefore built from the plan, as the one the live turn's awaited
 * write produces. That assumption is stated to the inspector rather than hidden (the
 * contact stage reports its own flag beside these rows), and in the ordinary case it
 * is not an assumption at all: replaying the newest line against the cut that line
 * already settled re-derives the SAME contact, which folds `contact_continued` — the
 * case that legitimately writes no row.
 *
 * Two fidelity limits worth knowing while reading the inspector:
 *
 * - **One character.** `loadChatPreviewCut` loads the primary participant, so an
 *   ensemble previews as a 1-on-1. A pronoun resolves only when exactly one character
 *   is present, so a group chat's preview can resolve a "your" the live turn refuses
 *   as ambiguous.
 * - **The cut is post-settle.** The live leg planned against the PRE-exchange scene;
 *   this replans against the scene that exchange left behind — the same
 *   after-the-fact reading the guidance preview beside it already takes on the
 *   premise check.
 *
 * Fenced whole like the live leg (docs/resilience.md): any failure degrades to no
 * outcomes, which is the flag-off preview, and never costs the inspector its page.
 */
async function previewChatContactOutcomes(input: {
  chatId: string;
  character: { id: string; name: string };
  cut: Awaited<ReturnType<typeof loadChatPreviewCut>>;
  message: { id: string | null; content: string; narrator: boolean };
  sink: DiagnosticCollector;
}): Promise<{ outcomes: readonly PhysicalActionOutcome[]; unresolvedPremise: ChatContactUnresolvedPremise | null }> {
  const { cut } = input;
  try {
    // No player line yet ⇒ no act is detectable, so the fallback ref is only ever a
    // placeholder for a plan that returns nothing.
    const eventRef = chatContactEventRef(input.message.id ?? `preview:${input.chatId}`);
    const storyMinute = Math.max(0, Math.trunc(cut.scenario.clockMinutes));
    // The same current-cut material answer the live leg derives, from the same
    // resolved wardrobe — a preview that read the persisted capture instead
    // would re-open the settle race the live leg closed, and explain a silence
    // the turn no longer produces.
    const actorId = garmentActorForCharacter(input.character.id);
    const { material } = chatContactMaterialAtCut({
      store: cut.scenario.garments,
      actorId,
      ...(cut.wardrobe.worn === undefined ? {} : { worn: cut.wardrobe.worn }),
      visibility: cut.wardrobe.partVisibility,
      environment: cut.scenario.environment,
      clockMinutes: cut.scenario.clockMinutes,
      freeTextOutfit: cut.state.outfit,
      wornItemIds: cut.state.wornItemIds,
      sink: input.sink,
    });
    // PRESENT only, exactly as the live roster is built: an away character is not a
    // body in the room, and an empty roster resolves no target at all.
    const characters: ChatContactRosterMember[] =
      cut.state.presence === "present"
        ? [
            {
              subjectId: affordanceSubjectId(input.character.id),
              name: input.character.name,
              aliases: cut.profile.aliases,
              material,
            },
          ]
        : [];

    // The permission owner's read, gated exactly as the live leg gates it. This
    // one the preview OBEYS rather than reports: a romantic attempt resolves
    // against whatever the ledger says, and a preview that answered from an
    // owner the live turn never consulted would explain a commit the turn did
    // not make. With the flag off, both paths reach the adapter's bare
    // `not_required` stub and both fall to `permission_unresolved` — silence,
    // which is the honest preview of a silent turn.
    let permissionPolicy: ChatContactPolicySource | undefined;
    if (chatRomanticPermissionEnabled()) {
      const permissionProjection = foldChatPermissionProjection(
        await listChatPermissionEvents(input.chatId, input.sink),
        input.sink,
      );
      permissionPolicy = (attempt) =>
        derivePermissionPolicyRead({
          projection: permissionProjection,
          permittedActorId: attempt.permittedActorId,
          grantingTargetId: attempt.grantingTargetId,
          actionKind: attempt.actionKind,
          playerSubjectId: CHAT_CONTACT_PLAYER_SUBJECT,
          attemptActionId: attempt.actionId,
        });
    }

    // The planned scene — the seeding, any release, and any movement the line wrote —
    // is deliberately NOT taken, and neither are the plan's `ended` commits: both are
    // authoritative state a live turn persists with the exchange, and a preview has no
    // exchange to persist them with. The live leg's own ending hooks (a story-clock
    // skip, a place change) are skipped here for the same reason — a read-only look at
    // a turn may not end a contact.
    const { act, resolution, commit } = planChatContactTurn({
      scene: cut.scenario.scene,
      message: input.message.content,
      narratorInput: input.message.narrator,
      characters,
      eventRef,
      storyTime: storyMinute,
      ...(permissionPolicy === undefined ? {} : { permissionPolicy }),
      sink: input.sink,
    });
    if (act === null || resolution === null) return { outcomes: [], unresolvedPremise: null };
    const acknowledgment =
      commit?.status === "committed"
        ? chatContactAcknowledgment({ commit, eventRef, actionId: act.actionId })
        : undefined;
    return {
      outcomes: [
        chatContactActionOutcome({
          act,
          resolution,
          eventRef,
          ...(commit === null ? {} : { commit }),
          ...(acknowledgment === undefined ? {} : { acknowledgment }),
          sink: input.sink,
        }),
      ],
      // The same typed premise the live leg derives — the inspector and the
      // prompt preview must both explain (or show) the reach fence the turn built.
      unresolvedPremise: chatContactUnresolvedPremise({ act, resolution, characters }),
    };
  } catch (error) {
    log.error("engine.chat", "chat contact preview failed", { error: describeError(error) });
    return { outcomes: [], unresolvedPremise: null };
  }
}

/**
 * The read-only developer preview of narrator physical guidance (source
 * resolution → candidate → disclosure → selection → rendered instruction).
 *
 * Computes on demand from the stored cut and the newest player line, and stores
 * NOTHING — there is nothing to store, because the live path recomputes this every
 * turn by design. Like the affordance preview it REPORTS `CHAT_PHYSICAL_CONSTRAINTS`
 * rather than obeying it: a developer asking why a fence never appeared needs the
 * answer with the flag off too.
 */
export async function previewChatPhysicalGuidance(input: {
  chatId: string;
  character: { id: string; name: string; profile: unknown };
}): Promise<PhysicalGuidancePreview> {
  const sink = new DiagnosticCollector();
  const cut = await loadChatPreviewCut({ chatId: input.chatId, character: input.character, sink });
  const read = chatVisualStateAffordanceRead({ characterId: input.character.id, cut, sink });
  const message = await lastPlayerMessage(input.chatId);
  const sensoryFocus = previewSensoryFocus({ character: input.character, cut, message });
  // Reported, never obeyed — the same discipline the affordance read above follows. A
  // developer asking why a contact turn narrated nothing needs the answer with
  // `CHAT_CONTACT_ACTIONS` off too, which is why this runs unconditionally and the
  // flag rides the preview as a field. (`previewChatPrompt` gates on it instead: that
  // surface is showing prompt bytes, so it has to obey.)
  const contact = await previewChatContactOutcomes({
    chatId: input.chatId,
    character: input.character,
    cut,
    message,
    sink,
  });
  const actionOutcomes = contact.outcomes;
  const stages = buildChatPhysicalGuidanceStages({
    read: read.read,
    perception: read.request.perception,
    committed: read.committed,
    subjectId: input.character.id,
    characterName: input.character.name,
    playerName: cut.player.name,
    message: message.content,
    narratorInput: message.narrator,
    // Same pure detector the live turn runs over the same line, so the inspector cannot
    // report a relevance decision the turn would not have made.
    sensoryFocus,
    // An empty list compiles identically to no list at all
    // (`normalizeGuidanceCandidates`), so the no-contact staircase is unchanged.
    actionOutcomes,
    sink,
  });
  return buildChatPhysicalGuidancePreview({
    flagEnabled: chatPhysicalConstraintsEnabled(),
    contactFlagEnabled: chatContactActionsEnabled(),
    narratorInput: message.narrator,
    message: message.content,
    playerName: cut.player.name,
    characterName: input.character.name,
    committed: read.committed,
    candidateConstraints: stages.candidateConstraints,
    candidateCorrections: stages.candidateCorrections,
    candidateActionOutcomes: stages.candidateActionOutcomes,
    guidance: stages.guidance,
    relevance: stages.relevance,
    constraintCodes: read.read.constraints.map((constraint) => constraint.code),
    rendered: renderChatPhysicalGuidance({
      guidance: stages.guidance,
      characterName: input.character.name,
      possessive: `${input.character.name}'s`,
      ...(contact.unresolvedPremise === null ? {} : { unresolvedPremise: contact.unresolvedPremise }),
      sink,
    }),
    diagnostics: [...stages.guidance.diagnostics, ...sink.items.filter((item) => item.code.startsWith("guidance."))],
  });
}

/**
 * Rebuild "what would reach the narrator now" for the dev inspector: the same
 * assembly as a live exchange — stored state (read-only
 * drift), rolling summary, persona, RAG recall — rendered into the prompt parts,
 * without touching state, history, or the exchange lock. Reflects the POST-exchange
 * state (i.e. the NEXT turn's prompt), which is what comparing live play against the
 * eval fixtures wants.
 */
export async function previewChatPrompt(input: {
  chatId: string;
  memoryGroupId: string;
  character: { id: string; name: string; profile: unknown };
}): Promise<ChatPromptPreview> {
  const sink = new DiagnosticCollector();
  // The inspector SHOWS the narrator prompt, so it has to show the one the next
  // exchange would actually build — including a Prompt Lab override. Agent
  // isolation does not apply here: that rule
  // keeps the resolved source away from HELPER AGENTS (pulse, extractors,
  // classifiers, composer, deliberator), which produce structured state rather
  // than prose. This surface renders the prose narrator's own prompt, and an
  // inspector that quietly showed production bytes for a conversation running a
  // test template would be worse than no inspector: the one place you go to ask
  // "what is the narrator actually being told" would answer wrongly, and the
  // Prompt Lab's whole point is being able to read that answer.
  //
  // Read-only: this resolves the CURRENT selection at preview time and generates
  // nothing. It is not the exchange's frozen source, and it takes no lock — the
  // live turn resolves its own under its own lock.
  const instructionSource = await resolveNarratorInstructionSource(
    await chatOwnerId(input.chatId),
    input.chatId,
    sink,
  );
  const cut = await loadChatPreviewCut({ chatId: input.chatId, character: input.character, sink });
  const { profile, scenario, state, player, wardrobe, playerWardrobe } = cut;
  const summaryState = await loadChatSummary(input.chatId);
  const memory = await retrieveChatMemory({
    groupId: input.memoryGroupId,
    queries: state.memoryQueries,
    input: "",
    sink,
  });
  // The inspector must show exactly what the live turn would build, garment
  // blocks included (slice 6) — same builder, same flag, one place to be wrong.
  const previewPlaceName = currentScenePlace(scenario.sceneMemory)?.name;
  // Same for the affordance cues (slice 5): re-derived read-only from the STORED
  // cut. The preview never persists `nextCues`, so looking at a prompt can't spend
  // the repeat gate — the read is pure, so rebuilding it costs nothing but CPU.
  const previewAffordance = chatAffordanceCuesEnabled()
    ? chatVisualStateAffordanceRead({ characterId: input.character.id, cut, sink })
    : null;
  const previewGarmentNarration = chatGarmentCuesEnabled()
    ? buildChatGarmentNarration({
        store: scenario.garments,
        atMinutes: scenario.clockMinutes,
        ...(previewPlaceName === undefined ? {} : { placeName: previewPlaceName }),
        actors: chatGarmentNarrationActors({
          characterId: input.character.id,
          characterName: input.character.name,
          playerName: player.name,
          characterVisibility: wardrobe.partVisibility,
          playerVisibility: playerWardrobe.partVisibility,
        }),
      })
    : null;
  // Same for the physical-guidance block: the
  // inspector must show what a live turn would build, so it runs the same compile
  // over the stored cut and the newest player line — the message a live turn would
  // have been holding. Nothing is stored either way; guidance never was.
  let previewPhysicalGuidance: readonly string[] = [];
  if (chatPhysicalConstraintsEnabled()) {
    const read = chatVisualStateAffordanceRead({ characterId: input.character.id, cut, sink });
    const message = await lastPlayerMessage(input.chatId);
    const sensoryFocus = previewSensoryFocus({ character: input.character, cut, message });
    // BOTH flags, exactly as the live path gates them: the contact leg is its own
    // experiment, and its outcome only reaches the narrator inside the guidance block
    // it rides in. Unlike the inspector, this surface OBEYS `CHAT_CONTACT_ACTIONS` —
    // it is showing prompt bytes, so a flag-off preview has to BE the flag-off bytes.
    const contact = chatContactActionsEnabled()
      ? await previewChatContactOutcomes({ chatId: input.chatId, character: input.character, cut, message, sink })
      : { outcomes: [] as readonly PhysicalActionOutcome[], unresolvedPremise: null };
    previewPhysicalGuidance = renderChatPhysicalGuidance({
      guidance: buildChatPhysicalGuidance({
        read: read.read,
        perception: read.request.perception,
        committed: read.committed,
        subjectId: input.character.id,
        characterName: input.character.name,
        playerName: player.name,
        message: message.content,
        narratorInput: message.narrator,
        sensoryFocus,
        // The same conditional spread the live call site uses, for the same reason: a
        // contact-flag-off preview compiles the exact bytes it compiled before the leg.
        ...(contact.outcomes.length > 0 ? { actionOutcomes: contact.outcomes } : {}),
        sink,
      }),
      characterName: input.character.name,
      possessive: `${input.character.name}'s`,
      ...(contact.unresolvedPremise === null ? {} : { unresolvedPremise: contact.unresolvedPremise }),
      sink,
    });
  }
  const parts = buildCharacterChatPromptParts({
    name: input.character.name,
    profile,
    instructionSource,
    priorSummary: summaryState?.summary,
    memory,
    player: playerPromptSlice(player, playerWardrobe),
    state: promptStateSlice(
      state,
      scenario,
      wardrobe,
      profile,
      previewGarmentNarration,
      previewAffordance
        ? renderChatAffordanceCues({
            cues: previewAffordance.read.cues,
            attributes: previewAffordance.attributes,
            possessive: `${input.character.name}'s`,
            garmentNames: previewAffordance.garmentNames,
            spokenGarmentIds: new Set(previewGarmentNarration?.wetnessGarmentIds ?? []),
          })
        : [],
    ),
    narrationShape: narrationShapeId("chat"),
    // Conditional spread, exactly as the live path threads it: absent when the flag
    // is off, so the previewed prompt is byte-identical to the pre-feature build.
    ...(previewPhysicalGuidance.length > 0 ? { physicalGuidance: previewPhysicalGuidance } : {}),
  });
  return {
    prefix: parts.prefix,
    tail: parts.tail,
    memory: { facts: memory.facts, episodes: memory.episodes },
    memoryQueries: state.memoryQueries,
  };
}
