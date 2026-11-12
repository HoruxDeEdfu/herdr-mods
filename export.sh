#!/usr/bin/env bash
# Copies the current mods and layout from Herdr into this repository.
# Run it after changing something in Herdr, before committing.
set -euo pipefail
SRC="$(cd "$(dirname "$0")" && pwd)"
HERDR="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
for m in code-files git-panel git-tabs; do
  rsync -a --delete --exclude .drafts --exclude .dev.json --exclude .accounts.json --exclude .DS_Store "$HERDR/mods/$m/" "$SRC/mods/$m/"
done
cp "$HERDR/layouts/main-code.json" "$SRC/layouts/"
echo "Exported. Review with: git -C \"$SRC\" status"
