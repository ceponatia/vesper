import { z } from "zod";
import {
  sceneStagingIdSchema,
  sceneStagingSurfaceDigestSchema,
  type SceneStagingSurfaceForm,
} from "./scene-staging";

/**
 * What a render STORES about the arrangement's wording.
 *
 * A revision on its own answers the wrong question. `on_all_fours@3` names the sentence the
 * registry offered, and a reader who finds it in a render record concludes those measured
 * words reached the provider — which is false whenever the endpoint's dialect wrote its own.
 * The measurements attached to `@3` then get credited to an image that never contained them,
 * and the next tuning round is reasoning from a phantom.
 *
 * So the record carries three separable facts: which wording was offered (revision), which
 * bytes that revision meant (digest), and what the dialect did with it (disposition). All
 * three are needed. Revision and disposition together say what happened; the digest is what
 * survives the registry moving on, because a revision is a name and a name can be made to
 * point somewhere else.
 *
 * PURE data and types. Nothing here reads the wording — the text has no name outside its own
 * module, which is why provenance can be assembled without a door into it.
 */

/**
 * What became of the registry's sentence on this render.
 *
 * - `adopted` — the dialect took the registry's wording, so those exact bytes are what the
 *   provider was sent and the measurements behind the revision apply to this image.
 * - `replaced` — the dialect worded the arrangement itself. The revision still matters: it
 *   names the wording that was available and declined, which is what makes a later
 *   comparison between two endpoints readable.
 *
 * There is deliberately no `dropped` member. A claim that does not survive fitting produces
 * no wording and so no record here at all, and the program's own `droppedClaimIds` already
 * names it — a second vocabulary for one fact is how the two drift apart.
 */
export const sceneStagingSurfaceDispositions = ["adopted", "replaced"] as const;

export const sceneStagingSurfaceDispositionSchema = z.enum(sceneStagingSurfaceDispositions);

export type SceneStagingSurfaceDisposition = (typeof sceneStagingSurfaceDispositions)[number];

/**
 * The shape a revision has once it has been read back out of storage.
 *
 * A stored string is untrusted, so it is checked rather than assumed. The authored side is
 * `SceneStagingSurfaceRevision`, which is composed and cannot be spelled wrong; this is the
 * same format stated as a rule for the side that receives it.
 */
const STORED_REVISION_PATTERN = /^[a-z_]+@\d+$/;

/**
 * One arrangement's wording, as a render records it.
 *
 * The dialect is a plain string on purpose: dialect ids belong to the compiler, and this
 * module stays clear of compiler internals so the scene vocabulary remains extractable.
 * Nothing is lost — a stored dialect id is resolved by whoever is reading the record.
 */
export const sceneStagingSurfaceProvenanceSchema = z
  .object({
    stagingId: sceneStagingIdSchema,
    /** `on_all_fours@3` — the wording the registry offered for this arrangement. */
    revision: z.string().regex(STORED_REVISION_PATTERN),
    /** SHA-256 of the bytes that revision meant, so a later reader can tell if it has moved. */
    digest: sceneStagingSurfaceDigestSchema,
    disposition: sceneStagingSurfaceDispositionSchema,
    /** The dialect that made the decision — a `promptDialectId`, resolved by the reader. */
    dialectId: z.string().min(1),
  })
  // A revision names the arrangement it belongs to, so a record whose two halves disagree is
  // corrupt rather than merely unusual, and reading it as fact would attribute one
  // arrangement's measurements to another.
  .refine((record) => record.revision.startsWith(`${record.stagingId}@`), {
    message: "revision does not name its own staging",
    path: ["revision"],
  });

export type SceneStagingSurfaceProvenance = z.infer<typeof sceneStagingSurfaceProvenanceSchema>;

/**
 * Record what a dialect did with an arrangement's wording.
 *
 * The revision and digest are taken from the form rather than from the caller, so a record
 * cannot claim a revision the form did not carry — the disposition and the dialect are the
 * only things a call site decides.
 */
export function sceneStagingSurfaceProvenance(
  form: SceneStagingSurfaceForm,
  disposition: SceneStagingSurfaceDisposition,
  dialectId: string,
): SceneStagingSurfaceProvenance {
  return {
    stagingId: form.stagingId,
    revision: form.revision,
    digest: form.digest,
    disposition,
    dialectId,
  };
}

/**
 * Parse a stored record defensively, returning null on anything unexpected.
 *
 * Image metadata is a trust boundary like any other (docs/resilience.md §1): the rows outlive
 * the code that wrote them, and an inspector must degrade to "no staging provenance" rather
 * than throwing at a reader.
 */
export function parseSceneStagingSurfaceProvenance(value: unknown): SceneStagingSurfaceProvenance | null {
  const parsed = sceneStagingSurfaceProvenanceSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
