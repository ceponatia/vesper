#!/usr/bin/env bash
# curl the Fly deploy as the QA account with the two things every hand-written
# call forgets: the session cookie, and an Origin header — a cookie-bearing
# mutation whose Origin does not match BETTER_AUTH_URL gets 403 csrf_origin
# (apps/web/src/server/api/csrf.ts), and Better Auth rejects a sign-in the
# same way ("Invalid origin").
#
#   fly-api.sh login                                   # reads DEV_PASSWORD off the machine; never prints it
#   fly-api.sh GET  /api/gallery
#   fly-api.sh PATCH /api/admin/self/image-models/<id> '{"reprobe":true}'
#   fly-api.sh POST /api/admin/self/image-generator/runs/delete @body.json
#   fly-api.sh logout
#
# Env: VESPER_FLY_URL (default https://vesper.fly.dev), VESPER_QA_EMAIL
# (default uxtest-main@vesper.local). The cookie jar lives at
# ~/.cache/vesper/fly.cookies (mode 600) and outlives the session; a 401
# triggers one re-login and retry. Response body goes to stdout, the status
# line to stderr, so `fly-api.sh GET /x | jq` works.
set -euo pipefail

BASE="${VESPER_FLY_URL:-https://vesper.fly.dev}"
EMAIL="${VESPER_QA_EMAIL:-uxtest-main@vesper.local}"
APP="${VESPER_FLY_APP:-vesper}"
JAR="${XDG_CACHE_HOME:-$HOME/.cache}/vesper/fly.cookies"

login() {
  local pw code
  pw=$(fly ssh console -a "$APP" -C "printenv DEV_PASSWORD" 2>/dev/null | tr -d '\r' | grep -v '^Connecting' | tail -1)
  [ -n "$pw" ] || { echo "could not read DEV_PASSWORD from the $APP machine (fly ssh)" >&2; exit 1; }
  mkdir -p "$(dirname "$JAR")"; ( umask 077; : > "$JAR" )
  code=$(jq -cn --arg e "$EMAIL" --arg p "$pw" '{email: $e, password: $p}' \
    | curl -sS -o /dev/null -w '%{http_code}' -c "$JAR" \
        -H "Origin: $BASE" -H 'Content-Type: application/json' --data @- \
        "$BASE/api/auth/sign-in/email")
  unset pw
  [ "$code" = 200 ] || { echo "sign-in as $EMAIL returned $code (secret rotated? ALLOW_SIGNUP irrelevant — this is sign-IN)" >&2; exit 1; }
  echo "signed in as $EMAIL → $JAR" >&2
}

request() {
  local method="$1" path="$2" body="${3:-}" args code out
  args=(-sS -b "$JAR" -c "$JAR" -H "Origin: $BASE" -H 'Accept: application/json' -X "$method")
  if [ -n "$body" ]; then
    args+=(-H 'Content-Type: application/json')
    case "$body" in @*) args+=(--data "$body") ;; *) args+=(--data "$body") ;; esac
  fi
  out=$(mktemp); trap 'rm -f "$out"' RETURN
  code=$(curl "${args[@]}" -o "$out" -w '%{http_code}' "$BASE$path")
  echo "$method $path → $code" >&2
  cat "$out"; echo
  [ "$code" != 401 ]
}

cmd="${1:-}"; shift || true
case "$cmd" in
  login) login ;;
  logout) rm -f "$JAR"; echo "removed $JAR" >&2 ;;
  GET|POST|PUT|PATCH|DELETE)
    path="${1:?path required, e.g. /api/gallery}"; body="${2:-}"
    case "$path" in /*) ;; *) echo "path must start with /" >&2; exit 1 ;; esac
    [ -s "$JAR" ] || login
    if ! request "$cmd" "$path" "$body"; then
      echo "401 — re-authenticating once" >&2; login; request "$cmd" "$path" "$body"
    fi ;;
  *) sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 1 ;;
esac
