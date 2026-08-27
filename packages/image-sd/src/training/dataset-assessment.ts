import {
  SD_TRAINING_DATASET_TARGET_MAX,
  SD_TRAINING_DATASET_TARGET_MIN,
  sdTrainingViews,
  type SdTrainingDataset,
  type SdTrainingView,
} from "./training-manifest";

/**
 * Whether a training set looks curated.
 *
 * The failure this exists to catch is not a crash — an uncurated dataset trains
 * perfectly happily. It produces a LoRA that learned the wrong thing: twenty
 * front-facing photographs in the same room teach Stable Diffusion "this
 * character IS this room", and the symptom arrives weeks later as renders that
 * refuse to change location or clothing. By then the dataset is gone and the
 * LoRA looks merely disappointing. So the report is produced up front, where a
 * curator can still act on it.
 *
 * **A report, never a refusal.** Nothing here throws, and nothing here is a
 * schema rule: the curation window is explicitly "approximately 12–20", a trial
 * value that no comparison has confirmed yet. A curator with eleven excellent images
 * should be able to train; the assessment's job is to make sure they know they
 * did that on purpose.
 *
 * Pure and sink-free — it takes a dataset and returns numbers. There is no
 * degradation to report, so there is nothing for a `DiagnosticSink` to carry.
 */
export interface SdTrainingDatasetAssessment {
  imageCount: number;
  /**
   * Views no image is tagged with, in the canonical `sdTrainingViews` order.
   *
   * Untagged images count toward nothing. That is deliberately pessimistic: an
   * image with no `view` might be any framing, and crediting it to a view would
   * report coverage the set may not have — which is the one wrong answer this
   * function can give, since a curator acts on it by stopping.
   */
  missingViews: readonly SdTrainingView[];
  belowTargetMin: boolean;
  aboveTargetMax: boolean;
}

/** The curation report for one training set. */
export function assessSdTrainingDataset(dataset: SdTrainingDataset): SdTrainingDatasetAssessment {
  const tagged = new Set<SdTrainingView>();
  for (const image of dataset.images) {
    if (image.view !== undefined) tagged.add(image.view);
  }
  const imageCount = dataset.images.length;
  return {
    imageCount,
    missingViews: sdTrainingViews.filter((view) => !tagged.has(view)),
    belowTargetMin: imageCount < SD_TRAINING_DATASET_TARGET_MIN,
    aboveTargetMax: imageCount > SD_TRAINING_DATASET_TARGET_MAX,
  };
}
