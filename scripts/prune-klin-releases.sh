#!/usr/bin/env bash
# Deletes Klin releases older than the newest <keep>, with their tags. klin-release.yml runs it
# after each publish. Only v<x.y.z>-klin.<run> builds are candidates, so pr-evidence and any
# hand-made release stay, and the release marked latest always stays. Prints one keep or delete
# line per release.
#
# Usage: scripts/prune-klin-releases.sh <owner/repo> <keep> [--dry-run]
set -euo pipefail

repo="${1:?owner/repo}"
keep="${2:?number of Klin releases to keep}"
dry_run="${3:-}"

plan="$(
  gh release list --repo "$repo" --limit 1000 --json tagName,isLatest |
    jq -r --argjson keep "$keep" '
      def run: (.tagName | capture("^v[0-9]+\\.[0-9]+\\.[0-9]+-klin\\.(?<n>[0-9]+)$").n | tonumber) // null;
      (map(select(run == null)) | .[] | "keep \(.tagName) (not a Klin build)"),
      (map(select(run != null)) | sort_by(-run) | to_entries[]
        | if .value.isLatest then "keep \(.value.tagName) (latest)"
          elif .key < $keep then "keep \(.value.tagName)"
          else "delete \(.value.tagName)" end)'
)"
echo "$plan"

while read -r action tag _; do
  [[ "$action" == delete ]] || continue
  if [[ "$dry_run" == --dry-run ]]; then continue; fi
  gh release delete "$tag" --repo "$repo" --cleanup-tag --yes
done <<<"$plan"
