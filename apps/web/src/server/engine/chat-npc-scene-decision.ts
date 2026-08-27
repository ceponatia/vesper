import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  activeContactsOf,
  admitNpcSceneCandidate,
  affordanceSubjectId,
  buildNpcSceneDigest,
  canonicalNpcSceneDigestString,
  diag,
  emptySceneState,
  garmentActorForCharacter,
  npcSceneNarrationSentences,
  GARMENT_PLAYER_ACTOR,
  NPC_SCENE_PLAYER_REF,
  parseNpcSceneDecisionOutput,
  parseSceneState,
  planNpcSceneChronology,
  type AffordanceSubjectId,
  type CharacterProfile,
  type ContactEventRef,
  type ContactLifecycleCommit,
  type DiagnosticSink,
  type NpcRef,
  type NpcSceneCandidate,
  type NpcSceneChronologyPlan,
  type NpcSceneDecisionParse,
  type NpcSceneDigest,
  type NpcSceneDigestHandles,
  type NpcSceneDigestPresence,
  type NpcSceneFloorEntry,
  type NpcSceneReplySpan,
  type NpcSceneSlot,
  type NpcSceneTier2Entry,
  type ParticipantRef,
  type PersonaProfile,
  type SceneState,
} from "@/contracts";
import type { AgentRunDescription } from "@/contracts/turns/agent-failure";
import { parseOrNull } from "@/lib/parse";
import { agentModelId, generateChecked, withGenerateTimeout, type AgentTelemetry } from "../ai";
import { characterChatMessages, characterChats, characterChatState, db } from "../db";
import { log } from "../log";
import {
  chatContactMaterialAtCut,
  CHAT_CONTACT_PLAYER_SUBJECT,
  type ChatContactMaterialSource,
} from "./chat-contact-adapter";
import {
  applyChatNpcContactEnding,
  chatReplyContactEventRef,
  detectChatNpcContactEnding,
  type ChatNpcContactEnding,
  type ChatNpcEndingCharacter,
} from "./chat-contact-reply";
import { locateChatNpcEndingActionSpan } from "./chat-contact-reply-offsets";
import {
  chatNpcDigestHash,
  chatNpcReplyHash,
  chatNpcSceneHash,
  loadChatNpcSceneDecision,
  recordChatNpcSceneDecision,
  NPC_SCENE_DECISION_MAX_CONTACT_ROWS,
  NPC_SCENE_DECISION_MAX_ROWS_PER_ACTION,
  NPC_SCENE_DECISION_PAYLOAD_VERSION,
  NPC_SCENE_DECISION_PERSISTENCE_CONFLICT,
  type ChatNpcSceneDecisionEnvelope,
  type NpcSceneDecisionAction,
  type NpcSceneDecisionDrop,
  type NpcSceneDecisionMode,
  type NpcSceneDecisionPayload,
  type NpcSceneDecisionStatus,
} from "./chat-npc-scene-envelope";
import {
  executeNpcSceneDecision,
  npcSceneCandidateSlot,
  npcSceneCandidateSummary,
  npcSceneDropEvidence,
  npcSceneFloorDetail,
  npcSceneQuoteHash,
  recordNpcSceneDrop,
  NPC_SCENE_DECISION_DETAIL_MAX,
  type NpcSceneExecutionMember,
  type NpcSceneMaterialCut,
} from "./chat-npc-scene-execute";
import { loadChatScenario } from "./chat-state";
import { resolveChatWardrobe, resolvePlayerWardrobe, playerWornIds } from "./chat-wardrobe";
import {
  CHAT_NPC_SCENE_DECISION_MAX_OUTPUT_TOKENS,
  CHAT_NPC_SCENE_DECISION_TIMEOUT_MS,
} from "./constants";
import {
  buildChatNpcSceneDecisionPrompt,
  CHAT_NPC_SCENE_DECISION_SYSTEM,
} from "./prompts/chat-npc-scene-decision";
import {
  chatContactActionsEnabled,
  chatNpcSceneDecisionsEnabled,
  chatNpcSceneDecisionShadowEnabled,
} from "./prompts/constants";

/**
 * THE COMMON NPC REPLY-SCENE DECISION LEG — the shadow wiring:
 * one classifier call per persisted nonempty assistant reply across EVERY
 * included reply kind, an authoritative post-settle presence cut, and NO new
 * authority — shadow evaluates and records, it never changes the scene beyond
 * what the frozen floor already does today.
 *
 * The leg runs in two halves around settlement, matching its execution
 * order ("launch the single classifier call concurrently with normal
 * post-reply settlement; resolution waits for the post-settle cut"):
 *
 * 1. **`beginChatNpcSceneDecision`** — right after nonempty reply persistence,
 *    BEFORE the state fan-out. It runs the reuse check first (an existing
 *    envelope for this assistant message is never reclassified, regardless of
 *    current flags), assembles the compact digest from the PRE-settle cut
 *    (prompt-time roster presence, the scene as the player leg left it, active
 *    contacts, pair proximity), runs the pure trigger, and — when the trigger
 *    fires — launches the ONE classifier call so it races settlement instead
 *    of following it. The ref↔id handle maps stay OUTSIDE the digest: they
 *    ride the handle for resolution and the envelope, never the model.
 *
 * 2. **`finishChatNpcSceneDecision`** — at the settle tail (and on the opening
 *    branch before it returns), the exchange's LAST scene writer. It reloads
 *    everything FRESH — the assistant row and exact reply bytes, the scene
 *    column and story minute, every roster member's persisted presence, and
 *    (only when an admitted contact start will read it) the settled garment
 *    store with per-actor coverage — never reusing the pipeline's stale
 *    `scenario` variable, awaits the classifier, parses slots independently,
 *    runs the four admission gates and the chronology planner, and records ONE
 *    durable envelope through the guarded transaction. The frozen floor's ending
 *    detection runs here too (under `CHAT_CONTACT_ACTIONS`, exactly as it ships
 *    today) and its commits ride the SAME transaction, so the ended projection
 *    and its decision record land atomically.
 *
 *    The one thing it CANNOT reload is what the settle itself did: the caller
 *    hands that in as a `ChatNpcSceneSettleReport` (today, which bodies had their
 *    wardrobe rewritten during this reply — the contact start's chronology veto).
 *
 * **Shadow evaluation is DRY.** An admitted tier-2 candidate is recorded as
 * admitted-but-not-executed (`resolution: "unresolved"`, detail names shadow);
 * no movement commits, no contact starts/updates, no presence-driven endings.
 *
 * **Authority EXECUTES the same admitted plan** (spec delivery steps 4–6;
 * `chat-npc-scene-execute.ts`). Everything up to and including the chronology
 * plan is SHARED — `admitNpcSceneDecision` is the one implementation of the four
 * gates, presence precedence, and the planner, so a shadow measurement and an
 * authority run can never disagree about what was admitted. Only the last step
 * forks: shadow records the plan dry, authority hands it to the executor, whose
 * presence endings, floor endings, movement commits, and contact start/update
 * rows all ride the SAME guarded transaction as the envelope.
 *
 * Every failure is fenced (docs/resilience.md): the leg degrades to "no
 * envelope this exchange" (or a `degraded` tombstone when one is persistable)
 * and never costs the settled reply. Persistence conflicts are the guarded
 * transaction's typed results — a warn diagnostic and nothing else.
 */

/** The classifier-output schema version the envelope records (`NpcSceneDecisionOutputV1`). */
export const NPC_SCENE_DECISION_SCHEMA_VERSION = 1;

/** The one leg id every diagnostic/telemetry row of the classifier call files under. */
const CLASSIFY_LEG_ID = "npc_scene_decision.classify";

/** The envelope-level degradation code. */
export const NPC_SCENE_DECISION_DEGRADED = "npc_scene_decision.degraded";

// ---------------------------------------------------------------------------
// Mode
// ---------------------------------------------------------------------------

/**
 * Which decision mode this exchange runs under, or `null` for "the leg does
 * not exist" (both flags off ⇒ the legacy reply-side ending block runs
 * byte-identically). Authority wins when both flags are on; note the authority
 * flag is itself effective only with `CHAT_CONTACT_ACTIONS=on`
 * (`chatNpcSceneDecisionsEnabled`).
 */
export function chatNpcSceneDecisionMode(): NpcSceneDecisionMode | null {
  if (chatNpcSceneDecisionsEnabled()) return "authority";
  if (chatNpcSceneDecisionShadowEnabled()) return "shadow";
  return null;
}

// ---------------------------------------------------------------------------
// The trigger (pure)
// ---------------------------------------------------------------------------

/**
 * The trigger's verb-stem lexicon — deliberately BROAD AND SLOPPY, because it
 * controls cost rather than authority and so may use a broader verb-stem list
 * than the floor. Prefix-matched, so `step` covers steps/stepped/
 * stepping. It is a SUPERSET of the frozen floor's withdraw/separate verbs and
 * of every congruence lexicon, so a sentence the floor or the verifiers could
 * act on can never be a trigger miss; the false positives it also admits cost
 * one classifier call, never authority.
 */
const TRIGGER_VERB_STEMS = [
  "approach",
  "back",
  "brush",
  "came",
  "close",
  "come",
  "cross",
  "draw",
  "drew",
  "drift",
  "duck",
  "ease",
  "edge",
  "gentle",
  "guide",
  "held",
  "hold",
  "inch",
  "laid",
  "lay",
  "lean",
  "let",
  "lift",
  "move",
  "pat",
  "place",
  "press",
  "pull",
  "push",
  "put",
  "reach",
  "relax",
  "remove",
  "rest",
  "rise",
  "rose",
  "sat",
  "scoot",
  "set",
  "settle",
  "shift",
  "shrug",
  "sink",
  "sit",
  "slid",
  "slide",
  "slip",
  "squeeze",
  "stand",
  "step",
  "still",
  "stood",
  "take",
  "took",
  "touch",
  "turn",
  "twist",
  "walk",
  "withdraw",
  "wrap",
] as const;

const TRIGGER_VERB_RE = new RegExp(`\\b(?:${TRIGGER_VERB_STEMS.join("|")})`, "iu");
/** Subject pronouns only — the trigger asks who might have ACTED, not who was touched. */
const TRIGGER_PRONOUN_RE = /(?<=^|[^\p{L}'’-])(?:she|he|they)(?=$|[^\p{L}'’-])/iu;

function escapeRegex(token: string): string {
  return token.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/** The first word of a display name, lowercased — how prose usually names her. */
function firstNameOf(name: string): string {
  return (name.trim().split(/\s+/u)[0] ?? "").toLowerCase();
}

/**
 * The cheap deterministic trigger: does any NARRATION sentence of the reply
 * contain a movement/contact verb stem AND name a digest roster member (name,
 * alias, or first name) — or a bare third-person pronoun when the digest has
 * exactly one NPC (or exactly one pre-settle-present NPC, so a sole present
 * body's "she" fires even while an away member sits in the digest)?
 *
 * Roster naming is deliberately presence-AGNOSTIC: previously-away members
 * remain in the digest precisely so an arrival narrated in THIS reply can be
 * classified, and a trigger that required pre-settle presence would miss
 * exactly those replies. Misses
 * are measured — the durable `trigger_miss` tombstone is the metric — and
 * never cause fallback extraction.
 */
export function npcSceneDecisionTriggered(reply: string, digest: NpcSceneDigest): boolean {
  if (digest.npcs.length === 0) return false;
  const tokens = new Set<string>();
  for (const npc of digest.npcs) {
    for (const raw of [npc.name, ...npc.aliases, firstNameOf(npc.name)]) {
      const token = raw.trim().toLowerCase();
      if (token.length > 0) tokens.add(token);
    }
  }
  const alternation = [...tokens]
    .sort((left, right) => right.length - left.length || (left < right ? -1 : 1))
    .map(escapeRegex)
    .join("|");
  const nameRe =
    alternation.length > 0
      ? new RegExp(`(?<=^|[^\\p{L}'’-])(?:${alternation})(?=$|[^\\p{L}'’-])`, "iu")
      : null;
  const presentCount = digest.npcs.filter((npc) => npc.presence === "present").length;
  const soleNpc = digest.npcs.length === 1 || presentCount === 1;
  for (const sentence of npcSceneNarrationSentences(reply)) {
    if (!TRIGGER_VERB_RE.test(sentence.text)) continue;
    if (nameRe !== null && nameRe.test(sentence.text)) return true;
    if (soleNpc && TRIGGER_PRONOUN_RE.test(sentence.text)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// The classifier call
// ---------------------------------------------------------------------------

export interface NpcSceneClassifierResult {
  /** The raw model value — judged ONLY by `parseNpcSceneDecisionOutput`. */
  readonly raw: unknown;
  readonly degraded: boolean;
  readonly timedOut: boolean;
  readonly latencyMs: number;
  readonly model: string;
  /**
   * What the call actually spent, when the provider reported it — the figures
   * the shadow measurement's cost gate is stated in. Absent means unmeasured
   * (a timeout, a provider that reported nothing), never free.
   */
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly costUsd?: number;
}

/**
 * The transport schema `generateChecked` parses with: any JSON object. LOOSE
 * ON PURPOSE — the per-digest ref schemas are `z.custom` closures a rendered
 * JSON Schema cannot express, and the slot-independent contract parser
 * (`parseNpcSceneDecisionOutput`) is the ONE judge of shape: a schema strict
 * enough to reject a malformed slot here would erase its valid sibling and
 * launder "malformed" into "degraded", which the durable slot trace forbids.
 * The closed schema reaches the model through the system prompt instead.
 */
const classifierTransportSchema = z.record(z.string(), z.unknown());

/** Inspector activity line for a clean run — mirrors the other structured legs. */
function describeNpcSceneDecision(value: Record<string, unknown>): AgentRunDescription {
  const movement = value.movement !== null && value.movement !== undefined;
  const contact = value.contact !== null && value.contact !== undefined;
  const summary =
    movement || contact
      ? [movement ? "movement proposal" : "", contact ? "contact proposal" : ""].filter(Boolean).join(" · ")
      : "no proposals";
  return { summary, details: [] };
}

/**
 * Launch the ONE classifier call — the `runChatPulse` recipe (reasoning off,
 * latency-sorted routing, no repair, temperature 0) under the leg's OWN hard
 * timeout (`CHAT_NPC_SCENE_DECISION_TIMEOUT_MS`, explicitly not the pulse's
 * temporary diagnostic ceiling). The returned promise NEVER rejects: every
 * failure shape — timeout, provider error, unparseable text — resolves as
 * `degraded`, which the finish half records as a durable tombstone. The
 * controller is aborted only by the timeout, so `signal.aborted` IS the
 * timed-out flag the envelope telemetry stores.
 */
function launchNpcSceneClassifier(input: {
  readonly chatId: string;
  readonly assistantMessageId: string;
  readonly digest: NpcSceneDigest;
  readonly reply: string;
  readonly sink?: DiagnosticSink;
}): Promise<NpcSceneClassifierResult> {
  const controller = new AbortController();
  const modelId = agentModelId();
  const prompt = buildChatNpcSceneDecisionPrompt({ digest: input.digest, reply: input.reply });
  const telemetry: Partial<AgentTelemetry> = {
    legId: CLASSIFY_LEG_ID,
    chatId: input.chatId,
    messageId: input.assistantMessageId,
    modelId,
    promptChars: CHAT_NPC_SCENE_DECISION_SYSTEM.length + prompt.length,
    maxOutputTokens: CHAT_NPC_SCENE_DECISION_MAX_OUTPUT_TOKENS,
  };
  const startedAt = Date.now();
  const work = generateChecked<Record<string, unknown>>({
    schema: classifierTransportSchema,
    system: CHAT_NPC_SCENE_DECISION_SYSTEM,
    prompt,
    modelId,
    temperature: 0,
    maxOutputTokens: CHAT_NPC_SCENE_DECISION_MAX_OUTPUT_TOKENS,
    code: CLASSIFY_LEG_ID,
    ...(input.sink === undefined ? {} : { sink: input.sink }),
    signal: controller.signal,
    disableReasoning: true,
    lowLatencyRouting: true,
    repair: false,
    degradeSeverity: "warn",
    // The cost gate this leg is measured against is stated in tokens and
    // dollars, so the call asks OpenRouter to price itself rather than leaving
    // the envelope to estimate from a model id.
    usageAccounting: true,
    telemetry,
  });
  return withGenerateTimeout(
    work,
    controller,
    CHAT_NPC_SCENE_DECISION_TIMEOUT_MS,
    `${CLASSIFY_LEG_ID}.timeout`,
    input.sink,
    telemetry,
    describeNpcSceneDecision,
  ).then((result) => ({
    raw: result.value,
    degraded: result.degraded || result.value === null,
    timedOut: controller.signal.aborted,
    latencyMs: Math.max(0, Date.now() - startedAt),
    model: modelId,
    ...(result.usage === undefined
      ? {}
      : { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens }),
    ...(result.costUsd === undefined ? {} : { costUsd: result.costUsd }),
  }));
}

/**
 * The envelope's telemetry for one classifier outcome, with the spend figures
 * the cost gate reads.
 *
 * Every spend field is OMITTED when unknown rather than defaulted to zero: the
 * gate treats them as measurements, and a zero would report an unmeasured call
 * as a free one. Each is also checked against the payload schema's own bounds
 * (non-negative; whole-number counts) before it is recorded, because the payload
 * is inserted WITHOUT a runtime parse — a figure the schema would refuse sails
 * into the column and then degrades the WHOLE payload on every later read.
 *
 * `settleWaitMs` is what the finish half actually blocked on the classifier
 * promise, which is the added-settle-latency figure; `latencyMs` measures the
 * call, and a call that finished during settlement cost the exchange nothing.
 */
export function npcSceneDecisionTelemetry(
  result: NpcSceneClassifierResult,
  settleWaitMs: number,
): NpcSceneDecisionPayload["telemetry"] {
  const count = (value: number | undefined): number | undefined =>
    value !== undefined && Number.isInteger(value) && value >= 0 ? value : undefined;
  const inputTokens = count(result.inputTokens);
  const outputTokens = count(result.outputTokens);
  const costUsd =
    result.costUsd !== undefined && Number.isFinite(result.costUsd) && result.costUsd >= 0
      ? result.costUsd
      : undefined;
  return {
    model: result.model,
    latencyMs: result.latencyMs,
    timedOut: result.timedOut,
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(costUsd === undefined ? {} : { costUsd }),
    settleWaitMs: Math.max(0, settleWaitMs),
  };
}

// ---------------------------------------------------------------------------
// Admission and planning (pure, SHARED by both modes)
// ---------------------------------------------------------------------------

/** The frozen floor's half of an evaluation, as the pure evaluator consumes it. */
export interface NpcSceneFloorInput {
  readonly reason: "withdrawn" | "separated";
  /** The ending NPC as a digest ref, when the subject id mapped; `null` never composites. */
  readonly subjectRef: NpcRef | null;
  /** The located action-phrase span, or `null` when the replay could not pin one (the entry then stays unordered). */
  readonly span: NpcSceneReplySpan | null;
  /** The ledger rows the floor's commits produce (whole-commit-list sequences, `contact_continued` skipped). */
  readonly rows: readonly { readonly eventRef: string; readonly sequence: number }[];
  /** Did the floor actually end anything? Zero covered contacts is an ordinary answer. */
  readonly committed: boolean;
}

export interface NpcSceneDecisionEvaluationInput {
  /** The COMPLETED assistant reply, exactly as persisted. */
  readonly reply: string;
  readonly digest: NpcSceneDigest;
  /** POST-settle-present roster refs — presence precedence; the player is implicitly present. */
  readonly presentNpcRefs: readonly NpcRef[];
  /** The slot-independent parse (`parseNpcSceneDecisionOutput`); `malformed_envelope` never reaches here. */
  readonly parse: NpcSceneDecisionParse;
  readonly floor: NpcSceneFloorInput | null;
  readonly sink?: DiagnosticSink;
}

export interface NpcSceneDecisionEvaluation {
  readonly slots: NpcSceneDecisionPayload["slots"];
  readonly actions: readonly NpcSceneDecisionAction[];
  readonly drops: readonly NpcSceneDecisionDrop[];
}

/** Which participants a candidate puts in the scene — the presence gate's question. */
function candidateParticipantRefs(candidate: NpcSceneCandidate): readonly ParticipantRef[] {
  switch (candidate.kind) {
    case "approach":
    case "depart":
      return [candidate.actorRef, candidate.counterpartRef];
    case "start":
      return [candidate.actorRef, candidate.targetRef];
    case "update":
      return [candidate.actorRef];
  }
}

/**
 * The floor's payload action. `committed` truthfully — the rows ride the same
 * transaction as this payload. The row-reference list respects the payload's
 * per-action cap (an over-cap list would degrade the whole payload on read —
 * see `NPC_SCENE_DECISION_MAX_ROWS_PER_ACTION`); the ledger rows themselves
 * are all written regardless, and the detail says when the list was sliced.
 */
function floorPayloadAction(floor: NpcSceneFloorInput, span: NpcSceneReplySpan, composite: boolean): NpcSceneDecisionAction {
  const truncated = floor.rows.length > NPC_SCENE_DECISION_MAX_ROWS_PER_ACTION;
  return {
    kind: "floor_ending",
    span,
    quoteHash: "",
    summary: `ending: ${floor.reason}${floor.subjectRef === null ? "" : ` by ${floor.subjectRef}`}`,
    resolution: floor.committed ? "committed" : "unresolved",
    detail: [
      npcSceneFloorDetail({ committed: floor.committed, spanUnlocated: floor.span === null, composite }),
      truncated ? "rows_truncated" : "",
    ]
      .filter(Boolean)
      .join(" ")
      .slice(0, NPC_SCENE_DECISION_DETAIL_MAX),
    contactRows: floor.rows.slice(0, NPC_SCENE_DECISION_MAX_ROWS_PER_ACTION).map((row) => ({ ...row })),
  };
}

/** What admission and planning produced — everything both modes agree on. */
export interface NpcSceneDecisionAdmission {
  readonly slots: NpcSceneDecisionPayload["slots"];
  readonly drops: readonly NpcSceneDecisionDrop[];
  /** The normalized ordered plan: shadow records it dry, authority executes it. */
  readonly plan: NpcSceneChronologyPlan;
}

export interface NpcSceneDecisionAdmissionInput {
  /** The COMPLETED assistant reply, exactly as persisted. */
  readonly reply: string;
  readonly digest: NpcSceneDigest;
  /** POST-settle-present roster refs — presence precedence; the player is implicitly present. */
  readonly presentNpcRefs: readonly NpcRef[];
  /** The slot-independent parse; `malformed_envelope` never reaches here. */
  readonly parse: NpcSceneDecisionParse;
  /** The floor's ORDERING half only — `null` when there is no ending, or none that could be located. */
  readonly floor: NpcSceneFloorEntry | null;
  readonly sink?: DiagnosticSink;
}

/**
 * Admit one reply's parsed slots and plan their chronology — PURE, and the ONE
 * implementation both modes run.
 *
 * The four evidence gates, presence precedence over classifier output, and the
 * chronological planner all live here precisely because shadow's measurement is
 * only evidence about authority if authority admits exactly what shadow
 * admitted. Every drop files its spec diagnostic
 * (`npc_scene_decision.<reason>`) beside the bounded payload record, so the
 * tallies exist in both the durable envelope and the exchange's diagnostic
 * stream — under the same reason codes in either mode.
 *
 * What it deliberately does NOT do is decide anything about the world: it
 * neither applies the floor's fold nor resolves a candidate. The caller's mode
 * owns that.
 */
export function admitNpcSceneDecision(input: NpcSceneDecisionAdmissionInput): NpcSceneDecisionAdmission {
  const drops: NpcSceneDecisionDrop[] = [];
  const present = new Set<ParticipantRef>([NPC_SCENE_PLAYER_REF, ...input.presentNpcRefs]);
  const context = { reply: input.reply, digest: input.digest, eligibleNpcRefs: input.presentNpcRefs };
  const tier2: NpcSceneTier2Entry[] = [];

  const pushDrop = (drop: NpcSceneDecisionDrop, severity: "info" | "warn"): void => {
    recordNpcSceneDrop(drops, drop, severity, input.sink);
  };

  /** One raw slot through malformed-trace → admission gates → presence precedence. */
  const evaluateSlot = (
    slotName: "movement" | "contact",
    slot: NpcSceneSlot<NpcSceneCandidate>,
  ): NpcSceneDecisionPayload["slots"]["movement"] => {
    switch (slot.status) {
      case "absent":
        return "absent";
      case "malformed":
        pushDrop(
          {
            candidate: slotName,
            reason: "slot_malformed",
            field: "",
            detail: (slot.issues[0] ?? "").slice(0, NPC_SCENE_DECISION_DETAIL_MAX),
            // No candidate survived the parse, so there is nothing to quote.
            evidence: "",
          },
          "warn",
        );
        return "malformed";
      case "parsed": {
        const candidate = slot.candidate;
        const admission = admitNpcSceneCandidate(context, candidate);
        if (admission.status === "dropped") {
          pushDrop(
            {
              candidate: slotName,
              reason: admission.drop.reason,
              field: admission.drop.field ?? "",
              detail: npcSceneCandidateSummary(candidate).slice(0, NPC_SCENE_DECISION_DETAIL_MAX),
              evidence: npcSceneDropEvidence(candidate),
            },
            "info",
          );
          return "parsed";
        }
        // Presence precedence: a participant not present in the POST-settle cut
        // cannot act or be a target — no name, pre-settle presence, or model
        // output rescues them.
        const away = candidateParticipantRefs(candidate).filter((ref) => !present.has(ref));
        if (away.length > 0) {
          pushDrop(
            {
              candidate: slotName,
              reason: "presence_conflict",
              field: "",
              detail: away.join(",").slice(0, NPC_SCENE_DECISION_DETAIL_MAX),
              evidence: npcSceneDropEvidence(candidate),
            },
            "warn",
          );
          return "parsed";
        }
        tier2.push({ candidate, span: admission.actionSpan });
        return "parsed";
      }
    }
  };

  let slots: NpcSceneDecisionPayload["slots"] = { movement: "absent", contact: "absent" };
  if (input.parse.status === "parsed") {
    slots = {
      movement: evaluateSlot("movement", input.parse.movement),
      contact: evaluateSlot("contact", input.parse.contact),
    };
  }

  // Chronology: the reply's own written order is the execution order; what
  // cannot be totally ordered drops (tier 2 only — the floor always survives).
  const plan = planNpcSceneChronology({ floor: input.floor, tier2 });
  for (const dropped of plan.dropped) {
    pushDrop(
      {
        candidate: npcSceneCandidateSlot(dropped.entry.candidate),
        reason: "chronology_ambiguous",
        field: "",
        detail: npcSceneCandidateSummary(dropped.entry.candidate).slice(0, NPC_SCENE_DECISION_DETAIL_MAX),
        evidence: npcSceneDropEvidence(dropped.entry.candidate),
      },
      "info",
    );
  }

  return { slots, drops, plan };
}

/** The floor's ORDERING half, as the planner takes it. `null` ⇒ nothing to order. */
function floorOrderingEntry(floor: NpcSceneFloorInput | null): NpcSceneFloorEntry | null {
  return floor !== null && floor.span !== null
    ? { reason: floor.reason, subjectRef: floor.subjectRef, span: floor.span }
    : null;
}

// ---------------------------------------------------------------------------
// Dry evaluation (SHADOW)
// ---------------------------------------------------------------------------

/**
 * Evaluate one reply for SHADOW: admit and plan for real, then record the plan
 * DRY — an admitted tier-2 candidate becomes ADMITTED, NOT COMMITTED
 * (`resolution: "unresolved"`, detail naming the shadow dry run). The scene
 * never changes from a tier-2 candidate here; only the floor's half carries
 * `committed` truth, because its rows ride the same transaction that stores
 * this payload.
 */
export function evaluateNpcSceneDecision(input: NpcSceneDecisionEvaluationInput): NpcSceneDecisionEvaluation {
  const admission = admitNpcSceneDecision({
    reply: input.reply,
    digest: input.digest,
    presentNpcRefs: input.presentNpcRefs,
    parse: input.parse,
    floor: floorOrderingEntry(input.floor),
    ...(input.sink === undefined ? {} : { sink: input.sink }),
  });

  // The normalized ordered action list — what the durable envelope records.
  const actions: NpcSceneDecisionAction[] = [];
  const pushTier2 = (entry: NpcSceneTier2Entry, composite: boolean): void => {
    actions.push({
      kind: npcSceneCandidateSlot(entry.candidate),
      span: entry.span,
      quoteHash: npcSceneQuoteHash(entry.candidate.evidence),
      summary: npcSceneCandidateSummary(entry.candidate),
      // ADMITTED, NOT COMMITTED: shadow grants no authority, so the resolver
      // never ran — "unresolved" is the resolver's silence, and the detail
      // names WHOSE silence it was so a later reader cannot mistake this for
      // a material/geometry miss.
      resolution: "unresolved",
      detail: composite ? "shadow_admitted_not_executed composite_departure" : "shadow_admitted_not_executed",
      contactRows: [],
    });
  };
  const floor = input.floor;
  for (const action of admission.plan.actions) {
    switch (action.source) {
      case "floor":
        if (floor !== null) actions.push(floorPayloadAction(floor, action.floor.span, false));
        break;
      case "composite_departure":
        if (floor !== null) actions.push(floorPayloadAction(floor, action.floor.span, true));
        pushTier2(action.depart, true);
        break;
      case "tier2":
        pushTier2(action.entry, false);
        break;
    }
  }
  // A floor whose action span could not be located never entered the planner
  // (it cannot be ordered), but its ends still committed — record it LAST,
  // spanning the whole reply, with the detail naming why it is unordered.
  if (floor !== null && floor.span === null) {
    actions.push(floorPayloadAction(floor, { start: 0, end: Math.max(1, input.reply.length) }, false));
  }

  return { slots: admission.slots, actions, drops: admission.drops };
}

// ---------------------------------------------------------------------------
// The pipeline handle: begin (pre-settle) / finish (post-settle)
// ---------------------------------------------------------------------------

/** One roster member as the pipeline hands it in — stable roster order, PRE-settle presence. */
export interface ChatNpcSceneRosterMemberInput {
  readonly characterId: string;
  readonly name: string;
  readonly aliases: readonly string[];
  readonly presence: NpcSceneDigestPresence;
  /**
   * The character sheet, carried for the POST-settle wardrobe resolve a contact
   * start's material read needs (`resolveChatWardrobe`).
   *
   * IDENTITY, not state: a profile is authored library data that a settle cannot
   * change, so carrying it across the two halves is not the stale-`scenario`
   * mistake the finish half exists to avoid. Everything that CAN move — presence,
   * the worn list, the free-text look, the garment store — is reloaded fresh.
   */
  readonly profile: CharacterProfile;
}

export interface BeginChatNpcSceneDecisionInput {
  readonly chatId: string;
  readonly assistantMessageId: string;
  /** The persisted reply bytes — settle's `full`, exactly as inserted/updated. */
  readonly reply: string;
  readonly mode: NpcSceneDecisionMode;
  /** The chat owner — whose wardrobe/library the post-settle garment resolve loads from. */
  readonly ownerId: string;
  readonly roster: readonly ChatNpcSceneRosterMemberInput[];
  /**
   * The player's persona sheet, when the chat has one — the wardrobe pool the
   * player's own worn ids resolve against. Absent (the bare account-name rung) ⇒
   * the player has no modelled clothes, and a start targeting them reads bare.
   */
  readonly playerPersona?: PersonaProfile;
  /** The PRE-settle scene — the digest's source cut (the scene as the player leg left it). */
  readonly scene: SceneState;
  readonly sink?: DiagnosticSink;
}

interface LiveRosterMember extends ChatNpcSceneRosterMemberInput {
  readonly subjectId: AffordanceSubjectId;
}

/**
 * The leg's between-halves state. `noop` is a first-class answer ("an envelope
 * already stands — never reclassify"), distinct from a thrown `begin` failure,
 * so the pipeline can tell "the leg owns this reply and has nothing to do"
 * from "the leg failed to launch and the legacy block should run".
 */
export type ChatNpcSceneDecisionHandle =
  | { readonly kind: "noop" }
  | {
      readonly kind: "live";
      readonly chatId: string;
      readonly assistantMessageId: string;
      readonly mode: NpcSceneDecisionMode;
      readonly ownerId: string;
      readonly reply: string;
      readonly digest: NpcSceneDigest;
      readonly handles: NpcSceneDigestHandles;
      readonly digestHash: string;
      readonly roster: readonly LiveRosterMember[];
      readonly playerPersona?: PersonaProfile;
      readonly triggered: boolean;
      readonly classifier: Promise<NpcSceneClassifierResult> | null;
      readonly sink?: DiagnosticSink;
    };

/**
 * What the SETTLE knew and the post-settle reload cannot recover — handed to the
 * finish half as the exchange's own report on itself.
 *
 * One field so far, and it is a signal only the writer has: which bodies had
 * their wardrobe authoritatively rewritten during this reply. The post-settle
 * store shows the FINAL clothes and says nothing about when they changed, so the
 * settle closure (which member outfit folds, the primary/player outfit folds, and
 * the ensemble garment reconcile ran) is the only place that answer exists.
 * The opening branch passes an empty set: an opening beat has no player act, no
 * archivist, and therefore no wardrobe write at all.
 */
export interface ChatNpcSceneSettleReport {
  readonly wardrobeChanged: ReadonlySet<AffordanceSubjectId>;
}

/** The settle report for a branch that wrote no wardrobe — the opening beat's. */
export function emptyChatNpcSceneSettleReport(): ChatNpcSceneSettleReport {
  return { wardrobeChanged: new Set<AffordanceSubjectId>() };
}

/**
 * The pre-settle half: reuse check → digest assembly → trigger → (maybe)
 * classifier launch. Runs right after nonempty reply persistence, BEFORE the
 * state fan-out, so the classifier races settlement.
 *
 * The reuse check comes FIRST — before any classifier spend — and an existing
 * envelope is never reclassified, whatever the current flags say. An existing
 * envelope whose `reply_hash` does not match the persisted bytes is a foreign
 * tombstone the
 * retake prune should have removed: it files a warn and the leg still does
 * nothing, because a second opinion under the same key would only die on
 * predicate 3.
 */
export async function beginChatNpcSceneDecision(
  input: BeginChatNpcSceneDecisionInput,
): Promise<ChatNpcSceneDecisionHandle> {
  const existing = await loadChatNpcSceneDecision(input.chatId, input.assistantMessageId, input.sink);
  if (existing !== null) {
    if (existing.replyHash !== chatNpcReplyHash(input.reply)) {
      input.sink?.push(
        diag(
          "warn",
          NPC_SCENE_DECISION_PERSISTENCE_CONFLICT,
          "an envelope under this reply's key carries a different reply hash; not reclassifying",
          {
            path: "chat_npc_scene_decisions",
            context: { chatId: input.chatId, assistantMessageId: input.assistantMessageId },
          },
        ),
      );
    }
    return { kind: "noop" };
  }

  const roster: LiveRosterMember[] = input.roster.map((member) => ({
    ...member,
    subjectId: affordanceSubjectId(member.characterId),
  }));
  // The digest, from the PRE-settle cut. Contacts with a non-body target can
  // never be tier-2 update material (the update ref law requires two bodies),
  // so they are omitted before the builder rather than half-described to it.
  const build = buildNpcSceneDigest({
    playerSubjectId: CHAT_CONTACT_PLAYER_SUBJECT,
    roster: roster.map((member) => ({
      subjectId: member.subjectId,
      name: member.name,
      aliases: member.aliases,
      presence: member.presence,
    })),
    contacts: activeContactsOf(input.scene.contacts).flatMap((contact) =>
      contact.target.kind !== "body"
        ? []
        : [
            {
              contactId: contact.contactId,
              actorSubjectId: contact.actorId,
              actionKind: contact.actionKind,
              sourceSubjectId: contact.source.subjectId,
              sourceLocationId: contact.source.locationId,
              targetSubjectId: contact.target.subjectId,
              targetLocationId: contact.target.locationId,
            },
          ],
    ),
    proximity: input.scene.proximity.map((relation) => ({
      aSubjectId: relation.subjectId,
      bSubjectId: relation.otherId,
      band: relation.band.value,
    })),
  });
  // Hashed over the digest's OWN canonical serialization (the versioned
  // `npc_scene_digest_v1:` string), so two semantically identical digests —
  // however assembled — fingerprint identically.
  const digestHash = chatNpcDigestHash(canonicalNpcSceneDigestString(build.digest));

  const triggered = npcSceneDecisionTriggered(input.reply, build.digest);
  const classifier = triggered
    ? launchNpcSceneClassifier({
        chatId: input.chatId,
        assistantMessageId: input.assistantMessageId,
        digest: build.digest,
        reply: input.reply,
        ...(input.sink === undefined ? {} : { sink: input.sink }),
      })
    : null;

  return {
    kind: "live",
    chatId: input.chatId,
    assistantMessageId: input.assistantMessageId,
    mode: input.mode,
    ownerId: input.ownerId,
    reply: input.reply,
    digest: build.digest,
    handles: build.handles,
    digestHash,
    roster,
    ...(input.playerPersona === undefined ? {} : { playerPersona: input.playerPersona }),
    triggered,
    classifier,
    ...(input.sink === undefined ? {} : { sink: input.sink }),
  };
}

/** The floor rows' payload references — the same whole-list sequence rule `chatContactEventRowsFor` applies. */
function contactRowRefsFor(
  commits: readonly ContactLifecycleCommit[],
  eventRef: ContactEventRef,
): { eventRef: string; sequence: number }[] {
  return commits.flatMap((commit, index) =>
    commit.kind === "contact_continued" ? [] : [{ eventRef, sequence: index }],
  );
}

// ---------------------------------------------------------------------------
// The POST-settle garment cut (contact starts only)
// ---------------------------------------------------------------------------

/**
 * The per-member state columns a wardrobe resolve needs, narrowed defensively.
 *
 * A row this schema cannot read is DROPPED rather than defaulted, and that is
 * the whole reason it is narrowed here at all: the empty default ("nothing worn,
 * nothing described") is what the three-way material law reads as BARE SKIN, and
 * a body whose row would not parse has not earned that claim. Dropping it leaves
 * the subject out of the cut, which the executor reads as `unavailable` — silence.
 */
const npcSceneWardrobeRowSchema = z.object({
  wornItemIds: z.array(z.string()),
  outfit: z.string(),
  outfitExposed: z.boolean(),
});

/**
 * Every body's material answer at the POST-settle garment cut — the read a
 * contact start's two-sided material composes. It is the current garment store
 * and per-actor coverage taken from the RELOADED post-settle garment cut, never
 * from the pre-settle scenario.
 *
 * Reloaded, not carried. `finalizeChatState`, the per-member settle, and the
 * ensemble garment reconcile all rewrite the wardrobe AFTER the digest was cut,
 * so the pipeline's `scenario` variable describes clothes that may no longer be
 * on anybody. This runs the SAME derivation the player leg runs pre-prompt
 * (`chatContactMaterialAtCut`) against the scenario as it stands now.
 *
 * **Only called when an admitted start actually needs it.** The derivation costs
 * a scenario load, a state read, and one wardrobe resolve per body; the
 * overwhelming majority of replies propose no contact at all, and a map nobody
 * reads is pure latency inside the exchange lock. An empty map is not a fallback
 * — it is the correct value when no start exists to consult it.
 *
 * The PLAYER is always in the map: they are the usual target of "she takes your
 * hand", and their wardrobe obeys the identical three-way law (modelled /
 * dressed-but-unmodellable / genuinely bare).
 */
async function loadNpcSceneMaterialCut(
  handle: Extract<ChatNpcSceneDecisionHandle, { kind: "live" }>,
): Promise<NpcSceneMaterialCut> {
  const sink = handle.sink;
  const material = new Map<AffordanceSubjectId, ChatContactMaterialSource>();
  const scenario = await loadChatScenario(handle.chatId, sink);
  if (scenario === null) return material;

  const characterIds = handle.roster.map((member) => member.characterId);
  const stateRows =
    characterIds.length > 0
      ? await db()
          .select({
            characterId: characterChatState.characterId,
            wornItemIds: characterChatState.wornItemIds,
            outfit: characterChatState.outfit,
            outfitExposed: characterChatState.outfitExposed,
          })
          .from(characterChatState)
          .where(
            and(eq(characterChatState.chatId, handle.chatId), inArray(characterChatState.characterId, characterIds)),
          )
      : [];
  const stateById = new Map(stateRows.map((row) => [row.characterId, row]));

  for (const member of handle.roster) {
    const row = stateById.get(member.characterId);
    // A roster member with no persisted state row has no wardrobe this cut can
    // speak for. Leaving them OUT of the map is the honest answer: the executor
    // reads an absent key as `unavailable`, and a start naming them falls silent
    // rather than resolving against an invented empty wardrobe.
    if (row === undefined) continue;
    const wardrobeState = parseOrNull(npcSceneWardrobeRowSchema, row, sink, "character_chat_state.wardrobe");
    if (wardrobeState === null) continue;
    const actorId = garmentActorForCharacter(member.characterId);
    const resolved = await resolveChatWardrobe(
      { ...wardrobeState, garments: scenario.garments, garmentActorId: actorId },
      handle.ownerId,
      member.profile,
      sink,
    );
    material.set(
      member.subjectId,
      chatContactMaterialAtCut({
        store: scenario.garments,
        actorId,
        ...(resolved.worn === undefined ? {} : { worn: resolved.worn }),
        visibility: resolved.partVisibility,
        environment: scenario.environment,
        clockMinutes: scenario.clockMinutes,
        freeTextOutfit: wardrobeState.outfit,
        wornItemIds: wardrobeState.wornItemIds,
        ...(sink === undefined ? {} : { sink }),
      }).material,
    );
  }

  const playerWardrobe = await resolvePlayerWardrobe(
    scenario.playerState,
    handle.ownerId,
    handle.playerPersona,
    sink,
    scenario.garments,
  );
  material.set(
    CHAT_CONTACT_PLAYER_SUBJECT,
    chatContactMaterialAtCut({
      store: scenario.garments,
      actorId: GARMENT_PLAYER_ACTOR,
      ...(playerWardrobe.worn === undefined ? {} : { worn: playerWardrobe.worn }),
      visibility: playerWardrobe.partVisibility,
      environment: scenario.environment,
      clockMinutes: scenario.clockMinutes,
      freeTextOutfit: scenario.playerState.overlay,
      wornItemIds: playerWornIds(scenario.playerState, handle.playerPersona),
      ...(sink === undefined ? {} : { sink }),
    }).material,
  );
  return material;
}

/** Does this plan hold a contact START — the only action that consults the garment cut? */
function planNeedsMaterialCut(plan: NpcSceneChronologyPlan): boolean {
  return plan.actions.some(
    (action) => action.source === "tier2" && action.entry.candidate.kind === "start",
  );
}

/**
 * The post-settle half. Fenced whole: any throw degrades to "no envelope this
 * exchange" with a log line, never a failed reply.
 *
 * `settle` is the exchange's report on its own writes — the wardrobe-change veto
 * set, which no reload can recover (see `ChatNpcSceneSettleReport`).
 */
export async function finishChatNpcSceneDecision(
  handle: ChatNpcSceneDecisionHandle,
  settle: ChatNpcSceneSettleReport,
): Promise<void> {
  if (handle.kind === "noop") return;
  try {
    await finishLive(handle, settle);
  } catch (error) {
    log.error("engine.chat", "npc scene decision leg failed", {
      chatId: handle.chatId,
      assistantMessageId: handle.assistantMessageId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function finishLive(
  handle: Extract<ChatNpcSceneDecisionHandle, { kind: "live" }>,
  settle: ChatNpcSceneSettleReport,
): Promise<void> {
  const sink = handle.sink;

  // --- The authoritative post-settle cut: reload FRESH ----------------------
  // Never the pipeline's stale `scenario` variable: `finalizeChatState`, the
  // ensemble member settle, and the garment reconcile all wrote state since
  // the digest was cut, and the projection the CAS must guard is the COLUMN.
  const [assistantRow] = await db()
    .select({ role: characterChatMessages.role, content: characterChatMessages.content })
    .from(characterChatMessages)
    .where(
      and(
        eq(characterChatMessages.id, handle.assistantMessageId),
        eq(characterChatMessages.chatId, handle.chatId),
      ),
    )
    .limit(1);
  if (assistantRow === undefined || assistantRow.role !== "assistant" || assistantRow.content !== handle.reply) {
    // The bytes the trigger and classifier read are gone (deleted or rewritten
    // mid-settle) — a decision about them would be a decision about nothing,
    // and predicate 1 would refuse it anyway. Warn and record nothing.
    sink?.push(
      diag(
        "warn",
        NPC_SCENE_DECISION_PERSISTENCE_CONFLICT,
        "assistant reply missing or changed at the post-settle cut; no decision recorded",
        {
          path: "chat_npc_scene_decisions",
          context: { chatId: handle.chatId, assistantMessageId: handle.assistantMessageId },
        },
      ),
    );
    return;
  }

  const [chatRow] = await db()
    .select({ scene: characterChats.scene, clockMinutes: characterChats.clockMinutes })
    .from(characterChats)
    .where(eq(characterChats.id, handle.chatId))
    .limit(1);
  if (chatRow === undefined) return; // the chat vanished mid-settle — nothing to record against
  const rawScene: unknown = chatRow.scene ?? null;
  // The raw column is the CAS's expected base; the parsed value is what the
  // evaluation reads. A healthy stored scene round-trips byte-stably (the
  // canonical constructor ordering); a scene the parser had to HEAL will fail
  // the CAS as `stale_scene` — a warn and nothing else, which is the right
  // answer for a column in that state.
  const baseScene = rawScene === null ? emptySceneState() : parseSceneState(rawScene, sink);
  const expectedBase = rawScene === null ? null : baseScene;
  // The post-settle story minute, truncated ONCE for the whole envelope.
  const storyMinute = Math.max(0, Math.trunc(chatRow.clockMinutes));

  // Post-settle presence — the authoritative cut. A roster member without a
  // persisted state row (a first opening beat, an unsettled ensemble member)
  // falls back to the pre-settle presence the digest carried: the settle that
  // just ran is the only writer that could have changed it.
  const characterIds = handle.roster.map((member) => member.characterId);
  const presenceRows =
    characterIds.length > 0
      ? await db()
          .select({ characterId: characterChatState.characterId, presence: characterChatState.presence })
          .from(characterChatState)
          .where(
            and(eq(characterChatState.chatId, handle.chatId), inArray(characterChatState.characterId, characterIds)),
          )
      : [];
  const presenceById = new Map(presenceRows.map((row) => [row.characterId, row.presence]));
  const presentMembers = handle.roster.filter(
    (member) => (presenceById.get(member.characterId) ?? member.presence) === "present",
  );
  const presentNpcRefs: NpcRef[] = presentMembers.flatMap((member) => {
    const ref = handle.handles.refBySubjectId.get(member.subjectId);
    return ref !== undefined && ref !== NPC_SCENE_PLAYER_REF ? [ref] : [];
  });

  // --- The frozen floor keeps its authority ---------------------------------
  // Detection runs exactly as the legacy reply-side block runs it today, gated
  // on CHAT_CONTACT_ACTIONS alone: the floor ships under that flag, and a
  // shadow flag must never grant (or revoke) contact authority. Its commits
  // ride the decision envelope's guarded transaction below instead of
  // `appendChatContactEventsWithScene`, so the ended projection and the decision
  // record land atomically.
  //
  // The FOLD is where the modes part. In shadow (and floor-only) mode it happens
  // right here, against the base scene, exactly as at HEAD. In authority mode it
  // is deferred to the executor, which applies it at the ending's CHRONOLOGICAL
  // position — that deferral is the whole reason the composite departure can
  // read a distance from the scene before the contact that licensed it ends.
  const authority = handle.mode === "authority" && chatContactActionsEnabled();
  const eventRef = chatReplyContactEventRef(handle.assistantMessageId);
  let ending: ChatNpcContactEnding | null = null;
  let floorSpan: NpcSceneReplySpan | null = null;
  let floorSubjectRef: NpcRef | null = null;
  let floorInput: NpcSceneFloorInput | null = null;
  let commits: readonly ContactLifecycleCommit[] = [];
  let nextScene = baseScene;
  if (chatContactActionsEnabled()) {
    const characters: ChatNpcEndingCharacter[] = presentMembers.map((member) => ({
      subjectId: member.subjectId,
      name: member.name,
      aliases: member.aliases,
    }));
    ending = detectChatNpcContactEnding({ reply: handle.reply, characters });
    if (ending !== null) {
      if (!authority) {
        const ended = applyChatNpcContactEnding({
          scene: baseScene,
          ending,
          eventRef,
          storyTime: storyMinute,
          ...(sink === undefined ? {} : { sink }),
        });
        commits = ended.commits;
        if (commits.length > 0) nextScene = ended.scene;
      }
      floorSpan = locateChatNpcEndingActionSpan({ reply: handle.reply, characters, ending });
      const subjectRef = handle.handles.refBySubjectId.get(ending.subjectId);
      floorSubjectRef = subjectRef !== undefined && subjectRef !== NPC_SCENE_PLAYER_REF ? subjectRef : null;
      if (!authority) {
        floorInput = {
          reason: ending.reason,
          subjectRef: floorSubjectRef,
          span: floorSpan,
          rows: contactRowRefsFor(commits, eventRef),
          committed: commits.length > 0,
        };
      }
    }
  }

  // --- Classifier outcome → status ------------------------------------------
  // `trigger_miss`, `degraded`, and `evaluated` are all durable tombstones.
  // The status names the CLASSIFIER's fate; the floor's half rides whichever
  // status the reply earned, because its authority predates this leg.
  const absentParse: NpcSceneDecisionParse = {
    status: "parsed",
    movement: { status: "absent" },
    contact: { status: "absent" },
  };
  let status: NpcSceneDecisionStatus;
  let parse: NpcSceneDecisionParse = absentParse;
  let telemetry: NpcSceneDecisionPayload["telemetry"] = { model: "", latencyMs: 0, timedOut: false };
  if (!handle.triggered || handle.classifier === null) {
    status = "trigger_miss";
  } else {
    // The wait, measured around the await itself: the call was launched before
    // settlement, so what the exchange PAID in latency is the remainder the
    // finish half still had to block for — usually near zero, and the honest
    // answer to "what did the leg add?" that the call's own latency cannot give.
    const waitedFrom = Date.now();
    const result = await handle.classifier;
    telemetry = npcSceneDecisionTelemetry(result, Date.now() - waitedFrom);
    if (result.degraded) {
      status = "degraded";
      sink?.push(
        diag(
          "warn",
          NPC_SCENE_DECISION_DEGRADED,
          result.timedOut
            ? "reply-scene classifier timed out; recording a degraded tombstone"
            : "reply-scene classifier degraded; recording a degraded tombstone",
          { path: "npc_scene_decision", context: { timedOut: result.timedOut } },
        ),
      );
    } else {
      const parsed = parseNpcSceneDecisionOutput(handle.digest, result.raw);
      if (parsed.status === "malformed_envelope") {
        // No slots to save — "malformed output" is a degraded tombstone by
        // ruling; the issues live in the diagnostic, the payload stays
        // empty-slotted.
        status = "degraded";
        sink?.push(
          diag("warn", NPC_SCENE_DECISION_DEGRADED, "classifier output envelope malformed; recording a degraded tombstone", {
            path: "npc_scene_decision",
            context: { issues: [...parsed.issues] },
          }),
        );
      } else {
        status = "evaluated";
        parse = parsed;
      }
    }
  }

  // --- Evaluate: dry in shadow, EXECUTED in authority -----------------------
  // Admission and planning are shared; only the last step forks. In authority
  // mode the executor owns presence integration, the ordered walk, and every
  // commit, and its final scene becomes the CAS's `next` — so the presence
  // endings, the floor's endings, and the tier-2 movement are one atomic write
  // with the envelope that explains them.
  let slots: NpcSceneDecisionPayload["slots"];
  let actions: readonly NpcSceneDecisionAction[];
  let drops: readonly NpcSceneDecisionDrop[];
  if (authority) {
    const admission = admitNpcSceneDecision({
      reply: handle.reply,
      digest: handle.digest,
      presentNpcRefs,
      parse,
      floor:
        ending === null || floorSpan === null
          ? null
          : { reason: ending.reason, subjectRef: floorSubjectRef, span: floorSpan },
      ...(sink === undefined ? {} : { sink }),
    });
    // EVERY roster member, with the post-settle answer — the away ones are the
    // whole point: presence precedence ends their contacts before any proposal
    // resolves, and a member the roster never listed cannot be rescued at all.
    const presentIds = new Set(presentMembers.map((member) => member.characterId));
    const roster: NpcSceneExecutionMember[] = handle.roster.map((member) => ({
      subjectId: member.subjectId,
      present: presentIds.has(member.characterId),
    }));
    // The POST-settle garment cut, loaded only when an admitted start will read
    // it. Fenced separately from the leg's outer catch: a wardrobe this cut could
    // not load must cost the start its material (silence), never the movement
    // authority and the envelope beside it.
    let material: NpcSceneMaterialCut = new Map();
    if (planNeedsMaterialCut(admission.plan)) {
      try {
        material = await loadNpcSceneMaterialCut(handle);
      } catch (error) {
        log.error("engine.chat", "npc scene decision material cut failed", {
          chatId: handle.chatId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const execution = executeNpcSceneDecision({
      reply: handle.reply,
      scene: baseScene,
      plan: admission.plan,
      floor: ending === null ? null : { ending, subjectRef: floorSubjectRef, span: floorSpan },
      roster,
      handles: handle.handles,
      eventRef,
      storyMinute,
      material,
      wardrobeChanged: settle.wardrobeChanged,
      ...(sink === undefined ? {} : { sink }),
    });
    slots = admission.slots;
    actions = execution.actions;
    drops = [...admission.drops, ...execution.drops];
    commits = execution.commits;
    nextScene = execution.scene;
  } else {
    const evaluation = evaluateNpcSceneDecision({
      reply: handle.reply,
      digest: handle.digest,
      presentNpcRefs,
      parse,
      floor: floorInput,
      ...(sink === undefined ? {} : { sink }),
    });
    slots = evaluation.slots;
    actions = evaluation.actions;
    drops = evaluation.drops;
  }

  const payload: NpcSceneDecisionPayload = {
    version: NPC_SCENE_DECISION_PAYLOAD_VERSION,
    slots,
    actions: [...actions],
    drops: [...drops],
    // Every ledger row this decision writes, in row order — the presence
    // endings' rows included, because they ride the same event ref and the same
    // transaction as the floor's. Sliced to the payload's cap: an over-cap list
    // would degrade the whole payload on read, and the ledger rows themselves
    // are the authoritative record either way.
    contactRows: contactRowRefsFor(commits, eventRef).slice(0, NPC_SCENE_DECISION_MAX_CONTACT_ROWS),
    telemetry,
  };
  const envelope: ChatNpcSceneDecisionEnvelope = {
    replyHash: chatNpcReplyHash(handle.reply),
    // "" on a trigger miss — the column convention for "no digest was spent on
    // this reply" (the digest was assembled, but no classifier ever read it).
    digestHash: status === "trigger_miss" ? "" : handle.digestHash,
    schemaVersion: NPC_SCENE_DECISION_SCHEMA_VERSION,
    mode: handle.mode,
    storyMinute,
    status,
    baseSceneHash: chatNpcSceneHash(baseScene),
    resultSceneHash: chatNpcSceneHash(nextScene),
    payload,
  };

  // The guarded transaction: envelope + the floor's rows + the scene CAS,
  // atomically. Conflict outcomes are typed results the module itself files as
  // `npc_scene_decision.persistence_conflict` warns — a stale scene or a lost
  // race in shadow is a warn and NOTHING else, never a throw into the
  // exchange (docs/resilience.md §2).
  await recordChatNpcSceneDecision({
    chatId: handle.chatId,
    assistantMessageId: handle.assistantMessageId,
    envelope,
    contact: { guardMessageId: handle.assistantMessageId, eventRef, commits },
    scene: { expectedBase, next: nextScene },
    ...(sink === undefined ? {} : { sink }),
  });
}
