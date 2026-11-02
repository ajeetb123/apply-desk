#!/bin/zsh
ROOT="${0:A:h}"
URL="http://127.0.0.1:8787/"
mkdir -p "$ROOT/instance"
if ! /usr/bin/curl -fsS "$URL" >/dev/null 2>&1; then
  nohup "$ROOT/.venv/bin/python" "$ROOT/app.py" >> "$ROOT/instance/app.log" 2>&1 </dev/null &
  echo $! > "$ROOT/instance/app.pid"
  for attempt in {1..24}; do
    if /usr/bin/curl -fsS "$URL" >/dev/null 2>&1; then break; fi
    /bin/sleep 0.25
  done
fi
/usr/bin/open "$URL"
