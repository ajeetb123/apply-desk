#!/bin/zsh
# Opens Apply Desk, building and installing it first when the source is newer.
set -e
ROOT="${0:A:h}"
APP=""
for candidate in "/Applications/Apply Desk.app" "$HOME/Applications/Apply Desk.app"; do
  [[ -d "$candidate" ]] && APP="$candidate" && break
done
needs_build=0
[[ -z "$APP" ]] && needs_build=1
if (( ! needs_build )); then
  for source in "$ROOT"/app.py "$ROOT"/macos/**/*.swift "$ROOT"/templates/* "$ROOT"/static/* "$ROOT/Build Apply Desk App.command"; do
    if [[ "$source" -nt "$APP/Contents/MacOS/ApplyDesk" ]]; then needs_build=1; break; fi
  done
fi
if (( needs_build )); then
  "$ROOT/Build Apply Desk App.command"
fi
/usr/bin/open -b com.ajeet.applydesk
