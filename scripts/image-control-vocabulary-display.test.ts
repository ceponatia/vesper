import fs from "node:fs";
import path from "node:path";
import { imageRenderControlsSchema } from "@vesper/image-core";
import { describe, expect, it } from "vitest";
import { repoRelative, stripComments } from "@/server/test-support";

/**
 * The Image Generator's run detail names EVERY normalized control a run
 * recorded — the display half of "nothing is silently ignored".
 *
 * `controlEntries` in `image-generator-run-detail.tsx` declares itself
 * "exhaustive over the stored shape", and nothing could hold it to that. Every
 * member of `imageRenderControlsSchema` is optional, so a control the function
 * forgets is not a type error, not a lint finding and not a test failure: the
 * panel simply omits it, and an operator reading a run back sees a control set
 * missing the value that decided the render. The component is out of reach of
 * an ordinary unit test besides — `controlEntries` is not exported, and
 * neither Vitest project includes `*.test.tsx` — so a source scan is the only
 * gate available for the claim the function makes about itself.
 *
 * The defect it kills is the one that just happened one layer down. `fastMode`
 * was declared on the controls schema, mapped by the control mapper and bound
 * by the probe, and was missing from BOTH `compileProfileRenderPlan`'s merge
 * and this list — so a run configured with it rendered under a value nothing
 * recorded and the detail panel could not have shown it either. The merge is
 * pinned in `@vesper/image-core`'s `compile-profile-plan.test.ts`; this is the
 * same alarm for the read-back.
 *
 * Derived from the schema rather than from a copied name list, so the next
 * control is covered by existing rather than by somebody remembering this file.
 */

const RUN_DETAIL = path.join(process.cwd(), "apps/web/src/components/settings/image-generator-run-detail.tsx");

/**
 * The body of `controlEntries`, comments blanked — a control named only in the
 * function's own doc comment, or elsewhere in the module, must not satisfy the
 * census.
 *
 * A scan that cannot find the function THROWS rather than asserting: a renamed
 * helper or a reformatted brace is a broken scanner, and reporting it as a
 * missing control would send the next reader after the wrong thing.
 */
function controlEntriesBody(): string {
  const source = stripComments(fs.readFileSync(RUN_DETAIL, "utf8"));
  const start = source.indexOf("function controlEntries(");
  if (start < 0) throw new Error(`[control-vocabulary] ${repoRelative(RUN_DETAIL)} declares no controlEntries`);
  const end = source.indexOf("\n}", start);
  if (end < 0) throw new Error(`[control-vocabulary] controlEntries in ${repoRelative(RUN_DETAIL)} has no end brace`);
  return source.slice(start, end);
}

describe("the Generator's run detail reads back the whole control vocabulary", () => {
  it("names every member of imageRenderControlsSchema", () => {
    const body = controlEntriesBody();
    const missing = Object.keys(imageRenderControlsSchema.shape).filter(
      (control) => !body.includes(`controls.${control}`),
    );
    expect(missing, `${repoRelative(RUN_DETAIL)} omits these controls from controlEntries`).toEqual([]);
  });
});
