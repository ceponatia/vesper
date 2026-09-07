import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { repoRelative, sourceFilesUnder, stripComments } from "@/server/test-support";

/**
 * The Prompt Lab is narrator-only — product law from the plan's §Agent
 * isolation, restated in the spec's Ownership rules: the resolved
 * `NarratorInstructionSource` reaches the four prose-narrator paths (legacy
 * 1:1/ensemble, successor co-present/solo) and NOTHING else. Not the reaction
 * pulse, memory extraction, the archivist, visual extraction, the
 * physical/contact or permission classifiers, the scene composer, meanwhile
 * agents, or the successor deliberator — helpers produce structured state, and
 * an owner's handwritten craft prose leaking into a classifier prompt would
 * corrupt extraction for a conversation precisely while it is being measured.
 *
 * No other gate sees this: tsc happily accepts a new `instructionSource`
 * parameter on a helper builder, and no behavioral suite runs every helper under
 * an override. So this census does what `image-internal-callers.test.ts` does
 * for image writes, in two rings:
 *
 * 1. **File ring** — any server/API module that touches the instruction-source
 *    contract or imports the narrator-prompts service must be one of the
 *    reviewed consumers below. Wiring the override into a new module is allowed
 *    — by editing `APPROVED` in a diff a reviewer can see, with the reason
 *    beside it.
 * 2. **Use-site ring** — approving a file is not approving every future use
 *    inside it. The exchange pipelines are exactly where the resolved source
 *    and the helper calls legitimately coexist, so a leak there (say,
 *    `instructionSource` slipped into the memory scribe's input object) would
 *    never change the file census. `PINNED_USE_SITES` therefore pins every
 *    place the source surface is named inside each approved file — the
 *    normalized source line plus its enclosing named expression — so ANY new,
 *    moved, or reworded use fails until it is re-reviewed and re-pinned here.
 *
 * The use-site signatures deliberately carry no line numbers: line drift and
 * edits that do not name the source surface change nothing. What they do carry
 * is the consuming expression — the callee, assignment target, property key,
 * interface, or import that encloses the mention — so relocating a mention into
 * a different consumer (the leak shape) cannot masquerade as churn.
 *
 * Comment-stripped before matching, so prose mentioning the contract stays free.
 */

const ROOTS = [path.join(process.cwd(), "apps/web/src/server"), path.join(process.cwd(), "apps/web/src/app/api")];

/**
 * The resolved-source surface: the source type and its schema/constructors, the
 * one resolver, the field name that threads it through build inputs, and the
 * service barrel (CRUD + resolver — no helper agent has business with any of it).
 */
const SOURCE_TOKENS =
  /\b(?:NarratorInstructionSource|narratorInstructionSourceSchema|resolveNarratorInstructionSource|productionInstructionSource|isTestInstructionSource|instructionSource)\b|@\/server\/narrator-prompts/;

/** Reviewed 2026-08-29 (slice 7 hardening): every entry is a sanctioned consumer. */
const APPROVED: readonly string[] = [
  // The Prompt Lab's own admin routes — template CRUD, duplicate, failure
  // mapping, and the per-chat selection (all behind `withOwnerAdmin*`).
  "apps/web/src/app/api/admin/self/narrator-prompt/[chatId]/route.ts",
  "apps/web/src/app/api/admin/self/narrator-prompts/[promptId]/duplicate/route.ts",
  "apps/web/src/app/api/admin/self/narrator-prompts/[promptId]/route.ts",
  "apps/web/src/app/api/admin/self/narrator-prompts/failure.ts",
  "apps/web/src/app/api/admin/self/narrator-prompts/route.ts",
  // The two exchange pipelines: each resolves ONE source under its exchange
  // lock, threads the frozen value into the prose-narrator build, and stamps
  // take provenance from it. The separate admin preview shows the prose
  // narrator's own prompt; it is not a helper agent.
  "apps/web/src/server/engine/chat-pipeline.ts",
  "apps/web/src/server/engine/chat-prompt-preview.ts",
  // Shared reply provenance builder; it consumes only the frozen source passed
  // by a prose narrator lane and never resolves or forwards one to helper agents.
  "apps/web/src/server/engine/chat-reply-store.ts",
  "apps/web/src/server/engine/sim-exchange/context.ts",
  "apps/web/src/server/engine/sim-exchange/dialogue.ts",
  "apps/web/src/server/engine/sim-exchange/solo.ts",
  "apps/web/src/server/engine/sim-exchange/retake.ts",
  // The successor render loop — rebuilds every hidden retry from the SAME
  // frozen source carried on its context, and records the revision it used.
  "apps/web/src/server/engine/sim-narrator.ts",
  // The four prose-narrator prompt builders and their shared classified charter.
  "apps/web/src/server/engine/prompts/character-chat/ensemble.ts",
  "apps/web/src/server/engine/prompts/character-chat/single.ts",
  "apps/web/src/server/engine/prompts/character-chat/types.ts",
  "apps/web/src/server/engine/prompts/charter.ts",
  "apps/web/src/server/engine/prompts/sim-render.ts",
  "apps/web/src/server/engine/prompts/sim-solo-render.ts",
  // The owner: selection storage and the never-throws resolution.
  "apps/web/src/server/narrator-prompts/selection.ts",
];

/* ------------------------------------------------------------------------ *
 * Use-site extraction.                                                      *
 *                                                                           *
 * Same species as the `@/server/test-support` scanners: text, not AST —     *
 * parse just enough that a signature names the consuming expression and     *
 * nothing else. A signature is                                              *
 *                                                                           *
 *   [outer head > ] [inner head :: ] <normalized token-bearing line>        *
 *                                                                           *
 * where a head is the prefix (through the opening delimiter) of an          *
 * enclosing NAMED construct on an earlier line — a call, an assignment, a   *
 * property key, an interface, an import. Anonymous and control-flow blocks  *
 * (`if`, `try`, bare braces, arrow bodies) contribute nothing, so wrapping  *
 * a region or reflowing unrelated code cannot move a signature.             *
 * ------------------------------------------------------------------------ */

/** Collapse a source slice to one whitespace-normalized line. */
const singleLine = (text: string): string => text.replace(/\s+/g, " ").trim();

/** A trailing word that makes a following `/` a regex, never division. */
const REGEX_PRECEDING_KEYWORDS = new Set(["return", "typeof", "case", "in", "of", "do", "else", "void", "delete", "instanceof", "yield"]);

/** Trailing identifiers that mean "not a named call" before a `(`. */
const NON_CALL_KEYWORDS = new Set(["if", "for", "while", "switch", "catch", "return", "await", "async", "typeof", "void", "delete", "do", "else", "yield", "function"]);

/**
 * Blank the contents of string and regex literals (delimiters may go too;
 * offsets and newlines are preserved) so the delimiter scan below cannot be
 * unbalanced by a paren or bracket inside prose or a pattern. Comments are
 * expected to be gone already (`stripComments`). The regex detector is the
 * standard conservative lexing heuristic — a `/` after an operator, opener, or
 * keyword position, closing on the same line — and a candidate that never
 * closes is left alone as division.
 */
function blankLiterals(stripped: string): string {
  const out = stripped.split("");
  let quote = "";
  for (let i = 0; i < out.length; i += 1) {
    const c = out[i] ?? "";
    if (quote !== "") {
      if (c === "\\") {
        out[i] = " ";
        if (out[i + 1] !== undefined && out[i + 1] !== "\n") out[i + 1] = " ";
        i += 1;
      } else if (c === quote) {
        quote = "";
      } else if (c !== "\n") {
        out[i] = " ";
      }
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      continue;
    }
    if (c !== "/") continue;
    // Regex or division? Inspect what the code before it ends with.
    let back = i - 1;
    while (back >= 0 && /\s/.test(out[back] ?? "")) back -= 1;
    const before = out.slice(Math.max(0, back - 11), back + 1).join("");
    const word = /([A-Za-z_$][\w$]*)$/.exec(before)?.[1];
    const afterOperator = back < 0 || /[(,=:[!&|?{};><+\-*%^~]/.test(out[back] ?? "");
    if (!afterOperator && (word === undefined || !REGEX_PRECEDING_KEYWORDS.has(word))) continue;
    // Candidate regex: find the unescaped, un-classed closing `/` on this line.
    let cls = false;
    let end = -1;
    for (let j = i + 1; j < out.length && out[j] !== "\n"; j += 1) {
      const r = out[j] ?? "";
      if (r === "\\") j += 1;
      else if (r === "[") cls = true;
      else if (r === "]") cls = false;
      else if (r === "/" && !cls) {
        end = j;
        break;
      }
    }
    if (end === -1) continue; // never closed — division after all
    for (let j = i; j <= end; j += 1) out[j] = " ";
    i = end;
  }
  return out.join("");
}

/** Is the enclosing opener at the end of `pre` (blanked text) a named construct worth a head? */
function informativeHead(opener: string, pre: string): boolean {
  const head = pre.trimEnd();
  if (opener === "(") {
    const callee = /([A-Za-z_$][\w$]*)$/.exec(head)?.[1];
    return callee !== undefined && !NON_CALL_KEYWORDS.has(callee);
  }
  // `{` and `[`: a property key or type-literal slot, an assignment or type
  // alias, a returned literal, an import/export specifier block, or a named
  // type container. Function bodies, control blocks, arrow bodies, and
  // destructuring patterns all fail every test here — deliberately.
  return (
    /[:=]$/.test(head) ||
    /\breturn$/.test(head) ||
    /\b(?:import|export)$/.test(head) ||
    /\b(?:interface|enum|namespace)\b[^;{}()]*$/.test(head)
  );
}

/**
 * Up to the two innermost named constructs enclosing `offset`, outermost first.
 * A balanced backward scan over literal-blanked text: closers push, openers pop,
 * and an unmatched opener is an enclosing construct. Openers on the token's own
 * line add nothing (the pinned line already shows them).
 */
function enclosingHeads(
  blanked: string,
  blankedLines: readonly string[],
  strippedLines: readonly string[],
  lineStarts: readonly number[],
  tokenLine: number,
  offset: number,
): string[] {
  let paren = 0;
  let brace = 0;
  let bracket = 0;
  const heads: string[] = [];
  const usedLines = new Set<number>([tokenLine]);
  let line = tokenLine;
  for (let i = offset - 1; i >= 0; i -= 1) {
    const c = blanked[i] ?? "";
    if (c === "\n") {
      line -= 1;
      continue;
    }
    if (c === ")") paren += 1;
    else if (c === "}") brace += 1;
    else if (c === "]") bracket += 1;
    else if (c === "(" || c === "{" || c === "[") {
      const depth = c === "(" ? paren : c === "{" ? brace : bracket;
      if (depth > 0) {
        if (c === "(") paren -= 1;
        else if (c === "{") brace -= 1;
        else bracket -= 1;
        continue;
      }
      if (usedLines.has(line)) continue;
      const column = i - (lineStarts[line] ?? 0);
      if (!informativeHead(c, (blankedLines[line] ?? "").slice(0, column))) continue;
      usedLines.add(line);
      heads.unshift(singleLine((strippedLines[line] ?? "").slice(0, column + 1)));
      if (heads.length === 2) break;
    }
  }
  return heads;
}

/**
 * The sorted multiset of use-site signatures in one comment-stripped file: one
 * signature per line that names the resolved-source surface. Sorted with
 * duplicates kept, so even a mention moved between two identically-spelled
 * homes changes the census.
 */
function collectSiteSignatures(stripped: string): string[] {
  const blanked = blankLiterals(stripped);
  const strippedLines = stripped.split("\n");
  const blankedLines = blanked.split("\n");
  const lineStarts: number[] = [];
  let cursor = 0;
  for (const lineText of blankedLines) {
    lineStarts.push(cursor);
    cursor += lineText.length + 1;
  }
  const signatures: string[] = [];
  for (let line = 0; line < strippedLines.length; line += 1) {
    const text = strippedLines[line] ?? "";
    const at = text.search(SOURCE_TOKENS);
    if (at === -1) continue;
    const heads = enclosingHeads(blanked, blankedLines, strippedLines, lineStarts, line, (lineStarts[line] ?? 0) + at);
    const site = singleLine(text);
    signatures.push(heads.length === 0 ? site : `${heads.join(" > ")} :: ${site}`);
  }
  return signatures.sort();
}

/**
 * Reviewed 2026-08-29 (slice 7 hardening, use-site ring): every signature is a
 * sanctioned consuming expression — the resolver call, the frozen value riding
 * an exchange context, a prose-narrator build input, provenance stamping, the
 * builders' own render-mode reads, or the service/contract plumbing. To change
 * this list, first re-review the new or moved site against the isolation law in
 * the header — in particular that the source still feeds no helper agent — then
 * pin it here with the diff telling the story.
 */
const PINNED_USE_SITES: Readonly<Record<string, readonly string[]>> = {
  "apps/web/src/app/api/admin/self/narrator-prompt/[chatId]/route.ts": [
    'import { getChatNarratorPromptSelection, setChatNarratorPromptSelection } from "@/server/narrator-prompts";',
  ],
  "apps/web/src/app/api/admin/self/narrator-prompts/[promptId]/duplicate/route.ts": [
    'import { duplicateNarratorPromptTemplate, getNarratorPromptTemplate } from "@/server/narrator-prompts";',
  ],
  "apps/web/src/app/api/admin/self/narrator-prompts/[promptId]/route.ts": ['} from "@/server/narrator-prompts";'],
  "apps/web/src/app/api/admin/self/narrator-prompts/failure.ts": [
    'import type { NarratorPromptRefusal } from "@/server/narrator-prompts";',
  ],
  "apps/web/src/app/api/admin/self/narrator-prompts/route.ts": [
    'import { createNarratorPromptTemplate, listNarratorPromptTemplates } from "@/server/narrator-prompts";',
  ],
  "apps/web/src/server/engine/chat-pipeline.ts": [
    // The exchange resolves one frozen source.
    "const instructionSource = await resolveNarratorInstructionSource(owner, chatId, sink);",
    // Take provenance for the legacy lane.
    "const narratorRun = buildNarratorRunProvenance( :: source: instructionSource,",
    // The exchange's prose-narrator build inputs (1:1 + ensemble).
    "const promptInput: CharacterChatPromptInput = { :: instructionSource,",
    "ensembleExtras = { :: instructionSource,",
    'import { resolveNarratorInstructionSource } from "@/server/narrator-prompts";',
  ],
  "apps/web/src/server/engine/chat-prompt-preview.ts": [
    "const instructionSource = await resolveNarratorInstructionSource(",
    "const parts = buildCharacterChatPromptParts( :: instructionSource,",
    'import { resolveNarratorInstructionSource } from "@/server/narrator-prompts";',
  ],
  "apps/web/src/server/engine/chat-reply-store.ts": [
    "export function buildNarratorRunProvenance(args: { :: source: NarratorInstructionSource | undefined;",
    "import { :: type NarratorInstructionSource,",
  ],
  "apps/web/src/server/engine/sim-exchange/context.ts": [
    "const instructionSource = await resolveNarratorInstructionSource(ownerId, chatId, instructions);",
    "export interface ResolvedSimExchange { :: instructionSource: NarratorInstructionSource;",
    'import type { NarratorInstructionSource } from "@/contracts/narrator-prompts";',
    'import { resolveNarratorInstructionSource } from "@/server/narrator-prompts";',
    "return { > ctx: { :: instructionSource,",
  ],
  "apps/web/src/server/engine/sim-exchange/dialogue.ts": [
    "const rendered = await renderCommittedCut( > conversation: { :: instructionSource: ctx.instructionSource,",
  ],
  "apps/web/src/server/engine/sim-exchange/retake.ts": [
    "const rendered = await renderCommittedCut( > conversation: { :: instructionSource: ctx.instructionSource,",
  ],
  "apps/web/src/server/engine/sim-exchange/solo.ts": [
    "const narratorRun = buildNarratorRunProvenance( :: source: ctx.instructionSource,",
    "const soloRenderContext: SimSoloRenderContext = { :: instructionSource: ctx.instructionSource,",
  ],
  "apps/web/src/server/engine/sim-narrator.ts": [
    // Provenance for the accepted successor attempt, from the context's frozen source.
    "return { > provenance: buildNarratorRunProvenance( :: source: context.instructionSource,",
  ],
  "apps/web/src/server/engine/prompts/character-chat/ensemble.ts": [
    "const mode = narratorRenderMode(extras.instructionSource ?? input.instructionSource);",
  ],
  "apps/web/src/server/engine/prompts/character-chat/single.ts": [
    "const mode = narratorRenderMode(input.instructionSource);",
  ],
  "apps/web/src/server/engine/prompts/character-chat/types.ts": [
    "export interface CharacterChatPromptInput { :: instructionSource?: NarratorInstructionSource;",
    "export interface EnsemblePromptExtras { :: instructionSource?: NarratorInstructionSource;",
    'import type { NarratorInstructionSource, NarratorPromptNode } from "@/contracts/narrator-prompts";',
  ],
  "apps/web/src/server/engine/prompts/charter.ts": [
    "export function narratorRenderMode(source: NarratorInstructionSource | undefined): NarratorPromptRenderMode {",
    "import { :: type NarratorInstructionSource,",
  ],
  "apps/web/src/server/engine/prompts/sim-render.ts": [
    "const prompt = renderNarratorPrompt( :: narratorRenderMode(context.instructionSource),",
    "export interface SimRenderContext { :: instructionSource?: NarratorInstructionSource;",
    "import { :: type NarratorInstructionSource,",
  ],
  "apps/web/src/server/engine/prompts/sim-solo-render.ts": [
    "const prompt = renderNarratorPrompt( :: narratorRenderMode(context.instructionSource),",
  ],
  "apps/web/src/server/narrator-prompts/selection.ts": [
    "): NarratorInstructionSource {",
    "): Promise<NarratorInstructionSource> {",
    "export async function resolveNarratorInstructionSource(",
    "if (!row || row.promptId === null) return productionInstructionSource();",
    "import { :: productionInstructionSource,",
    "import { :: type NarratorInstructionSource,",
    "return productionInstructionSource();",
    "return productionInstructionSource();",
  ],
};

describe("narrator instruction-source consumer census", () => {
  it("contains only the reviewed prose-narrator consumers — helper agents stay on their own prompts", () => {
    const actual: string[] = [];
    for (const absolute of ROOTS.flatMap((root) => sourceFilesUnder(root))) {
      if (SOURCE_TOKENS.test(stripComments(fs.readFileSync(absolute, "utf8")))) actual.push(repoRelative(absolute));
    }
    expect(actual.sort()).toEqual([...APPROVED].sort());
  });

  it("matches the pinned use sites inside every approved file — a new use of the resolved source means re-reviewing isolation", () => {
    expect(
      Object.keys(PINNED_USE_SITES).sort(),
      "PINNED_USE_SITES must pin exactly the APPROVED files: approving a file is not approving every future use inside it",
    ).toEqual([...APPROVED].sort());
    for (const file of APPROVED) {
      const stripped = stripComments(fs.readFileSync(path.join(process.cwd(), file), "utf8"));
      expect(
        collectSiteSignatures(stripped),
        `the narrator instruction-source use sites in ${file} changed. Every mention of the resolved source is pinned by its consuming expression; re-review the new or moved site against the isolation law in this test's header — above all, that the source feeds NO helper agent (pulse, extractors, archivist, classifiers, composer, meanwhile, deliberator) — then update PINNED_USE_SITES for this file`,
      ).toEqual([...(PINNED_USE_SITES[file] ?? [])]);
    }
  });
});
