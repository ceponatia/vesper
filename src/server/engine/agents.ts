import { and, desc, eq } from "drizzle-orm";
import type { ZodType } from "zod";
import type { DiagnosticSink } from "@/contracts/diagnostics";
import {
  archivistResultSchema,
  continuityResultSchema,
  directorResultSchema,
  simulantResultSchema,
  type AgentResults,
  type ArchivistResult,
  type ContinuityResult,
  type DirectorResult,
  type SimulantResult,
  type TurnProvider,
  type TurnProviders,
} from "@/contracts/turns/agent-results";
import type { TurnAuthor } from "@/contracts/turns/stream";
import { agentModelId, generateChecked, isDemoMode, type GenerateCheckedResult } from "../ai";
import { db, facts } from "../db";
import { activeLocationId, type BundleItem, type SessionBundle } from "./bundle";
import { stagedLocationAnchor } from "./merge";
import { demoAgentResults } from "./demo";
import {
  ARCHIVIST_SYSTEM,
  buildArchivistPrompt,
  buildContinuityPrompt,
  buildDirectorPrompt,
  buildSimulantPrompt,
  CONTINUITY_SYSTEM,
  DIRECTOR_SYSTEM,
  SIMULANT_SYSTEM,
} from "./prompts/agents";
import { buildAwarenessBlocks, buildCanonicalFactsBlock, buildPresenceRoster, dispositionBandSummary, effectiveMeterDefinitions } from "./scene";
import { detectIntent } from "./intent";
import { sceneIntentFromBrief } from "./intake";
import type { IntentBrief } from "@/contracts/turns/intent-brief";
import { resolveGameTime } from "@/lib/clock";

/**
 * Post-turn agent fan-out (docs/turn-engine.md §Post-turn agents): four
 * single-concern generateChecked calls in parallel, each fed only its own
 * state slice. Agents fail independently — a failed agent is null in the
 * result and the merge reducer applies its documented degraded default.
 *
 * Alongside the results it returns per-agent `providers` — which OpenRouter
 * upstream served each call and how long it took — for the Inspector's
 * slow-provider tracking (the narrator's own attribution is captured in the
 * pipeline; embedding is excluded).
 */

/** How many recent active facts ride in the archivist prompt as supersede candidates. */
const ARCHIVIST_ACTIVE_FACTS = 10;

export interface AgentTurnInput {
  number: number;
  author: TurnAuthor;
  input: string;
  /**
   * The pre-narrator intake brief persisted on the turn (pipeline passes it
   * through). The continuity awareness rebuild reuses it instead of re-running
   * `detectIntent`, so the auditor sees exactly the intent the narrator's prompt
   * used. Absent on pre-migration turns / callers that don't supply it → falls
   * back to `detectIntent`.
   */
  intentBrief?: IntentBrief;
}

export interface RunAgentsOptions {
  /** Reconcile mode: simulant in end-state mode, continuity/director skipped. */
  endState?: boolean;
  sink?: DiagnosticSink;
}

export interface PostTurnAgentsResult {
  results: AgentResults;
  /** Per-agent provider attribution (embedding excluded); empty in demo mode. */
  providers: TurnProviders;
}

export async function runPostTurnAgents(
  bundle: SessionBundle,
  turn: AgentTurnInput,
  narration: string,
  opts: RunAgentsOptions = {},
): Promise<PostTurnAgentsResult> {
  const activeLoc = activeLocationId(bundle);
  // Anchor presence exactly where the narrator's prompt anchored it: a staged
  // player move (merge.stagedLocationAnchor) made the TARGET room's occupants
  // Present in the prompt — auditing against the old room would flag them
  // (followups.phase2.md #13).
  const anchorLoc = stagedLocationAnchor(bundle, turn.input, turn.author).staged?.id ?? activeLoc;
  const present = bundle.participants.filter((p) => p.locationId !== null && p.locationId === anchorLoc);
  const presentNames = present.map((p) => p.displayName);
  const player = bundle.participants.find((p) => p.isUser);

  if (isDemoMode()) {
    const demo = demoAgentResults(turn.input, {
      npcNames: present.filter((p) => !p.isUser).map((p) => p.displayName),
      locationNames: bundle.locations.map((l) => l.name),
      playerName: bundle.session.embodied ? player?.displayName : undefined,
      narration,
      priorBrief: bundle.brief,
    });
    if (opts.endState) return { results: { ...demo, continuity: null, director: null }, providers: {} };
    return { results: demo, providers: {} };
  }

  const locationNameById = new Map(bundle.locations.map((l) => [l.id, l.name]));
  const meterIds = effectiveMeterDefinitions(bundle.style).map((m) => m.id);
  const scopedItems = inScopeItems(bundle, activeLoc);

  const simulantPrompt = buildSimulantPrompt({
    playerInput: turn.input,
    narration,
    author: turn.author,
    participants: bundle.participants.map((p) => ({
      displayName: p.displayName,
      isUser: p.isUser,
      locationName: p.locationId ? (locationNameById.get(p.locationId) ?? null) : null,
      activity: p.state.activity,
      meters: p.state.meters,
      traitBands: p.isUser ? undefined : dispositionBandSummary(p.snapshot.traits),
    })),
    locations: bundle.locations.map((l) => ({ name: l.name, exits: exitNames(bundle, l.id) })),
    items: scopedItems.map((i) => ({ name: i.name, placement: placementLabel(i, bundle) })),
    meterIds,
    endState: opts.endState,
  });

  const activeFactRows = await db()
    .select({ subjectName: facts.subjectName, text: facts.text })
    .from(facts)
    .where(and(eq(facts.sessionId, bundle.session.id), eq(facts.status, "active")))
    .orderBy(desc(facts.createdAt))
    .limit(ARCHIVIST_ACTIVE_FACTS);

  const archivistPrompt = buildArchivistPrompt({
    playerInput: turn.input,
    narration,
    author: turn.author,
    characterNames: bundle.participants.map((p) => p.displayName),
    locationNames: bundle.locations.map((l) => l.name),
    itemNames: scopedItems.map((i) => i.name),
    activeFacts: activeFactRows,
  });

  // In-session post-turn agents use the world's agent-model override (World tab),
  // falling back to the default. Authoring agents don't pass modelId, so they
  // stay on the default — outside the session switch.
  const agentModel = agentModelId(bundle.world.agentModel);
  // lowLatencyRouting: prefer the lowest-latency provider endpoint for the model
  // (same weights). The four agents fan out in parallel post-turn; trimming each
  // one's TTFT tail returns the session to "ready" sooner (the dominant cost is
  // OpenRouter routing variance, not output length — pre-narrator-agents.followups.md §2d).
  const run = <T>(schema: ZodType<T>, system: string, prompt: string, code: string) =>
    generateChecked<T>({ schema, system, prompt, code, modelId: agentModel, sink: opts.sink, lowLatencyRouting: true });

  if (opts.endState) {
    const [simulant, archivist] = await Promise.allSettled([
      run<SimulantResult>(simulantResultSchema, SIMULANT_SYSTEM, simulantPrompt, "agent.simulant"),
      run<ArchivistResult>(archivistResultSchema, ARCHIVIST_SYSTEM, archivistPrompt, "agent.archivist"),
    ]);
    return {
      results: {
        simulant: settle(simulant),
        archivist: settle(archivist),
        continuity: null,
        director: null,
      },
      providers: providersFrom({ simulant, archivist }),
    };
  }

  // Awareness blocks the continuity agent audits `reacted_to_unperceived_event`
  // against — same builder, anchor, and turn-start clock the pre-turn prompt used,
  // so the auditor sees exactly what the narrator was told who could perceive.
  // Reuse the persisted intake brief so the continuity auditor's awareness
  // blocks are byte-identical to the narrator's prompt (no second derivation);
  // fall back to the regex for turns that carry no brief.
  const continuityIntent = turn.intentBrief
    ? sceneIntentFromBrief(turn.intentBrief)
    : detectIntent(turn.input, presentNames, []);
  const continuityGameTime = resolveGameTime(bundle.clockMinutes, bundle.style.calendarStart);
  const awarenessBlocks = buildAwarenessBlocks(bundle, anchorLoc, continuityIntent, continuityGameTime, turn.input);

  const continuityPrompt = buildContinuityPrompt({
    playerInput: turn.input,
    narration,
    author: turn.author,
    canonicalFactsBlock: buildCanonicalFactsBlock(bundle),
    // Pre-merge locations, anchored where the narrator's prompt was (staged
    // move target when the player entered a room) — the roster rule 6 audits
    // against must be the one the narrator actually saw.
    presenceRoster: buildPresenceRoster(bundle, anchorLoc),
    awarenessBlocks,
    socialCards: bundle.style.socialCards,
    presentNames,
  });

  const directorPrompt = buildDirectorPrompt({
    playerInput: turn.input,
    narration,
    author: turn.author,
    priorBrief: bundle.brief,
    threads: bundle.runtime.storyThreads.filter((t) => t.status === "open" || t.status === "cooling"),
    turnNumber: turn.number,
    presentNames,
    // Present NPCs' standing trait bands so direction/notes fit their temperament (DIRECTOR_SYSTEM Rule 7).
    presentDisposition: present
      .filter((p) => !p.isUser)
      .map((p) => ({ name: p.displayName, bands: dispositionBandSummary(p.snapshot.traits) })),
    // Off-screen NPCs the director may pre-position (the Cast-tab notion of "elsewhere").
    absentNpcs: bundle.participants
      .filter((p) => !p.isUser && p.locationId !== anchorLoc)
      .map((p) => ({ name: p.displayName, locationName: p.locationId ? (locationNameById.get(p.locationId) ?? null) : null })),
    locationNames: bundle.locations.map((l) => l.name),
    stagedIntents: bundle.runtime.stagedIntents
      .filter((s) => s.status === "active")
      .map((s) => ({
        id: s.id,
        npcName: bundle.participants.find((p) => p.id === s.participantId)?.displayName ?? s.participantId,
        destinationName: locationNameById.get(s.destinationLocationId) ?? s.destinationLocationId,
        reason: s.reason,
      })),
  });

  const [simulant, archivist, continuity, director] = await Promise.allSettled([
    run<SimulantResult>(simulantResultSchema, SIMULANT_SYSTEM, simulantPrompt, "agent.simulant"),
    run<ArchivistResult>(archivistResultSchema, ARCHIVIST_SYSTEM, archivistPrompt, "agent.archivist"),
    run<ContinuityResult>(continuityResultSchema, CONTINUITY_SYSTEM, continuityPrompt, "agent.continuity"),
    run<DirectorResult>(directorResultSchema, DIRECTOR_SYSTEM, directorPrompt, "agent.director"),
  ]);

  return {
    results: {
      simulant: settle(simulant),
      archivist: settle(archivist),
      continuity: settle(continuity),
      director: settle(director),
    },
    providers: providersFrom({ simulant, archivist, continuity, director }),
  };
}

/**
 * A degraded generateChecked result counts as a failed agent: the merge
 * reducer owns the documented per-agent fallbacks (docs/turn-engine.md
 * §Degraded defaults), so it must see null, not a schema-default object.
 */
function settle<T>(result: PromiseSettledResult<{ value: T | null; degraded: boolean }>): T | null {
  if (result.status === "rejected") return null;
  if (result.value.degraded) return null;
  return result.value.value;
}

/**
 * Provider attribution for one agent leg. Recorded independently of `settle` —
 * a degraded agent still tells us which (possibly slow) provider it hit; only a
 * call that never completed (rejected / no latency) is omitted.
 */
function providerOf(result: PromiseSettledResult<GenerateCheckedResult<unknown>>): TurnProvider | null {
  if (result.status === "rejected") return null;
  const { provider, latencyMs } = result.value;
  if (latencyMs === undefined) return null;
  return { provider: provider ?? null, ms: latencyMs };
}

/** Collapse each settled agent into its provider entry, dropping legs that never completed. */
function providersFrom(
  legs: Partial<Record<keyof AgentResults, PromiseSettledResult<GenerateCheckedResult<unknown>>>>,
): TurnProviders {
  const providers: TurnProviders = {};
  for (const [leg, result] of Object.entries(legs)) {
    if (!result) continue;
    const entry = providerOf(result);
    if (entry) providers[leg as keyof AgentResults] = entry;
  }
  return providers;
}

function exitNames(bundle: SessionBundle, locationId: string): string[] {
  const nameById = new Map(bundle.locations.map((l) => [l.id, l.name]));
  const out: string[] = [];
  const seen = new Set<string>();
  for (const link of bundle.links) {
    const target = link.fromId === locationId ? link.toId : link.toId === locationId ? link.fromId : null;
    if (!target || seen.has(target)) continue;
    seen.add(target);
    const name = nameById.get(target);
    if (name) out.push(name);
  }
  return out;
}

/** Items the agents may reference: held/worn by present participants, loose in the room, or in room containers. */
function inScopeItems(bundle: SessionBundle, activeLoc: string | null): BundleItem[] {
  const presentIds = new Set(
    bundle.participants.filter((p) => p.locationId !== null && p.locationId === activeLoc).map((p) => p.id),
  );
  const roomItemIds = new Set(
    bundle.items.filter((i) => i.locationId !== null && i.locationId === activeLoc).map((i) => i.id),
  );
  return bundle.items.filter(
    (i) =>
      (i.holderParticipantId !== null && presentIds.has(i.holderParticipantId)) ||
      (i.locationId !== null && i.locationId === activeLoc) ||
      (i.containerInstanceId !== null && roomItemIds.has(i.containerInstanceId)),
  );
}

function placementLabel(item: BundleItem, bundle: SessionBundle): string {
  if (item.holderParticipantId) {
    const holder = bundle.participants.find((p) => p.id === item.holderParticipantId);
    const name = holder?.displayName ?? "someone";
    return item.worn ? `worn by ${name}` : `carried by ${name}`;
  }
  if (item.containerInstanceId) {
    const container = bundle.items.find((i) => i.id === item.containerInstanceId);
    return `inside ${container?.name ?? "a container"}`;
  }
  if (item.locationId) {
    const loc = bundle.locations.find((l) => l.id === item.locationId);
    return `in ${loc?.name ?? "the scene"}`;
  }
  return "unplaced";
}
