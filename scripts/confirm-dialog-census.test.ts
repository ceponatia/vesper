import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { matchDelimiter, repoRelative, sourceFilesUnder, stripComments } from "@/server/test-support";

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
 *
 * The boundary takes three checks, in this order. The census proves every
 * confirmation ROUTES through `ConfirmDialog`. `MIXED_USE_CONFIRM_SITES` covers
 * the one case the census is blind to — a file allowlisted for its own raw
 * `Dialog` that also owns a confirmation. The guard check at the bottom proves
 * `ConfirmDialog` still does the thing all that routing was for.
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
  "apps/web/src/components/settings/files-page.tsx",
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

/**
 * The census above is a FILE-level check, and this closes its one blind spot.
 *
 * A file that both holds a legitimate raw `Dialog` and routes a destructive
 * confirmation through `ConfirmDialog` is allowlisted for the first reason, so
 * replacing its confirmation with a hand-rolled raw dialog changes no importer
 * and the census stays green — unguarded deletion restored, invisibly. Only
 * counting the `ConfirmDialog` sites inside those files can see it.
 *
 * Every other adopter is covered by construction: it imports no raw `Dialog`
 * at all, so hand-rolling one there ADDS an importer the census rejects. That
 * is why this map is short rather than a second census — it is exactly the
 * intersection of `ALLOWED_DIALOG_IMPORTERS` with the `ConfirmDialog`
 * adopters.
 *
 * That last sentence is a claim, so the first test below DERIVES the
 * intersection from the repo and asserts this map equals it. Writing the two
 * files out by hand and checking only that they are allowlisted would leave
 * the blind spot open at its other end: an allowlisted raw-`Dialog` component
 * that ADOPTS `ConfirmDialog` later becomes mixed-use, and an unpinned
 * mixed-use file is exactly the hole this map exists to close.
 */
const MIXED_USE_CONFIRM_SITES: ReadonlyMap<string, number> = new Map([
  ["apps/web/src/components/chat/chat-conversation.tsx", 1],
  ["apps/web/src/components/chat/chats-page.tsx", 1],
  ["apps/web/src/components/settings/files-page.tsx", 1],
]);

/** `<ConfirmDialog` sites in `file`, comments blanked so prose never counts. */
function confirmDialogSites(file: string): number {
  const source = stripComments(fs.readFileSync(path.join(process.cwd(), file), "utf8"));
  return source.match(/<ConfirmDialog\b/g)?.length ?? 0;
}

describe("mixed-use allowlisted components", () => {
  it("are pinned exhaustively, so a newly mixed-use file cannot enter the blind spot unnoticed", () => {
    const derived = ALLOWED_DIALOG_IMPORTERS.filter((file) => confirmDialogSites(file) > 0).sort();

    expect(derived, "every allowlisted file that adopts ConfirmDialog must be pinned below").toEqual(
      [...MIXED_USE_CONFIRM_SITES.keys()].sort(),
    );
  });

  it("keep their destructive confirmations on ConfirmDialog", () => {
    for (const [file, expected] of MIXED_USE_CONFIRM_SITES) {
      expect(
        confirmDialogSites(file),
        `${file} must still route ${expected} confirmation(s) through ConfirmDialog`,
      ).toBe(expected);
    }
  });
});

/**
 * `ConfirmDialog` still guards dismissal while the confirmed operation runs.
 *
 * The defect this kills is the silent removal of that guard, in any of its
 * three shapes: wiring `Dialog`'s `onClose` straight to the `onClose` PROP, so
 * Escape and a backdrop click stop being guarded while Cancel still looks
 * guarded; dropping `busy` from the confirm button, so a second click starts
 * a second delete; or INVERTING the condition to `if (busy) onClose()`, which
 * dismisses a running deletion and refuses to dismiss an idle dialog while
 * naming every token the correct guard names. All three are valid TypeScript,
 * all three are lint-clean, and one edit takes the guard away from all 26
 * adopted sites at once — the blast radius the one shared surface bought,
 * spent in reverse.
 *
 * Nothing else can catch it. A rendered assertion is out of reach: both Vitest
 * projects run in `node` and include `*.test.ts` only, so no suite here can
 * mount this component (`image-control-vocabulary-display.test.ts` states the
 * same constraint for the Generator's run detail, and answers it the same way).
 *
 * Structure, never a snapshot. It asserts that ONE shared local handler reaches
 * both `Dialog`'s `onClose` and Cancel's `onClick`, that the handler's body
 * closes only while NOT `busy`, and that the confirm button carries `busy` —
 * not the text of any of them, so reformatting, renaming `dismiss`, reordering
 * the props and rewording every label all stay green. A shape it cannot find
 * THROWS rather than failing an assertion: a rewritten component is a stale
 * scanner, and reporting that as a missing guard would send the next reader
 * after the wrong thing.
 */
const CONFIRM_DIALOG = path.join(process.cwd(), "apps/web/src/components/ui/confirm-dialog.tsx");

/** Comments blanked and whitespace collapsed — a guard named only in the doc comment must not satisfy a check. */
function confirmDialogSource(): string {
  return stripComments(fs.readFileSync(CONFIRM_DIALOG, "utf8")).replace(/\s+/g, " ");
}

/** The identifier `<Dialog>` is handed as `onClose`. */
function dialogCloseHandler(source: string): string {
  const match = /<Dialog\b[\s\S]*?\sonClose=\{(\w+)\}/.exec(source);
  if (match === null) {
    throw new Error(
      `[confirm-dialog] ${repoRelative(CONFIRM_DIALOG)} hands <Dialog> no bare-identifier onClose — ` +
        "the component was rewritten, so this scanner is stale rather than the guard missing",
    );
  }
  return match[1] ?? "";
}

/** The brace-matched body of `const <name> = ...`. */
function handlerBody(source: string, name: string): string {
  const declaration = new RegExp(String.raw`\bconst\s+${name}\s*=`).exec(source);
  if (declaration === null) {
    throw new Error(`[confirm-dialog] ${name} is not declared as a const in ${repoRelative(CONFIRM_DIALOG)}`);
  }
  const open = source.indexOf("{", declaration.index + declaration[0].length);
  const close = open === -1 ? -1 : matchDelimiter(source, open, "{", "}");
  if (close === -1) {
    throw new Error(`[confirm-dialog] ${name} has no brace-matched body in ${repoRelative(CONFIRM_DIALOG)}`);
  }
  return source.slice(open, close + 1);
}

/**
 * True when `body` reaches `onClose()` only while `busy` is FALSE, in either
 * idiomatic shape of that guard: the call sits in the consequent of
 * `if (!busy)`, or a leading `if (busy) return` precedes it.
 *
 * Two things have to hold, and the second is easy to lose. POLARITY, because
 * an inverted `if (busy) onClose()` still contains `busy` and `onClose()` — so
 * token presence cannot tell the guard from its exact opposite, the one that
 * dismisses a running deletion and refuses to dismiss an idle dialog. And
 * BINDING, because a condition that does not govern the call guards nothing:
 * `onClose(); if (busy) return;` names an idle/busy test and closes
 * unconditionally, so the predicate must prove the call is downstream of the
 * guard rather than merely in the same function.
 */
function closesOnlyWhenIdle(body: string): boolean {
  const negated = /if\s*\(\s*!\s*busy\s*\)\s*/.exec(body);
  if (negated !== null) {
    const consequent = negated.index + negated[0].length;
    if (body.startsWith("{", consequent)) {
      // A braced consequent may hold more than the call; match it and look inside.
      const end = matchDelimiter(body, consequent, "{", "}");
      if (end !== -1 && body.slice(consequent, end + 1).includes("onClose()")) return true;
    } else if (/^onClose\s*\(\)/.test(body.slice(consequent))) {
      return true;
    }
  }

  // A leading `if (busy) return` makes every later close unreachable while
  // busy. Position is the whole point: the same return AFTER the call is inert.
  const earlyReturn = /if\s*\(\s*busy\s*\)\s*\{?\s*return\b/.exec(body);
  const close = body.indexOf("onClose()");
  return earlyReturn !== null && close !== -1 && earlyReturn.index < close;
}

/** The attribute text of the `<Button>` that fires `onConfirm`. */
function confirmButtonAttributes(source: string): string {
  const confirm = [...source.matchAll(/<Button\b([^>]*)>/g)]
    .map((match) => match[1] ?? "")
    .find((attributes) => attributes.includes("onClick={onConfirm}"));
  if (confirm === undefined) {
    throw new Error(
      `[confirm-dialog] no <Button> in ${repoRelative(CONFIRM_DIALOG)} fires onConfirm — ` +
        "the component was rewritten, so this scanner is stale rather than the guard missing",
    );
  }
  return confirm;
}

describe("ConfirmDialog's busy guard", () => {
  it("sends Escape, the backdrop click and Cancel through one handler that decides on busy", () => {
    const source = confirmDialogSource();
    const handler = dialogCloseHandler(source);

    // The caller's own prop reaching Dialog IS the regression: Escape and a
    // backdrop click would dismiss a running operation while Cancel refused.
    expect(handler, "Dialog's onClose must be a guarded wrapper, not the onClose prop").not.toBe("onClose");
    expect(source, "Cancel must share Dialog's dismissal handler").toContain(`onClick={${handler}}`);

    const body = handlerBody(source, handler);
    expect(body, `${handler} must still be able to close`).toContain("onClose()");
    expect(
      closesOnlyWhenIdle(body),
      `${handler} must close only while NOT busy — an inverted guard reads as \`${body.trim()}\``,
    ).toBe(true);
  });

  it("gives the confirm button Button's own busy, so a second click starts no second operation", () => {
    // `Button` renders `disabled={disabled || busy}` plus the spinner, so this
    // one prop is both halves of "cannot be clicked twice" and "says so".
    expect(
      confirmButtonAttributes(confirmDialogSource()),
      "the confirm button must carry busy, not just confirmDisabled",
    ).toContain("busy={busy}");
  });
});
