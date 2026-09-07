export { EXP2_SCALE, exp2NegativeFixedPoint } from "@vesper/contracts";
export {
  BODY_THRESHOLD_HORIZON_SECONDS,
  buildMeterView,
  deriveSleepCredit,
  integrateMeterValue,
  modifiersLiveAt,
  normalizeConditionModifierSpecs,
  selfCareAdjustmentsBetween,
  solveNextThresholdCrossing,
  thresholdCrossed,
  type MeterIntegrationView,
  type ThresholdCrossing,
} from "./bodies/integration";
export {
  bodyConditionExpiryUniquenessKey,
  bodyThresholdUniquenessKey,
  bodyThresholdUniquenessKeyPrefix,
  deriveBodyConditionId,
  deriveBodyModifierId,
  type BodyBranchMeta,
  type BodyEventCommandContext,
} from "./bodies/events";
export {
  applySourceToMeter,
  resolveApplyBodySource,
  resolveInitializeActorBody,
  type ApplyBodySourceResolution,
  type ApplySourceToMeterArgs,
  type ApplySourceToMeterResult,
  type BodyMeterResolutionView,
  type InitializeActorBodyResolution,
  type InitializeActorBodyResolutionView,
} from "./bodies/sources";
export {
  buildSleepConditionTrain,
  resolveApplyBodyCondition,
  resolveApplyBodyModifier,
  resolveEndBodyCondition,
  type ApplyBodyConditionResolution,
  type ApplyBodyConditionResolutionView,
  type ApplyBodyModifierResolution,
  type EndBodyConditionResolution,
  type EndBodyConditionResolutionView,
  type SleepConditionTrain,
} from "./bodies/conditions";
export {
  buildActorBodyAlarmRearms,
  resolveBodyThreshold,
  type ResolveBodyThresholdResolution,
  type ResolveBodyThresholdResolutionView,
} from "./bodies/alarms";
export {
  bodyCollapseUniquenessKey,
  bodyCollapseUniquenessKeyPrefix,
  collapseContextOf,
  lastSleepEndedAtOf,
  resolveBodyCollapse,
  solveCollapseCrossing,
  type CollapseContext,
  type CollapseCrossing,
  type ResolveBodyCollapseResolution,
  type ResolveBodyCollapseResolutionView,
} from "./bodies/collapse";
export {
  applyBodyEvent,
  emptyBodiesSeed,
  replayBodiesHistory,
  sortBodiesProjection,
  type BodiesReplayInput,
} from "./bodies/projection";
