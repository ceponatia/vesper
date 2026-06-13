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
} from "@/contracts/turns/agent-results";
import type { TurnAuthor } from "@/contracts/turns/stream";
import { generateChecked, isDemoMode } from "../ai";
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
import { buildAwarenessBlocks, buildCanonicalFactsBlock, buildPresenceRoster, effectiveMeterDefinitions } from "./scene";
import { detectIntent } from "./intent";
import { resolveGameTime } from "@/lib/clock";

/**
 * Post-turn agent fan-out (docs/turn-engine.md §Post-turn agents): four
 * single-concern generateChecked calls in parallel, each fed only its own
 * state slice. Agents fail independently — a failed agent is null in the
 * result and the merge reducer applies its documented degraded default.
 */

/** How many recent active facts ride in the archivist prompt as supersede candidates. */
const ARCHIVIST_ACTIVE_FACTS = 10;

export interface AgentTurnInput {
  number: number;
  author: TurnAuthor;
  input: string;
}

export interface RunAgentsOptions {
  /** Reconcile mode: simulant in end-state mode, continuity/director skipped. */
  endState?: boolean;
  sink?: DiagnosticSink;
}

export async function runPostTurnAgents(
  bundle: SessionBundle,
  turn: AgentTurnInput,
  narration: string,
  opts: RunAgentsOptions = {},
): Promise<AgentResults> {
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
    if (opts.endState) return { ...demo, continuity: null, director: null };
    return demo;
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

  const run = <T>(schema: ZodType<T>, system: string, prompt: string, code: string) =>
    generateChecked<T>({ schema, system, prompt, code, sink: opts.sink });

  if (opts.endState) {
    const [simulant, archivist] = await Promise.allSettled([
      run<SimulantResult>(simulantResultSchema, SIMULANT_SYSTEM, simulantPrompt, "agent.simulant"),
      run<ArchivistResult>(archivistResultSchema, ARCHIVIST_SYSTEM, archivistPrompt, "agent.archivist"),
    ]);
    return {
      simulant: settle(simulant),
      archivist: settle(archivist),
      continuity: null,
      director: null,
    };
  }

  // Awareness blocks the continuity agent audits `reacted_to_unperceived_event`
  // against — same builder, anchor, and turn-start clock the pre-turn prompt used,
  // so the auditor sees exactly what the narrator was told who could perceive.
  const continuityIntent = detectIntent(turn.input, presentNames, []);
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
    norms: bundle.style.norms,
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
  });

  const [simulant, archivist, continuity, director] = await Promise.allSettled([
    run<SimulantResult>(simulantResultSchema, SIMULANT_SYSTEM, simulantPrompt, "agent.simulant"),
    run<ArchivistResult>(archivistResultSchema, ARCHIVIST_SYSTEM, archivistPrompt, "agent.archivist"),
    run<ContinuityResult>(continuityResultSchema, CONTINUITY_SYSTEM, continuityPrompt, "agent.continuity"),
    run<DirectorResult>(directorResultSchema, DIRECTOR_SYSTEM, directorPrompt, "agent.director"),
  ]);

  return {
    simulant: settle(simulant),
    archivist: settle(archivist),
    continuity: settle(continuity),
    director: settle(director),
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
