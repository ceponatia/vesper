import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * SPIKE (scene-images.spec.md §5 — throwaway, manual, SFW-only): does Flux
 * composite TWO reference identities into one scene?
 *
 * Finding that shaped this script (June 2026 web research): the OpenRouter image
 * API reached through the Vercel AI SDK `imageModel` caps `maxImagesPerCall` at
 * 1 — our current `generateImage({ model: openrouter.imageModel(...) })` path
 * CANNOT send two references. Multi-image Flux lives only in the **BFL direct
 * API** (`flux-2-pro-preview`, up to 8 refs, async polling, `x-key` auth), so
 * this spike hits BFL directly with raw fetch. It is **SFW-only**: BFL
 * input-moderates prompts AND uploaded images and rejects sexual content, so
 * this validates clothed two-character compositing only — never the intimate
 * core (that points at self-hosted ComfyUI, §7). If two-ref SFW works well, the
 * graduation is a real `src/server/ai/bfl.ts` provider behind the §4 router.
 *
 *   BFL_API_KEY=... pnpm tsx scripts/spikes/flux-multiref.ts \
 *     --a path/to/refA.png --b path/to/refB.png \
 *     [--prompt "..."] [--out data/spikes/flux-multiref] [--model flux-2-pro-preview]
 */
const BFL_BASE = "https://api.bfl.ai/v1";
const POLL_INTERVAL_MS = 1500;
const POLL_TIMEOUT_MS = 120_000;

interface Args {
  a: string;
  b: string;
  prompt: string;
  out: string;
  model: string;
}

function parseArgs(argv: string[]): Args {
  const map = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token?.startsWith("--")) map.set(token.slice(2), argv[i + 1] ?? "");
  }
  const a = map.get("a");
  const b = map.get("b");
  if (!a || !b) throw new Error("usage: --a <refA> --b <refB> [--prompt <text>] [--out <dir>] [--model <bfl-model>]");
  return {
    a,
    b,
    prompt:
      map.get("prompt") ||
      "The person from image 1 and the person from image 2 standing together, fully clothed, in a warm candlelit tavern. Natural photograph, no collage.",
    out: map.get("out") || "data/spikes/flux-multiref",
    model: map.get("model") || "flux-2-pro-preview",
  };
}

async function toDataUri(file: string): Promise<string> {
  const buf = await fs.readFile(file);
  const ext = path.extname(file).toLowerCase();
  const mime = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
  return `data:${mime};base64,${buf.toString("base64")}`;
}

interface SubmitResponse {
  id?: string;
  polling_url?: string;
}
interface PollResponse {
  status?: string;
  result?: { sample?: string } | null;
}

async function submit(args: Args, key: string): Promise<SubmitResponse> {
  const res = await fetch(`${BFL_BASE}/${args.model}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-key": key },
    body: JSON.stringify({
      prompt: args.prompt,
      input_image: await toDataUri(args.a),
      input_image_2: await toDataUri(args.b),
    }),
  });
  if (!res.ok) throw new Error(`BFL submit ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as SubmitResponse;
}

async function poll(pollingUrl: string, key: string): Promise<string> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  for (;;) {
    const res = await fetch(pollingUrl, { headers: { "x-key": key } });
    if (!res.ok) throw new Error(`BFL poll ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as PollResponse;
    const status = body.status ?? "Unknown";
    if (status === "Ready" && body.result?.sample) return body.result.sample;
    if (status !== "Pending" && status !== "Queued" && status !== "Processing") {
      throw new Error(`BFL returned status "${status}" (moderation/error — Flux multi-ref is SFW-only)`);
    }
    if (Date.now() > deadline) throw new Error("BFL poll timed out");
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

async function main(): Promise<void> {
  const key = process.env.BFL_API_KEY;
  if (!key) throw new Error("BFL_API_KEY not set");
  const args = parseArgs(process.argv.slice(2));
  await fs.mkdir(args.out, { recursive: true });

  console.log(`submitting two-ref edit to BFL ${args.model}…`);
  const submitted = await submit(args, key);
  if (!submitted.polling_url) throw new Error("BFL submit returned no polling_url");

  const sampleUrl = await poll(submitted.polling_url, key);
  const image = Buffer.from(await (await fetch(sampleUrl)).arrayBuffer());
  const outPath = path.join(args.out, "output.png");
  await fs.writeFile(outPath, image);

  console.log(`output → ${outPath}`);
  console.log("\nSCORE BY EYE: did it composite BOTH identities, or drop/blend one? (SFW only — never the intimate core.)");
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
