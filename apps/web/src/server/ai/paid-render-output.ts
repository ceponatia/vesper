import { AsyncLocalStorage } from "node:async_hooks";
import { log } from "@/server/log";

/**
 * **A paid output's ids, recorded before its download** — the seam a provider
 * lane calls the moment a render has succeeded and been billed, so a process
 * that dies while the output is still downloading leaves something to recover
 * from instead of a second paid render.
 *
 * The lane knows the workflow and the output it chose; it does not know which
 * stored record the render belongs to, and must not. The code that owns that
 * record — `runImagePipeline` for an `images` row — installs a recorder around
 * the render with {@link withPaidRenderOutputRecorder}, and the lane calls
 * {@link recordPaidRenderOutput} without knowing whether anyone is listening.
 * The recorder rides the render's own async context (`AsyncLocalStorage`), so
 * concurrent renders each reach only their own record, and a render with no
 * recorder installed — a bench run, a probe, a test — records nothing.
 *
 * Best-effort, like a lease heartbeat: the record never fails the render and
 * never holds its download back for long. The lane waits at most
 * {@link PAID_RENDER_OUTPUT_RECORD_WAIT_MS} for the recorder, then downloads
 * anyway while the write finishes on its own; a recorder that throws is logged
 * and ignored.
 */

/** The ids that identify a paid output to fetch again. */
export interface PaidRenderOutput {
  /** The provider workflow that rendered, and billed, the output. */
  readonly predictionId: string;
  /** The output the workflow produced and the lane chose to download. */
  readonly outputId: string;
  /** The model that rendered it — what says which provider can fetch it again. */
  readonly modelSlug: string;
}

/** Writes one paid output's ids onto the record its render belongs to. */
export type PaidRenderOutputRecorder = (output: PaidRenderOutput) => Promise<void>;

/**
 * How long a lane waits for the record before it downloads anyway. One guarded
 * write normally answers in milliseconds; a database that is not answering must
 * not stall an output that is already paid for, so past this the download
 * starts and the write lands, or not, on its own.
 */
export const PAID_RENDER_OUTPUT_RECORD_WAIT_MS = 5_000;

const recorders = new AsyncLocalStorage<PaidRenderOutputRecorder>();

/** Run `render` with `recorder` receiving every paid output it records, and nothing else's. */
export function withPaidRenderOutputRecorder<T>(recorder: PaidRenderOutputRecorder, render: () => Promise<T>): Promise<T> {
  return recorders.run(recorder, render);
}

/**
 * Record a paid output's ids on the record the current render belongs to, if
 * one is listening. Never throws, and returns within
 * {@link PAID_RENDER_OUTPUT_RECORD_WAIT_MS} whatever the recorder does.
 */
export async function recordPaidRenderOutput(output: PaidRenderOutput): Promise<void> {
  const recorder = recorders.getStore();
  if (recorder === undefined) return;
  // Never rejects: a recorder that throws is a failed record, not a failed render.
  const written = (async (): Promise<"recorded"> => {
    try {
      await recorder(output);
    } catch (error) {
      log.warn("ai.paid_output", "a paid render output's ids could not be recorded", {
        predictionId: output.predictionId,
        error: (error instanceof Error ? error.message : String(error)).slice(0, 300),
      });
    }
    return "recorded";
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const waited = new Promise<"waiting">((resolve) => {
    timer = setTimeout(() => resolve("waiting"), PAID_RENDER_OUTPUT_RECORD_WAIT_MS);
    timer.unref?.();
  });
  const outcome = await Promise.race([written, waited]);
  clearTimeout(timer);
  if (outcome === "waiting") {
    log.warn("ai.paid_output", "a paid render output's ids were still being recorded; its download starts without waiting", {
      predictionId: output.predictionId,
    });
  }
}
