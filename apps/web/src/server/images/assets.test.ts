import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { DiagnosticCollector } from "@/contracts/diagnostics";
import { canCreateSymlinks, testPngBuffer, withTempDataRoot, type TempDataRoot } from "@/server/test-support";

vi.mock("../db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../db")>();
  return { ...actual, db: vi.fn() };
});

import { db, type Db } from "../db";
import {
  absoluteImagePath,
  dataRoot,
  imageMeta,
  imageRelativePath,
  planFailedImageRetirement,
  runImagePipeline,
  writeWebpAtomic,
  type ImagePipelineOutcome,
  type ImagePipelineThrown,
} from "./assets";
import { monogramSvg } from "./monogram";

const symlinksAvailable = canCreateSymlinks();

let sandbox: TempDataRoot;
let tmp: string;

beforeEach(async () => {
  sandbox = await withTempDataRoot("vesper-images");
  tmp = sandbox.root;
});

afterEach(async () => {
  await sandbox.cleanup();
});

describe("dataRoot / paths", () => {
  it("defaults to an absolute <cwd>/data path and honors the DATA_ROOT override", () => {
    expect(dataRoot()).toBe(tmp);
    expect(path.isAbsolute(dataRoot())).toBe(true);
    delete process.env.DATA_ROOT;
    expect(dataRoot()).toBe(path.resolve(process.cwd(), "data"));
  });

  /**
   * The apps/web move's release blocker, asserted rather than assumed
   * (monorepo-image-core.spec.apps-web.md §"Persistent image storage and process
   * working directory"). The repository root is derived from this file's own
   * location — five levels up from src/server/images — so the check is
   * independent of where the runner happens to be started, and an unset
   * DATA_ROOT that began resolving under apps/web (which is what a Next process
   * whose CWD is its project directory would produce) fails here instead of
   * silently making the deployed image library look empty.
   */
  it("resolves an unset DATA_ROOT to the repository's data directory, never the web project's", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const repoRoot = path.resolve(here, "../../../../..");
    delete process.env.DATA_ROOT;

    expect(dataRoot()).toBe(path.join(repoRoot, "data"));
    expect(dataRoot().split(path.sep)).not.toContain("apps");

    // An explicit root is used verbatim, whatever the working directory is —
    // this is the invariant Fly and the Dockerfile depend on.
    process.env.DATA_ROOT = tmp;
    expect(dataRoot()).toBe(tmp);
  });

  it("derives the canonical relative path and resolves it against the root", () => {
    expect(imageRelativePath("owner1", "img1")).toBe("images/owner1/img1.webp");
    expect(absoluteImagePath({ path: "images/owner1/img1.webp" })).toBe(path.join(tmp, "images/owner1/img1.webp"));
  });
});

describe("imageMeta", () => {
  it("passes an object through and degrades every other jsonb shape to {}", () => {
    expect(imageMeta({ lookKey: "abc", source: "upload" })).toEqual({ lookKey: "abc", source: "upload" });
    // The shapes a jsonb column can legally hold besides an object — each must
    // read as "no fields" rather than throw or expose an index.
    for (const raw of [null, undefined, [], ["a"], "lookKey", 7, true]) {
      expect(imageMeta(raw)).toEqual({});
    }
  });

  it("misses cleanly on an absent field, so a caller's guard just fails", () => {
    expect(imageMeta({}).lookKey).toBeUndefined();
    expect(imageMeta([{ lookKey: "abc" }]).lookKey).toBeUndefined(); // an array is not a record
  });
});

describe("writeWebpAtomic", () => {
  it("converts to webp, creates directories, and leaves no pending temp behind", async () => {
    const target = path.join(tmp, "images", "owner1", "img1.webp");

    const info = await writeWebpAtomic(target, await testPngBuffer());
    expect(info).toMatchObject({ width: 8, height: 12 });
    expect(info.bytes).toBeGreaterThan(0);

    const written = await fs.readFile(target);
    expect((await sharp(written).metadata()).format).toBe("webp");
    const siblings = await fs.readdir(path.dirname(target));
    expect(siblings).toEqual(["img1.webp"]);
  });

  // The first SVG-with-text rasterization on a machine builds the fontconfig
  // cache, which on a cold CI runner can alone exceed the default 5s.
  it("rasterizes SVG monograms (the demo-mode pipeline input)", { timeout: 30_000 }, async () => {
    const target = path.join(tmp, "images", "owner1", "mono.webp");
    const info = await writeWebpAtomic(target, monogramSvg("Mira Vale"));
    expect(info.width).toBe(768);
    expect(info.height).toBe(1024);
  });

  it("rejects garbage input without leaving partial files", async () => {
    const target = path.join(tmp, "images", "owner1", "bad.webp");
    await expect(writeWebpAtomic(target, Buffer.from("not an image"))).rejects.toThrow();
    await expect(fs.access(target)).rejects.toThrow();
  });

  it("rejects writes outside DATA_ROOT", async () => {
    const outside = path.join(path.dirname(tmp), `${path.basename(tmp)}-outside`, "escape.webp");
    await expect(writeWebpAtomic(outside, await testPngBuffer())).rejects.toThrow("escapes DATA_ROOT");
    await expect(fs.access(outside)).rejects.toThrow();
  });

  it.skipIf(!symlinksAvailable)("does not follow a pre-planted pending-file symlink", async () => {
    const ownerDir = path.join(tmp, "images", "owner1");
    const target = path.join(ownerDir, "img1.webp");
    const pending = path.join(ownerDir, "img1.pending.webp");
    const outside = path.join(path.dirname(tmp), `${path.basename(tmp)}-outside.webp`);
    await fs.mkdir(ownerDir, { recursive: true });
    await fs.writeFile(outside, "untouched");
    await fs.symlink(outside, pending, "file");

    await expect(writeWebpAtomic(target, await testPngBuffer())).rejects.toThrow("symbolic link");
    expect(await fs.readFile(outside, "utf8")).toBe("untouched");
  });
});

/** The reserved row every fake pipeline run below starts from. */
const RESERVED = {
  id: "pipelinerow1abcdefghijkl",
  ownerId: "owner1",
  path: "images/owner1/pipelinerow1abcdefghijkl.webp",
  status: "pending",
  meta: {},
};

/**
 * Enough of the drizzle builder for the shell's own writes — the reserve insert,
 * the fail update, and the save update — so the sequence can be asserted without
 * a database. Each `set` is recorded, which is how a test reads what the row
 * ended up saying. The lane-level pipelines (real rows, real files, real
 * provider misses) are covered in assets.int.test.ts.
 */
function fakePipelineDb(): { client: Db; updates: Record<string, unknown>[] } {
  const updates: Record<string, unknown>[] = [];
  const client = {
    insert: () => ({ values: () => ({ returning: () => Promise.resolve([RESERVED]) }) }),
    select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve([RESERVED]) }) }) }),
    update: () => ({
      set: (values: Record<string, unknown>) => {
        updates.push(values);
        return { where: () => ({ returning: () => Promise.resolve([{ ...RESERVED, ...values }]) }) };
      },
    }),
  };
  return { client: client as unknown as Db, updates };
}

function rowError(values: Record<string, unknown> | undefined): unknown {
  return imageMeta(values?.meta).error;
}

/**
 * The one reserve → generate → save-or-fail → log sequence (audit C1). These pin
 * the shell's own contract — which hooks fire on which path, and the warn
 * diagnostic a thrown generation records, since recording it in EVERY lane is
 * the deliberate resilience change slice 4 shipped
 * (image-pipeline-consolidation.plan.md §Review rulings 2026-07-30).
 */
describe("runImagePipeline", () => {
  const asset = { ownerId: RESERVED.ownerId, kind: "avatar" as const };
  const diagnostic = { code: "images.avatar.generate_failed", context: { characterId: "char-1" } };

  it("saves, then updates pointers, then logs — and reports ready", async () => {
    const { client, updates } = fakePipelineDb();
    vi.mocked(db).mockReturnValue(client);
    const order: string[] = [];
    const settled: ImagePipelineOutcome[] = [];

    const result = await runImagePipeline({
      asset,
      produce: () => Promise.resolve({ ok: true, image: monogramSvg("Mira Vale") }),
      onReady: () => {
        order.push("ready");
        return Promise.resolve();
      },
      onSettled: (outcome) => {
        order.push("settled");
        settled.push(outcome);
      },
      failureDiagnostic: diagnostic,
    });

    expect(result).toEqual({ imageId: RESERVED.id, status: "ready" });
    // The file exists because the row already did — row before file, unmoved.
    await expect(fs.access(absoluteImagePath(RESERVED))).resolves.toBeUndefined();
    expect(updates.at(-1)).toMatchObject({ status: "ready" });
    expect(order).toEqual(["ready", "settled"]); // pointers first, log last
    expect(settled[0]?.status).toBe("ready");
    expect(settled[0]?.startedMs).toBeLessThanOrEqual(Date.now());
  });

  it("a produce that throws fails the row, records the lane's warn diagnostic, and never settles", async () => {
    const { client, updates } = fakePipelineDb();
    vi.mocked(db).mockReturnValue(client);
    const sink = new DiagnosticCollector();
    const settled: ImagePipelineOutcome[] = [];
    const thrown: ImagePipelineThrown[] = [];
    let readied = false;

    const result = await runImagePipeline({
      asset,
      produce: () => Promise.reject(new Error("VENICE_API_KEY not configured")),
      onReady: () => {
        readied = true;
        return Promise.resolve();
      },
      onSettled: (outcome) => settled.push(outcome),
      onThrown: (outcome) => thrown.push(outcome),
      failureDiagnostic: diagnostic,
      sink,
    });

    expect(result).toEqual({ imageId: RESERVED.id, status: "failed" });
    expect(updates.at(-1)).toMatchObject({ status: "failed" });
    expect(rowError(updates.at(-1))).toBe("VENICE_API_KEY not configured");
    expect(readied).toBe(false);
    // The two log hooks are exclusive: a lane logging different payloads on the
    // two paths (avatar, entity) must never emit both for one generation.
    expect(thrown.map((t) => t.message)).toEqual(["VENICE_API_KEY not configured"]);
    expect(settled).toEqual([]);
    expect(sink.items).toHaveLength(1);
    expect(sink.items[0]?.severity).toBe("warn");
    expect(sink.items[0]?.code).toBe("images.avatar.generate_failed");
    // The failing row's id joins the lane's context — the entity lane's shape.
    expect(sink.items[0]?.context).toEqual({ characterId: "char-1", imageId: RESERVED.id });
  });

  it("a produce that reports a failure fails the row and settles — the lane owns any diagnostic there", async () => {
    // The scene chain and the reference edit report failure rather than throwing;
    // the shell must not mistake that for a thrown provider error, and must not
    // record the thrown path's diagnostic for a lane's own precondition miss.
    const { client, updates } = fakePipelineDb();
    vi.mocked(db).mockReturnValue(client);
    const sink = new DiagnosticCollector();
    const settled: ImagePipelineOutcome[] = [];

    const result = await runImagePipeline({
      asset,
      produce: () => Promise.resolve({ ok: false, error: "no ready canonical avatar to use as reference" }),
      onSettled: (outcome) => settled.push(outcome),
      failureDiagnostic: diagnostic,
      sink,
    });

    expect(result.status).toBe("failed");
    expect(rowError(updates.at(-1))).toBe("no ready canonical avatar to use as reference");
    expect(settled.map((s) => s.status)).toEqual(["failed"]);
    expect(sink.items).toEqual([]);
  });

  it("a failed precondition records the row and stops — no generation, no hooks, no diagnostic", async () => {
    // The avatar/entity/variant shape: the row is reserved BEFORE the lane knows
    // its entity is missing, so it stays on record as failed, unlogged.
    const { client, updates } = fakePipelineDb();
    vi.mocked(db).mockReturnValue(client);
    const sink = new DiagnosticCollector();
    let produced = false;
    let logged = 0;

    const result = await runImagePipeline({
      asset,
      failedPrecondition: "character char-1 not found",
      produce: () => {
        produced = true;
        return Promise.resolve({ ok: true, image: monogramSvg("Never") });
      },
      onSettled: () => {
        logged += 1;
      },
      onThrown: () => {
        logged += 1;
      },
      failureDiagnostic: diagnostic,
      sink,
    });

    expect(result).toEqual({ imageId: RESERVED.id, status: "failed" });
    expect(produced).toBe(false);
    expect(rowError(updates.at(-1))).toBe("character char-1 not found");
    expect(logged).toBe(0);
    expect(sink.items).toEqual([]);
  });

  it("merges a produce result's meta into the row on save", async () => {
    // The provenance channel: the render attempt rides the SAME update that
    // marks the row ready, so a ready row never lacks its record.
    const { client, updates } = fakePipelineDb();
    vi.mocked(db).mockReturnValue(client);

    const result = await runImagePipeline({
      asset,
      produce: () =>
        Promise.resolve({ ok: true, image: monogramSvg("Mira Vale"), meta: { render: { seed: 42, predictionId: "pred-1" } } }),
    });

    expect(result.status).toBe("ready");
    const saved = updates.at(-1);
    expect(saved).toMatchObject({ status: "ready" });
    expect(imageMeta(saved?.meta).render).toEqual({ seed: 42, predictionId: "pred-1" });
    // The file facts land beside it, not instead of it.
    expect(imageMeta(saved?.meta).width).toBe(768);
  });

  it("merges a produce result's meta into the row on a reported failure", async () => {
    // A failed prediction's id is exactly what an operator needs to trace, so
    // the fail update carries the meta too — beside the error text.
    const { client, updates } = fakePipelineDb();
    vi.mocked(db).mockReturnValue(client);

    const result = await runImagePipeline({
      asset,
      produce: () => Promise.resolve({ ok: false, error: "provider exploded", meta: { render: { predictionId: "pred-9" } } }),
    });

    expect(result.status).toBe("failed");
    const failed = updates.at(-1);
    expect(failed).toMatchObject({ status: "failed" });
    expect(imageMeta(failed?.meta).render).toEqual({ predictionId: "pred-9" });
    expect(rowError(failed)).toBe("provider exploded");
  });

  it("runs afterReserve before generating, and a context-free lane gets a context-free diagnostic", async () => {
    // The chat anchors' shape (no context supplied) and the scene lane's
    // reference rows, which are written against the row before the clock starts.
    const { client } = fakePipelineDb();
    vi.mocked(db).mockReturnValue(client);
    const sink = new DiagnosticCollector();
    const order: string[] = [];

    await runImagePipeline({
      asset,
      afterReserve: (reserved) => {
        order.push(`reserved:${reserved.id}`);
        return Promise.resolve();
      },
      produce: () => {
        order.push("produce");
        return Promise.reject(new Error("replicate edit failed"));
      },
      failureDiagnostic: { code: "images.chat_look.failed" },
      sink,
    });

    expect(order).toEqual([`reserved:${RESERVED.id}`, "produce"]);
    expect(sink.items[0]?.code).toBe("images.chat_look.failed");
    expect(sink.items[0]?.context).toBeUndefined();
  });
});

/**
 * Retention's decision rule (docs/images/asset-registry.md §image_sweep).
 *
 * Falsified against two implementations that look reasonable and destroy data:
 * one that ages a row by `created_at`, which deletes the "this render failed"
 * tile in the same tick the failure appeared for any row that was `ready` first;
 * and one with no proportion rail, which turns a volume that did not mount —
 * every ready row marked failed — into a wiped images table one day later.
 */
describe("planFailedImageRetirement", () => {
  const now = new Date("2026-08-24T12:00:00.000Z");
  const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();
  const DAY = 24 * 60 * 60_000;

  /** Every candidate is months old by `created_at`; only the stamp differs. */
  const row = (id: string, failedAt?: string) => ({
    id,
    meta: failedAt === undefined ? {} : { failedAt },
    createdAt: new Date(now.getTime() - 90 * DAY),
  });

  it("ages a row by its failure stamp, retiring the oldest failures first", () => {
    const plan = planFailedImageRetirement(
      [
        row("just-failed", ago(60_000)),
        row("two-days", ago(2 * DAY)),
        row("exactly-a-day", ago(DAY)),
        row("still-fresh", ago(DAY - 60_000)),
        // No stamp: it failed before `failImage` wrote one, so `created_at`
        // stands in — and such a row is older than the window by definition.
        { ...row("legacy"), meta: { error: "provider exploded" } },
        // A row reserved minutes ago and failed immediately: the fallback must
        // not retire it either.
        { id: "legacy-fresh", meta: {}, createdAt: new Date(now.getTime() - 60_000) },
      ],
      100,
      now,
    );

    expect(plan).toEqual({ ids: ["legacy", "two-days", "exactly-a-day"], disagreement: false });
  });

  it("refuses a scope that is mostly long-failed, and bounds an ordinary pass", () => {
    const expired = (count: number, since = 2 * DAY) =>
      Array.from({ length: count }, (_, index) => row(`expired-${String(index)}`, ago(since + index)));

    // 30 of 40 rows failed: the database and the volume disagree, and deleting
    // rows on that reading is as unrecoverable as wiping the volume.
    expect(planFailedImageRetirement(expired(30), 40, now)).toEqual({ ids: [], disagreement: true });

    // Below the floor the proportion is noise — a small database still gets cleaned.
    expect(planFailedImageRetirement(expired(3), 3, now).ids).toHaveLength(3);

    // A genuine backlog drains a bounded slice per pass rather than in one statement.
    expect(planFailedImageRetirement(expired(250), 1000, now).ids).toHaveLength(200);
  });
});
