import { describe, expect, it } from "vitest";
import type { ReplicateHttp } from "./http";
import {
  type PreparedReferenceBytes,
  REFERENCE_UPLOAD_CONCURRENCY,
  transportReplicateReferences,
} from "./files";

/**
 * The bounded-concurrency transport, against a hand-held HTTP seam: every
 * upload parks on a promise the test resolves by name, so in-flight counts and
 * completion order are DRIVEN rather than raced. No global fetch stub — the
 * function takes its `ReplicateHttp`, which is the whole point of the seam.
 */

const prepared = (over: Partial<PreparedReferenceBytes> = {}): PreparedReferenceBytes => ({
  bytes: Buffer.from("bytes"),
  mediaType: "image/webp",
  extension: "webp",
  ...over,
});

/** One parked upload: the filename it was posted under, and its outcome lever. */
interface ParkedUpload {
  filename: string;
  succeed: () => void;
  fail: () => void;
}

/**
 * An http whose POST /files calls park until the test releases them. Uploads
 * settle with `id` = the posted filename, so URLs and delete paths read back
 * which input slot each call carried. A filename in `failImmediately` answers
 * 500 without parking — the lever for making a failure land FIRST,
 * deterministically, while its neighbours are still in flight.
 */
function parkedHttp(options: { failImmediately?: string[] } = {}): {
  http: ReplicateHttp;
  parked: ParkedUpload[];
  deletes: string[];
  uploadsStarted: () => number;
  maxInFlight: () => number;
  release: (filename: string, outcome?: "succeed" | "fail") => void;
} {
  const parked: ParkedUpload[] = [];
  const deletes: string[] = [];
  let started = 0;
  let inFlight = 0;
  let peak = 0;
  const http: ReplicateHttp = {
    configured: true,
    authHeaders: () => ({}),
    apiFetch: (path, init) => {
      if ((init?.method ?? "GET") === "DELETE") {
        deletes.push(path);
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      const body = init?.body;
      if (!(body instanceof FormData)) throw new Error(`unexpected request: ${path}`);
      const entry = body.get("content");
      if (!(entry instanceof File)) throw new Error("upload carried no file content");
      started += 1;
      if (options.failImmediately?.includes(entry.name)) {
        return Promise.resolve(new Response("boom", { status: 500 }));
      }
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      return new Promise<Response>((resolve) => {
        const settle = (response: Response): void => {
          inFlight -= 1;
          resolve(response);
        };
        parked.push({
          filename: entry.name,
          succeed: () =>
            settle(Response.json({ id: entry.name, urls: { get: `https://files.test/${entry.name}` } })),
          fail: () => settle(new Response("boom", { status: 500 })),
        });
      });
    },
  };
  const release = (filename: string, outcome: "succeed" | "fail" = "succeed"): void => {
    const index = parked.findIndex((upload) => upload.filename === filename);
    const upload = parked[index];
    if (!upload) throw new Error(`no parked upload named ${filename}`);
    parked.splice(index, 1);
    upload[outcome]();
  };
  return { http, parked, deletes, uploadsStarted: () => started, maxInFlight: () => peak, release };
}

/** Spin event-loop turns until the condition holds — the parked promises need real ticks. */
async function until(condition: () => boolean): Promise<void> {
  for (let turn = 0; turn < 200 && !condition(); turn += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  if (!condition()) throw new Error("condition never became true");
}

describe("transportReplicateReferences", () => {
  it("uploads with at most the bounded concurrency in flight", async () => {
    const { http, parked, maxInFlight, release } = parkedHttp();
    const references = Array.from({ length: 8 }, () => prepared());
    const result = transportReplicateReferences(http, references, "file");

    for (let released = 0; released < references.length; released += 1) {
      await until(() => parked.length > 0);
      expect(maxInFlight()).toBeLessThanOrEqual(REFERENCE_UPLOAD_CONCURRENCY);
      const next = parked[0];
      if (!next) throw new Error("nothing parked");
      release(next.filename);
    }

    const transported = await result;
    expect(transported.ok).toBe(true);
    // The pool actually saturated: fewer would mean the bound is accidental.
    expect(maxInFlight()).toBe(REFERENCE_UPLOAD_CONCURRENCY);
  });

  it("returns URIs in INPUT order whatever order the uploads complete in", async () => {
    const { http, parked, release } = parkedHttp();
    const references = Array.from({ length: 4 }, () => prepared());
    const result = transportReplicateReferences(http, references, "file");

    // Three park immediately (the pool), the fourth once a slot frees. Settle
    // them 3, 4, 1, 2 — nothing like input order.
    await until(() => parked.length === 3);
    release("vesper-reference-3.webp");
    await until(() => parked.some((upload) => upload.filename === "vesper-reference-4.webp"));
    release("vesper-reference-4.webp");
    release("vesper-reference-1.webp");
    release("vesper-reference-2.webp");

    const transported = await result;
    if (!transported.ok) throw new Error(transported.error);
    // A reordering here would silently swap a pose map for a face at the
    // positional split in `runRegistryImageModel`.
    expect(transported.uris).toEqual([
      "https://files.test/vesper-reference-1.webp",
      "https://files.test/vesper-reference-2.webp",
      "https://files.test/vesper-reference-3.webp",
      "https://files.test/vesper-reference-4.webp",
    ]);
  });

  it("deletes every successful upload when one fails, and starts none after the failure", async () => {
    const { http, parked, deletes, uploadsStarted, release } = parkedHttp({
      failImmediately: ["vesper-reference-2.webp"],
    });
    const references = Array.from({ length: 4 }, () => prepared());
    const result = transportReplicateReferences(http, references, "file");

    // Uploads 1 and 3 park; upload 2 has already answered 500. One macrotask
    // turn lets that failure record before the successes land, so what follows
    // is driven, not raced.
    await until(() => parked.length === 2);
    await new Promise((resolve) => setTimeout(resolve, 0));
    release("vesper-reference-1.webp");
    release("vesper-reference-3.webp");

    const transported = await result;
    expect(transported.ok).toBe(false);
    if (transported.ok) throw new Error("expected a failure");
    expect(transported.error).toContain("replicate 500");
    // The render is not happening; the files that DID land must not outlive it.
    expect(deletes.sort()).toEqual([
      "/files/vesper-reference-1.webp",
      "/files/vesper-reference-3.webp",
    ]);
    // The fourth upload was never begun: workers stop claiming once one failed.
    expect(uploadsStarted()).toBe(3);
  });

  it("stamps each reference's own media type and extension onto its upload", async () => {
    const types: Array<{ name: string; type: string }> = [];
    const http: ReplicateHttp = {
      configured: true,
      authHeaders: () => ({}),
      apiFetch: (path, init) => {
        const body = init?.body;
        if (!(body instanceof FormData)) throw new Error(`unexpected request: ${path}`);
        const entry = body.get("content");
        if (!(entry instanceof File)) throw new Error("upload carried no file content");
        types.push({ name: entry.name, type: entry.type });
        return Promise.resolve(
          Response.json({ id: entry.name, urls: { get: `https://files.test/${entry.name}` } }),
        );
      },
    };
    const transported = await transportReplicateReferences(
      http,
      [prepared(), prepared({ mediaType: "image/png", extension: "png" })],
      "file",
    );
    expect(transported.ok).toBe(true);
    expect(types).toEqual([
      { name: "vesper-reference-1.webp", type: "image/webp" },
      { name: "vesper-reference-2.png", type: "image/png" },
    ]);
  });

  it("inlines data_url references under their own media types, touching no network", async () => {
    const http: ReplicateHttp = {
      configured: true,
      authHeaders: () => ({}),
      apiFetch: () => {
        throw new Error("data_url transport must not call the provider");
      },
    };
    const transported = await transportReplicateReferences(
      http,
      [prepared({ bytes: Buffer.from("face") }), prepared({ bytes: Buffer.from("mask"), mediaType: "image/png", extension: "png" })],
      "data_url",
    );
    expect(transported.ok).toBe(true);
    if (!transported.ok) throw new Error(transported.error);
    expect(transported.uris).toEqual([
      `data:image/webp;base64,${Buffer.from("face").toString("base64")}`,
      `data:image/png;base64,${Buffer.from("mask").toString("base64")}`,
    ]);
    // Nothing uploaded means nothing to clean up after the prediction either.
    expect(transported.files).toEqual([]);
  });

  it("transports an empty list without touching the provider", async () => {
    const http: ReplicateHttp = {
      configured: true,
      authHeaders: () => ({}),
      apiFetch: () => {
        throw new Error("an empty transport must not call the provider");
      },
    };
    expect(await transportReplicateReferences(http, [], "file")).toEqual({ ok: true, uris: [], files: [] });
  });
});
