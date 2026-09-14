import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { repoRelative, sourceFilesUnder } from "@/server/test-support";

/**
 * Every confirmation — a destructive delete or an equivalent one-step
 * decision — renders through `ConfirmDialog` (`components/ui/confirm-dialog.tsx`),
 * which owns the busy-guarded dismissal contract (docs/ui/conventions.md
 * §Confirmations). A component that still imports the raw `Dialog` primitive
 * directly is therefore, by construction, NOT a yes/no confirmation: a form, a
 * picker, a panel, or a reading surface.
 *
 * This is that boundary made a tripwire. `ALLOWED_DIALOG_IMPORTERS` is a
 * reviewed, exhaustive list (#287) of the sites where a raw `Dialog` is
 * correct — plus `confirm-dialog.tsx` itself, which is what `Dialog` renders
 * through. A new entry belongs here only when the site genuinely collects
 * input, picks an entity, or shows a reading surface; a new hand-rolled
 * destructive dialog belongs on `ConfirmDialog` instead, which is exactly the
 * class of site #287 found already unguarded (`entity-library.tsx`'s
 * generate-images confirm, several settings remove dialogs) before this test
 * existed to catch it.
 */
const COMPONENTS_DIR = path.join(process.cwd(), "apps/web/src/components");

/** Sorted, and kept that way — `sourceFilesUnder` walks in `readdir` order, which is not stable. */
const ALLOWED_DIALOG_IMPORTERS: readonly string[] = [
  "apps/web/src/components/characters/avatar-upload-dialog.tsx",
  "apps/web/src/components/characters/character-proposal-review.tsx",
  "apps/web/src/components/characters/chat-scenario-modal.tsx",
  "apps/web/src/components/characters/chat-state-tools.tsx",
  "apps/web/src/components/characters/identity-crop-dialog.tsx",
  "apps/web/src/components/characters/reference-view-history.tsx",
  "apps/web/src/components/chat/calendar-start-dialog.tsx",
  "apps/web/src/components/chat/chat-clock-card.tsx",
  "apps/web/src/components/chat/chat-conversation-menu.tsx",
  "apps/web/src/components/chat/chat-conversation.tsx",
  "apps/web/src/components/chat/chat-inspector-agent-health.tsx",
  "apps/web/src/components/chat/chat-permissions-panel.tsx",
  "apps/web/src/components/chat/chat-plans-panel.tsx",
  "apps/web/src/components/chat/chat-supporting-cast-panel.tsx",
  "apps/web/src/components/chat/chats-page.tsx",
  "apps/web/src/components/chat/new-chat-dialog.tsx",
  "apps/web/src/components/library/entity-picker.tsx",
  "apps/web/src/components/settings/identity-trials-page.tsx",
  "apps/web/src/components/ui/confirm-dialog.tsx",
];

/**
 * True when `source` imports the `Dialog` value export from the ui primitive
 * — the `@/components/ui/dialog` alias every ordinary site uses, or the
 * relative `./dialog` that only `confirm-dialog.tsx` (living beside it) uses.
 * A regex, not a parser, mirrors `image-internal-callers.test.ts`: precision
 * comes from requiring the bare identifier `Dialog` (so `DialogProps` and
 * `ConfirmDialog` never match) from one of exactly those two specifiers.
 */
function importsDialogPrimitive(source: string, fileRepoRelative: string): boolean {
  const declaration = /import\s*{([^}]+)}\s*from\s*["']([^"']+)["']/g;
  let match = declaration.exec(source);
  while (match !== null) {
    const names = (match[1] ?? "")
      .split(",")
      .map((specifier) => specifier.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]?.trim() ?? "");
    const from = match[2] ?? "";
    if (names.includes("Dialog")) {
      const isAliasImport = from === "@/components/ui/dialog";
      const isConfirmDialogsOwnImport = from === "./dialog" && path.posix.dirname(fileRepoRelative) === "apps/web/src/components/ui";
      if (isAliasImport || isConfirmDialogsOwnImport) return true;
    }
    match = declaration.exec(source);
  }
  return false;
}

describe("raw Dialog importer census", () => {
  it("matches the reviewed allowlist of non-ConfirmDialog sites exactly", () => {
    const actual = sourceFilesUnder(COMPONENTS_DIR)
      .map((absolute) => repoRelative(absolute))
      .filter((file) => importsDialogPrimitive(fs.readFileSync(path.join(process.cwd(), file), "utf8"), file))
      .sort();

    expect(actual).toEqual([...ALLOWED_DIALOG_IMPORTERS].sort());
  });
});
