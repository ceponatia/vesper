import { fnv1aHex } from "@vesper/contracts";
import type { SdTrainingDataset, SdTrainingImage } from "./training-manifest";

/**
 * The fingerprint of a training set.
 *
 * **This value is persisted in the application's identity-pack-to-LoRA binding
 * to detect staleness after an identity pack changes
 * (sd-rendering-package.plan.md §9), so its byte-level stability is a
 * compatibility contract.** A stored fingerprint is compared against a freshly
 * computed one; if this function's serialization is ever changed, every stored
 * fingerprint stops matching, and every trained LoRA in the library is reported
 * stale on the same day. The opposite mistake is worse and quieter: a change
 * that made two different datasets serialize the same way would mark a LoRA
 * fresh forever after its pack was re-curated, and the only symptom is renders
 * that gradually stop looking like the character.
 *
 * Neither failure throws, so `dataset-fingerprint.test.ts` golden-pins the
 * output. A failure there means the format moved, not that the pin is stale.
 *
 * Three properties make it usable as a staleness key:
 *
 * 1. **Order-independent.** Images are sorted by id before serialization,
 *    because the application assembles the list from a database read and a query
 *    without an explicit ordering is free to return the same rows in a different
 *    order on a different day. A fingerprint that changed for that reason would
 *    retrain every LoRA at random.
 * 2. **Content-sensitive.** A changed URI, caption, view or tag changes the
 *    fingerprint. Those are exactly the edits that change what the LoRA would
 *    learn, and a fingerprint over ids alone would miss all of them.
 * 3. **Unambiguous.** Fields are joined with ASCII separator characters rather
 *    than punctuation that can legitimately appear in a caption or a tag, so no
 *    caption can be written that makes one image serialize as two.
 *
 * FNV-1a is the repository's one string hash (`@vesper/contracts`), shared so
 * that a fingerprint means the same thing in every workspace. Non-cryptographic
 * and 32 bits: a staleness key, never a security or dedup boundary.
 */

/** Field separator — U+001F, the ASCII unit separator. */
const FIELD = "\u001f";
/** Record separator — U+001E. Divides one image's line from the next. */
const RECORD = "\u001e";
/** Tag separator — U+001D. Tags keep their given order; it is authored, not incidental. */
const TAG = "\u001d";

/**
 * One image as a canonical line.
 *
 * An absent optional field and an empty one serialize identically. That is a
 * deliberate reading: a caption of `""` says nothing about the image, exactly as
 * no caption does, and treating them as different training data would retrain a
 * LoRA because a text box was cleared rather than left alone.
 */
function canonicalImageLine(image: SdTrainingImage): string {
  return [image.id, image.uri, image.view ?? "", image.caption ?? "", (image.tags ?? []).join(TAG)].join(FIELD);
}

/** The dataset's staleness key: `fnv1aHex` over its canonical, id-sorted serialization. */
export function fingerprintSdTrainingDataset(dataset: SdTrainingDataset): string {
  const ordered = [...dataset.images].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  // Compared by code unit, not `localeCompare`: the collation order of a locale
  // is a property of the machine that ran the sort, and a fingerprint that
  // depended on it would differ between a developer's laptop and the deploy.
  return fnv1aHex(ordered.map(canonicalImageLine).join(RECORD));
}
