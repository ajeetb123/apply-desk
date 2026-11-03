#!/bin/zsh
ROOT="${0:A:h}"
PIDFILE="$ROOT/instance/app.pid"
/usr/bin/osascript -e 'tell application id "com.ajeet.applydesk" to quit' >/dev/null 2>&1 || true
if [[ -f "$PIDFILE" ]]; then
  PID=$(<"$PIDFILE")
  if [[ "$PID" == <-> ]] && /bin/kill -0 "$PID" 2>/dev/null; then /bin/kill "$PID"; fi
  /bin/rm -f "$PIDFILE"
fi
echo "Apply Desk background app and local service stopped."
