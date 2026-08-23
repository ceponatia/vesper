import { describe, expect, it } from "vitest";
import { assessSdTrainingDataset } from "./dataset-assessment";
import {
  SD_TRAINING_DATASET_TARGET_MAX,
  SD_TRAINING_DATASET_TARGET_MIN,
  sdTrainingViews,
  type SdTrainingDataset,
  type SdTrainingView,
} from "./training-manifest";

/**
 * **An uncurated training set is reported, not passed.**
 *
 * The bad implementation this kills is the one that always looks healthy — a
 * coverage check that credits untagged images to every view, or a size check
 * that only ever fires on an empty list. Either one trains a LoRA on twenty
 * front-facing photographs of the same room and reports a clean set, and the
 * consequence arrives weeks later as a character who cannot change location
 * (sd-rendering-package.plan.md §8).
 *
 * The clean row matters as much as the failing ones: a report that flagged a
 * properly curated set would be ignored within a week, which is the same
 * outcome as not having one.
 */

const [FIRST_VIEW] = sdTrainingViews;

/** `count` images whose view tags cycle through `views`; an empty `views` leaves them untagged. */
function datasetOf(count: number, views: readonly SdTrainingView[]): SdTrainingDataset {
  return {
    images: Array.from({ length: count }, (_unused, index) => ({
      id: `img-${String(index)}`,
      uri: `https://example.invalid/${String(index)}.png`,
      view: views.length > 0 ? views[index % views.length] : undefined,
    })),
  };
}

interface AssessmentCase {
  name: string;
  dataset: SdTrainingDataset;
  missingViews: readonly SdTrainingView[];
  belowTargetMin: boolean;
  aboveTargetMax: boolean;
}

const cases: readonly AssessmentCase[] = [
  {
    name: "a set that is all one framing",
    dataset: datasetOf(SD_TRAINING_DATASET_TARGET_MIN, [FIRST_VIEW]),
    missingViews: sdTrainingViews.filter((view) => view !== FIRST_VIEW),
    belowTargetMin: false,
    aboveTargetMax: false,
  },
  {
    name: "a set nobody tagged",
    dataset: datasetOf(SD_TRAINING_DATASET_TARGET_MIN, []),
    missingViews: sdTrainingViews,
    belowTargetMin: false,
    aboveTargetMax: false,
  },
  {
    name: "a set below the curation target",
    dataset: datasetOf(SD_TRAINING_DATASET_TARGET_MIN - 1, sdTrainingViews),
    missingViews: [],
    belowTargetMin: true,
    aboveTargetMax: false,
  },
  {
    name: "a set above the curation target",
    dataset: datasetOf(SD_TRAINING_DATASET_TARGET_MAX + 1, sdTrainingViews),
    missingViews: [],
    belowTargetMin: false,
    aboveTargetMax: true,
  },
  {
    name: "a curated set",
    dataset: datasetOf(SD_TRAINING_DATASET_TARGET_MIN, sdTrainingViews),
    missingViews: [],
    belowTargetMin: false,
    aboveTargetMax: false,
  },
];

describe("SD training dataset assessment", () => {
  it.each(cases)("reports $name", ({ dataset, missingViews, belowTargetMin, aboveTargetMax }) => {
    expect(assessSdTrainingDataset(dataset)).toEqual({
      imageCount: dataset.images.length,
      missingViews,
      belowTargetMin,
      aboveTargetMax,
    });
  });
});
