#!/usr/bin/env bash
# Snapshot every board item's Iteration value to stdout as JSON, keyed by the
# iteration TITLE — the only thing that survives an iterationConfiguration
# mutation, which recreates every iteration id and clears the field on every
# item. Take this before re-cutting iteration dates; feed it to
# iteration-restore.sh afterwards.
#
#   iteration-snapshot.sh > iterations-before.json
set -euo pipefail

OWNER=ceponatia
PROJECT=7

gh project item-list "$PROJECT" --owner "$OWNER" --format json --limit 500 \
  | jq '[.items[]
         | select(.iteration != null)
         | {number: .content.number, type: .content.type, itemId: .id,
            title: (.iteration.title // .iteration), startDate: (.iteration.startDate // null)}]
         | sort_by(.number)'
