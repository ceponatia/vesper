import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sceneGenStateSchema } from "@/contracts/state/scene-gen";

/**
 * The browser-safety regression check for `@vesper/image-core`
 * (monorepo-image-core.spec.guardrails.md §"Runtime targets are part of the
 * package contract").
 *
 * `src/contracts` is client-importable, so this module is the designated fixture
 * that keeps the package on a path Next compiles into a CLIENT bundle. That is
 * the only check that notices a Node-only transitive dependency entering the
 * package's public graph: package unit tests run in Node and would pass happily,
 * and the failure would otherwise surface as a broken production build.
 *
 * So two things are pinned here — that the fixture still imports a RUNTIME value
 * from the package (a type-only import compiles away and proves nothing), and
 * that the value still behaves. Deleting the import to "clean up" removes the
 * guarantee, not just a line.
 */

const SCENE_GEN_SOURCE = join(process.cwd(), "apps/web/src/contracts/state/scene-gen.ts");

describe("scene-gen as the image-core portability fixture", () => {
  it("imports a runtime symbol from the package, not just a type", () => {
    const source = readFileSync(SCENE_GEN_SOURCE, "utf8");
    const runtimeImport = /^import\s+\{[^}]*\}\s+from\s+"@vesper\/image-core";$/m;
    expect(source).toMatch(runtimeImport);
    expect(source).not.toMatch(/^import\s+type\s+\{[^}]*\}\s+from\s+"@vesper\/image-core";$/m);
  });

  it("runs the package's runtime schema from a client-importable module", () => {
    expect(sceneGenStateSchema.parse({}).referenceMode).toBe("single");
    expect(sceneGenStateSchema.parse({ referenceMode: "multi" }).referenceMode).toBe("multi");
  });
});
