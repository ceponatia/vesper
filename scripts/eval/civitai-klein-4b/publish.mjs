#!/usr/bin/env node
/**
 * Build a self-contained, shareable web bundle of the evaluation under
 * eval-images/civitai-klein-4b/web/: contact sheets re-encoded as JPEG, the
 * delivered images, the markdown docs, and an index.html of direct links
 * grouped by gate. Nothing is uploaded here; the script prints the `aws s3
 * sync` command for the owner's public bucket under an unguessable prefix.
 *
 *   node scripts/eval/civitai-klein-4b/publish.mjs [--include-adult] [--prefix <name>]
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import sharp from "sharp";
import { createAdultClassifier } from "./lib/adult.mjs";
import { DEFAULT_OUT_DIR } from "./lib/env.mjs";

const args = process.argv.slice(2);
const includeAdult = args.includes("--include-adult");
const prefixArg = args.includes("--prefix") ? args[args.indexOf("--prefix") + 1] : null;
const outDir = DEFAULT_OUT_DIR;
const webDir = path.join(outDir, "web");

const { render: renderIsAdult, sheet: sheetIsAdult, unclassified } = createAdultClassifier(outDir);

// ---- classify everything first: the bundle is only rebuilt once it is safe to.
const sheetFiles = readdirSync(path.join(outDir, "contact-sheets")).filter((f) => f.endsWith(".png")).sort();
const sheetPlan = sheetFiles.map((file) => ({ file, name: file.replace(/\.png$/, ""), adult: sheetIsAdult(file.replace(/\.png$/, "")) }));
const imagePlan = [];
for (const phase of readdirSync(path.join(outDir, "images")).sort()) {
  const dir = path.join(outDir, "images", phase);
  if (!statSync(dir).isDirectory()) continue;
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".jpg")).sort()) imagePlan.push({ phase, file, adult: renderIsAdult(phase, file) });
}
if (!includeAdult && unclassified.length > 0) {
  process.stderr.write(
    `refusing to build the adult-excluded bundle: ${unclassified.length} item(s) could not be classified\n` +
      unclassified.map((line) => `  ${line}\n`).join("") +
      "Declare the arm in its manifest (or the manifest's \"adult\" flag), or rebuild with --include-adult.\n",
  );
  process.exit(1);
}

// ---- rebuild from empty: a previous --include-adult bundle must not survive
// into a default one, because `aws s3 sync` would upload the leftovers under a
// page that says adult arms were excluded.
rmSync(webDir, { recursive: true, force: true });
mkdirSync(path.join(webDir, "sheets"), { recursive: true });
mkdirSync(path.join(webDir, "images"), { recursive: true });

const sheets = [];
let excluded = 0;
for (const entry of sheetPlan) {
  if (!includeAdult && entry.adult !== false) { excluded += 1; continue; }
  const specFile = path.join(outDir, "contact-sheets", "specs", `${entry.name}.json`);
  const title = existsSync(specFile) ? JSON.parse(readFileSync(specFile, "utf8")).title ?? entry.file : entry.file;
  const target = path.join(webDir, "sheets", `${entry.name}.jpg`);
  await sharp(path.join(outDir, "contact-sheets", entry.file)).jpeg({ quality: 85, mozjpeg: true }).toFile(target);
  sheets.push({ name: entry.name, file: `sheets/${path.basename(target)}`, title, bytes: statSync(target).size });
}

const images = [];
for (const entry of imagePlan) {
  if (!includeAdult && entry.adult !== false) { excluded += 1; continue; }
  mkdirSync(path.join(webDir, "images", entry.phase), { recursive: true });
  copyFileSync(path.join(outDir, "images", entry.phase, entry.file), path.join(webDir, "images", entry.phase, entry.file));
  images.push({ phase: entry.phase, file: `images/${entry.phase}/${entry.file}` });
}

for (const doc of ["RESULTS.md", "ledger.md"]) if (existsSync(path.join(outDir, doc))) copyFileSync(path.join(outDir, doc), path.join(webDir, doc));
for (const csv of readdirSync(path.join(outDir, "scores")).filter((f) => f.endsWith(".csv"))) {
  mkdirSync(path.join(webDir, "scores"), { recursive: true });
  copyFileSync(path.join(outDir, "scores", csv), path.join(webDir, "scores", csv));
}

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const scoreFiles = existsSync(path.join(webDir, "scores")) ? readdirSync(path.join(webDir, "scores")) : [];
const byPhase = {};
for (const img of images) (byPhase[img.phase] ??= []).push(img);
const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Klein 4B qualification — review bundle</title>
<style>body{font-family:system-ui,sans-serif;max-width:1100px;margin:2rem auto;padding:0 1rem;color:#222}h2{margin-top:2.5rem}figure{margin:1rem 0}img{max-width:100%;height:auto;border:1px solid #ccc}figcaption{font-size:.9rem;color:#555}ul.files{columns:2;font-size:.9rem}code{background:#f3f3f3;padding:0 .2rem}</style></head>
<body>
<h1>Civitai FLUX.2 Klein 4B — qualification review bundle</h1>
<p>Generated ${new Date().toISOString()}. Docs: <a href="RESULTS.md">RESULTS.md</a> · <a href="ledger.md">ledger.md</a> · scores: ${scoreFiles.map((f) => `<a href="scores/${f}">${esc(f)}</a>`).join(" · ")}${includeAdult ? "" : ` · ${excluded} adult item(s) excluded from this bundle`}</p>
<h2>Contact sheets</h2>
${sheets.map((s) => `<figure><a href="${s.file}"><img src="${s.file}" alt="${esc(s.name)}" loading="lazy"></a><figcaption><b>${esc(s.name)}</b> — ${esc(s.title)} (<a href="${s.file}">direct link</a>, ${Math.round(s.bytes / 1024)} KB)</figcaption></figure>`).join("\n")}
<h2>Individual renders (direct links)</h2>
${Object.entries(byPhase).map(([phase, list]) => `<h3>${esc(phase)}</h3><ul class="files">${list.map((i) => `<li><a href="${i.file}">${esc(path.basename(i.file))}</a></li>`).join("")}</ul>`).join("\n")}
</body></html>
`;
writeFileSync(path.join(webDir, "index.html"), html);

const prefix = prefixArg ?? `eval/klein-4b-${randomBytes(6).toString("hex")}`;
const totalBytes = sheets.reduce((s, x) => s + x.bytes, 0) + images.reduce((s, i) => s + statSync(path.join(webDir, i.file)).size, 0);
process.stdout.write([
  `web bundle: ${webDir} (rebuilt from empty)`,
  `  ${sheets.length} contact sheets (JPEG), ${images.length} renders, ${Math.round(totalBytes / 1024 / 1024)} MB${includeAdult ? " (adult included)" : ` (${excluded} adult item(s) excluded)`}`,
  "",
  "Upload (after `aws login`) to the public bucket under an unguessable prefix, then share the index URL:",
  `  aws s3 sync "${webDir}" "s3://snarebox-pub/${prefix}/" --delete --content-type-by-extension --cache-control max-age=300`,
  `  https://snarebox-pub.s3.us-east-2.amazonaws.com/${prefix}/index.html`,
  "",
  "Direct links follow the same pattern: <bucket-url>/<prefix>/sheets/<name>.jpg, <prefix>/images/<gate>/<arm>.jpg, <prefix>/RESULTS.md",
  "",
].join("\n"));
