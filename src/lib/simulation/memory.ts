import type { SimulationBranchEvent } from "@/contracts/simulation/branching";
import type { Assertion, Belief } from "@/contracts/simulation/knowledge";
import {
  deriveMemoryDocumentId,
  MEMORY_DOCUMENT_SCHEMA_VERSION,
  memoryDocumentSchema,
  type AuthoredLoreSeed,
  type EpistemicLabel,
  type MemoryDocument,
} from "@/contracts/simulation/memory";
import type { SpeechActDeliveredEvent } from "@/contracts/simulation/narrative";
import type { Observation } from "@/contracts/simulation/perception";
import type { SoftCanonEntry } from "@/contracts/simulation/soft-canon";
import { canonicalValueKey } from "./knowledge";

/**
 * E4.4 — the pure memory kernel (engine.spec §24). Projectors turn persisted
 * source rows into REDACTED documents deterministically — text templates
 * only, no model — and the ranker orders an already-eligible candidate set.
 * Similarity never decides witness, truth, validity, or access (§24.1): by
 * the time anything here runs, eligibility has been resolved relationally.
 */

function compareStableText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareStableText);
}

// ---------------------------------------------------------------------------
// Redacted text templates
// ---------------------------------------------------------------------------

/**
 * One neutral phrase per event kind, exhaustive so a new event cannot ship
 * without a memory-phrase ruling. Observation text NEVER quotes payload
 * detail — spoken content reaches recall only through speech-act and belief
 * documents, whose eligibility is their participants and holders (§24.3
 * redaction: authorized source data only).
 */
function eventKindPhrase(kind: SimulationBranchEvent["type"]): string {
  switch (kind) {
    case "actor_departed":
      return "someone departing";
    case "actor_arrived":
      return "someone arriving";
    case "journey_planned":
      return "a journey being planned";
    case "journey_delayed":
      return "a journey running late";
    case "journey_interrupted":
      return "a journey interrupted";
    case "journey_abandoned":
      return "a journey abandoned";
    case "activity_started":
      return "an activity beginning";
    case "activity_completed":
      return "an activity concluding";
    case "activity_cancelled":
      return "an activity broken off";
    case "activity_failed":
      return "an attempt failing";
    case "activity_interrupted":
      return "an activity interrupted";
    case "activity_resumed":
      return "an activity resuming";
    case "engagement_opened":
      return "a conversation starting";
    case "engagement_ended":
      return "a conversation ending";
    case "engagement_interrupted":
      return "a conversation interrupted";
    case "engagement_winding_down":
      return "a conversation winding down";
    case "zone_entered":
      return "someone coming through";
    case "storyteller_relocation":
      return "someone suddenly present";
    case "item_transferred":
      return "an item changing hands";
    case "item_destroyed":
      return "an item being destroyed";
    case "item_consumed":
      return "an item being consumed";
    case "speech_act_delivered":
      return "something meaningful being said";
    case "disclosure_made":
      return "something being confided";
    case "body_source_applied":
      return "their body registering a change";
    case "body_condition_applied":
      return "a change coming over someone";
    case "body_condition_ended":
      return "a bodily state passing";
    case "body_threshold_crossed":
      return "a body reaching a limit";
    case "body_collapsed":
      return "a body giving out";
    case "item_condition_threshold_crossed":
      return "an item's condition reaching a limit";
    case "item_ownership_set":
    case "trigger_scheduled":
    case "commitment_created":
    case "pressure_raised":
    case "commitment_kept":
    case "commitment_late":
    case "commitment_missed":
    case "soft_canon_recorded":
    case "soft_canon_promoted":
    case "soft_canon_demoted":
    case "body_initialized":
    case "body_modifier_applied":
    case "item_condition_initialized":
    case "item_condition_source_applied":
    case "item_condition_modifier_applied":
    case "item_condition_modifier_ended":
    case "household_created":
    case "household_membership_set":
    case "material_lot_initialized":
    case "material_lot_adjusted":
    case "means_band_set":
    case "household_restock_routine_configured":
    case "pressure_acknowledged":
    case "actor_lod_assigned":
    case "routine_policy_resolved":
    case "cohort_created":
    case "cohort_adjusted":
      // Bookkeeping derives no observations (§20); unreachable in practice
      // (mirrors `body_initialized`/`item_ownership_set`). Pressure
      // acknowledgment (E5.5 slice 3) is pure turn bookkeeping, not
      // memory-eligible — mirrors `body_initialized`. An actor-LOD
      // assignment (E6.1, §27) is an engine performance dial — no story
      // fact exists to recall.
      return "world bookkeeping";
    case "material_lot_transferred":
      return "stock changing hands";
    case "item_instantiated_from_promotion":
      // Narratively meaningful (§26.10/§27.2): a concrete item coming into
      // being from stock — memory-eligible, mirrors `activity_completed`.
      return "an item coming into someone's hands";
    case "household_restock_fulfilled":
      return "a household's stores being restocked";
    case "household_restock_deferred":
      return "a household's restock falling through";
    case "relationship_entry_authored":
      // Narratively meaningful (§21.3): a promise, boundary, favor, or other
      // ledger-worthy relationship fact — memory-eligible, mirrors
      // `item_instantiated_from_promotion`.
      return "something between them being marked";
    case "relationship_change_recorded":
      return "the shape of a relationship shifting";
    case "consent_escalation_resolved":
      // Narratively meaningful (E5.5 slice 3, ruling 16): whether consent was
      // granted or declined is significant relationship evidence —
      // memory-eligible, mirrors `relationship_entry_authored`.
      return "a boundary being tested and answered";
  }
}

export function observationEpistemicLabel(observation: Observation): EpistemicLabel {
  if (observation.evidenceClass === "reported") return "heard_about";
  if (observation.detailTier <= 1) return "glimpsed";
  return "observed";
}

// ---------------------------------------------------------------------------
// Document projectors (pure; upsert-shaped — same source row, same document)
// ---------------------------------------------------------------------------

export function projectObservationDocument(
  observation: Observation,
  event: SimulationBranchEvent,
): MemoryDocument {
  const label = observationEpistemicLabel(observation);
  const phrase = eventKindPhrase(event.type);
  const involved = sortedUnique(event.actorIds);
  const text =
    label === "glimpsed"
      ? `Half-noticed ${phrase} nearby.`
      : label === "heard_about"
        ? `Was told something directly — ${phrase}.`
        : `Witnessed ${phrase}${involved.length > 0 ? ` involving ${involved.join(", ")}` : ""}.`;
  return memoryDocumentSchema.parse({
    id: deriveMemoryDocumentId("observation", observation.id),
    branchId: observation.branchId,
    sourceKind: "observation",
    sourceId: observation.id,
    sourceEventId: observation.sourceEventId,
    firstSequence: observation.sourceEventSequence,
    lastSequence: observation.sourceEventSequence,
    storySecond: observation.storySecond,
    visibility: "actors",
    eligibleActorIds: [observation.witnessActorId],
    aboutEntityIds: sortedUnique([...event.actorIds, ...(event.locationId ? [event.locationId] : [])]),
    validFromSecond: observation.storySecond,
    epistemicLabel: label,
    confidenceFixedPoint: observation.confidenceFixedPoint,
    text,
    docSchemaVersion: MEMORY_DOCUMENT_SCHEMA_VERSION,
  });
}

export function projectSpeechActDocument(event: SpeechActDeliveredEvent): MemoryDocument {
  const participants = sortedUnique([event.payload.actorId, ...event.payload.targetActorIds]);
  return memoryDocumentSchema.parse({
    id: deriveMemoryDocumentId("speech_act", event.id),
    branchId: event.branchId,
    sourceKind: "speech_act",
    sourceId: event.id,
    sourceEventId: event.id,
    firstSequence: event.sequence,
    lastSequence: event.sequence,
    storySecond: event.storySecond,
    visibility: "actors",
    eligibleActorIds: participants,
    aboutEntityIds: sortedUnique([...participants, event.payload.engagementId]),
    validFromSecond: event.storySecond,
    epistemicLabel: "witnessed_speech",
    text: `Speech act (${event.payload.effectType}) from ${event.payload.actorId}: ${event.payload.detail}`,
    docSchemaVersion: MEMORY_DOCUMENT_SCHEMA_VERSION,
  });
}

export function projectBeliefDocument(belief: Belief, assertion: Assertion): MemoryDocument {
  if (belief.assertionId !== assertion.id) {
    throw new Error(`Belief ${belief.id} does not reference assertion ${assertion.id}`);
  }
  const live = belief.status === "active" || belief.status === "doubted";
  const chain = belief.learnedFromActorIds;
  const chainSuffix = chain.length > 0 ? ` (heard through ${chain.join(" then ")})` : "";
  const doubt = belief.status === "doubted" ? " Holds this with doubt." : "";
  return memoryDocumentSchema.parse({
    id: deriveMemoryDocumentId("belief", belief.id),
    branchId: belief.branchId,
    sourceKind: "belief",
    sourceId: belief.id,
    sourceEventId: belief.sourceEventId,
    firstSequence: belief.sourceEventSequence,
    lastSequence: belief.sourceEventSequence,
    storySecond: belief.believedFrom,
    visibility: "actors",
    eligibleActorIds: [belief.holderActorId],
    aboutEntityIds: sortedUnique([...assertion.subjectIds]),
    validFromSecond: belief.believedFrom,
    ...(belief.believedUntil === undefined ? {} : { validUntilSecond: belief.believedUntil }),
    ...(live ? {} : { supersededAtSecond: belief.believedUntil ?? belief.believedFrom }),
    epistemicLabel: "believed",
    confidenceFixedPoint: belief.confidenceFixedPoint,
    text: `Believes ${assertion.propositionKey} of ${assertion.subjectIds.join(", ")}: ${canonicalValueKey(assertion.claimedValue)}.${chainSuffix}${doubt}`,
    docSchemaVersion: MEMORY_DOCUMENT_SCHEMA_VERSION,
  });
}

export function projectAssertionDocument(assertion: Assertion): MemoryDocument {
  const active = assertion.status === "active";
  return memoryDocumentSchema.parse({
    id: deriveMemoryDocumentId("assertion", assertion.id),
    branchId: assertion.branchId,
    sourceKind: "assertion",
    sourceId: assertion.id,
    ...(assertion.sourceEventId === undefined ? {} : { sourceEventId: assertion.sourceEventId }),
    firstSequence: assertion.sourceEventSequence ?? 0,
    lastSequence: assertion.sourceEventSequence ?? 0,
    storySecond: assertion.assertedAt,
    // Resolved relationally at query time: recallable only by an actor
    // holding a live belief in this assertion on the query branch (§24.1).
    visibility: "belief_holders",
    eligibleActorIds: [],
    aboutEntityIds: sortedUnique([...assertion.subjectIds]),
    validFromSecond: assertion.validFrom ?? assertion.assertedAt,
    ...(assertion.validUntil === undefined ? {} : { validUntilSecond: assertion.validUntil }),
    ...(active ? {} : { supersededAtSecond: assertion.statusChangedAt ?? assertion.assertedAt }),
    epistemicLabel: "claimed",
    text: `${assertion.sourceActorId ?? "Someone"} claimed ${assertion.propositionKey} of ${assertion.subjectIds.join(", ")}: ${canonicalValueKey(assertion.claimedValue)}.`,
    docSchemaVersion: MEMORY_DOCUMENT_SCHEMA_VERSION,
  });
}

export function projectSoftCanonDocument(entry: SoftCanonEntry, sequence: number): MemoryDocument {
  const isPublicScope = entry.scope === "world" || entry.scope === "location";
  const demoted = entry.status === "demoted";
  return memoryDocumentSchema.parse({
    id: deriveMemoryDocumentId("soft_canon", entry.id),
    branchId: entry.branchId,
    sourceKind: "soft_canon",
    sourceId: entry.id,
    firstSequence: sequence,
    lastSequence: sequence,
    storySecond: entry.lastRecordedAt,
    visibility: isPublicScope ? "public" : "actors",
    eligibleActorIds: isPublicScope ? [] : sortedUnique([...entry.subjectIds]),
    aboutEntityIds: sortedUnique([...entry.subjectIds]),
    validFromSecond: entry.firstRecordedAt,
    // Promoted canon does not expire (§23.4); active entries keep their TTL.
    ...(entry.status === "promoted" || entry.validUntil === undefined
      ? {}
      : { validUntilSecond: entry.validUntil }),
    ...(demoted ? { supersededAtSecond: entry.statusChangedAt ?? entry.lastRecordedAt } : {}),
    epistemicLabel: "established_detail",
    confidenceFixedPoint: entry.confidenceFixedPoint,
    text: `Established detail ${entry.key} (${entry.scope}): ${canonicalValueKey(entry.value)}.`,
    docSchemaVersion: MEMORY_DOCUMENT_SCHEMA_VERSION,
  });
}

export function projectAuthoredLoreDocument(branchId: string, seed: AuthoredLoreSeed): MemoryDocument {
  return memoryDocumentSchema.parse({
    id: deriveMemoryDocumentId("authored_lore", seed.loreId),
    branchId,
    sourceKind: "authored_lore",
    sourceId: seed.loreId,
    // Seeded documents predate every event: visible to all descendants.
    firstSequence: 0,
    lastSequence: 0,
    storySecond: seed.validFromSecond,
    visibility: seed.visibility,
    eligibleActorIds: [...seed.eligibleActorIds],
    aboutEntityIds: [...seed.aboutEntityIds],
    validFromSecond: seed.validFromSecond,
    ...(seed.validUntilSecond === undefined ? {} : { validUntilSecond: seed.validUntilSecond }),
    epistemicLabel: "authored_lore",
    text: seed.text,
    docSchemaVersion: MEMORY_DOCUMENT_SCHEMA_VERSION,
  });
}

// ---------------------------------------------------------------------------
// Ranking (§24.1 steps 5–6) — inside the eligible set only
// ---------------------------------------------------------------------------

export function tokenizeMemoryText(text: string): string[] {
  return sortedUnique(text.toLowerCase().match(/[a-z0-9]+/gu) ?? []);
}

function cosineFixedPoint(left: readonly number[], right: readonly number[]): number {
  let dot = 0;
  let normLeft = 0;
  let normRight = 0;
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    dot += a * b;
    normLeft += a * a;
    normRight += b * b;
  }
  if (normLeft === 0 || normRight === 0) return 0;
  return Math.round((dot / Math.sqrt(normLeft * normRight)) * 10_000);
}

function jaccardFixedPoint(queryTokens: readonly string[], docTokens: readonly string[]): number {
  if (queryTokens.length === 0 || docTokens.length === 0) return 0;
  const docSet = new Set(docTokens);
  let shared = 0;
  for (const token of queryTokens) if (docSet.has(token)) shared += 1;
  const union = docSet.size + queryTokens.length - shared;
  return union === 0 ? 0 : Math.round((shared / union) * 10_000);
}

export interface MemoryRankCandidate {
  doc: MemoryDocument;
  embedding?: readonly number[];
}

export interface RankedMemoryDocument {
  doc: MemoryDocument;
  scoreFixedPoint: number;
}

export interface RankMemoryDocumentsInput {
  candidates: readonly MemoryRankCandidate[];
  queryText?: string;
  queryEmbedding?: readonly number[];
  queryEmbeddingModel?: string;
  limit: number;
}

export interface RankMemoryDocumentsResult {
  ranked: RankedMemoryDocument[];
  /** Vector-mode candidates skipped for lack of a same-model embedding. */
  unembeddedEligible: number;
}

/**
 * Deterministic ranking + diversification over an eligible candidate set.
 * Vector mode ranks only same-model embedded documents (never mixing models,
 * never guessing); lexical mode uses token overlap; with neither, recency
 * orders the set. Ties always break by document id. Diversification
 * round-robins across source kinds so one chatty class cannot crowd the
 * context budget (§24.1 step 6).
 */
export function rankMemoryDocuments(input: RankMemoryDocumentsInput): RankMemoryDocumentsResult {
  let unembeddedEligible = 0;
  let scored: RankedMemoryDocument[];
  if (input.queryEmbedding !== undefined) {
    scored = [];
    for (const candidate of input.candidates) {
      if (
        candidate.embedding === undefined ||
        candidate.doc.embeddingModel !== input.queryEmbeddingModel
      ) {
        unembeddedEligible += 1;
        continue;
      }
      scored.push({
        doc: candidate.doc,
        scoreFixedPoint: cosineFixedPoint(input.queryEmbedding, candidate.embedding),
      });
    }
  } else if (input.queryText !== undefined) {
    const queryTokens = tokenizeMemoryText(input.queryText);
    scored = input.candidates.map((candidate) => ({
      doc: candidate.doc,
      scoreFixedPoint: jaccardFixedPoint(queryTokens, tokenizeMemoryText(candidate.doc.text)),
    }));
  } else {
    scored = input.candidates.map((candidate) => ({ doc: candidate.doc, scoreFixedPoint: 0 }));
  }

  scored.sort(
    (left, right) =>
      right.scoreFixedPoint - left.scoreFixedPoint ||
      right.doc.storySecond - left.doc.storySecond ||
      compareStableText(left.doc.id, right.doc.id),
  );

  // Round-robin by source kind in first-appearance order.
  const byKind = new Map<string, RankedMemoryDocument[]>();
  for (const item of scored) {
    const bucket = byKind.get(item.doc.sourceKind) ?? [];
    bucket.push(item);
    byKind.set(item.doc.sourceKind, bucket);
  }
  const buckets = [...byKind.values()];
  const ranked: RankedMemoryDocument[] = [];
  let cursor = 0;
  while (ranked.length < input.limit && buckets.some((bucket) => bucket.length > 0)) {
    const bucket = buckets[cursor % buckets.length];
    cursor += 1;
    const next = bucket?.shift();
    if (next) ranked.push(next);
  }
  return { ranked, unembeddedEligible };
}
