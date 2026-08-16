import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Tripwire: every `engine.spec §N` citation resolves to a section the spec
 * actually defines.
 *
 * The engine's normative contract lives in `docs/developer-notes/engine.spec*.md`
 * and is cited from source and from the reference docs by section number — 400+
 * times. Those citations are the reason the spec's numbering is documented as
 * global and never-renumbered, and the reason the spec stayed out of `finished/`
 * when the rest of its family was archived.
 *
 * Nothing enforced any of that. A renumbered heading, a deleted section, a
 * renamed cluster file, or a typo'd citation all failed silently and stayed
 * wrong until a human happened to follow the reference. This test is what turns
 * that promise into a gate.
 *
 * It is deliberately NOT a link checker. A `§N` citation is a plain-text
 * reference, not a path, which is what makes it survive the spec being moved or
 * split — so what needs asserting is that the *number* still means something.
 *
 * ## Resolution has two rules, and the second one matters
 *
 * A citation resolves when its number is a heading (`### 26.7 Item condition`),
 * OR when it indexes into a numbered list inside its parent heading. The second
 * rule is not a loophole — it is how the spec is written. §3.1 is a heading
 * holding eight numbered invariants, and `docs/engine/kernel.md` cites §3.1.4 to
 * mean the fourth of them. That is a more precise citation than §3.1 would be,
 * and it stays checkable: dropping an invariant from the list breaks it.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Directories scanned for citations. Anything that cites the contract belongs here. */
const CITING_ROOTS = ["apps/web/src", "packages", "scripts", "docs/engine"] as const;
const CITING_EXTENSIONS = [".ts", ".tsx", ".md"] as const;

/**
 * A citation is `engine.spec` followed by one or more `§N` tokens, which may be
 * comma-joined and may be ranges (`§15.1–15.2`, `§10.2–§10.3`). Every number in
 * that run is checked, range endpoints included — a range whose end vanished is
 * as broken as a missing single section.
 */
const CITATION = /engine\.spec\s*((?:§\s*\d[\d.]*)(?:\s*[–—-]\s*§?\s*\d[\d.]*)?(?:\s*,\s*§\s*\d[\d.]*(?:\s*[–—-]\s*§?\s*\d[\d.]*)?)*)/g;
const SECTION_NUMBER = /\d+(?:\.\d+)*/g;
/** `## 12.` / `### 26.7 Item condition` — the spec's heading form. */
const SECTION_HEADING = /^#{2,4}\s+(\d+(?:\.\d+)*)[.\s]/gm;
/** A top-level ordered-list item, which is what a depth-3 citation indexes into. */
const ORDERED_ITEM = /^(\d+)\.\s/gm;

interface SpecSection {
  /** The cluster file that owns it, for the failure message. */
  file: string;
  /** Text between this heading and the next, used to count numbered items. */
  body: string;
}

function walk(dir: string): string[] {
  const absolute = path.join(repoRoot, dir);
  let entries: string[];
  try {
    entries = readdirSync(absolute);
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const entry of entries) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
    const child = path.join(dir, entry);
    if (statSync(path.join(repoRoot, child)).isDirectory()) {
      found.push(...walk(child));
    } else if (CITING_EXTENSIONS.some((extension) => entry.endsWith(extension))) {
      found.push(child);
    }
  }
  return found;
}

function readSpecSections(): Map<string, SpecSection> {
  const specDir = "docs/developer-notes";
  const files = readdirSync(path.join(repoRoot, specDir))
    .filter((name) => name.startsWith("engine.spec") && name.endsWith(".md"))
    .sort();
  const sections = new Map<string, SpecSection>();
  for (const file of files) {
    const text = readFileSync(path.join(repoRoot, specDir, file), "utf8");
    const headings = [...text.matchAll(SECTION_HEADING)];
    for (const [index, heading] of headings.entries()) {
      const number = heading[1];
      if (number === undefined) continue;
      const start = heading.index + heading[0].length;
      const end = headings[index + 1]?.index ?? text.length;
      sections.set(number, { file, body: text.slice(start, end) });
    }
  }
  return sections;
}

function resolves(number: string, sections: Map<string, SpecSection>): boolean {
  if (sections.has(number)) return true;
  const split = number.lastIndexOf(".");
  if (split === -1) return false;
  const parent = sections.get(number.slice(0, split));
  if (!parent) return false;
  const item = Number(number.slice(split + 1));
  if (!Number.isInteger(item) || item < 1) return false;
  return item <= [...parent.body.matchAll(ORDERED_ITEM)].length;
}

interface Citation {
  number: string;
  source: string;
}

function readCitations(): Citation[] {
  const citations: Citation[] = [];
  for (const root of CITING_ROOTS) {
    for (const file of walk(root)) {
      const text = readFileSync(path.join(repoRoot, file), "utf8");
      for (const match of text.matchAll(CITATION)) {
        const run = match[1];
        if (run === undefined) continue;
        for (const number of run.matchAll(SECTION_NUMBER)) {
          citations.push({ number: number[0].replace(/\.$/, ""), source: file });
        }
      }
    }
  }
  return citations;
}

describe("engine.spec § citations", () => {
  const sections = readSpecSections();
  const citations = readCitations();

  it("the spec cluster is where the § index says it is", () => {
    // If the spec is moved or renamed, every assertion below would pass vacuously
    // on an empty section map. Fail loudly here instead.
    expect(sections.size).toBeGreaterThan(100);
    expect(sections.has("1")).toBe(true);
  });

  it("finds citations to check — an extractor that matches nothing proves nothing", () => {
    expect(citations.length).toBeGreaterThan(300);
  });

  it("every cited section exists in the spec", () => {
    const unresolved = citations.filter((citation) => !resolves(citation.number, sections));
    // Group by section so a renumbered heading reports once with its callers.
    const report = [...new Map(unresolved.map((c) => [c.number, c])).values()]
      .map((c) => {
        const callers = unresolved.filter((other) => other.number === c.number).length;
        return `  §${c.number} — ${callers} citation(s), e.g. ${c.source}`;
      })
      .join("\n");
    expect(report, `engine.spec citations that no longer resolve:\n${report}`).toBe("");
  });
});
