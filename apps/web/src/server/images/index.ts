// The folder's front door, and the one place the identity-pack maintenance hooks
// are installed. `assets.ts` owns image deletion and the scheduled sweep but
// cannot import the pack service that implements their derived-state half — that
// edge would close an import cycle (`pnpm lint:cycles`), which is why the hooks
// are registered rather than imported. Registering them HERE makes the dependency
// visible: every consumer of this folder comes through this barrel (reaching past
// it into a module is a lint error), so the registration is an import edge in the
// diff instead of a side effect of whichever pack module happened to load first.
import { installIdentityPackMaintenance } from "./identity-pack-maintenance";

installIdentityPackMaintenance();

// Four services are split across modules that import each other directly, so they
// export helpers no caller outside this folder may use. Those four are re-exported
// by NAME rather than with `export *`: the folder's public surface stays exactly
// what it was before the split, and a cross-module helper cannot reach a route by
// accident (nor silently vanish from this barrel when a second module happens to
// export the same name — an ambiguous `export *` name is dropped, not reported).
// Modules absent below export nothing public: the pack service's derivation and
// promotion halves, the lab's five lanes, and the prompt format kit.

export * from "./assets";

export {
  identityPackLockKey,
  type IdentityPackPolicyProjection,
  type IdentityPackRow,
  isRetryableIdentityPackFailure,
  type JsonColumn,
  packRowToContract,
  projectIdentityPackPolicy,
  readJsonColumn,
  setIdentityIntrinsicPolicyForTesting,
  sourceContentHashOf,
} from "./identity-pack-store";
export {
  deriveIdentityPackWithoutProcessLockForTesting,
  ensureIdentityPack,
  RESERVATION_JOIN_MS,
} from "./identity-pack-ensure";
export {
  getIdentityPackForOwner,
  getIdentityPackHistoryForAdmin,
  getIdentityPackRevisionForTrial,
  type IdentityPackHistory,
  type IdentityPackRevisionForTrialCode,
  type IdentityPackRevisionForTrialInput,
  type IdentityPackRevisionForTrialResult,
  type IdentityPackSummary,
  identityPackSummaryToWire,
} from "./identity-pack-read";
export {
  type ManualIdentityCropConflict,
  type ManualIdentityCropInput,
  type ManualIdentityCropRejection,
  type ResetIdentityPackInput,
  resetIdentityPackToAutomatic,
  saveManualIdentityCrop,
  type SaveManualIdentityCropInput,
  type SaveManualIdentityCropResult,
} from "./identity-pack-manual";
export {
  IDENTITY_PACK_TRIAL_CORPORA,
  type IdentityPackBatchCounts,
  type IdentityPackBatchOutcome,
  MAX_IDENTITY_PACK_PREPARATION_PASSES,
  prepareIdentityPacksBatch,
  type PrepareIdentityPacksBatchInput,
  type PrepareIdentityPacksBatchResult,
  queueIdentityPackPreparation,
  runIdentityPackPreparationForTesting,
} from "./identity-pack-preparation";
export {
  type CleanupIdentityPackOptions,
  cleanupIdentityPackRevisions,
  deleteCharacterIdentityAssets,
  findIdentityPackInconsistencies,
  IDENTITY_PACK_REVISION_RETENTION_MS,
  type IdentityPackCleanupResult,
  type IdentityPackSweepFindings,
  invalidateIdentityPackForSource,
  type InvalidateIdentityPackInput,
} from "./identity-pack-maintenance";
export * from "./identity-pack-references";
export * from "./identity-pack-consume";
export {
  deleteIdentityPackTrialRun,
  type DeleteIdentityPackTrialRunResult,
  type ExecutedTrialCell,
  getIdentityPackTrialRunDetail,
  type IdentityPackTrialCellRow,
  type IdentityPackTrialCellView,
  identityPackTrialLockKey,
  type IdentityPackTrialRefusal,
  type IdentityPackTrialRunDetail,
  type IdentityPackTrialRunRow,
  listIdentityPackTrialRuns,
  readTrialVerdicts,
  trialPairLeftIsA,
} from "./identity-pack-trial-store";
export {
  createIdentityPackTrialRun,
  type CreateIdentityPackTrialRunInput,
  type CreateIdentityPackTrialRunResult,
} from "./identity-pack-trial-plan";
export {
  executeIdentityPackTrialCells,
  type ExecuteIdentityPackTrialCellsInput,
  type ExecuteIdentityPackTrialCellsResult,
  runTrialExecutionPassForTesting,
  STALE_CLAIM_MS,
} from "./identity-pack-trial-execute";
export {
  setTrialRendererForTesting,
  type TrialCellRenderer,
  type TrialCellRenderInput,
} from "./identity-pack-trial-render";
export {
  identityPackTrialSummary,
  nextUnreviewedTrialPair,
  type NextUnreviewedTrialPairResult,
  recordTrialVerdict,
  type RecordTrialVerdictInput,
  type RecordTrialVerdictResult,
  submitTrialPairGrade,
  type SubmitTrialPairGradeInput,
  type SubmitTrialPairGradeResult,
} from "./identity-pack-trial-review";
export * from "./identity-trial-model-versions";
export {
  deleteImageLabExperiment,
  type DeleteImageLabExperimentResult,
  getImageLabExperimentDetail,
  type ImageLabExperimentRow,
  type ImageLabProviderOutcome,
  type ImageLabRefusal,
  type ImageLabRunPayload,
  listImageLabExperiments,
  recordImageLabVerdict,
  type RecordImageLabVerdictResult,
} from "./image-lab-store";
export { type ImageLabRenderer, type ImageLabRenderRequest, setImageLabRendererForTesting } from "./image-lab-render";
export {
  isOwnedImageSourceKind,
  type ListOwnedImageSourcesOptions,
  listOwnedImageSources,
  OWNED_IMAGE_SOURCE_DEFAULT_LIMIT,
  OWNED_IMAGE_SOURCE_KINDS,
  OWNED_IMAGE_SOURCE_MAX_LIMIT,
  type OwnedImageSource,
  ownedImageRow,
  readOrderedInputBytes,
  readOwnedImageBytes,
} from "./owned-image-reads";
export {
  createImageGeneratorRun,
  type CreateImageGeneratorRunInput,
  type CreateImageGeneratorRunResult,
  deleteImageGeneratorRun,
  type DeleteImageGeneratorRunResult,
  deleteImageGeneratorRuns,
  type DeleteImageGeneratorRunsResult,
  getImageGeneratorRunDetail,
  type ImageGeneratorProviderOutcome,
  type ImageGeneratorRunPayload,
  type ImageGeneratorRunRow,
  listImageGeneratorRuns,
  toWireImageGeneratorRun,
} from "./image-generator-store";
export { runImageGeneratorRun } from "./image-generator-run";
export {
  type GeneratorRenderer,
  type GeneratorRenderRequest,
  setImageGeneratorRendererForTesting,
} from "./image-generator-render";
export {
  createImageLabExperiment,
  type CreateImageLabExperimentInput,
  type CreateImageLabExperimentResult,
} from "./image-lab-create";
export { runImageLabExperiment } from "./image-lab-run";
export * from "./image-lab-controls";
export * from "./image-loras";
export * from "./identity-lora-bindings";
export * from "./models";
export * from "./model-profiles";
export * from "./model-versions";
export * from "./render-intent";
export * from "./render-intent-capture";
export * from "./shadow-comparison";
export * from "./render-fingerprint";
export * from "./route-safe";
export * from "./chat-look";
export * from "./monogram";
export {
  type AvatarOutfitItem,
  type AvatarStyle,
  type AvatarWardrobeItem,
  buildAvatarPrompt,
  toWornInputs,
  visibleAvatarOutfit,
  wardrobeGarmentKey,
} from "./prompts-avatar";
export { buildVariantInstruction, PORTRAIT_IDENTITY_LOCK, type VariantKind } from "./prompts-variant";
export {
  buildSceneComposerPrompt,
  emptySceneSpec,
  formatExposure,
  RECENT_NARRATION_LATEST_CHARS,
  RECENT_NARRATION_PRIOR_CHARS,
  RECENT_NARRATION_TURNS,
  RECENT_PLAYER_MESSAGE_CHARS,
  SCENE_COMPOSER_SYSTEM,
  sceneEvidenceCorpus,
  type SceneComposerContext,
  sceneComposerSystem,
  type ScenePresentCharacter,
  type SceneSpec,
  sceneSpecSchema,
  type SceneWornItem,
  wardrobeOutfitSummary,
} from "./prompts-scene-composer";
export {
  apparentAgeAnchor,
  characterAppearanceSummary,
  identityAnchorSummary,
  imageAgeWord,
  sceneRevealAppearance,
  viewerBodyAppearance,
} from "./prompts-appearance";
export {
  bindLimbsToOwner,
  emptySceneRenderPlan,
  heuristicFocalName,
  normalizeName,
  resolveScenePlan,
  type SceneCharacterSpec,
  type SceneRenderPlan,
  scrubBlush,
  scrubPlayerFromAction,
} from "./prompts-scene-plan";
export {
  buildSceneRenderPrompt,
  EDIT_RENDER_PROMPT_LIMIT,
  SCENE_POV_RULE,
  sceneFramingRule,
  type SceneMultiReference,
  type SceneRenderOptions,
  SELFIE_FRAMING,
} from "./prompts-scene-render";
export { applySceneCastVisual, type SceneSubjectVisualSlice } from "./scene-subject-visual";
export {
  buildEntityPromptProgram,
  isEntityPromptRefusal,
  type EntityPromptProgram,
  type EntityPromptProgramInput,
  type EntityPromptProgramResult,
} from "./entity-prompt-program";
// The character-lane pack seeds register their packs and bindings at import
// time, exactly like the package's own 2512 seed. Exporting them here makes the
// registration a visible import edge of the folder rather than a side effect of
// whichever module loads first; it changes no production render — only the
// entity lane resolves bindings today, and it asks for item/location alone.
export * from "./packs-qwen-2511";
export * from "./packs-qwen-2512-portrait";
// The one semantic path a character lane's prompt program is built on, for the
// shadow that measures a cutover and the production render that performs one.
export {
  buildCharacterPromptProgram,
  isCharacterPromptCompiled,
  isCharacterPromptRefusal,
  isCharacterPromptUnbound,
  variantChangeOperation,
  IMAGE_CHARACTER_PROMPT_PACK_MISSING,
  VARIANT_CHANGE_CONCEPTS,
  type CharacterPromptLane,
  type CharacterPromptProgram,
  type CharacterPromptProgramInput,
  type CharacterPromptProgramRefusal,
  type CharacterPromptProgramResult,
  type CharacterPromptProgramUnbound,
  type CharacterPromptSubjectCut,
  type CharacterPromptTask,
} from "./character-prompt-program";
// The Round 2 shadow wiring: lane entries, seeded deltas, canonical fact names.
export * from "./character-shadow";
export * from "./avatar";
export {
  AVATAR_PORTRAIT_CAMERA,
  AVATAR_PORTRAIT_CAMERA_ID,
  AVATAR_SEGMENT_POLICY,
  buildAvatarSegments,
  type AvatarSegmentAssembly,
  type AvatarSegmentAssemblyInput,
} from "./avatar-segments";
export {
  buildStandaloneSubjectVisual,
  portraitPerception,
  type StandaloneSubjectVisual,
  type StandaloneSubjectVisualInput,
} from "./standalone-subject-visual";
export {
  buildVariantSegments,
  VARIANT_EDIT_CAMERA,
  VARIANT_EDIT_CAMERA_ID,
  VARIANT_SEGMENT_POLICY,
  type VariantSegmentAssembly,
  type VariantSegmentAssemblyInput,
} from "./variant-segments";
export {
  buildChatLookSegments,
  CHAT_LOOK_CAMERA,
  CHAT_LOOK_CAMERA_ID,
  CHAT_LOOK_SEGMENT_POLICY,
  CHAT_LOOK_VISUAL_DIGEST_UNAVAILABLE,
  CHAT_LOOK_VISUAL_REQUIRED_MISSING,
  VISUAL_CLAUSE_OMIT_CHAT_LOOK_CACHE,
  type ChatLookSegmentAssembly,
  type ChatLookSegmentInput,
  type ChatLookVisualCut,
} from "./chat-look-segments";
export {
  VISUAL_CLAUSE_OMIT_CURATED,
  VISUAL_CLAUSE_OMIT_ELIDED,
  VISUAL_CLAUSE_OMIT_INAPPLICABLE,
  VISUAL_CLAUSE_OMIT_NONVISUAL,
  VISUAL_CLAUSE_OMIT_REGISTRY,
  visualFactClauseResolver,
  type VisualFactClauseSources,
} from "./visual-fact-clauses";
export * from "./variants";
export * from "./upload";
export * from "./entity";
export * from "./scene";
export * from "./character-scene";
