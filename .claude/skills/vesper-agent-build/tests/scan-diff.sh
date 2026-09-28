#!/usr/bin/env bash
# Offline contract checks for scan-diff.sh's lint:authz prediction (route-authz.py).
# A throwaway git repository with a stub gate file; no application code, no network.
set -euo pipefail

# Isolate git from the caller: an exported GIT_DIR (a hook) would aim `add`/`commit`
# at the outer repository, and a global color.ui=always would put escapes in the
# diff that scan-diff's control-character check then fails on.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR GIT_OBJECT_DIRECTORY
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1

SKILL_DIR=$(cd "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
REPO="$TMP/repo"
UNIT="$TMP/unit"
GATE="$TMP/check-route-authz.ts"

fail() { echo "FAILED: $1" >&2; exit 1; }
put() { mkdir -p "$(dirname "$1")"; cat >"$1"; }

# write_gate <file> [extra helper]...: the gate's literal shapes, including a
# commented-out helper, a `[^/]` class inside the RESOURCE_ROUTE literal, and the
# constants route-authz.py mirrors. The wrapper list is decoration: the gate never
# consults it, and neither may the port.
write_gate() {
  local file=$1 name
  shift
  mkdir -p "$(dirname "$file")"
  {
    cat <<'TS'
export const APPROVED_ROUTE_AUTHZ_WRAPPERS = [
  "withOwnedChat",
  "withAuthorizedResource",
] as const;

export const APPROVED_ROUTE_AUTHZ_HELPERS = [
  "loadOwnedChat",
  // "retiredHelper",
  "requireSimChat",
  "findItem",
  "findViewable",
  "cloneToLibrary",
TS
    for name in "$@"; do printf '  "%s",\n' "$name"; done
    cat <<'TS'
] as const;

export const RESOURCE_ROUTE = /^apps\/web\/src\/app\/api\/.+\/\[[^/]+\]\/.*route\.ts$/;

const WITH_USER_CALL = /\bwithUser(?:<[^>\n]+>)?\s*\(/g;
const OWNER_TOKEN = /\bowner(?:Id|_id)\b/;
const USER_ID = /\buser\.id\b/;
const GUARD_CHECK_LOOKAHEAD = 4;
const GUARD_EXIT_LOOKAHEAD = 3;
TS
  } >"$file"
}
write_gate "$GATE"

# --- route-authz.py: one handler shape per row --------------------------------------------
# check <safe|unsafe> <route path> <name>; the route source is on stdin.
check() {
  local want=$1 path=$2 name=$3 rc=0
  rm -rf "$UNIT"; put "$UNIT/$path"
  (cd "$UNIT" && python3 "$SKILL_DIR/route-authz.py" --gate "$GATE" "$path" >/dev/null) || rc=$?
  case "$want:$rc" in
    safe:0|unsafe:1) echo "ok  $name" ;;
    *) fail "$name: expected $want, route-authz.py exited $rc" ;;
  esac
}

# The first ten rows are check-route-authz.test.ts's FIXTURES, verbatim.
check safe 'apps/web/src/app/api/chats/[chatId]/route.ts' "a guarded owner lookup is authorization evidence" <<'TS'
export const GET = withUser(async (user, _req, ctx) => {
  const { chatId } = await ctx.params;
  const owned = await loadOwnedChat(chatId, user.id);
  if (!owned) return jsonError("not_found", "chat not found", 404);
  return jsonOk({ chat: owned.chat });
});
TS
check safe 'apps/web/src/app/api/chats/[chatId]/sim-command/route.ts' "the successor gate may guard through its ok result" <<'TS'
export const POST = withUser(async (user, req, ctx) => {
  const { chatId } = await ctx.params;
  const gate = await requireSimChat(chatId, user.id);
  if (!gate.ok) return gate.response;
  return jsonOk({ branchId: gate.sim.branchId });
});
TS
check safe 'apps/web/src/app/api/items/[id]/route.ts' "an inline id plus owner predicate is authorization evidence" <<'TS'
export const DELETE = withUser(async (user, _req, ctx) => {
  const { id } = await ctx.params;
  const [deleted] = await db()
    .delete(items)
    .where(and(eq(items.id, id), eq(items.ownerId, user.id)))
    .returning({ id: items.id });
  if (!deleted) return jsonError("not_found", "item not found", 404);
  return jsonOk({ deleted: true });
});
TS
check safe 'apps/web/src/app/api/characters/[id]/clone/route.ts' "the intentional owner-or-public clone seam is recognized" <<'TS'
export const POST = withUser(async (user, _req, ctx) => {
  const { id } = await ctx.params;
  const result = await cloneToLibrary("character", id, user.id);
  if (!result.ok) return jsonError("not_found", "character not found", 404);
  return jsonOk({ id: result.id }, 201);
});
TS
check safe 'apps/web/src/app/api/locations/[id]/route.ts' "the intentional owner-or-public view seam is recognized" <<'TS'
export const GET = withUser(async (user, _req, ctx) => {
  const { id } = await ctx.params;
  const row = await findViewable("location", id, user.id);
  if (!row) return jsonError("not_found", "location not found", 404);
  return jsonOk({ row });
});
TS
check unsafe 'apps/web/src/app/api/chats/[chatId]/route.ts' "mentioning an approved helper in a comment proves nothing" <<'TS'
export const GET = withUser(async (user, _req, ctx) => {
  const { chatId } = await ctx.params;
  // loadOwnedChat(chatId, user.id) would be the right gate.
  return jsonOk({ chatId });
});
TS
check unsafe 'apps/web/src/app/api/chats/[chatId]/route.ts' "calling an approved helper with another owner proves nothing" <<'TS'
export const GET = withUser(async (user, req, ctx) => {
  const { chatId } = await ctx.params;
  const owned = await loadOwnedChat(chatId, body.value.ownerId);
  if (!owned) return jsonError("not_found", "chat not found", 404);
  return jsonOk({ chat: owned.chat });
});
TS
check unsafe 'apps/web/src/app/api/chats/[chatId]/route.ts' "discarding an approved helper result proves nothing" <<'TS'
export const GET = withUser(async (user, _req, ctx) => {
  const { chatId } = await ctx.params;
  await loadOwnedChat(chatId, user.id);
  return jsonOk({ chatId });
});
TS
check unsafe 'apps/web/src/app/api/items/[id]/route.ts' "an owner predicate on an unrelated id does not guard the route resource" <<'TS'
export const DELETE = withUser(async (user, _req, ctx) => {
  const { id } = await ctx.params;
  const otherId = "different";
  await db().delete(items).where(and(eq(items.id, otherId), eq(items.ownerId, user.id)));
  return jsonOk({ id });
});
TS
check unsafe 'apps/web/src/app/api/items/[id]/route.ts' "every bare handler in a mixed route must carry evidence" <<'TS'
export const GET = withUser(async (user, _req, ctx) => {
  const { id } = await ctx.params;
  const row = await findItem(user.id, id);
  if (!row) return jsonError("not_found", "item not found", 404);
  return jsonOk({ row });
});

export const DELETE = withUser(async (_user, _req, ctx) => {
  const { id } = await ctx.params;
  await db().delete(items).where(eq(items.id, id));
  return jsonOk({ deleted: true });
});
TS

# The generic form most routes use (the 2026-09-27 false negative, #649).
check unsafe 'apps/web/src/app/api/chats/[chatId]/time-skip/route.ts' "a generic withUser<Params>( handler is judged, not skipped" <<'TS'
type Params = { chatId: string };
export const POST = withUser<Params>(async (user, req: NextRequest, ctx) => {
  const { chatId } = await ctx.params;
  return jsonOk({ chatId });
});
TS
check safe 'apps/web/src/app/api/chats/[chatId]/time-skip/route.ts' "a generic handler with a guarded helper passes" <<'TS'
type Params = { chatId: string };
export const POST = withUser<Params>(async (user, req: NextRequest, ctx) => {
  const { chatId } = await ctx.params;
  const owned = await loadOwnedChat(chatId, user.id);
  if (!owned) return jsonError("not_found", "chat not found", 404);
  return jsonOk({ chat: owned.chat });
});
TS
check safe 'apps/web/src/app/api/chats/[chatId]/notes/route.ts' "a wrapper-only route has no bare handler to judge" <<'TS'
export const GET = withOwnedChat<Params>(async (_user, _req, { chat }) => jsonOk({ chat }));
TS
check unsafe 'apps/web/src/app/api/chats/[chatId]/notes/route.ts' "a wrapper elsewhere in the file does not bless a bare handler" <<'TS'
export const GET = withOwnedChat<Params>(async (_user, _req, { chat }) => jsonOk({ chat }));
export const DELETE = withUser<Params>(async (_user, _req, ctx) => {
  const { chatId } = await ctx.params;
  await db().delete(chats).where(eq(chats.id, chatId));
  return jsonOk({ deleted: true });
});
TS
check unsafe 'apps/web/src/app/api/chats/[chatId]/route.ts' "a helper commented out of the gate's list is not approved" <<'TS'
export const GET = withUser<Params>(async (user, _req, ctx) => {
  const { chatId } = await ctx.params;
  const owned = await retiredHelper(chatId, user.id);
  if (!owned) return jsonError("not_found", "chat not found", 404);
  return jsonOk({ owned });
});
TS
check safe 'apps/web/src/app/api/chats/route.ts' "a route without a [param] segment is out of scope" <<'TS'
export const GET = withUser(async (user) => jsonOk({ user: user.id }));
TS

# Guard shapes the real routes do not use yet; verdicts read from the gate's resultIsGuarded.
check safe 'apps/web/src/app/api/chats/[chatId]/route.ts' "a result compared to null guards the route" <<'TS'
export const GET = withUser<Params>(async (user, _req, ctx) => {
  const { chatId } = await ctx.params;
  const owned = await loadOwnedChat(chatId, user.id);
  if (owned === null) return jsonError("not_found", "chat not found", 404);
  return jsonOk({ owned });
});
TS
check safe 'apps/web/src/app/api/chats/[chatId]/route.ts' "a result chosen by a ternary guards the route" <<'TS'
export const GET = withUser<Params>(async (user, _req, ctx) => {
  const { chatId } = await ctx.params;
  const owned = await loadOwnedChat(chatId, user.id);
  return owned ? jsonOk({ owned }) : jsonError("not_found", "chat not found", 404);
});
TS
check unsafe 'apps/web/src/app/api/chats/[chatId]/route.ts' "a guard past the four-line lookahead is too late" <<'TS'
export const GET = withUser<Params>(async (user, _req, ctx) => {
  const { chatId } = await ctx.params;
  const owned = await loadOwnedChat(chatId, user.id);
  const a = 1;
  const b = 2;
  const c = 3;
  const d = 4;
  if (!owned) return jsonError("not_found", "chat not found", 404);
  return jsonOk({ owned, a, b, c, d });
});
TS

# Text the gate's JavaScript reads differently from Python's defaults.
printf 'export const GET = withUser\xc2\xa0(async (user, _req, ctx) => {\n  const { chatId } = await ctx.params;\n  return jsonOk({ chatId });\n});\n' \
  | check unsafe 'apps/web/src/app/api/chats/[chatId]/route.ts' "a handler after a no-break space is judged (JavaScript's \\s matches U+00A0)"
printf 'export const GET = withUser(async (user, _req, ctx) => {\n  const { chatId } = await ctx.params;\n  const owned = await loadOwnedChat(chatId, user.id);\n  if\xc2\xa0(!owned) return jsonError("not_found", "chat not found", 404);\n  return jsonOk({ owned });\n});\n' \
  | check safe 'apps/web/src/app/api/chats/[chatId]/route.ts' "a guard written with a no-break space still counts"
printf 'export const GET = withUser(async (user, _req, ctx) => {\n  const { chatId } = await ctx.params; // note\r  const owned = await loadOwnedChat(chatId, user.id);\n  if (!owned) return jsonError("not_found", "chat not found", 404);\n  return jsonOk({ owned });\n});\n' \
  | check unsafe 'apps/web/src/app/api/chats/[chatId]/route.ts' "a lone CR does not end a // comment (readFileSync keeps it)"
# readFileSync(path, "utf8") decodes invalid bytes to U+FFFD. A strict decode would
# raise, and scan-diff would then drop its prediction for every changed route.
printf 'export const GET = withUser(async (user, _req, ctx) => {\n  // \xff\xfe not utf-8\n  return jsonOk({});\n});\n' \
  | check unsafe 'apps/web/src/app/api/chats/[chatId]/route.ts' "a route that is not valid utf-8 is decoded as the gate decodes it and judged"

# --- route-authz.py: what it refuses to predict ---------------------------------------------
# refuses <exit> <stderr text> <name> <route-authz.py args>...
refuses() {
  local want=$1 text=$2 name=$3 rc=0 err
  shift 3
  rm -rf "$UNIT"; mkdir -p "$UNIT"
  err=$(cd "$UNIT" && python3 "$SKILL_DIR/route-authz.py" "$@" 2>&1 >/dev/null) || rc=$?
  [ "$rc" -eq "$want" ] || fail "$name: exited $rc, not $want ($err)"
  grep -Fq -- "$text" <<<"$err" || fail "$name: stderr does not say '$text': $err"
  echo "ok  $name"
}
refuses 2 "missing.ts" "a missing gate file exits 2 instead of passing every route" \
  --gate "$TMP/missing.ts" 'apps/web/src/app/api/chats/[chatId]/route.ts'
sed 's/GUARD_CHECK_LOOKAHEAD = 4;/GUARD_CHECK_LOOKAHEAD = 5;/' "$GATE" >"$TMP/drifted.ts"
refuses 2 "const GUARD_CHECK_LOOKAHEAD = 4;" "a gate whose mirrored constants changed exits 2 and names them" \
  --gate "$TMP/drifted.ts" 'apps/web/src/app/api/chats/[chatId]/route.ts'
sed 's/  "requireSimChat",/  ...OWNER_HELPERS,/' "$GATE" >"$TMP/spread.ts"
refuses 2 "APPROVED_ROUTE_AUTHZ_HELPERS" "a helper list it can only half read exits 2" \
  --gate "$TMP/spread.ts" 'apps/web/src/app/api/chats/[chatId]/route.ts'
refuses 3 "apps/web/src/app/api/chats/[chatId]/gone/route.ts" "a changed route it cannot read exits 3; other paths are not read" \
  --gate "$GATE" docs/absent.md 'apps/web/src/app/api/chats/[chatId]/gone/route.ts'

# --- scan-diff.sh end to end ----------------------------------------------------------------
g() {
  git -C "$REPO" -c user.name=fixture -c user.email=fixture@example.invalid \
    -c commit.gpgsign=false -c core.hooksPath=/dev/null "$@"
}
scan() { (cd "$SKILL_DIR" && ./scan-diff.sh "$REPO"); }   # a relative $0, as the skill runs it
authz_warns() { grep -c 'lint:authz' <<<"$1" || true; }

SAFE=apps/web/src/app/api/chats/[chatId]/time-skip/route.ts
UNSAFE=apps/web/src/app/api/widgets/[id]/route.ts
mkdir -p "$REPO"
g init -q -b main
write_gate "$REPO/scripts/check-route-authz.ts"
put "$REPO/$SAFE" <<'TS'
type Params = { chatId: string };
export const POST = withUser<Params>(async (user, req: NextRequest, ctx) => {
  const { chatId } = await ctx.params;
  const owned = await loadOwnedChat(chatId, user.id);
  if (!owned) return jsonError("not_found", "chat not found", 404);
  return jsonOk({ chat: owned.chat });
});
TS
put "$REPO/$UNSAFE" <<'TS'
type Params = { id: string };
export const DELETE = withUser<Params>(async (_user, _req, ctx) => {
  const { id } = await ctx.params;
  await db().delete(widgets).where(eq(widgets.id, id));
  return jsonOk({ deleted: true });
});
TS
g add -A && g commit -qm base

g switch -qc edits
printf '// edited\n' >>"$REPO/$SAFE"
printf '// edited\n' >>"$REPO/$UNSAFE"
g commit -qam edits
out=$(scan) || fail "scan-diff exited non-zero on warnings only"
grep -Fq "WARN  $UNSAFE: a bare withUser handler has no authorization evidence" <<<"$out" \
  || fail "scan-diff did not warn on an edited generic withUser<Params>( route with no evidence"
[ "$(authz_warns "$out")" -eq 1 ] || fail "scan-diff warned on the guarded route too: $out"
echo 'ok  scan-diff warns on the unguarded generic route and not the guarded one'

g switch -qc pure-rename main
g mv "apps/web/src/app/api/widgets" "apps/web/src/app/api/gadgets"
g commit -qm rename
out=$(scan)
[ "$(authz_warns "$out")" -eq 0 ] || fail "scan-diff warned on a pure rename, which the gate skips: $out"
printf '// edited\n' >>"$REPO/apps/web/src/app/api/gadgets/[id]/route.ts"
g commit -qam edit
out=$(scan)
grep -Fq 'WARN  apps/web/src/app/api/gadgets/[id]/route.ts: a bare withUser' <<<"$out" \
  || fail "scan-diff skipped a rename that also edited the route"
echo 'ok  scan-diff skips a pure rename and judges a rename with edits, as the gate does'

g switch -qc new-helper main
write_gate "$REPO/scripts/check-route-authz.ts" loadOwnedWidget
put "$REPO/$UNSAFE" <<'TS'
type Params = { id: string };
export const DELETE = withUser<Params>(async (user, _req, ctx) => {
  const { id } = await ctx.params;
  const widget = await loadOwnedWidget(id, user.id);
  if (!widget) return jsonError("not_found", "widget not found", 404);
  return jsonOk({ deleted: true });
});
TS
g commit -qam "new helper"
out=$(scan)
[ "$(authz_warns "$out")" -eq 0 ] || fail "scan-diff ignored a helper the branch's own gate approves: $out"
echo "ok  scan-diff reads the helper list from the scanned branch's gate"

g switch -qc broken-gate main
printf 'export const RESOURCE_ROUTE = "moved";\n' >"$REPO/scripts/check-route-authz.ts"
printf '// edited\n' >>"$REPO/$UNSAFE"
g commit -qam "broken gate"
out=$(scan 2>&1)
grep -Fq 'WARN  lint:authz not predicted: route-authz.py exited 2' <<<"$out" \
  || fail "scan-diff did not report an unreadable gate: $out"
echo 'ok  scan-diff reports an unreadable gate instead of passing silently'

# An interpreter that dies before main() exits 1 with nothing on stdout; that must
# not become a warning about an empty path.
mkdir -p "$TMP/fakebin"
printf '#!/bin/sh\nexit 1\n' >"$TMP/fakebin/python3"
chmod +x "$TMP/fakebin/python3"
g switch -qc silent-python main
printf '// edited\n' >>"$REPO/$UNSAFE"
g commit -qam "silent python"
out=$(PATH="$TMP/fakebin:$PATH" scan 2>&1)
grep -Fq 'WARN  lint:authz not predicted: route-authz.py exited 1' <<<"$out" \
  || fail "scan-diff read a silent exit 1 as a verdict: $out"
! grep -Fq 'WARN  : ' <<<"$out" || fail "scan-diff warned about an empty path: $out"
echo 'ok  scan-diff reports a silent route-authz.py failure instead of an empty-path warning'

g switch -qc delete-route main
g rm -q "$UNSAFE"
g commit -qm delete
out=$(scan)
[ "$(authz_warns "$out")" -eq 0 ] || fail "scan-diff passed a deleted route to route-authz.py: $out"
echo 'ok  scan-diff leaves a deleted route out, as the gate does'

echo "scan-diff fixtures passed"
