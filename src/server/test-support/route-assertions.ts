import { expect } from "vitest";

/**
 * Response helpers for route-handler suites.
 *
 * Two incantations were copied dozens of times: the double cast on a parsed
 * body (`((await res.json()) as { error: { code: string } }).error.code`), and a
 * bare `await res.text()` whose real purpose — draining the stream so the
 * route's finalizer has run — lived in a per-call-site comment that was as often
 * missing as present. Both are stated once here.
 *
 * NOTE for whoever wires the `index.ts` barrel: this is the only test-support
 * module that imports `vitest`, and `src/server/engine/simulation/command-authz.ts`
 * imports the barrel from PRODUCTION code. Re-exporting this file pulls vitest
 * into the Next build graph. Either sever that production import first, or keep
 * this module out of the production-reachable barrel.
 */

/**
 * Parse a JSON response, asserting `status` first when given. The status check
 * comes before the parse so a 500's error envelope is not reported as a shape
 * mismatch of the payload the test expected.
 */
export async function expectJson<T>(res: Response, status?: number): Promise<T> {
  if (status !== undefined) expect(res.status).toBe(status);
  return (await res.json()) as T;
}

/**
 * Assert the `{ error: { code, message } }` envelope `respond.ts` returns for
 * every failure, and hand back the parsed error so a caller can make further
 * assertions on the message. `code` is checked only when supplied — plenty of
 * cases care about the status alone.
 */
export async function expectApiError(
  res: Response,
  status: number,
  code?: string,
): Promise<{ code: string; message: string }> {
  expect(res.status).toBe(status);
  const body = (await res.json()) as { error?: { code?: unknown; message?: unknown } };
  expect(body.error, `expected an { error: { code, message } } envelope, got ${JSON.stringify(body)}`).toBeDefined();
  const error = { code: String(body.error?.code ?? ""), message: String(body.error?.message ?? "") };
  if (code !== undefined) expect(error.code).toBe(code);
  return error;
}

/**
 * Read a streamed response to completion and return the text.
 *
 * **This is a synchronization point, not just a read.** A streaming chat route
 * persists the assistant reply, releases its keyed lock, and runs its post-turn
 * work inside the stream's own tail — none of which has happened while bytes are
 * still pending. A test that queries the database, or that sends a second
 * message, without draining first races the finalizer and fails intermittently.
 * Drain even when the body is not asserted on.
 */
export async function drainStream(res: Response): Promise<string> {
  return res.text();
}
