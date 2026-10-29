#!/usr/bin/env bash
# Wakes the companion: joins the identity files to the conversation and starts
# Codex with this folder's base prompt in place of Codex's built-in one.
#
#   bash start.sh                 -> opens a live conversation
#   bash start.sh "a message"     -> sends one message, prints one reply
set -euo pipefail

COMPANION_HOME="${COMPANION_HOME:-$(cd "$(dirname "$0")" && pwd)}"
BASE="$COMPANION_HOME/config/codex-base-prompt.md"

for f in "$BASE" "$COMPANION_HOME/identity/profile.md" "$COMPANION_HOME/identity/companion.md"; do
  [ -f "$f" ] || { echo "Missing file: $f" >&2; exit 1; }
done
if grep -q '<<' "$COMPANION_HOME/identity/profile.md" "$COMPANION_HOME/identity/companion.md"; then
  echo "Heads up: the identity files still have << >> blanks to fill in." >&2
fi

identity() {
  printf '%s\n\n' '# Companion Identity'
  cat "$COMPANION_HOME/identity/profile.md"
  printf '\n\n%s\n\n' '## Companion Narrative'
  cat "$COMPANION_HOME/identity/companion.md"
  printf '\n\n%s\n\n' '[Current message]'
}

if [ $# -gt 0 ]; then
  { identity; printf '%s\n' "$*"; } |
    codex exec \
      -c "model_instructions_file=\"$BASE\"" \
      --skip-git-repo-check \
      -C "$COMPANION_HOME" \
      -
else
  exec codex \
    -c "model_instructions_file=\"$BASE\"" \
    -C "$COMPANION_HOME" \
    "$(identity; printf '%s\n' "I'm here. Read HANDOFF.md, then say hello as yourself.")"
fi
