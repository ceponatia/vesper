import { APICallError } from "ai";

/**
 * Fixtures for the model-gateway suites (`src/server/ai`).
 *
 * Two shapes were copied across four files: the AI SDK `APICallError` the
 * provider-error classifier parses, and the "drive an array of deltas through a
 * streaming transform and join the result" loop the narrator post-processors are
 * tested with.
 */

/** The provider endpoint the classifier's fixtures all name. */
const PROVIDER_URL = "https://openrouter.ai/api/v1/chat/completions";

/**
 * An AI SDK API error carrying `responseBody` — the field the provider-error
 * classifier actually reads. The defaults are the awkward real case the suites
 * exist for: OpenRouter answering **200** with `"Invalid JSON response"` while
 * the true reason (moderation, context overflow) hides in the body.
 */
export function apiError(responseBody: string, message = "Invalid JSON response", statusCode = 200): APICallError {
  return new APICallError({
    message,
    url: PROVIDER_URL,
    requestBodyValues: {},
    statusCode,
    responseBody,
  });
}

/**
 * Feed `chunks` through a streaming transform one delta at a time and join what
 * comes out — the streaming counterpart of a one-shot call, so the same input
 * can be asserted both ways.
 *
 * The source is a real async generator rather than an array: these transforms
 * buffer across deltas (a tag or a repeated block can straddle a chunk
 * boundary), and only lazy arrival proves the buffering.
 */
export async function collectStream(
  chunks: readonly string[],
  transform: (source: AsyncIterable<string>) => AsyncIterable<string>,
): Promise<string> {
  async function* source(): AsyncGenerator<string> {
    for (const chunk of chunks) yield chunk;
  }
  let out = "";
  for await (const piece of transform(source())) out += piece;
  return out;
}
