#!/bin/zsh
# Quits Apply Desk; the app stops its local service as it quits.
if /usr/bin/pgrep -qf "Apply Desk.app/Contents/MacOS/ApplyDesk"; then
  /usr/bin/osascript -e 'tell application id "com.ajeet.applydesk" to quit' >/dev/null 2>&1 || true
fi
# Also stop a service left by the older Terminal-started version.
ROOT="${0:A:h}"
PIDFILE="$ROOT/instance/app.pid"
if [[ -f "$PIDFILE" ]]; then
  PID=$(<"$PIDFILE")
  if [[ "$PID" == <-> ]] && /bin/kill -0 "$PID" 2>/dev/null; then /bin/kill "$PID"; fi
  /bin/rm -f "$PIDFILE"
fi
echo "Apply Desk stopped. Open it again from Applications or Spotlight."
