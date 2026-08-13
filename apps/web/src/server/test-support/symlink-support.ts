import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Whether this process can create symlinks, probed once by actually planting
 * one in a temp directory. On Windows `fs.symlink` requires Developer Mode or
 * elevation and fails with EPERM otherwise, so the symlink-escape containment
 * suites skip the cases that must PLANT a symlink when the capability is
 * missing — the containment logic under test is never weakened, only the
 * fixture setup is impossible. On CI a failed probe throws instead of
 * skipping: the escape tests are a security gate and must never silently
 * vanish there.
 */
let cached: boolean | undefined;

export function canCreateSymlinks(): boolean {
  if (cached !== undefined) return cached;
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), "vesper-symlink-probe-"));
  let supported = false;
  try {
    fs.symlinkSync(probeDir, path.join(probeDir, "link"), "dir");
    supported = true;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (process.env.CI === "true") {
      throw new Error(
        `[symlink-support] cannot create symlinks on CI (${reason}); the symlink-escape containment tests must stay active there.`,
      );
    }
    process.stderr.write(
      `[symlink-support] skipping symlink-escape tests — cannot create symlinks (${reason}); on Windows enable Developer Mode or run elevated to activate them.\n`,
    );
  } finally {
    fs.rmSync(probeDir, { recursive: true, force: true });
  }
  cached = supported;
  return supported;
}
