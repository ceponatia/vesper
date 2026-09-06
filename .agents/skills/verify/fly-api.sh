#!/usr/bin/env bash
# Authenticated JSON requests to the Fly deployment as the Vesper QA account.
#
#   fly-api.sh login
#   fly-api.sh GET /api/gallery
#   fly-api.sh PATCH /api/admin/self/image-models/<id> '{"reprobe":true}'
#   fly-api.sh --expect 404 GET /api/missing
#   fly-api.sh logout
#
# Env: VESPER_FLY_URL, VESPER_QA_EMAIL, VESPER_FLY_APP, XDG_CACHE_HOME.
# Response bodies go to stdout. Diagnostics and status lines go to stderr.
set -euo pipefail

BASE="${VESPER_FLY_URL:-https://vesper.fly.dev}"
EMAIL="${VESPER_QA_EMAIL:-uxtest-main@vesper.local}"
APP="${VESPER_FLY_APP:-vesper}"
JAR="${XDG_CACHE_HOME:-$HOME/.cache}/vesper/fly.cookies"
EXPECTED_STATUS=""
RESPONSE_CODE=""

usage() {
  sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//' >&2
}

fail_login() {
  rm -f "$JAR"
  echo "$1" >&2
  return "${2:-1}"
}

has_current_session_cookie() {
  local now
  now=$(date +%s)
  awk -F '\t' -v now="$now" '
    /^#HttpOnly_/ { sub(/^#HttpOnly_/, "", $1) }
    /^#/ || NF < 7 { next }
    ($6 == "better-auth.session_token" || $6 == "__Secure-better-auth.session_token") \
      && length($7) > 0 && $5 ~ /^[0-9]+$/ \
      && (($5 + 0) == 0 || ($5 + 0) > now) { found = 1 }
    END { exit(found ? 0 : 1) }
  ' "$JAR"
}

login() {
  local pw code curl_status

  if ! pw=$(fly ssh console -a "$APP" -C "printenv DEV_PASSWORD" 2>/dev/null \
    | tr -d '\r' | grep -v '^Connecting' | tail -1); then
    fail_login "could not read DEV_PASSWORD from the $APP machine (fly ssh)"
    return
  fi
  if [ -z "$pw" ]; then
    fail_login "could not read DEV_PASSWORD from the $APP machine (fly ssh)"
    return
  fi

  mkdir -p "$(dirname "$JAR")"
  ( umask 077; : > "$JAR" )
  chmod 600 "$JAR"

  if code=$(jq -cn --arg e "$EMAIL" --arg p "$pw" '{email: $e, password: $p}' \
    | curl -sS -o /dev/null -w '%{http_code}' -c "$JAR" \
        -H "Origin: $BASE" -H 'Content-Type: application/json' --data @- \
        "$BASE/api/auth/sign-in/email"); then
    curl_status=0
  else
    curl_status=$?
  fi
  unset pw

  if [ "$curl_status" -ne 0 ]; then
    fail_login "sign-in transport failed (curl exit $curl_status)" "$curl_status"
    return
  fi
  if [[ ! "$code" =~ ^2[0-9][0-9]$ ]]; then
    fail_login "sign-in as $EMAIL returned HTTP $code"
    return
  fi
  if ! has_current_session_cookie; then
    fail_login "sign-in as $EMAIL returned HTTP $code without a usable Better Auth session cookie"
    return
  fi
  echo "signed in as $EMAIL" >&2
}

perform_request() {
  local method="$1" path="$2" body="$3" out="$4"
  local curl_status
  local -a args

  args=(-sS -b "$JAR" -c "$JAR" -H "Origin: $BASE" -H 'Accept: application/json' -X "$method")
  if [ -n "$body" ]; then
    args+=(-H 'Content-Type: application/json' --data "$body")
  fi

  if RESPONSE_CODE=$(curl "${args[@]}" -o "$out" -w '%{http_code}' "$BASE$path"); then
    curl_status=0
  else
    curl_status=$?
  fi
  if [ "$curl_status" -ne 0 ]; then
    echo "$method $path transport failed (curl exit $curl_status)" >&2
    return "$curl_status"
  fi
}

status_is_expected() {
  local code="$1"
  if [ -n "$EXPECTED_STATUS" ]; then
    [ "$code" = "$EXPECTED_STATUS" ]
  else
    [[ "$code" =~ ^2[0-9][0-9]$ ]]
  fi
}

request() {
  local method="$1" path="$2" body="$3"
  local out curl_status
  out=$(mktemp)
  trap 'rm -f "$out"' RETURN

  if perform_request "$method" "$path" "$body" "$out"; then
    curl_status=0
  else
    curl_status=$?
  fi
  if [ "$curl_status" -ne 0 ]; then
    return "$curl_status"
  fi

  if [ "$RESPONSE_CODE" = 401 ]; then
    echo "$method $path returned HTTP 401; re-authenticating once" >&2
    login || return
    : > "$out"
    if perform_request "$method" "$path" "$body" "$out"; then
      curl_status=0
    else
      curl_status=$?
    fi
    if [ "$curl_status" -ne 0 ]; then
      return "$curl_status"
    fi
  fi

  cat "$out"
  echo "$method $path -> HTTP $RESPONSE_CODE" >&2
  if ! status_is_expected "$RESPONSE_CODE"; then
    if [ -n "$EXPECTED_STATUS" ]; then
      echo "expected HTTP $EXPECTED_STATUS, received HTTP $RESPONSE_CODE" >&2
    else
      echo "unexpected HTTP $RESPONSE_CODE (expected 2xx)" >&2
    fi
    return 22
  fi
}

while [ "${1:-}" = "--expect" ] || [[ "${1:-}" == --expect=* ]]; do
  case "$1" in
    --expect)
      [ "$#" -ge 2 ] || { echo "--expect requires a status code" >&2; exit 2; }
      EXPECTED_STATUS="$2"
      shift 2
      ;;
    --expect=*)
      EXPECTED_STATUS="${1#--expect=}"
      shift
      ;;
  esac
done

if [ -n "$EXPECTED_STATUS" ] && [[ ! "$EXPECTED_STATUS" =~ ^[1-5][0-9][0-9]$ ]]; then
  echo "--expect requires one HTTP status code from 100 through 599" >&2
  exit 2
fi

cmd="${1:-}"
[ "$#" -eq 0 ] || shift
case "$cmd" in
  login)
    [ "$#" -eq 0 ] || { usage; exit 2; }
    login
    ;;
  logout)
    [ "$#" -eq 0 ] || { usage; exit 2; }
    rm -f "$JAR"
    echo "removed $JAR" >&2
    ;;
  GET|POST|PUT|PATCH|DELETE)
    path="${1:?path required, e.g. /api/gallery}"
    body="${2:-}"
    [ "$#" -le 2 ] || { usage; exit 2; }
    case "$path" in
      /*) ;;
      *) echo "path must start with /" >&2; exit 2 ;;
    esac
    [ -s "$JAR" ] || login
    request "$cmd" "$path" "$body"
    ;;
  -h|--help)
    usage
    ;;
  *)
    usage
    exit 2
    ;;
esac
