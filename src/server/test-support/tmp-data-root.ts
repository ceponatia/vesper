import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * A throwaway `DATA_ROOT` for image suites, replacing five near-identical
 * `mkdtemp` + `process.env.DATA_ROOT = tmp` blocks whose cleanup all ended in
 * `delete process.env.DATA_ROOT` — a blind delete that silently drops a
 * `DATA_ROOT` the developer had exported, rather than restoring it.
 */

export interface TempDataRoot {
  /** The temp directory itself; removed wholesale by {@link TempDataRoot.cleanup}. */
  sandbox: string;
  /** What `DATA_ROOT` points at — the sandbox, or `sandbox/<subdir>`. */
  root: string;
  /** Restores the previous `DATA_ROOT` (including "was unset") and removes the sandbox. */
  cleanup: () => Promise<void>;
}

/**
 * Create the sandbox and point `DATA_ROOT` at it. Named for the pattern rather
 * than the shape — it takes no callback, because the suites that need it split
 * setup and teardown across `beforeEach`/`afterEach` (or `beforeAll`/`afterAll`)
 * and hold the handle in a `let` between them.
 *
 * Pass `subdir` when the test needs the configured root to sit INSIDE the temp
 * directory rather than be it — the path-containment suites plant sibling
 * directories (a real one plus a symlink to it) next to the root and then point
 * `DATA_ROOT` at the link, which only works if the sandbox is the parent.
 */
export async function withTempDataRoot(
  prefix: string,
  opts: { subdir?: string } = {},
): Promise<TempDataRoot> {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), prefix.endsWith("-") ? prefix : `${prefix}-`));
  const root = opts.subdir === undefined ? sandbox : path.join(sandbox, opts.subdir);
  if (root !== sandbox) await fs.mkdir(root, { recursive: true });

  const previous = process.env.DATA_ROOT;
  process.env.DATA_ROOT = root;

  return {
    sandbox,
    root,
    cleanup: async () => {
      if (previous === undefined) delete process.env.DATA_ROOT;
      else process.env.DATA_ROOT = previous;
      await fs.rm(sandbox, { recursive: true, force: true });
    },
  };
}
