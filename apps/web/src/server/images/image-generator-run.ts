import type { DiagnosticSink } from "@/contracts/diagnostics";
import {
  claimGeneratorRun,
  IMAGE_GENERATOR_RUN_THREW,
  type ImageGeneratorRunPayload,
  ownedGeneratorRun,
  settleGeneratorRunFailed,
} from "./image-generator-store";
import { prepareGeneratorRequest } from "./image-generator-request";
import { settleGeneratorRender } from "./image-generator-settle";

/**
 * The Image Generator's runner: the body of the `generator_image` job the route
 * starts.
 *
 * NOTHING here throws through the job runner — every stop is a settled row
 * carrying its reason, because a raw-testing bench that threw would leave the
 * admin staring at a `pending` record with nothing on it. And everything that
 * can refuse does so BEFORE provider spend: the failed attempt is a stable
 * `image_generator.*` code (or a verbatim shared-layer code) on the row, never
 * a silently trimmed request.
 *
 * A run asking for several images is still ONE of everything above: one
 * compiled plan, one pre-spend record, one strict gate. Only the render step
 * repeats, because every registered model returns exactly one image per
 * prediction — the count is the bench's own loop, never a provider input.
 *
 * Deliberately parallel to — never importing — the Lab's render kernel: the
 * two benches share the pure planner, the LoRA resolver, and the byte readers,
 * and nothing else.
 */

/**
 * Run one Generator run. A settled run is never re-run — its evidence already
 * exists, and a second render under the same id would replace an output the
 * admin may already be comparing. A rerun is a new row via `sourceRunId`.
 */
export async function runImageGeneratorRun(
  runId: string,
  ownerId: string,
  sink?: DiagnosticSink,
): Promise<ImageGeneratorRunPayload> {
  // The claim IS the check. Reading the row and then writing `running` would let
  // two deliveries of the same job both see `pending` and both buy a
  // prediction; a conditional update returns a row to exactly one of them.
  const row = await claimGeneratorRun(runId, ownerId);
  if (!row) {
    const existing = await ownedGeneratorRun(runId, ownerId);
    return { runId, skipped: existing?.status ?? "not_found", providerOutcome: null };
  }

  try {
    const prepared = await prepareGeneratorRequest(row, sink);
    if (!prepared.ok) return prepared.result;
    return await settleGeneratorRender(prepared.row, prepared.request, prepared.columns, sink);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return await settleGeneratorRunFailed(row, IMAGE_GENERATOR_RUN_THREW, message, sink);
  }
}
