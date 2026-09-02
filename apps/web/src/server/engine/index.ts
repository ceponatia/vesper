export * from "./constants";
export * from "./jobs";
export * from "./keyed-lock";
export * from "./character-chat";
export * from "./simulation";
export * from "./chat-pipeline";
export * from "./chat-reference-enqueue";
export * from "./chat-reference-images";
export * from "./chat-action-beat";
export * from "./chat-authority";
export * from "./engine-comparison";
export * from "./sim-beats";
export * from "./composition-diagnostics";
export * from "./sim-time-jobs";
export * from "./sim-exchange";
export * from "./sim-narrator";
export * from "./sim-shadow";
export * from "./sim-surfaces";
export * from "./sim-visual-state";
export * from "./chat-callback";
export * from "./chat-feeling";
export * from "./chat-initiative";
export * from "./chat-intent";
export * from "./chat-relationships";
export * from "./chat-selfie";
export * from "./chat-vision";
export * from "./chat-summary";
export * from "./chat-affordances";
export * from "./chat-garment-affordances";
export * from "./chat-affordance-preview";
export * from "./chat-physical-guidance";
export * from "./chat-physical-guidance-render";
export * from "./chat-physical-guidance-preview";
export * from "./chat-recognition-adapter";
export * from "./chat-contact-events";
export * from "./chat-permission-events";
// Two chat-contact-adapter values with callers outside the pipeline: the lane's
// player subject id (the permission override route,
// src/app/api/admin/chat-permissions) and the exchange event ref (the rollout
// trial's driver, which must reproduce an attempt id to bind a denial to it).
// The adapter itself stays out of the barrel — its DETECTOR surface is
// pipeline-internal, and neither of these is a detector.
export { chatContactEventRef, CHAT_CONTACT_PLAYER_SUBJECT } from "./chat-contact-adapter";
export * from "./chat-npc-scene-envelope";
export * from "./visual-memory-store";
export * from "./chat-wardrobe";
export * from "./chat-garments";
export * from "./chat-state";
export * from "./chat-memory";
export * from "./chat-scene-sketch";
export * from "./chat-meanwhile";
export * from "./prompts/chat-extractors";
export * from "./prompts/chat-meanwhile";
export * from "./prompts/chat-scene-sketch";
export * from "./prompts/chat-summary";
export * from "./prompts/chat-state";
export * from "./prompts/character-chat";
export * from "./prompts/sim-render";
// The two narrator lanes' shared visual-state blocks, and the headings they own
// — named by the sensory-allowance carve-out and by the eval harness's splice.
export * from "./prompts/visual-state-block";
// prompts/constants re-exports engine constants; only its unique values here.
export {
  AGENT_INPUT_CAP,
  AGENT_NARRATION_CAP,
  DEFAULT_NARRATION_SHAPE,
  type NarrationLane,
  NARRATION_LANE_DEFAULTS,
  NARRATION_SHAPE_IDS,
  NARRATION_SHAPE_PROFILES,
  type NarrationShapeId,
  chatContactActionsEnabled,
  chatGarmentCuesEnabled,
  chatPhysicalConstraintsEnabled,
  chatRomanticPermissionDevOverrideEnabled,
  chatRomanticPermissionEnabled,
  narrationShapeId,
  readDevNarrationShape,
  setDevNarrationShape,
} from "./prompts/constants";
