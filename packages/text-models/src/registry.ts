import type { TextModelAdapter } from "./composer";

/**
 * Every model whose call profile Vesper has written down, keyed by the EXACT
 * model id its host serves it under.
 *
 * Exact, with no normalization of any kind. Owner ruling (2026-08-17): every
 * setting is exact-model evidence, and no model inherits a sibling's profile by
 * name. Two checkpoints from one author, at one quantization, differing only in
 * a suffix, are asked differently the moment either is measured — so a lookup
 * that fell back to a shared prefix would hand a model somebody else's
 * measurements and report nothing.
 *
 * Empty. The vocabulary, the dialects and the composer are what this package
 * publishes; a registered adapter is a claim that a specific model has been
 * measured, and an entry added without that measurement is the model-card
 * guessing the exact-id keying exists to prevent.
 */
export const TEXT_MODEL_ADAPTERS: Readonly<Record<string, TextModelAdapter>> = {};

/**
 * The adapter for a registered model, or null when Vesper has nothing special
 * to say about it.
 *
 * **Null is the ordinary answer, never an error.** Most narrators have no
 * adapter and are asked exactly as they are today; a caller treats null as "no
 * profile, no extra validation, no execution hints, lane defaults throughout"
 * and carries on. If this ever started throwing or logging on a miss, every
 * unadapted model would look broken while behaving perfectly — and since the
 * registry is empty until a model is measured, that is every model.
 *
 * The empty string is a miss like any other: an unset id is a caller's bug, but
 * answering it with a refusal here would turn a missing selection into a failed
 * turn rather than a model asked at lane defaults.
 */
export function adapterForTextModel(id: string): TextModelAdapter | null {
  return TEXT_MODEL_ADAPTERS[id] ?? null;
}
