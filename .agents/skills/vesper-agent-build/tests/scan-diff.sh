#!/usr/bin/env bash
# Offline contract checks for scan-diff.sh's lint:authz prediction (route-authz.py).
# A throwaway git repository with a stub gate file; no application code, no network.
set -euo pipefail

SKILL_DIR=$(cd "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
REPO="$TMP/repo"
UNIT="$TMP/unit"
GATE="$TMP/check-route-authz.ts"

fail() { echo "FAILED: $1" >&2; exit 1; }
put() { mkdir -p "$(dirname "$1")"; cat >"$1"; }

# The gate's literal shapes, including a commented-out helper and a `[^/]`
# class inside the RESOURCE_ROUTE literal. The wrapper list is decoration: the
# gate never consults it, and neither may the port.
put "$GATE" <<'TS'
export const APPROVED_ROUTE_AUTHZ_WRAPPERS = [
  "withOwnedChat",
  "withAuthorizedResource",
] as const;

/** Audited seams; "notAHelper" in this comment must not count. */
export const APPROVED_ROUTE_AUTHZ_HELPERS = [
  "loadOwnedChat",
  // "retiredHelper",
  "requireSimChat",
  "findItem",
  "findViewable",
  "cloneToLibrary",
] as const;

export const RESOURCE_ROUTE = /^apps\/web\/src\/app\/api\/.+\/\[[^/]+\]\/.*route\.ts$/;
TS

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

rc=0
(cd "$UNIT" && python3 "$SKILL_DIR/route-authz.py" --gate "$TMP/missing.ts" x 2>/dev/null) || rc=$?
[ "$rc" -eq 2 ] || fail "a missing gate file exited $rc, not 2"
echo 'ok  an unreadable gate exits 2 instead of passing every route'

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
put "$REPO/scripts/check-route-authz.ts" <"$GATE"
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
sed -i 's/  "cloneToLibrary",/  "cloneToLibrary",\n  "loadOwnedWidget",/' "$REPO/scripts/check-route-authz.ts"
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
grep -Fq 'WARN  lint:authz not predicted for 1 changed route file(s): route-authz.py exited 2' <<<"$out" \
  || fail "scan-diff did not report an unreadable gate: $out"
echo 'ok  scan-diff reports an unreadable gate instead of passing silently'

g switch -qc delete-route main
g rm -q "$UNSAFE"
g commit -qm delete
out=$(scan)
[ "$(authz_warns "$out")" -eq 0 ] || fail "scan-diff judged a deleted route: $out"
echo 'ok  scan-diff ignores a deleted route'

echo "scan-diff fixtures passed"
