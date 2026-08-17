import { z } from "zod";
import { apiDelete, apiGet, apiPatch, apiPost, withQuery } from "@/lib/client/api";

/** Client data layer for the explicitly self-scoped owner-admin chat inspector. */
const textOr = (fallback: string) => z.string().catch(fallback);
const optionalId = z
  .string()
  .nullish()
  .catch(null)
  .transform((value) => value ?? null);

/** Array where invalid elements are dropped instead of failing the whole list. */
function arrayOf<T>(item: z.ZodType<T>) {
  return z
    .array(z.unknown())
    .catch([])
    .transform((items) =>
      items.flatMap((itemValue) => {
        const parsed = item.safeParse(itemValue);
        return parsed.success ? [parsed.data] : [];
      }),
    );
}

export const inspectorFactSchema = z.object({
  id: z.string().min(1),
  kind: textOr("knowledge"),
  subjectKind: textOr("character"),
  subjectId: optionalId,
  subjectName: textOr(""),
  text: textOr(""),
  tags: z.array(z.string()).catch([]),
  confidence: z.number().catch(0),
  status: z.enum(["active", "superseded", "retracted"]).catch("active"),
  pinned: z.boolean().catch(false),
  origin: z.enum(["extracted", "player", "dev"]).catch("extracted"),
  sourceTurnId: optionalId,
  sourceMessageId: optionalId,
  supersededById: optionalId,
  createdAt: optionalId,
  supersededAt: optionalId,
});
export type InspectorFact = z.infer<typeof inspectorFactSchema>;

export const inspectorEpisodeSchema = z.object({
  id: z.string().min(1),
  turnNumber: z.number().catch(0),
  summary: textOr(""),
  sourceMessageId: optionalId,
  createdAt: optionalId,
  embedded: z.boolean().catch(false),
});
export type InspectorEpisode = z.infer<typeof inspectorEpisodeSchema>;

export const inspectorSummarySchema = z.object({
  summary: textOr(""),
  watermarkAt: optionalId,
  coveredExchanges: z.number().catch(0),
});
export type InspectorSummary = z.infer<typeof inspectorSummarySchema>;

export const inspectorOverviewSchema = z.object({
  facts: arrayOf(inspectorFactSchema),
  episodes: arrayOf(inspectorEpisodeSchema),
  summary: inspectorSummarySchema.nullable().catch(null),
  character: z.object({ id: textOr(""), name: textOr("") }).catch({ id: "", name: "" }),
});
export type InspectorOverview = z.infer<typeof inspectorOverviewSchema>;

export const inspectorPromptSchema = z.object({
  prefix: textOr(""),
  tail: textOr(""),
  memory: z
    .object({
      facts: z.array(z.string()).catch([]),
      episodes: z.array(z.string()).catch([]),
    })
    .catch({ facts: [], episodes: [] }),
  memoryQueries: z.array(z.string()).catch([]),
});
export type InspectorPrompt = z.infer<typeof inspectorPromptSchema>;

/**
 * The read-only affordance preview (body-attribute-affordances slice 6): the
 * staged calculation for every domain this lane can feed. Every field heals —
 * this is a debug surface, and a shape drift should show a gap, not an error page.
 */
const previewValueSchema = z.object({ path: textOr(""), value: textOr("") });

export const affordancePreviewResolutionSchema = z.object({
  phenomenonId: textOr(""),
  kind: z.enum(["observation", "constraint", "suppressed"]).catch("suppressed"),
  code: textOr(""),
  detail: textOr(""),
  band: textOr(""),
  locationId: textOr(""),
  tags: z.array(z.string()).catch([]),
});
export type AffordancePreviewResolution = z.infer<typeof affordancePreviewResolutionSchema>;

export const affordancePreviewDomainSchema = z.object({
  domainId: textOr(""),
  inputs: arrayOf(z.object({ key: textOr(""), status: textOr("") })),
  profile: arrayOf(previewValueSchema).nullable().catch(null),
  mechanics: arrayOf(previewValueSchema),
  resolutions: arrayOf(affordancePreviewResolutionSchema),
  evidence: z.array(z.string()).catch([]),
  diagnostics: arrayOf(z.object({ level: textOr("info"), code: textOr(""), message: textOr("") })),
});
export type AffordancePreviewDomain = z.infer<typeof affordancePreviewDomainSchema>;

export const affordancePreviewSchema = z.object({
  storyTime: z.number().catch(0),
  cueFlagEnabled: z.boolean().catch(false),
  domains: arrayOf(affordancePreviewDomainSchema),
  perception: z
    .object({
      exposure: arrayOf(z.object({ locationId: textOr(""), exposure: textOr("unknown") })),
      channels: arrayOf(z.object({ channel: textOr(""), available: z.boolean().catch(false) })),
    })
    .catch({ exposure: [], channels: [] }),
  observations: arrayOf(affordancePreviewResolutionSchema),
  suppressed: arrayOf(affordancePreviewResolutionSchema),
  cues: arrayOf(z.object({ phenomenonId: textOr(""), band: textOr(""), line: textOr("") })),
  coverage: z
    .object({
      atMinutes: z.number().catch(0),
      entries: arrayOf(
        z.object({
          locationId: textOr(""),
          band: textOr("opaque"),
          evidence: arrayOf(
            z.object({ garmentId: textOr(""), regionId: textOr(""), effectiveOpacity: z.number().catch(0) }),
          ),
        }),
      ),
    })
    .nullable()
    .catch(null),
});
export type AffordancePreview = z.infer<typeof affordancePreviewSchema>;

/**
 * The read-only narrator physical-guidance preview
 * (narrator-physical-guidance.plan.md slice 2): input authority → committed state →
 * candidates → selection → rendered lines. Every field heals, like the affordance
 * preview above — a debug surface should show a gap, never an error page.
 */
const guidanceCandidateSchema = z.object({
  kind: z.enum(["constraint", "correction"]).catch("constraint"),
  fingerprint: textOr(""),
  id: textOr(""),
  disclosure: textOr(""),
  grade: textOr(""),
  locusIds: z.array(z.string()).catch([]),
  prohibitedClaimCodes: z.array(z.string()).catch([]),
  allowedClaimCodes: z.array(z.string()).catch([]),
  areas: z.array(z.string()).catch([]),
  evidence: z.array(z.string()).catch([]),
});
export type PhysicalGuidanceCandidate = z.infer<typeof guidanceCandidateSchema>;

/** One resolved physical action (the contact leg), as the inspector lists it. */
const guidanceActionOutcomeSchema = z.object({
  fingerprint: textOr(""),
  actionId: textOr(""),
  status: textOr("unresolved"),
  disclosure: textOr(""),
  narratorMustResolve: z.boolean().catch(false),
  resultCodes: z.array(z.string()).catch([]),
  evidence: z.array(z.string()).catch([]),
});
export type PhysicalGuidanceActionOutcome = z.infer<typeof guidanceActionOutcomeSchema>;

export const physicalGuidancePreviewSchema = z.object({
  flagEnabled: z.boolean().catch(false),
  contactFlagEnabled: z.boolean().catch(false),
  inputAuthority: z
    .object({
      narratorInput: z.boolean().catch(false),
      message: textOr(""),
      spans: arrayOf(z.object({ kind: textOr(""), eligible: z.boolean().catch(false), text: textOr("") })),
      eligibleSpans: z.number().catch(0),
    })
    .catch({ narratorInput: false, message: "", spans: [], eligibleSpans: 0 }),
  committed: z
    .object({
      wetnessBand: textOr("—"),
      wetnessCause: textOr("—"),
      arrangement: textOr("—"),
      coveredFraction: textOr("—"),
      available: arrayOf(z.object({ owner: textOr(""), available: z.boolean().catch(false) })),
    })
    .catch({ wetnessBand: "—", wetnessCause: "—", arrangement: "—", coveredFraction: "—", available: [] }),
  relevance: z
    .object({
      relevant: z.boolean().catch(false),
      signals: z.array(z.string()).catch([]),
      constraints: arrayOf(
        z.object({ code: textOr(""), admitted: z.boolean().catch(false), reason: textOr("") }),
      ),
    })
    .catch({ relevant: false, signals: [], constraints: [] }),
  candidates: z
    .object({
      constraints: arrayOf(guidanceCandidateSchema),
      corrections: arrayOf(guidanceCandidateSchema),
      actionOutcomes: arrayOf(guidanceActionOutcomeSchema),
      diagnostics: arrayOf(z.object({ level: textOr("info"), code: textOr(""), message: textOr("") })),
    })
    .catch({ constraints: [], corrections: [], actionOutcomes: [], diagnostics: [] }),
  selection: z
    .object({
      constraints: z.array(z.string()).catch([]),
      corrections: z.array(z.string()).catch([]),
      actionOutcomes: z.array(z.string()).catch([]),
      dropped: z.array(z.string()).catch([]),
    })
    .catch({ constraints: [], corrections: [], actionOutcomes: [], dropped: [] }),
  rendered: z.array(z.string()).catch([]),
});
export type PhysicalGuidancePreview = z.infer<typeof physicalGuidancePreviewSchema>;

/**
 * The read-only visual-state preview (visual-state.plan.md slice 6): the
 * source-to-selection staircase — features, composition, suppressions,
 * attention scores, consumer selections, and the slice's measurements. Every
 * field heals, like the previews above — a debug surface should show a gap,
 * never an error page.
 */
const visualStateSuppressionSchema = z.object({
  key: textOr(""),
  code: textOr(""),
  detail: textOr(""),
});
export type VisualStateSuppressionRow = z.infer<typeof visualStateSuppressionSchema>;

export const visualStateFeatureRowSchema = z.object({
  key: textOr(""),
  kindId: textOr(""),
  layer: textOr(""),
  stability: textOr(""),
  locus: textOr(""),
  source: textOr(""),
  value: z.unknown(),
  fingerprint: textOr(""),
  tags: z.array(z.string()).catch([]),
  changedAtMinutes: z.number().nullable().catch(null),
  validUntilMinutes: z.number().nullable().catch(null),
  relationships: z.array(z.string()).catch([]),
  evidence: z.array(z.string()).catch([]),
});
export type VisualStateFeatureRow = z.infer<typeof visualStateFeatureRowSchema>;

const visualStateCompositionRowSchema = z.object({
  key: textOr(""),
  effectiveVisibility: z.number().catch(0),
  coverage: z.number().catch(0),
  occlusion: z.number().catch(0),
  replacedBy: z.string().nullable().catch(null),
  modifiedBy: z.array(z.string()).catch([]),
  attachedTo: z.array(z.string()).catch([]),
  derivedFrom: z.array(z.string()).catch([]),
});
export type VisualStateCompositionRow = z.infer<typeof visualStateCompositionRowSchema>;

export const visualStateCandidateRowSchema = z.object({
  key: textOr(""),
  layer: textOr(""),
  priority: z.number().catch(0),
  visibility: z.number().catch(0),
  uniqueness: z.number().catch(0),
  importance: z.number().catch(0),
  detailTier: z.number().catch(0),
  novelty: z.number().catch(0),
  changeSignificance: z.number().catch(0),
  actionRelevance: z.number().catch(0),
  consumerRelevance: z.number().catch(0),
  repetitionCooldown: z.number().catch(0),
  repeatKey: textOr(""),
  noveltySource: textOr("none"),
  cueStatus: z.string().nullable().catch(null),
});
export type VisualStateCandidateRow = z.infer<typeof visualStateCandidateRowSchema>;

/** The conditions the production reads ran under, and which of them nobody owns. */
const visualStateViewingSchema = z
  .object({
    lighting: textOr("unknown"),
    distance: textOr("unknown"),
    angle: textOr("unknown"),
    motion: textOr("unknown"),
    declared: z.array(z.string()).catch([]),
  })
  .catch({ lighting: "unknown", distance: "unknown", angle: "unknown", motion: "unknown", declared: [] });

/** The narrator cue record — repetition and first visibility for what memory does not hold. */
const visualStateCueStateSchema = z
  .object({
    sequenceAfter: z.number().catch(0),
    recordCount: z.number().catch(0),
    observedCount: z.number().catch(0),
    mentionCommitCount: z.number().catch(0),
  })
  .catch({ sequenceAfter: 0, recordCount: 0, observedCount: 0, mentionCommitCount: 0 });

const countRecord = z.record(z.string(), z.number()).catch({});

const visualStateSetComparisonSchema = z
  .object({
    legacyCount: z.number().catch(0),
    projectedCount: z.number().catch(0),
    sharedCount: z.number().catch(0),
    legacyOnly: z.array(z.string()).catch([]),
    projectedOnly: z.array(z.string()).catch([]),
  })
  .nullable()
  .catch(null);
export type VisualStateSetComparisonRow = z.infer<typeof visualStateSetComparisonSchema>;

const visualStateMeasurementsSchema = z
  .object({
    featureCount: z.number().catch(0),
    featuresByLayer: countRecord,
    featuresByKind: countRecord,
    suppressionCount: z.number().catch(0),
    suppressionsByCode: countRecord,
    missingOwnerCount: z.number().catch(0),
    duplicateKeyCount: z.number().catch(0),
    narrator: z
      .object({
        candidateCount: z.number().catch(0),
        selectedCount: z.number().catch(0),
        suppressionsByCode: countRecord,
        constraintCount: z.number().catch(0),
        noticeCount: z.number().catch(0),
      })
      .catch({ candidateCount: 0, selectedCount: 0, suppressionsByCode: {}, constraintCount: 0, noticeCount: 0 }),
    image: z
      .object({
        candidateCount: z.number().catch(0),
        selectedCount: z.number().catch(0),
        suppressionsByCode: countRecord,
        mandatoryCount: z.number().catch(0),
        suppressedOptionalCount: z.number().catch(0),
      })
      .catch({
        candidateCount: 0,
        selectedCount: 0,
        suppressionsByCode: {},
        mandatoryCount: 0,
        suppressedOptionalCount: 0,
      }),
    attributes: visualStateSetComparisonSchema,
    garments: visualStateSetComparisonSchema,
  })
  .catch({
    featureCount: 0,
    featuresByLayer: {},
    featuresByKind: {},
    suppressionCount: 0,
    suppressionsByCode: {},
    missingOwnerCount: 0,
    duplicateKeyCount: 0,
    narrator: { candidateCount: 0, selectedCount: 0, suppressionsByCode: {}, constraintCount: 0, noticeCount: 0 },
    image: {
      candidateCount: 0,
      selectedCount: 0,
      suppressionsByCode: {},
      mandatoryCount: 0,
      suppressedOptionalCount: 0,
    },
    attributes: null,
    garments: null,
  });
export type VisualStateMeasurementsRow = z.infer<typeof visualStateMeasurementsSchema>;

export const visualStatePreviewSchema = z.object({
  lane: z.enum(["character_chat", "successor"]).catch("character_chat"),
  shadowFlagEnabled: z.boolean().catch(false),
  scopeKey: textOr(""),
  cutId: textOr(""),
  atMinutes: z.number().catch(0),
  subjects: z.array(z.string()).catch([]),
  features: arrayOf(visualStateFeatureRowSchema),
  composition: arrayOf(visualStateCompositionRowSchema),
  suppressions: arrayOf(visualStateSuppressionSchema),
  staircase: arrayOf(visualStateCandidateRowSchema),
  viewing: visualStateViewingSchema,
  narrator: z
    .object({
      digests: arrayOf(
        z.object({
          subjectId: textOr(""),
          constraintKeys: z.array(z.string()).catch([]),
          selected: arrayOf(
            z.object({ key: textOr(""), reason: textOr(""), repeatKey: textOr(""), priority: z.number().catch(0) }),
          ),
          suppressedCount: z.number().catch(0),
        }),
      ),
      noticeCount: z.number().catch(0),
      changeCount: z.number().catch(0),
      mentionCommitCount: z.number().catch(0),
      cueState: visualStateCueStateSchema,
      suppressions: arrayOf(visualStateSuppressionSchema),
    })
    .catch({
      digests: [],
      noticeCount: 0,
      changeCount: 0,
      mentionCommitCount: 0,
      cueState: { sequenceAfter: 0, recordCount: 0, observedCount: 0, mentionCommitCount: 0 },
      suppressions: [],
    }),
  image: z
    .object({
      mandatoryKeys: z.array(z.string()).catch([]),
      optional: arrayOf(visualStateCandidateRowSchema),
      suppressedOptionalCount: z.number().catch(0),
      suppressions: arrayOf(visualStateSuppressionSchema),
    })
    .catch({ mandatoryKeys: [], optional: [], suppressedOptionalCount: 0, suppressions: [] }),
  measurements: visualStateMeasurementsSchema,
  diagnostics: arrayOf(z.object({ severity: textOr("info"), code: textOr(""), message: textOr("") })),
});
export type VisualStatePreview = z.infer<typeof visualStatePreviewSchema>;

export const episodeScoresSchema = z.object({
  scores: arrayOf(z.object({ id: z.string().min(1), score: z.number().catch(0) })),
  degraded: z.boolean().catch(false),
});
export type EpisodeScores = z.infer<typeof episodeScoresSchema>;

const factPatchResponseSchema = z.object({
  fact: inspectorFactSchema,
  embedDegraded: z.boolean().catch(false),
});

const episodePatchResponseSchema = z.object({
  episode: inspectorEpisodeSchema,
  embedDegraded: z.boolean().catch(false),
});

export interface InspectorFactPatch {
  text?: string;
  pinned?: boolean;
  status?: "active" | "retracted";
}

export interface InspectorFactCreate {
  text: string;
  subjectName?: string;
  subjectKind?: string;
  kind?: string;
  pinned?: boolean;
}

const base = (chatId: string) => `/api/admin/self/chat-inspector/${chatId}`;

export const agentFailureRowSchema = z.object({
  legId: textOr("unknown"),
  kind: z.enum(["timeout", "api_error", "parse_failed"]).catch("timeout"),
  cause: textOr("unknown"),
  messageId: optionalId,
  modelId: textOr(""),
  provider: optionalId,
  promptChars: z.number().catch(0),
  maxOutputTokens: z.number().catch(0),
  timeoutMs: z.number().catch(0),
  latencyMs: z.number().catch(0),
  detail: textOr(""),
  reasoningProfile: textOr("off"),
  reasoningEnabled: z.boolean().catch(false),
  at: textOr(""),
});
export type AgentFailureRow = z.infer<typeof agentFailureRowSchema>;

const tallyRowSchema = z.object({ key: textOr(""), count: z.number().catch(0) });

const failureReportSchema = z.object({
  recent: arrayOf(agentFailureRowSchema),
  total: z.number().catch(0),
  byLeg: arrayOf(tallyRowSchema),
  byCause: arrayOf(tallyRowSchema),
});
const EMPTY_FAILURE_REPORT = { recent: [], total: 0, byLeg: [], byCause: [] };

export const agentRunDetailRowSchema = z.object({ label: textOr(""), items: arrayOf(z.string().catch("")) });
export type AgentRunDetailRow = z.infer<typeof agentRunDetailRowSchema>;

export const agentRunRowSchema = z.object({
  legId: textOr("unknown"),
  messageId: optionalId,
  modelId: textOr(""),
  provider: optionalId,
  promptChars: z.number().catch(0),
  maxOutputTokens: z.number().catch(0),
  latencyMs: z.number().catch(0),
  summary: textOr(""),
  details: arrayOf(agentRunDetailRowSchema),
  reasoningProfile: textOr("off"),
  reasoningEnabled: z.boolean().catch(false),
  at: textOr(""),
});
export type AgentRunRow = z.infer<typeof agentRunRowSchema>;

const runStatRowSchema = z.object({
  key: textOr(""),
  count: z.number().catch(0),
  medianMs: z.number().catch(0),
  maxMs: z.number().catch(0),
});
export type AgentRunStatRow = z.infer<typeof runStatRowSchema>;

const runReportSchema = z.object({
  recent: arrayOf(agentRunRowSchema),
  total: z.number().catch(0),
  byLeg: arrayOf(runStatRowSchema),
});
const EMPTY_RUN_REPORT = { recent: [], total: 0, byLeg: [] };

/**
 * Global fields remain as empty compatibility defaults for the current UI, but
 * the self-scoped API never returns cross-chat data.
 */
export const agentHealthSchema = z.object({
  days: z.number().catch(7),
  chat: failureReportSchema,
  global: failureReportSchema.catch(EMPTY_FAILURE_REPORT).default(EMPTY_FAILURE_REPORT),
  runs: runReportSchema.catch(EMPTY_RUN_REPORT).default(EMPTY_RUN_REPORT),
  runsGlobal: runReportSchema.catch(EMPTY_RUN_REPORT).default(EMPTY_RUN_REPORT),
});
export type AgentHealth = z.infer<typeof agentHealthSchema>;

export const compositionFallbackRowSchema = z.object({
  site: textOr("departure"),
  code: textOr("drain_short"),
  messageId: optionalId,
  detail: textOr(""),
  at: textOr(""),
});
export type CompositionFallbackRow = z.infer<typeof compositionFallbackRowSchema>;

const compositionReportSchema = z.object({
  recent: arrayOf(compositionFallbackRowSchema),
  total: z.number().catch(0),
  byCode: arrayOf(tallyRowSchema),
  bySite: arrayOf(tallyRowSchema),
});
const EMPTY_COMPOSITION_REPORT = { recent: [], total: 0, byCode: [], bySite: [] };

export const compositionHealthSchema = z.object({
  days: z.number().catch(7),
  chat: compositionReportSchema,
  global: compositionReportSchema.catch(EMPTY_COMPOSITION_REPORT).default(EMPTY_COMPOSITION_REPORT),
});
export type CompositionHealth = z.infer<typeof compositionHealthSchema>;

export const chatInspectorApi = {
  overview: (chatId: string) => apiGet(inspectorOverviewSchema, base(chatId)),
  prompt: (chatId: string) => apiGet(inspectorPromptSchema, `${base(chatId)}/prompt`),
  affordances: (chatId: string) => apiGet(affordancePreviewSchema, `${base(chatId)}/affordances`),
  physicalGuidance: (chatId: string) =>
    apiGet(physicalGuidancePreviewSchema, `${base(chatId)}/physical-guidance`),
  visualState: (chatId: string) => apiGet(visualStatePreviewSchema, `${base(chatId)}/visual-state`),
  agentFailures: (chatId: string, days?: number) =>
    apiGet(agentHealthSchema, withQuery(`${base(chatId)}/agent-failures`, days ? { days: String(days) } : {})),
  compositionFallbacks: (chatId: string, days?: number) =>
    apiGet(
      compositionHealthSchema,
      withQuery(`${base(chatId)}/composition-fallbacks`, days ? { days: String(days) } : {}),
    ),
  createFact: (chatId: string, body: InspectorFactCreate) =>
    apiPost(z.object({ id: z.string().min(1) }), `${base(chatId)}/facts`, body),
  updateFact: (chatId: string, factId: string, patch: InspectorFactPatch) =>
    apiPatch(factPatchResponseSchema, `${base(chatId)}/facts/${factId}`, patch),
  updateEpisode: (chatId: string, episodeId: string, summary: string) =>
    apiPatch(episodePatchResponseSchema, `${base(chatId)}/episodes/${episodeId}`, { summary }),
  deleteEpisode: (chatId: string, episodeId: string) => apiDelete(`${base(chatId)}/episodes/${episodeId}`),
  scoreEpisodes: (chatId: string, query: string) =>
    apiGet(episodeScoresSchema, withQuery(`${base(chatId)}/episodes/score`, { q: query })),
  updateSummary: (chatId: string, summary: string) =>
    apiPatch(inspectorSummarySchema, `${base(chatId)}/summary`, { summary }),
};
