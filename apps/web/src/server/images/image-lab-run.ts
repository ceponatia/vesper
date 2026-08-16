import { and, eq } from "drizzle-orm";
import type { DiagnosticSink } from "@/contracts/diagnostics";
import { db, imageLabExperiments } from "../db";
import { runBaseline } from "./image-lab-baseline";
import { runControlled, runControlProbe } from "./image-lab-control";
import { runFinishingPass } from "./image-lab-finishing";
import { settleFailed } from "./image-lab-render";
import { runTwoCharacterScene } from "./image-lab-scene";
import { runStagedScene } from "./image-lab-staged";
import { type ImageLabExperimentRow, type ImageLabRunPayload, LAB_RUN_THREW, ownedExperiment } from "./image-lab-store";

/**
 * The run entry point and its exhaustive dispatch to one lane per experiment
 * kind. Every lane lives in its own module; the shared machinery they all use is
 * `./image-lab-render.ts`.
 */

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

/**
 * Run one experiment — the body of the `lab_image` job the route starts.
 *
 * NOTHING here throws through the job runner. Every stop is a settled row
 * carrying its reason, because a lab experiment that threw would leave an admin
 * staring at a `pending` record with nothing on it, which is precisely the
 * outcome a bench exists to prevent.
 *
 * The returned record becomes the job row's payload: it is read by a human
 * looking at `jobs`, and by the route for one field — `providerOutcome`, which
 * the settled promise cannot carry, precisely because settling is what this
 * runner does instead of throwing.
 */
export async function runImageLabExperiment(
  experimentId: string,
  ownerId: string,
  sink?: DiagnosticSink,
): Promise<ImageLabRunPayload> {
  const row = await ownedExperiment(experimentId, ownerId);
  if (!row) return { experimentId, skipped: "not_found", providerOutcome: null };
  // A settled experiment is never re-run: its evidence already exists, and a
  // second render under the same id would replace an output the verdict may
  // already be about. A rerun is a new experiment.
  if (row.status !== "pending") return { experimentId, skipped: row.status, providerOutcome: null };

  await db()
    .update(imageLabExperiments)
    .set({ status: "running", startedAt: new Date() })
    .where(and(eq(imageLabExperiments.id, experimentId), eq(imageLabExperiments.ownerId, ownerId)));

  try {
    return await runExperimentOfKind(row, sink);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return await settleFailed(row, LAB_RUN_THREW, message, sink);
  }
}

/**
 * The kind dispatch, EXHAUSTIVE over {@link ImageLabExperimentKind} — so a ninth
 * kind is a compile error here rather than a silent fall-through to whatever the
 * last arm did. The eighth, `staged_scene`, arrived exactly that way.
 */
function runExperimentOfKind(row: ImageLabExperimentRow, sink?: DiagnosticSink): Promise<ImageLabRunPayload> {
  switch (row.kind) {
    case "control_probe":
      return runControlProbe(row, sink);
    case "baseline_portrait":
      return runBaseline(row, "variant", sink);
    case "baseline_scene":
      return runBaseline(row, "scene", sink);
    case "controlled_portrait":
    case "controlled_scene":
      return runControlled(row, row.kind, sink);
    case "two_character_scene":
      return runTwoCharacterScene(row, sink);
    case "finishing_pass":
      return runFinishingPass(row, sink);
    case "staged_scene":
      return runStagedScene(row, sink);
  }
}
