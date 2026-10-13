#!/bin/sh
# Prints the body of a version's section in CHANGELOG.md (from under its
# "## <version> - <date>" heading to the next "## "), for its release notes.
# Fails when there is no such section or it is empty.
set -eu
version="$1"
notes="$(awk -v heading="## $version - " '
  index($0, heading) == 1 { found = 1; next }
  found && /^## / { exit }
  found { print }
' "$(dirname "$0")/../CHANGELOG.md")"
if [ -z "$(printf '%s' "$notes" | tr -d '[:space:]')" ]; then
  echo "CHANGELOG.md has no section for $version" >&2
  exit 1
fi
printf '%s\n' "$notes" | sed '/./,$!d'
