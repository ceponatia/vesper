#!/usr/bin/env bash
# Snapshot every board item's Iteration value to stdout as JSON, keyed by the
# iteration TITLE — the only thing that survives an iterationConfiguration
# mutation, which recreates every iteration id and clears the field on every
# item. Take this before re-cutting iteration dates; feed it to
# iteration-restore.sh afterwards. Paginates the board directly over GraphQL
# (100 items a page) — this is the one board-wide read in the toolkit, so run
# it once, not in a loop.
#
#   iteration-snapshot.sh > iterations-before.json
set -euo pipefail

PROJECT_ID=PVT_kwHOARzdw84BhlWR

acc='[]'; after=""
while :; do
  args=(-f project="$PROJECT_ID")
  [ -z "$after" ] || args+=(-f after="$after")
  page=$(gh api graphql "${args[@]}" -f query='query($project:ID!, $after:String) { node(id:$project) { ... on ProjectV2 {
      items(first:100, after:$after) {
        pageInfo { hasNextPage endCursor }
        nodes { id
          content { __typename ... on Issue { number } ... on PullRequest { number } }
          iteration: fieldValueByName(name:"Iteration") { ... on ProjectV2ItemFieldIterationValue { iterationId title startDate } } }
      } } } }')
  acc=$(jq -c --argjson p "$page" '. + [$p.data.node.items.nodes[]
        | select(.iteration != null and .iteration.title != null and .content.number != null)
        | {number: .content.number, type: .content.__typename, itemId: .id, title: .iteration.title, startDate: .iteration.startDate}]' <<<"$acc")
  [ "$(jq -r '.data.node.items.pageInfo.hasNextPage' <<<"$page")" = true ] || break
  after=$(jq -r '.data.node.items.pageInfo.endCursor' <<<"$page")
done

jq 'sort_by(.number)' <<<"$acc"
