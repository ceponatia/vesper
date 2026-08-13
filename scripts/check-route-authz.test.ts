import { describe, expect, it } from "vitest";
import { contentChangedPaths } from "./check-route-authz";

/**
 * The route-authorization gate reads source, so it must look only at files whose
 * source changed. Renames are the trap: a repository-wide move makes every file
 * in the tree "changed", and the gate would then report findings about code the
 * change never touched — which is exactly what the `apps/web` move produced
 * before this filter existed.
 */
describe("contentChangedPaths", () => {
  it("keeps added, copied and modified paths", () => {
    const status = [
      "A\tapps/web/src/app/api/items/[id]/route.ts",
      "M\tapps/web/src/app/api/chats/[chatId]/route.ts",
      "C075\tapps/web/src/app/api/a/route.ts\tapps/web/src/app/api/b/route.ts",
    ].join("\n");

    expect(contentChangedPaths(status)).toEqual([
      "apps/web/src/app/api/items/[id]/route.ts",
      "apps/web/src/app/api/chats/[chatId]/route.ts",
      "apps/web/src/app/api/b/route.ts",
    ]);
  });

  it("drops a pure rename but keeps a rename that also edited the file", () => {
    const status = [
      "R100\tsrc/app/api/items/[id]/route.ts\tapps/web/src/app/api/items/[id]/route.ts",
      "R087\tsrc/app/api/chats/[chatId]/route.ts\tapps/web/src/app/api/chats/[chatId]/route.ts",
    ].join("\n");

    expect(contentChangedPaths(status)).toEqual(["apps/web/src/app/api/chats/[chatId]/route.ts"]);
  });

  it("ignores blank lines rather than emitting empty paths", () => {
    expect(contentChangedPaths("\n\nM\tapps/web/src/app/api/x/route.ts\n\n")).toEqual([
      "apps/web/src/app/api/x/route.ts",
    ]);
  });
});
