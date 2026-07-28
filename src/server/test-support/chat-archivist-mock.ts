import {
  degradedChatArchivist,
  type ChatArchivist,
  type ChatExtractionLegs,
  type RetrievedMemoryDetail,
} from "@/contracts/turns/chat-archivist";
import type { GarmentOperationProposal } from "@/contracts/turns/chat-garment-ops";

/**
 * The `vi.mock("./chat-memory")` factory the chat-lane integration suites share.
 *
 * Five suites carried a byte-identical (or near-identical) hoisted mock block:
 * `runChatExtraction` resolving a hoisted archivist result and `writeChatMemory`
 * resolving void. They mock at the MERGE seam on purpose — that keeps each suite
 * about the fold under test (wardrobe, garment ops, cue memory, per-leg
 * degradation) rather than about leg composition, and `AI_FAKE=1` alone would
 * degrade every leg and prove nothing.
 *
 * ## Adoption shape (the vi.mock hoisting constraint)
 *
 * A `vi.mock` factory is hoisted ABOVE the file's imports, so it cannot reference
 * a top-level import — `chatMemoryMockModule` has to be reached through a dynamic
 * import inside the factory. The mutable state has to come from `vi.hoisted`,
 * which is hoisted too, so it stays an inline object literal:
 *
 * ```ts
 * const mock = vi.hoisted(() => ({ archivist: { value: null as ChatArchivist | null, degraded: false } }));
 *
 * vi.mock("./chat-memory", async () => {
 *   const { chatMemoryMockModule } = await import("../test-support/chat-archivist-mock");
 *   return chatMemoryMockModule(mock);
 * });
 * ```
 *
 * Two things about that import specifier:
 *
 * - `"./chat-memory"` resolves relative to the TEST file (which lives in
 *   `src/server/engine/`), so the mocked module id is unchanged by moving the
 *   factory body here — this helper only supplies the factory's RETURN value.
 * - the helper is imported by RELATIVE path. `@/server/test-support/…` is a
 *   banned deep alias import (eslint `no-restricted-imports`), and the barrel
 *   (`@/server/test-support`) also works if the module is exported from it.
 *
 * The factory closes over `state` and reads it lazily on every call, so a test
 * body reassigning `mock.archivist` between exchanges takes effect immediately.
 */

/** Every leg healthy — what a suite that isn't testing degradation wants. */
export const HEALTHY_EXTRACTION_LEGS: ChatExtractionLegs = {
  memory: false,
  continuity: false,
  character: false,
};

/** Every leg down — the pre-split whole-archivist degrade. */
export const DEGRADED_EXTRACTION_LEGS: ChatExtractionLegs = {
  memory: true,
  continuity: true,
  character: true,
};

/**
 * The hoisted state the mocked module reads. Only `archivist` is required, so an
 * existing suite's `vi.hoisted` literal keeps working verbatim.
 */
export interface ChatMemoryMockState {
  /** What `runChatExtraction` resolves as its merged aggregate. */
  archivist: { value: ChatArchivist | null; degraded: boolean };
  /** Per-leg degradation flags; default `HEALTHY_EXTRACTION_LEGS`. */
  legs?: ChatExtractionLegs;
  /** True ⇒ `writeChatMemory` rejects, standing in for a down memory database. */
  writeThrows?: boolean;
}

/** A fresh default state, for suites that can afford `await vi.hoisted(async …)`. */
export function chatMemoryMockState(): ChatMemoryMockState {
  return { archivist: { value: null, degraded: false }, legs: { ...HEALTHY_EXTRACTION_LEGS }, writeThrows: false };
}

export interface ChatMemoryMockModule {
  runChatExtraction: () => Promise<{ value: ChatArchivist | null; degraded: boolean; legs: ChatExtractionLegs }>;
  writeChatMemory: () => Promise<void>;
  retrieveChatMemory: () => Promise<{ facts: string[]; episodes: string[]; detail: RetrievedMemoryDetail[] }>;
}

/**
 * Build the mocked `./chat-memory` module surface.
 *
 * `retrieveChatMemory` is included (returning nothing recalled) because any
 * suite that reaches the prompt preview pulls `chat-pipeline`, which imports it;
 * suites that never call it are unaffected by its presence. The rest of the real
 * module's exports are deliberately NOT stubbed — a suite that starts needing
 * one should say so explicitly rather than inherit a silent fake.
 */
export function chatMemoryMockModule(state: ChatMemoryMockState): ChatMemoryMockModule {
  return {
    runChatExtraction: () =>
      Promise.resolve({
        value: state.archivist.value,
        degraded: state.archivist.degraded,
        legs: state.legs ?? HEALTHY_EXTRACTION_LEGS,
      }),
    writeChatMemory: () =>
      state.writeThrows === true ? Promise.reject(new Error("memory infra down")) : Promise.resolve(),
    retrieveChatMemory: () => Promise.resolve({ facts: [], episodes: [], detail: [] }),
  };
}

// ---------------------------------------------------------------------------
// Archivist shapers (ordinary imports — used in test bodies, not in the factory)
// ---------------------------------------------------------------------------

/** A full archivist result: degraded defaults with the given fields replaced. */
export function chatArchivist(overrides: Partial<ChatArchivist> = {}): ChatArchivist {
  return { ...degradedChatArchivist(), ...overrides };
}

/**
 * An archivist whose OUTFIT field carries the given free-text proposal — the
 * legacy (pre-garment-graph) continuity grammar the name-matching bridge folds.
 */
export function withOutfit(outfit: Partial<ChatArchivist["outfit"]>): ChatArchivist {
  return chatArchivist({ outfit: { description: "", exposed: false, removed: [], added: [], ...outfit } });
}

/** An archivist whose continuity leg returned exactly these typed garment operations. */
export function withOps(proposals: readonly GarmentOperationProposal[]): ChatArchivist {
  return chatArchivist({ garmentOperations: [...proposals] });
}
