#!/usr/bin/env node
// The documentation gate: `pnpm lint:docs`.
//
// Three checks over the repository's Markdown, each the executable form of a
// rule the `vesper-docs` skill states in prose:
//
//   1. LINKS — every relative `.md` link in `docs/**/*.md` resolves to a file.
//   2. SECTIONS — every `<file>.md §<Heading>` citation in `docs/` names a
//      heading that file actually has. A link proves only that the file
//      exists, which is exactly how a citation survives the section it names
//      moving to a sibling page. A cited heading has no closing delimiter in
//      prose, so the cited text runs to the first `)`, `.`, `,`, `;`, `:` or
//      backtick, and matches a heading that is a prefix of it, or it of a
//      heading with any parenthetical dropped.
//   3. RETIRED — no reference to a retired working document survives in
//      `apps`, `packages`, `scripts` or `docs`, in any form. `docs/README.md`
//      owns the rule; this is its enforcement. A hit is a `<name>.{plan,spec,
//      trial,audit,deferred,research,followups}.md` name, allowed only when it
//      names a file that exists under `docs/`, or a bare `§N` section number,
//      allowed only when the same line names a still-existing document under
//      `docs/` that has a numbered section N, or the hit sits inside a doc
//      citing its own numbered section N.
//
// Zero dependencies on purpose: the CI job that runs this checks out the tree
// and calls `node scripts/check-docs.mjs` without pnpm, setup-node or an
// install, because job setup is the dominant billed cost of a short CodeBuild
// gate. Keep it that way — Node built-ins only.
//
// Usage: node scripts/check-docs.mjs [--root <repo>]
// Prints one line per finding naming the file and the target, then a summary;
// exits 1 when anything is wrong.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RETIRED_SCAN_DIRS = ["apps", "packages", "scripts", "docs"];
const SKIP_DIRS = new Set([".git", "node_modules", ".next", "dist", "build", "coverage"]);
const LINK_PATTERN = /\]\(([^)#]+\.md)(?:#[^)]*)?\)/g;
const CITATION_PATTERN = /([\w./-]+\.md)[`)]* §([^).,;:`]+)/g;
const RETIRED_PATTERN = /([a-z0-9-]+\.(?:plan|spec|trial|audit|deferred|research|followups)\.md)|§([0-9]+)/g;
const MD_TOKEN_PATTERN = /[\w./-]+\.md\b/g;
const PATH_TOKEN_CHAR = /[\w./-]/;

/** Repo-relative path with forward slashes, for output that reads the same on every OS. */
function display(root, file) {
  return path.relative(root, file).split(path.sep).join("/");
}

function isFile(candidate) {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function walk(dir, accept, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(full, accept, out);
    } else if (entry.isFile() && accept(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function isUnder(dir, file) {
  const rel = path.relative(dir, file);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Heading inventory of one Markdown file: every line starting with `#`,
 * whitespace collapsed, `#` and spaces trimmed from both ends, paired with the
 * same heading minus any trailing parenthetical.
 */
function readHeadings(file, cache) {
  let headings = cache.get(file);
  if (!headings) {
    headings = readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => line.startsWith("#"))
      .map((line) => line.replace(/\s+/g, " ").replace(/^[# ]+|[# ]+$/g, ""))
      .map((heading) => ({ heading, base: heading.replace(/\s*\(.*/, "") }));
    cache.set(file, headings);
  }
  return headings;
}

function hasNumberedSection(file, number, cache) {
  return readHeadings(file, cache).some(({ heading }) => {
    const match = /^(\d+)(?:[.\s]|$)/.exec(heading);
    return match !== null && Number(match[1]) === number;
  });
}

function checkLinks(root, docFiles) {
  const findings = [];
  for (const file of docFiles) {
    const dir = path.dirname(file);
    for (const match of readFileSync(file, "utf8").matchAll(LINK_PATTERN)) {
      const target = match[1];
      if (target.startsWith("http")) continue;
      if (!existsSync(path.normalize(path.join(dir, target)))) {
        findings.push({ check: "BROKEN LINK", file: display(root, file), target });
      }
    }
  }
  return findings;
}

function checkSectionCitations(root, docFiles, headingCache) {
  const findings = [];
  for (const file of docFiles) {
    const text = readFileSync(file, "utf8").replace(/\s+/g, " ");
    for (const match of text.matchAll(CITATION_PATTERN)) {
      const target = match[1];
      const section = match[2].trim();
      const cited = [path.normalize(path.join(path.dirname(file), target)), path.join(root, target)].find(isFile);
      if (!section || cited === undefined) continue;
      const known = readHeadings(cited, headingCache).some(
        ({ heading, base }) => heading.startsWith(section) || section.startsWith(base),
      );
      if (!known) {
        findings.push({ check: "NO SECTION", file: display(root, file), target: `${target} §${section}` });
      }
    }
  }
  return findings;
}

/**
 * Resolve a document named in prose to a file under `docs/`: relative to the
 * naming file, to the repository root, or to `docs/` itself; a bare basename
 * may also name a file anywhere under `docs/`. Returns null when it names
 * nothing a reader can open.
 */
function resolveNamedDoc(root, docsDir, fromFile, token, docsByBasename) {
  const candidates = [path.join(path.dirname(fromFile), token), path.join(root, token), path.join(docsDir, token)];
  for (const candidate of candidates) {
    const normalized = path.normalize(candidate);
    if (isFile(normalized) && isUnder(docsDir, normalized)) return normalized;
  }
  if (!token.includes("/")) {
    const byName = docsByBasename.get(token);
    if (byName && byName.length > 0) return byName[0];
  }
  return null;
}

function pathTokenAround(line, start, end) {
  let from = start;
  while (from > 0 && PATH_TOKEN_CHAR.test(line[from - 1])) from -= 1;
  let to = end;
  while (to < line.length && PATH_TOKEN_CHAR.test(line[to])) to += 1;
  return line.slice(from, to);
}

function checkRetiredReferences(root, docsDir, docFiles, headingCache) {
  const findings = [];
  const docsByBasename = new Map();
  for (const file of docFiles) {
    const name = path.basename(file);
    docsByBasename.set(name, [...(docsByBasename.get(name) ?? []), file]);
  }
  const resolve = (fromFile, token) => resolveNamedDoc(root, docsDir, fromFile, token, docsByBasename);

  const scanFiles = RETIRED_SCAN_DIRS.flatMap((dir) => walk(path.join(root, dir), () => true));
  for (const file of scanFiles) {
    const content = readFileSync(file, "utf8");
    if (content.includes("\0")) continue; // binary, as git grep would skip it
    const lines = content.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const where = `${display(root, file)}:${index + 1}`;
      let namedDocs = null;
      for (const match of line.matchAll(RETIRED_PATTERN)) {
        if (match[1] !== undefined) {
          const token = pathTokenAround(line, match.index, match.index + match[0].length);
          if (resolve(file, token) === null) {
            findings.push({ check: "RETIRED DOCUMENT", file: where, target: token });
          }
          continue;
        }
        const number = Number(match[2]);
        namedDocs ??= [...line.matchAll(MD_TOKEN_PATTERN)].map((m) => resolve(file, m[0])).filter((d) => d !== null);
        const owned =
          namedDocs.some((doc) => hasNumberedSection(doc, number, headingCache)) ||
          (isUnder(docsDir, file) && hasNumberedSection(file, number, headingCache));
        if (!owned) {
          findings.push({
            check: "RETIRED SECTION",
            file: where,
            target: `§${number} (no document named on the line owns section ${number})`,
          });
        }
      }
    }
  }
  return findings;
}

/**
 * Run all three checks over the repository at `root`.
 * @returns {{ findings: Array<{check: string, file: string, target: string}>, docFiles: number }}
 */
export function checkDocs(root) {
  const docsDir = path.join(root, "docs");
  const docFiles = walk(docsDir, (name) => name.endsWith(".md"));
  const headingCache = new Map();
  const findings = [
    ...checkLinks(root, docFiles),
    ...checkSectionCitations(root, docFiles, headingCache),
    ...checkRetiredReferences(root, docsDir, docFiles, headingCache),
  ];
  return { findings, docFiles: docFiles.length };
}

function main(argv) {
  const rootFlag = argv.indexOf("--root");
  const root = path.resolve(rootFlag === -1 ? process.cwd() : argv[rootFlag + 1]);
  const { findings, docFiles } = checkDocs(root);
  for (const finding of findings) {
    console.log(`${finding.check} ${finding.file} -> ${finding.target}`);
  }
  const count = (check) => findings.filter((finding) => finding.check === check).length;
  const summary =
    `docs checks: ${docFiles} docs, ${count("BROKEN LINK")} broken links, ` +
    `${count("NO SECTION")} bad section citations, ` +
    `${count("RETIRED DOCUMENT") + count("RETIRED SECTION")} retired-document references`;
  if (findings.length > 0) {
    console.error(`FAIL ${summary}`);
    return 1;
  }
  console.log(`OK ${summary}`);
  return 0;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
