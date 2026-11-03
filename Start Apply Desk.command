#!/bin/zsh
set -e
ROOT="${0:A:h}"
URL="http://127.0.0.1:8787/"
mkdir -p "$ROOT/instance"
if ! /usr/bin/curl -fsS "$URL" >/dev/null 2>&1; then
  nohup "$ROOT/.venv/bin/python" "$ROOT/app.py" >> "$ROOT/instance/app.log" 2>&1 &
  echo $! > "$ROOT/instance/app.pid"
  for attempt in {1..40}; do
    if /usr/bin/curl -fsS "$URL" >/dev/null 2>&1; then break; fi
    /bin/sleep 0.25
  done
fi
if [[ ! -d "$ROOT/Apply Desk.app" || "$ROOT/macos/ApplyDeskMenuBar.swift" -nt "$ROOT/Apply Desk.app/Contents/MacOS/ApplyDesk" ]]; then
  "$ROOT/Build Apply Desk App.command"
fi
/usr/bin/open -a "$ROOT/Apply Desk.app"
