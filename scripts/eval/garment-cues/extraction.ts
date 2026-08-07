import {
  chatContinuitySchema,
  type GarmentOperationProposal,
} from "@/contracts";
import type { DiagnosticSink } from "@/contracts/diagnostics";
import { agentModelId, generateChecked } from "@/server/ai";
import {
  buildChatExtractorPrompt,
  buildChatExtractorSystem,
  type ChatExtractorContext,
} from "@/server/engine";
import {
  CHARACTER_NAME,
  PLAYER_NAME,
  type GarmentExtractionFixture,
} from "./fixtures";
import {
  extractionExpectationMatches,
  extractionHandles,
} from "./harness";

/**
 * Extraction half of the garment tuning instrument.
 *
 * The narrator arms begin from authoritative stores so prompt quality is not
 * confounded by a bad archivist call. Extraction accuracy is measured beside
 * them against its own fixed corpus, using the production continuity system
 * prompt, user prompt, schema, model route and grounded handle table. This is a
 * single continuity call per fixture rather than `runChatExtraction`'s three-leg
 * fan-out, because the other two legs' outputs are discarded by this campaign.
 */

export interface GarmentExtractionCaseResult {
  fixtureId: string;
  degraded: boolean;
  expectedCount: number;
  matchedCount: number;
  actual: GarmentOperationProposal[];
  promptChars: number;
}

export async function runGarmentExtractionFixture(
  fixture: GarmentExtractionFixture,
  sink?: DiagnosticSink,
): Promise<GarmentExtractionCaseResult> {
  const context: ChatExtractorContext = {
    characterName: CHARACTER_NAME,
    playerName: PLAYER_NAME,
    exchange: fixture.exchange,
    garmentHandles: extractionHandles(fixture),
  };
  const system = buildChatExtractorSystem("continuity", context);
  const prompt = buildChatExtractorPrompt("continuity", context);
  const result = await generateChecked({
    schema: chatContinuitySchema,
    system,
    prompt,
    modelId: agentModelId(),
    temperature: 0,
    maxOutputTokens: 4_000,
    code: "eval.garment_cues.extraction",
    disableReasoning: true,
    lowLatencyRouting: true,
    repair: false,
    ...(sink ? { sink } : {}),
  });
  const actual = result.degraded || result.value === null ? [] : [...result.value.garmentOperations];
  const matchedCount = fixture.expected.filter((expected) => extractionExpectationMatches(actual, expected)).length;
  return {
    fixtureId: fixture.id,
    degraded: result.degraded || result.value === null,
    expectedCount: fixture.expected.length,
    matchedCount,
    actual,
    promptChars: system.length + prompt.length,
  };
}

export function extractionAccuracy(results: readonly GarmentExtractionCaseResult[]): number {
  const expected = results.reduce((sum, result) => sum + result.expectedCount, 0);
  const matched = results.reduce((sum, result) => sum + result.matchedCount, 0);
  return expected === 0 ? 1 : matched / expected;
}
