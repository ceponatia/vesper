/**
 * Typed client data layer over the route-handler API. Domain leaves own transport,
 * response schemas, endpoint families, and streaming; this entry preserves the
 * application-facing surface with explicit exports. Every response crosses a
 * trust boundary and is parsed with forgiving schemas.
 */
export { meSchema, meApi } from "./api/account";
export type { Me } from "./api/account";
export {
  replyTakesSchema,
  chatMessageSchema,
  garmentPartControlSchema,
  garmentPartConditionSchema,
  garmentDepositReadoutSchema,
  garmentDamageReadoutSchema,
  garmentReadoutSchema,
  chatStateSnapshotSchema,
  chatSummarySchema,
  chatRosterMemberSchema,
  chatTranscriptSchema,
  chatRelationshipSchema,
  liveEdgeRecordSchema,
  chatRelationshipsSchema,
  libraryRelationshipsSchema,
  libraryRelationshipsConflictSchema,
  chatWorldSchema,
  simTravelResultSchema,
  simMoveTogetherResultSchema,
  simGiveItemResultSchema,
  simDoActivityResultSchema,
} from "./api/chat-schemas";
export type {
  ReplyTakes,
  ChatMessage,
  GarmentPartControl,
  GarmentPartCondition,
  GarmentDepositReadout,
  GarmentDamageReadout,
  GarmentReadout,
  ChatStateSnapshot,
  ChatStateEdit,
  ChatSummary,
  ChatRosterMember,
  ChatTranscript,
  ChatRelationship,
  LiveEdgeRecord,
  AuthoredEdgeRecord,
  ChatRelationships,
  LibraryRelationships,
  ChatWorld,
  SimTravelResult,
  SimMoveTogetherResult,
  SimGiveItemResult,
  SimDoActivityResult,
} from "./api/chat-schemas";
export { sendChatMessage } from "./api/chat-stream";
export type { ChatStreamOutcome } from "./api/chat-stream";
export {
  chatsApi,
  presetRelationshipSchema,
  chatPresetSchema,
  chatPresetsApi,
  successorChatSummarySchema,
  successorChatsApi,
} from "./api/chats";
export type {
  PresetRelationship,
  ChatPreset,
  SuccessorChatSummary,
} from "./api/chats";
export {
  toApiError,
  apiGet,
  apiPost,
  apiPatch,
  apiPut,
  apiDelete,
  withQuery,
} from "./api/http";
export type { ApiError, ApiResult } from "./api/http";
export { characterAuthoringRunsApi, characterAuthoringRunSchema } from "./api/character-authoring-runs";
export type {
  CharacterAuthoringDecision,
  CharacterAuthoringGenerationInput,
  CharacterAuthoringResult,
  CharacterAuthoringRun,
  CharacterAuthoringSource,
  CharacterAuthoringTarget,
} from "./api/character-authoring-runs";
export {
  identityPackConflictSummary,
  identityPackRejectionCode,
  identityPacksApi,
  identityPackTrialRefusal,
  adminIdentityPacksApi,
} from "./api/identity-packs";
export type {
  IdentityPackAdminRevision,
  IdentityPackBlockedWire,
  IdentityPackNormalizedCropWire,
  IdentityPackSummaryWire,
  IdentityPackWriteGuard,
} from "./api/identity-packs";
export { imageGeneratorApi } from "./api/image-generator";
export { imageLabApi } from "./api/image-lab";
export { characterMediaJobsApi, characterMediaJobsClientResponseSchema } from "./api/character-media";
export type {
  CharacterMediaJob,
  CharacterMediaJobsClientResponse,
  CharacterMediaRetryTarget,
} from "./api/character-media";
export {
  imageModelSchema,
  imageReferenceTransports,
  imageProfileOptionSchema,
  imageProfileResolutionSchema,
  imageProfilesApi,
  imageVersionBlockedBodySchema,
  adminImageModelsApi,
  adminImageModelProfilesApi,
  IMAGE_LORA_MAX_SCALE,
  IMAGE_LORA_MAX_TRIGGER_WORDS,
  IMAGE_LORA_MIN_SCALE,
  imageLoraLocatorTypes,
  imageLoraSchema,
  isValidImageLoraLocator,
  redactImageLoraLocator,
  imageLorasApi,
} from "./api/image-models";
export type {
  ImageModel,
  ImageModelProfile,
  ImageModelProfileCreateRequest,
  ImageModelProfileUpdateRequest,
  ImageModelSurface,
  ImageProfileTask,
  ImageReferenceTransport,
  ImageProfileOption,
  ImageProfileResolution,
  ImageVersionProfileFindings,
  ImageVersionProbeResponse,
  ImageVersionSmokeResponse,
  AdminImageRegistry,
  ImageLora,
  ImageLoraCreateRequest,
  ImageLoraLocatorType,
  ImageLoraUpdateRequest,
} from "./api/image-models";
export {
  imageUrl,
  imageRowMetaSchema,
  galleryImageSchema,
  imageRecordSchema,
  portraitVariantKindLabel,
  portraitVariantKinds,
  ownedImageSourceSchema,
  ownedImagesApi,
  galleryApi,
} from "./api/images";
export type {
  GalleryTab,
  GalleryImage,
  ImageRecord,
  PortraitVariantKind,
  OwnedImageSourceRecord,
} from "./api/images";
export {
  visibilitySchema,
  createdRefSchema,
  detailOf,
  characterSummarySchema,
  characterDetailSchema,
  characterSaveSchema,
  personaSummarySchema,
  personaDetailSchema,
  locationSummarySchema,
  locationConnectionSchema,
  locationDetailSchema,
  itemSummarySchema,
  itemDetailSchema,
  socialCardSummarySchema,
  socialCardDetailSchema,
  characterForgeSections,
  characterSheetScopes,
  characterDraftSchema,
  emptyCharacterDraft,
  portraitReviewSchema,
  charactersApi,
  itemDraftProposalSchema,
  locationsApi,
  itemsApi,
  socialCardsApi,
  personasApi,
} from "./api/library";
export type {
  Visibility,
  CreatedRef,
  Ambient,
  CharacterSummary,
  CharacterDetail,
  CharacterPortraitAcceptance,
  CharacterSaveResult,
  PersonaSummary,
  PersonaDetail,
  LocationSummary,
  LocationConnection,
  LocationDetail,
  ItemDefinitionParts,
  ItemSummary,
  ItemDetail,
  SocialCardSummary,
  SocialCardDetail,
  CharacterForgeSection,
  CharacterSheetScope,
  CharacterDraft,
  PortraitReview,
  ListParams,
  ItemDraftProposal,
} from "./api/library";
export { referenceViewsApi } from "./api/reference-views";
export type {
  ReferenceView,
  ReferenceViewAngleId,
  ReferenceViewHistoryEntry,
  ReferenceViewHistoryVerdict,
  ReferenceViewQueueOutcome,
  ReferenceViewSetSummary,
  ReferenceViewState,
  ReferenceViewSummary,
  ReferenceViewWardrobe,
} from "./api/reference-views";
