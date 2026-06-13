import { generateText } from "ai";
import { z, type ZodType } from "zod";
import { diag, type DiagnosticSink } from "@/contracts/diagnostics";
import { isDemoMode, openrouter, stateModelId } from "./provider";

export interface GenerateCheckedOptions<T> {
  schema: ZodType<T>;
  system: string;
  prompt: string;
  /** OpenRouter model id; defaults to the state model. */
  modelId?: string;
  temperature?: number;
  maxOutputTokens?: number;
  /** Diagnostic code prefix, e.g. "agent.simulant". */
  code: string;
  sink?: DiagnosticSink;
  /** Demo-mode / total-failure fallback. Omit to get null on failure. */
  fallback?: () => T;
}

export interface GenerateCheckedResult<T> {
  value: T | null;
  degraded: boolean;
}

/**
 * Structured generation with the resilience ladder (docs/resilience.md §3):
 * typed output → one repair round-trip with the validation issues → degraded
 * fallback. Never throws into the pipeline.
 */
export async function generateChecked<T>(opts: GenerateCheckedOptions<T>): Promise<GenerateCheckedResult<T>> {
  if (isDemoMode()) {
    return degrade(opts, "demo mode");
  }

  // Plain text + local parse, NOT provider-side constrained decoding
  // (`Output.object` / response_format json_schema): constrained decoding
  // degenerates on some models — Gemini 2.5 Flash returned hollow-but-valid
  // objects that all-defaulted schemas accepted without ever tripping repair
  // (followups.phase2.md #20). The model sees the JSON Schema as text; the
  // resilience ladder below does the enforcement.
  const schemaText = jsonSchemaText(opts.schema);
  const attempt = async (prompt: string): Promise<T> => {
    const result = await generateText({
      model: openrouter().chat(opts.modelId ?? stateModelId()),
      temperature: opts.temperature ?? 0,
      maxOutputTokens: opts.maxOutputTokens ?? 4096,
      system: [
        opts.system,
        "",
        "Respond with ONLY a single JSON object — no markdown fences, no commentary." +
          (schemaText ? ` It must conform to this JSON Schema:\n${schemaText}` : ""),
      ].join("\n"),
      prompt,
    });
    return opts.schema.parse(JSON.parse(extractJsonObject(result.text)));
  };

  let firstError = "";
  try {
    return { value: await attempt(opts.prompt), degraded: false };
  } catch (err) {
    firstError = errorText(err);
  }

  try {
    const value = await attempt(
      [
        opts.prompt,
        "",
        "Your previous response failed validation with these issues:",
        firstError.slice(0, 2000),
        "Respond again with a valid object. Fix only the listed issues.",
      ].join("\n"),
    );
    // info, not warn: the repair *succeeded* — the user has nothing to act on.
    opts.sink?.push(diag("info", `${opts.code}.repaired`, "structured output needed one repair round-trip"));
    return { value, degraded: false };
  } catch (err) {
    opts.sink?.push(
      diag("error", `${opts.code}.parse_failed`, `structured output failed after repair: ${errorText(err).slice(0, 500)}`),
    );
    return degrade(opts, "validation failed twice");
  }
}

function degrade<T>(opts: GenerateCheckedOptions<T>, reason: string): GenerateCheckedResult<T> {
  if (opts.fallback) {
    opts.sink?.push(diag("info", `${opts.code}.degraded`, `using degraded fallback (${reason})`));
    return { value: opts.fallback(), degraded: true };
  }
  const empty = opts.schema.safeParse({});
  if (empty.success) {
    opts.sink?.push(diag("info", `${opts.code}.degraded`, `using schema defaults (${reason})`));
    return { value: empty.data, degraded: true };
  }
  return { value: null, degraded: true };
}

/**
 * Pure: pull the JSON object out of a model response that may carry markdown
 * fences or stray prose. First "{" to last "}" — models that chat around the
 * object still parse; genuinely malformed JSON throws into the repair ladder.
 */
export function extractJsonObject(text: string): string {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) throw new Error("response contained no JSON object");
  return text.slice(start, end + 1);
}

/** JSON Schema rendering of the zod schema for the prompt; "" when the schema can't be serialized (worked examples carry the shape then). */
function jsonSchemaText(schema: ZodType<unknown>): string {
  try {
    return JSON.stringify(z.toJSONSchema(schema as never, { io: "input" }));
  } catch {
    return "";
  }
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
