import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { log } from "@/server/log";
import {
  PAID_RENDER_OUTPUT_RECORD_WAIT_MS,
  recordPaidRenderOutput,
  withPaidRenderOutputRecorder,
  type PaidRenderOutput,
} from "./paid-render-output";

/**
 * **A paid output's early record reaches its own render and never costs the
 * render anything** (#687).
 *
 * A provider lane records a billed output's ids through this seam before it
 * downloads, without knowing which row the render belongs to. These kill the
 * implementations that would make that record a hazard instead of a safety
 * net: a recorder reached through module state rather than the render's own
 * async context (two concurrent renders write each other's ids onto the wrong
 * row), a record that throws into the lane (a database hiccup fails a render
 * that already succeeded), and a record the lane awaits without bound (a
 * database that stops answering stalls an output that is already paid for).
 * The lane's own call — the ids it passes, and that it passes them before the
 * download — is `civitai-runtime.test.ts`'s.
 */

const OUTPUT: PaidRenderOutput = { predictionId: "wf-1", outputId: "blob-1", modelSlug: "civitai/flux-2-klein-4b" };

beforeEach(() => {
  vi.mocked(log.warn).mockClear();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("recordPaidRenderOutput (#687)", () => {
  it("records nothing outside a render that installed a recorder", async () => {
    await expect(recordPaidRenderOutput(OUTPUT)).resolves.toBeUndefined();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("hands each concurrent render's ids to its own recorder and no other", async () => {
    const first: PaidRenderOutput[] = [];
    const second: PaidRenderOutput[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const render = async (id: string): Promise<void> => {
      // Both renders are in flight at once, and record only after each has
      // yielded to the other.
      await gate;
      await recordPaidRenderOutput({ ...OUTPUT, predictionId: id });
    };

    const running = Promise.all([
      withPaidRenderOutputRecorder(async (output) => { first.push(output); }, () => render("wf-first")),
      withPaidRenderOutputRecorder(async (output) => { second.push(output); }, () => render("wf-second")),
    ]);
    release();
    await running;

    expect(first).toEqual([{ ...OUTPUT, predictionId: "wf-first" }]);
    expect(second).toEqual([{ ...OUTPUT, predictionId: "wf-second" }]);
  });

  it("never throws when the recorder fails, and says so in the log", async () => {
    await expect(withPaidRenderOutputRecorder(async () => {
      throw new Error("the database is not answering");
    }, () => recordPaidRenderOutput(OUTPUT))).resolves.toBeUndefined();

    expect(log.warn).toHaveBeenCalledWith(
      "ai.paid_output",
      "a paid render output's ids could not be recorded",
      { predictionId: "wf-1", error: "the database is not answering" },
    );
  });

  it("stops waiting for a recorder that does not answer once the bounded wait has passed", async () => {
    vi.useFakeTimers();
    let returned = false;

    const recording = withPaidRenderOutputRecorder(
      () => new Promise<void>(() => undefined),
      () => recordPaidRenderOutput(OUTPUT),
    ).then(() => {
      returned = true;
    });
    await vi.advanceTimersByTimeAsync(PAID_RENDER_OUTPUT_RECORD_WAIT_MS - 1);
    expect(returned).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await recording;

    expect(returned).toBe(true);
    expect(log.warn).toHaveBeenCalledWith(
      "ai.paid_output",
      "a paid render output's ids were still being recorded; its download starts without waiting",
      { predictionId: "wf-1" },
    );
  });
});
